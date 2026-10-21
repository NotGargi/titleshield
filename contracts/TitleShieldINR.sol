// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TitleShield INR (tINR)
/// @notice Tokenised rupee used by the title escrow. 1 tINR = ₹1, 2 decimals (paise).
///         Every token is backed 1:1 by money held in the trustee bank's escrow account:
///         the trustee mints tokens when an advance is credited to the bank, and burns
///         ("redeems") them when the bank pays the money out to a verified account.
contract TitleShieldINR {
    string public constant name = "TitleShield INR";
    string public constant symbol = "tINR";
    uint8 public constant decimals = 2;

    address public immutable trustee;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isMinter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterSet(address indexed minter, bool allowed);
    event Redeemed(address indexed holder, uint256 value, bytes32 bankReference);

    error NotTrustee();
    error NotMinter();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor() {
        trustee = msg.sender;
        isMinter[msg.sender] = true;
        emit MinterSet(msg.sender, true);
    }

    modifier onlyTrustee() {
        if (msg.sender != trustee) revert NotTrustee();
        _;
    }

    function setMinter(address minter, bool allowed) external onlyTrustee {
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    /// @notice Issue tokens against money received by the trustee bank.
    function mint(address to, uint256 value) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    /// @notice Off-ramp: the trustee bank paid `value` rupees to the holder's verified bank
    ///         account (reference = hash of the bank UTR), so the tokens are retired.
    function redeem(address holder, uint256 value, bytes32 bankReference) external onlyTrustee {
        if (balanceOf[holder] < value) revert InsufficientBalance();
        balanceOf[holder] -= value;
        totalSupply -= value;
        emit Transfer(holder, address(0), value);
        emit Redeemed(holder, value, bankReference);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
