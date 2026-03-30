// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IDatumGovernanceHelper
/// @notice Interface for governance slash computation and dust guard satellite.
interface IDatumGovernanceHelper {
    /// @notice Compute slash amount for a losing voter after resolution.
    /// @param campaignId The campaign ID
    /// @param voteDirection 1=aye, 2=nay
    /// @param lockAmount The voter's locked stake
    /// @param slashBps Slash percentage in basis points
    /// @return slash The slash amount (0 if winner or unresolved)
    function computeSlash(
        uint256 campaignId,
        uint8 voteDirection,
        uint256 lockAmount,
        uint256 slashBps
    ) external view returns (uint256 slash);

    /// @notice Check that a transfer amount meets the existential deposit minimum.
    ///         Reverts with E58 if below minimum on PolkaVM. No-op on EVM.
    /// @param amount The transfer amount to validate
    function checkMinBalance(uint256 amount) external view;
}
