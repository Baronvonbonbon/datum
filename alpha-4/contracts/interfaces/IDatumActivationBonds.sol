// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumActivationBonds
/// @notice Optimistic-activation collateral for campaigns.
///
///         Advertisers post a bond at createCampaign. After a timelock window,
///         anyone may permissionlessly activate() the campaign — UNLESS a
///         challenger posts a counter-bond, which forces the campaign into the
///         GovernanceV2 vote path. Bonds are released or slashed on resolution.
///
///         Threat model: bond plus challenge-counter-bond replaces the always-on
///         governance vote for routine campaigns. Vote happens only when a
///         challenger commits collateral to dispute.
interface IDatumActivationBonds {
    // ── Phases ────────────────────────────────────────────────────────────────
    // 0 = none / not registered
    // 1 = open (timelock running; challenge accepted)
    // 2 = contested (challenger posted; awaiting governance resolution)
    // 3 = resolved (bonds finalised — refunds queued via pull pattern)
    enum Phase { None, Open, Contested, Resolved }

    // ── Events ────────────────────────────────────────────────────────────────
    event BondOpened(uint256 indexed campaignId, address indexed creator, uint256 bond, uint64 timelockExpiry);
    event Challenged(uint256 indexed campaignId, address indexed challenger, uint256 bond);
    event Activated(uint256 indexed campaignId, address indexed activator);
    event Resolved(uint256 indexed campaignId, bool creatorWon, uint256 winnerRefund, uint256 winnerBonus, uint256 treasuryCut);
    event PayoutClaimed(address indexed recipient, uint256 amount);

    /// @notice Active campaign was muted by a bond-backed call.
    event Muted(uint256 indexed campaignId, address indexed muter, uint256 bond);
    /// @notice Mute resolved. upheld=true if campaign was Terminated; false
    ///         if campaign remained Active (mute rejected) or auto-resolved
    ///         at muteMaxBlocks timeout.
    event MuteResolved(uint256 indexed campaignId, bool upheld, uint256 refundOrPenalty);

    // ── Write ─────────────────────────────────────────────────────────────────

    /// @notice Open a bond for a new campaign. Called by DatumCampaigns at createCampaign.
    /// @dev    Phase: None → Open. msg.value is the creator bond.
    function openBond(uint256 campaignId, address creator) external payable;

    /// @notice Post a counter-bond to dispute activation. Permissionless during timelock.
    /// @dev    Phase: Open → Contested. msg.value must be ≥ creator bond.
    function challenge(uint256 campaignId) external payable;

    /// @notice Permissionless activation after timelock with no challenge.
    /// @dev    Phase: Open → Resolved. Calls Campaigns.activateCampaign and
    ///         refunds creator bond.
    function activate(uint256 campaignId) external;

    /// @notice Settle bonds after governance resolution OR pending expiry.
    ///         Reads campaign status: Active → creator won; Terminated →
    ///         challenger won; Expired → both refunded (no-fault timeout).
    /// @dev    Phase: Contested → Resolved (or Open → Resolved on expiry).
    function settle(uint256 campaignId) external;

    /// @notice Pull-pattern claim for queued refunds/bonuses.
    function claim() external;
    function claimTo(address recipient) external;

    // ── Emergency mute (Phase 2b) ─────────────────────────────────────────────

    /// @notice Bond-backed instant pause on an Active campaign.
    ///         Sets isMuted(cid)=true; DatumClaimValidator rejects claims
    ///         while muted. Resolution comes via settleMute() after the
    ///         demote vote concludes OR after muteMaxBlocks auto-timeout.
    function mute(uint256 campaignId) external payable;

    /// @notice Resolve a mute by reading current campaign status. Active →
    ///         mute rejected, muter bond paid to advertiser; Terminated →
    ///         mute upheld, muter refunded with optional bonus; Expired →
    ///         no-fault, muter refunded. Auto-resolves as "rejected" after
    ///         muteMaxBlocks even if campaign is still Active.
    function settleMute(uint256 campaignId) external;

    /// @notice True while a campaign is bond-muted. Consulted by
    ///         DatumClaimValidator on the settlement path.
    function isMuted(uint256 campaignId) external view returns (bool);

    function muterOf(uint256 campaignId) external view returns (address);
    function muteBondOf(uint256 campaignId) external view returns (uint256);
    function mutedAtBlock(uint256 campaignId) external view returns (uint64);

    /// @notice Floor on mute bond — higher than challenge minBond because
    ///         muting an Active (paying) campaign is more disruptive.
    function muteMinBond() external view returns (uint256);
    /// @notice Max blocks a mute can stay open before auto-resolving as
    ///         "rejected" (anti-grief). Governable.
    function muteMaxBlocks() external view returns (uint64);

    // ── Views ─────────────────────────────────────────────────────────────────
    function phase(uint256 campaignId) external view returns (Phase);
    function isContested(uint256 campaignId) external view returns (bool);
    function isOpen(uint256 campaignId) external view returns (bool);
    function creatorOf(uint256 campaignId) external view returns (address);
    function challengerOf(uint256 campaignId) external view returns (address);
    function creatorBond(uint256 campaignId) external view returns (uint256);
    function challengerBond(uint256 campaignId) external view returns (uint256);
    function timelockExpiry(uint256 campaignId) external view returns (uint64);
    function pending(address account) external view returns (uint256);

    /// @notice Minimum bond required at openBond. Governable.
    function minBond() external view returns (uint256);
    /// @notice Timelock length in blocks. Governable.
    function timelockBlocks() external view returns (uint64);
    /// @notice Basis points of loser's bond taken as winner bonus. Remainder
    ///         (winnerBonus + treasuryBps removed) reverts to the loser, so the
    ///         losing party isn't wiped out wholesale. Governable.
    function winnerBonusBps() external view returns (uint16);
    /// @notice Basis points of loser's bond routed to treasury. Governable.
    function treasuryBps() external view returns (uint16);
}
