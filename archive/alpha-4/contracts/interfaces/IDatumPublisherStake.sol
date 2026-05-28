// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumPublisherStake
/// @notice FP-1 + FP-4: Publisher staking with bonding-curve requirement.
///         Publishers lock DOT proportional to impression volume.
///         Required stake = baseStakePlanck + cumulativeImpressions * planckPerImpression
interface IDatumPublisherStake {
    event Staked(address indexed publisher, uint256 amount, uint256 newTotal);
    event UnstakeRequested(address indexed publisher, uint256 amount, uint256 availableBlock);
    event Unstaked(address indexed publisher, uint256 amount);
    event Slashed(address indexed publisher, uint256 amount, address recipient);
    event ImpressionsRecorded(address indexed publisher, uint256 added, uint256 cumulative);
    event ParamsUpdated(uint256 baseStakePlanck, uint256 planckPerImpression, uint256 unstakeDelayBlocks);

    struct UnstakeRequest {
        uint256 amount;
        uint256 availableBlock;
    }

    /// @notice Lock DOT as publisher stake (payable — receives native DOT).
    function stake() external payable;

    /// @notice Initiate unstake. Funds locked for unstakeDelayBlocks.
    ///         Reverts if the remaining stake would drop below requiredStake().
    /// @param amount Planck to unstake.
    function requestUnstake(uint256 amount) external;

    /// @notice Claim pending unstake after delay has elapsed.
    function unstake() external;

    /// @notice Slash a publisher's stake. Callable by authorised slashContract only.
    /// @param publisher  Publisher to slash.
    /// @param amount     Planck to slash (capped at actual stake).
    /// @param recipient  Where slashed funds go.
    function slash(address publisher, uint256 amount, address recipient) external;

    /// @notice Record settled impressions for a publisher. Callable by Settlement only.
    ///         Advances the bonding curve — increasing required stake for future unstakes.
    function recordImpressions(address publisher, uint256 count) external;

    // ── Views ──────────────────────────────────────────────────────────────────

    /// @notice Current staked balance for a publisher.
    function staked(address publisher) external view returns (uint256);

    /// @notice Cumulative settled impressions for a publisher (drives bonding curve).
    function cumulativeImpressions(address publisher) external view returns (uint256);

    /// @notice Pending unstake request (amount=0 means none).
    function pendingUnstake(address publisher) external view returns (UnstakeRequest memory);

    /// @notice Minimum stake required given current cumulative impressions.
    function requiredStake(address publisher) external view returns (uint256);

    /// @notice True if staked[publisher] >= requiredStake(publisher).
    function isAdequatelyStaked(address publisher) external view returns (bool);

    // ── Parameters ─────────────────────────────────────────────────────────────

    function baseStakePlanck() external view returns (uint256);
    function planckPerImpression() external view returns (uint256);
    function unstakeDelayBlocks() external view returns (uint256);
}
