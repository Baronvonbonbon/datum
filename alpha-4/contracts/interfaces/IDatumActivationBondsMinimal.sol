// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumActivationBondsMinimal
/// @notice Minimal read-surface used by GovernanceV2 to gate Pending-campaign
///         voting on whether a challenger has contested optimistic activation.
interface IDatumActivationBondsMinimal {
    function isContested(uint256 campaignId) external view returns (bool);
    function isOpen(uint256 campaignId) external view returns (bool);
}
