// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title TitleShield title escrow
/// @notice Holds a buyer's advance (in a test ERC-20 token) until an authorised title-verification
///         verdict arrives, then enforces the outcome:
///   - VERIFIED_CLEAN      -> tokens go to the seller (less the fee), only if the score is >= 90,
///                            or an advocate resolved a dispute
///   - QUALIFYING_DEFECT   -> the full deposit goes back to the buyer (e.g. undisclosed mortgage, court stay)
///   - INCONCLUSIVE        -> nothing moves; the escrow becomes DISPUTED until a reviewed verdict arrives
/// A verdict is valid only if it is signed (EIP-712) by the authorised oracle, names this escrow and
/// search, has not expired and has not been used before. Anyone may submit it; nobody can forge it.
/// After the deadline, an unsettled deposit can only go back to the buyer, never to the seller.
contract TitleEscrow {
    enum Status { None, Created, Funded, VerificationPending, Disputed, Released, Refunded }
    enum Outcome { None, VerifiedClean, QualifyingDefect, Inconclusive }

    struct Escrow {
        bytes32 searchId;        // title search this escrow is bound to
        address buyer;           // set by the deposit
        address seller;
        uint256 amount;          // deposit in token units
        uint256 fee;             // charged only on release
        uint64 deadline;
        Status status;
        uint16 score;
        bytes32 agreementHash;   // SHA-256 of the e-signed agreement (kept off-chain)
        bytes32 propertyHash;    // hash of the property description (no personal data on-chain)
        bytes32 evidenceHash;    // SHA-256 of the evidence package behind the accepted verdict
    }

    /// @dev EIP-712 typed verdict signed by the oracle.
    struct Verdict {
        bytes32 escrowId;
        bytes32 searchId;
        uint8 outcome;
        uint16 score;
        bytes32 evidenceHash;
        bool advocateReviewed;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes32 nonce;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 escrowId,bytes32 searchId,uint8 outcome,uint16 score,bytes32 evidenceHash,bool advocateReviewed,uint64 issuedAt,uint64 expiresAt,bytes32 nonce)"
    );
    uint16 public constant CLEAR_SCORE = 90;
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable token;
    address public immutable owner;      // deploys and can rotate the oracle
    address public immutable operator;   // backend: registers escrows and marks verification started
    address public immutable feeWallet;
    address public oracle;               // the only key whose verdicts are accepted
    bytes32 private immutable _domainSeparator;
    uint256 private immutable _chainId;

    mapping(bytes32 => Escrow) public escrows;
    mapping(bytes32 => bool) public usedNonces;
    uint256 public totalLocked;
    uint256 private _lock = 1;

    event EscrowCreated(bytes32 indexed escrowId, bytes32 indexed searchId, address seller, uint256 amount, uint256 fee, uint64 deadline);
    event Deposited(bytes32 indexed escrowId, address indexed buyer, uint256 amount);
    event VerificationStarted(bytes32 indexed escrowId, bytes32 indexed searchId);
    event VerdictAccepted(bytes32 indexed escrowId, uint8 outcome, uint16 score, bytes32 evidenceHash, bytes32 nonce, bool advocateReviewed);
    event Disputed(bytes32 indexed escrowId, uint16 score, bytes32 evidenceHash);
    event Released(bytes32 indexed escrowId, address indexed seller, uint256 toSeller, uint256 fee);
    event Refunded(bytes32 indexed escrowId, address indexed buyer, uint256 amount, string reason);
    event OracleChanged(address indexed previous, address indexed current);

    error NotOwner();
    error NotOperator();
    error AlreadyExists();
    error BadState(Status current);
    error WrongEscrowOrSearch();
    error AttestationExpired();
    error AttestationNotYetValid();
    error NonceAlreadyUsed();
    error UnauthorizedSigner(address recovered);
    error BadSignature();
    error TitleNotClear(uint16 score);
    error InvalidOutcome();
    error DeadlineNotReached(uint64 deadline);
    error TransferFailed();
    error Reentrancy();
    error ZeroAddress();

    constructor(IERC20 token_, address operator_, address oracle_, address feeWallet_) {
        if (address(token_) == address(0) || operator_ == address(0) || oracle_ == address(0) || feeWallet_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = msg.sender;
        operator = operator_;
        oracle = oracle_;
        feeWallet = feeWallet_;
        _chainId = block.chainid;
        _domainSeparator = _buildDomainSeparator();
        emit OracleChanged(address(0), oracle_);
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------- escrow lifecycle ----------------

    /// @notice Register an escrow (after both parties have e-signed the agreement).
    function createEscrow(bytes32 escrowId, bytes32 searchId, address seller, uint256 amount, uint256 fee, bytes32 agreementHash, bytes32 propertyHash, uint64 deadline) external {
        if (msg.sender != operator) revert NotOperator();
        if (seller == address(0)) revert ZeroAddress();
        if (escrows[escrowId].status != Status.None) revert AlreadyExists();
        escrows[escrowId] = Escrow(searchId, address(0), seller, amount, fee, deadline, Status.Created, 0, agreementHash, propertyHash, bytes32(0));
        emit EscrowCreated(escrowId, searchId, seller, amount, fee, deadline);
    }

    /// @notice The buyer deposits the advance (approve the token first). The depositor becomes the buyer
    ///         and is the only possible refund destination. A second deposit is rejected.
    function deposit(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Created) revert BadState(e.status);
        e.buyer = msg.sender;
        e.status = Status.Funded;
        totalLocked += e.amount;
        if (!token.transferFrom(msg.sender, address(this), e.amount)) revert TransferFailed();
        emit Deposited(escrowId, msg.sender, e.amount);
    }

    /// @notice The backend has started the title search for this funded escrow.
    function beginVerification(bytes32 escrowId) external {
        if (msg.sender != operator) revert NotOperator();
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded) revert BadState(e.status);
        e.status = Status.VerificationPending;
        emit VerificationStarted(escrowId, e.searchId);
    }

    /// @notice Apply an oracle-signed verdict. Anyone may submit it; only a valid oracle signature counts.
    function settle(Verdict calldata v, bytes calldata signature) external nonReentrant {
        Escrow storage e = escrows[v.escrowId];
        if (e.status != Status.VerificationPending && e.status != Status.Disputed) revert BadState(e.status);
        if (v.searchId != e.searchId) revert WrongEscrowOrSearch();
        if (block.timestamp > v.expiresAt) revert AttestationExpired();
        if (v.issuedAt > block.timestamp + 300) revert AttestationNotYetValid();
        if (usedNonces[v.nonce]) revert NonceAlreadyUsed();
        address signer = _recover(_hashVerdict(v), signature);
        if (signer != oracle) revert UnauthorizedSigner(signer);

        // effects
        usedNonces[v.nonce] = true;
        e.score = v.score;
        e.evidenceHash = v.evidenceHash;
        emit VerdictAccepted(v.escrowId, v.outcome, v.score, v.evidenceHash, v.nonce, v.advocateReviewed);

        if (v.outcome == uint8(Outcome.VerifiedClean)) {
            bool reviewed = e.status == Status.Disputed && v.advocateReviewed;
            if (v.score < CLEAR_SCORE && !reviewed) revert TitleNotClear(v.score);
            e.status = Status.Released;
            totalLocked -= e.amount;
            uint256 toSeller = e.amount - e.fee;
            // interactions
            if (!token.transfer(e.seller, toSeller)) revert TransferFailed();
            if (e.fee > 0 && !token.transfer(feeWallet, e.fee)) revert TransferFailed();
            emit Released(v.escrowId, e.seller, toSeller, e.fee);
        } else if (v.outcome == uint8(Outcome.QualifyingDefect)) {
            e.status = Status.Refunded;
            totalLocked -= e.amount;
            if (!token.transfer(e.buyer, e.amount)) revert TransferFailed();
            emit Refunded(v.escrowId, e.buyer, e.amount, "Qualifying title defect");
        } else if (v.outcome == uint8(Outcome.Inconclusive)) {
            if (e.status != Status.VerificationPending) revert BadState(e.status);
            e.status = Status.Disputed;
            emit Disputed(v.escrowId, v.score, v.evidenceHash);
        } else {
            revert InvalidOutcome();
        }
    }

    /// @notice Buyer protection: after the deadline an unsettled deposit can be returned to the buyer by anyone.
    ///         It can never be released to the seller this way.
    function refundAfterDeadline(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded && e.status != Status.VerificationPending && e.status != Status.Disputed) revert BadState(e.status);
        if (block.timestamp <= e.deadline) revert DeadlineNotReached(e.deadline);
        e.status = Status.Refunded;
        totalLocked -= e.amount;
        if (!token.transfer(e.buyer, e.amount)) revert TransferFailed();
        emit Refunded(escrowId, e.buyer, e.amount, "No verdict before the deadline");
    }

    /// @notice Controlled oracle rotation.
    function setOracle(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        emit OracleChanged(oracle, next);
        oracle = next;
    }

    // ---------------- EIP-712 ----------------

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _chainId ? _domainSeparator : _buildDomainSeparator();
    }

    function hashVerdict(Verdict calldata v) external view returns (bytes32) { return _hashVerdict(v); }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("TitleShieldEscrow")), keccak256(bytes("1")), block.chainid, address(this)
        ));
    }

    function _hashVerdict(Verdict calldata v) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            VERDICT_TYPEHASH, v.escrowId, v.searchId, v.outcome, v.score, v.evidenceHash, v.advocateReviewed, v.issuedAt, v.expiresAt, v.nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > HALF_ORDER) revert BadSignature(); // reject malleable signatures
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }
}
