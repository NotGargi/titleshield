// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TitleShieldINR.sol";

/// @title TitleShield title escrow
/// @notice Holds the buyer's advance (usually 10% of the price) in tINR until the title is verified.
///   - Clean title certificate (score >= 90)       -> funds unlock to the seller (less the escrow fee).
///   - Undisclosed bank lien, court stay or bar    -> funds revert to the buyer, in full, at once.
///   - Anything uncertain                          -> funds stay locked until an advocate decides.
///   - No decision before the deadline             -> anyone can send the advance back to the buyer.
/// Only the verification oracle can settle, and money can only ever reach the buyer, the seller
/// or the fee wallet recorded when the escrow was opened.
contract TitleEscrow {
    enum Status { None, Open, Funded, OnHold, Released, Refunded }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;          // advance, in tINR paise
        uint256 fee;             // escrow fee, charged only on release
        uint64 deadline;         // unix time after which the buyer can be refunded without a verdict
        Status status;
        uint16 score;            // title score 0-100 at settlement
        bytes32 agreementHash;   // SHA-256 of the e-signed tri-party agreement PDF
        bytes32 propertyHash;    // hash of the property description
        bytes32 depositReference;// hash of the bank UTR that funded it
        bytes32 certificateHash; // hash of the Title Clearance Certificate / defect report
    }

    uint16 public constant CLEAR_SCORE = 90;

    TitleShieldINR public immutable token;
    address public immutable trustee;
    address public immutable oracle;
    address public immutable feeWallet;

    mapping(bytes32 => Escrow) public escrows;
    uint256 public totalLocked;

    event Opened(bytes32 indexed escrowId, address buyer, address seller, uint256 amount, uint256 fee, bytes32 agreementHash, bytes32 propertyHash, uint64 deadline);
    event Funded(bytes32 indexed escrowId, uint256 amount, bytes32 depositReference);
    event HeldForReview(bytes32 indexed escrowId, uint16 score, bytes32 certificateHash);
    event Released(bytes32 indexed escrowId, address seller, uint256 toSeller, uint256 fee, uint16 score, bytes32 certificateHash);
    event Refunded(bytes32 indexed escrowId, address buyer, uint256 amount, bytes32 certificateHash, string reason);

    error NotTrustee();
    error NotOracle();
    error BadState(Status current);
    error TitleNotClear(uint16 score);
    error DeadlineNotReached(uint64 deadline);
    error AlreadyExists();

    constructor(TitleShieldINR token_, address oracle_, address feeWallet_) {
        token = token_;
        trustee = msg.sender;
        oracle = oracle_;
        feeWallet = feeWallet_;
    }

    modifier onlyTrustee() { if (msg.sender != trustee) revert NotTrustee(); _; }
    modifier onlyOracle() { if (msg.sender != oracle) revert NotOracle(); _; }

    /// @notice Register an escrow once both parties have e-signed the agreement.
    function open(bytes32 escrowId, address buyer, address seller, uint256 amount, uint256 fee, bytes32 agreementHash, bytes32 propertyHash, uint64 deadline) external onlyTrustee {
        if (escrows[escrowId].status != Status.None) revert AlreadyExists();
        escrows[escrowId] = Escrow(buyer, seller, amount, fee, deadline, Status.Open, 0, agreementHash, propertyHash, bytes32(0), bytes32(0));
        emit Opened(escrowId, buyer, seller, amount, fee, agreementHash, propertyHash, deadline);
    }

    /// @notice The trustee bank received the advance: tokenise it and lock it in this contract.
    function fund(bytes32 escrowId, bytes32 depositReference) external onlyTrustee {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Open) revert BadState(e.status);
        e.status = Status.Funded;
        e.depositReference = depositReference;
        totalLocked += e.amount;
        token.mint(address(this), e.amount);
        emit Funded(escrowId, e.amount, depositReference);
    }

    /// @notice Verification came back uncertain: keep the money locked for an advocate.
    function hold(bytes32 escrowId, uint16 score, bytes32 certificateHash) external onlyOracle {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded) revert BadState(e.status);
        e.status = Status.OnHold;
        e.score = score;
        e.certificateHash = certificateHash;
        emit HeldForReview(escrowId, score, certificateHash);
    }

    /// @notice Clean title: unlock to the seller. A held escrow needs an advocate's approval instead of the score.
    function release(bytes32 escrowId, uint16 score, bytes32 certificateHash, bytes32 advocateApproval) external onlyOracle {
        Escrow storage e = escrows[escrowId];
        if (e.status == Status.Funded) {
            if (score < CLEAR_SCORE) revert TitleNotClear(score);
        } else if (e.status == Status.OnHold) {
            if (advocateApproval == bytes32(0)) revert TitleNotClear(score);
        } else {
            revert BadState(e.status);
        }
        e.status = Status.Released;
        e.score = score;
        e.certificateHash = certificateHash;
        totalLocked -= e.amount;
        uint256 toSeller = e.amount - e.fee;
        token.transfer(e.seller, toSeller);
        if (e.fee > 0) token.transfer(feeWallet, e.fee);
        emit Released(escrowId, e.seller, toSeller, e.fee, score, certificateHash);
    }

    /// @notice Defect found (e.g. an undisclosed bank lien): the full advance goes back to the buyer.
    function refund(bytes32 escrowId, uint16 score, bytes32 certificateHash, string calldata reason) external onlyOracle {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded && e.status != Status.OnHold) revert BadState(e.status);
        e.status = Status.Refunded;
        e.score = score;
        e.certificateHash = certificateHash;
        totalLocked -= e.amount;
        token.transfer(e.buyer, e.amount);
        emit Refunded(escrowId, e.buyer, e.amount, certificateHash, reason);
    }

    /// @notice Buyer protection that needs no one's permission: after the deadline, anyone can return the advance.
    function refundAfterDeadline(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        if (e.status != Status.Funded && e.status != Status.OnHold) revert BadState(e.status);
        if (block.timestamp <= e.deadline) revert DeadlineNotReached(e.deadline);
        e.status = Status.Refunded;
        totalLocked -= e.amount;
        token.transfer(e.buyer, e.amount);
        emit Refunded(escrowId, e.buyer, e.amount, bytes32(0), "No verdict before the deadline");
    }
}
