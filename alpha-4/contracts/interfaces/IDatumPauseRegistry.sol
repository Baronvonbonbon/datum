// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IDatumPauseRegistry {
    function paused() external view returns (bool);

    /// @notice CB6: per-category pause accessors. Each contract should check
    ///         the category most relevant to its operation so that, e.g., a
    ///         settlement-pause does not block governance from responding.
    function pausedSettlement() external view returns (bool);
    function pausedCampaignCreation() external view returns (bool);
    function pausedGovernance() external view returns (bool);
    function pausedTokenMint() external view returns (bool);
    function pausedCategories() external view returns (uint8);
}
