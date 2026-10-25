// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TitleShield Test Token (TST)
/// @notice Mock ERC-20 used only to demonstrate the escrow on a test network.
///         It has NO monetary value and does not represent rupees or any real asset.
///         Anyone may mint a limited amount from the faucet for testing.
contract TestToken {
    string public constant name = "TitleShield Test Token";
    string public constant symbol = "TST";
    uint8 public constant decimals = 2;
    uint256 public constant FAUCET_LIMIT = 100_000_000_00; // 10 crore TST per call

    address public immutable owner;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error AboveFaucetLimit();
    error ZeroAddress();

    constructor() { owner = msg.sender; }

    /// @notice Test faucet: mint up to FAUCET_LIMIT to yourself.
    function faucet(uint256 value) external {
        if (value > FAUCET_LIMIT) revert AboveFaucetLimit();
        _mint(msg.sender, value);
    }

    /// @notice Faucet on behalf of a demo wallet (same limit).
    function faucetTo(address to, uint256 value) external {
        if (value > FAUCET_LIMIT) revert AboveFaucetLimit();
        _mint(to, value);
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

    function _mint(address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
