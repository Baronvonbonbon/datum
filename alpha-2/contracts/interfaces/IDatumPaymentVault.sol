// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumPaymentVault
/// @notice Interface for the pull-payment vault extracted from DatumSettlement.
///         Holds publisher/user/protocol balances and handles all withdrawals.
interface IDatumPaymentVault {
    event PublisherWithdrawal(address indexed publisher, uint256 amount);
    event UserWithdrawal(address indexed user, uint256 amount);
    event ProtocolWithdrawal(address indexed recipient, uint256 amount);
    event SettlementCredited(address indexed publisher, address indexed user, uint256 total);

    /// @notice Record settlement proceeds split. Called by Settlement after each settled claim.
    /// @dev Non-payable. DOT already at Vault from BudgetLedger.deductAndTransfer().
    function creditSettlement(
        address publisher, uint256 pubAmount,
        address user, uint256 userAmount,
        uint256 protocolAmount
    ) external;

    /// @notice Withdraw accumulated publisher payments
    function withdrawPublisher() external;

    /// @notice Withdraw accumulated user payments
    function withdrawUser() external;

    /// @notice Withdraw accumulated protocol fees (owner only)
    function withdrawProtocol(address recipient) external;

    function publisherBalance(address publisher) external view returns (uint256);
    function userBalance(address user) external view returns (uint256);
    function protocolBalance() external view returns (uint256);
}
