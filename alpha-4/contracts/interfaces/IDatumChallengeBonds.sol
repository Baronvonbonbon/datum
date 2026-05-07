// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumChallengeBonds
/// @notice FP-2: Optional advertiser challenge bonds.
///         Advertisers lock a bond at campaign creation; returned on normal end.
///         If publisher fraud is upheld, the slash proceeds partially fund a bonus
///         pool from which bonded advertisers can claim proportional compensation.
interface IDatumChallengeBonds {
    event BondLocked(uint256 indexed campaignId, address indexed advertiser, address indexed publisher, uint256 amount);
    event BondReturned(uint256 indexed campaignId, address indexed advertiser, uint256 amount);
    event BonusAdded(address indexed publisher, uint256 amount, uint256 poolTotal);
    event BonusClaimed(uint256 indexed campaignId, address indexed advertiser, uint256 amount);

    /// @notice Lock a bond for a campaign. Callable by Campaigns contract on creation.
    ///         Receives the bond as native DOT (msg.value).
    /// @param campaignId Campaign ID.
    /// @param advertiser Bond owner.
    /// @param publisher  Publisher the bond is associated with.
    function lockBond(uint256 campaignId, address advertiser, address publisher) external payable;

    /// @notice Return the bond to the advertiser. Callable by Lifecycle on complete/expire.
    /// @param campaignId Campaign ID.
    function returnBond(uint256 campaignId) external;

    /// @notice Add to the publisher's bonus pool (from slash proceeds).
    ///         Callable by PublisherGovernance on successful fraud resolution.
    ///         Receives funds as native DOT (msg.value).
    /// @param publisher Publisher whose bonus pool grows.
    function addToPool(address publisher) external payable;

    /// @notice Claim bonus for a campaign whose publisher was found fraudulent.
    ///         Advertiser receives bond * bonusPool[publisher] / totalBonds[publisher]
    ///         (capped to actual pool balance). Bond is burned (not returned).
    /// @param campaignId Campaign ID with a locked bond.
    function claimBonus(uint256 campaignId) external;

    // ── Views ──────────────────────────────────────────────────────────────────

    function bondOwner(uint256 campaignId) external view returns (address);
    function bond(uint256 campaignId) external view returns (uint256);
    function bondPublisher(uint256 campaignId) external view returns (address);

    /// @notice Total bonds locked against a publisher across all campaigns.
    function totalBonds(address publisher) external view returns (uint256);

    /// @notice Current bonus pool accrued for a publisher from slash proceeds.
    function bonusPool(address publisher) external view returns (uint256);

    /// @notice Whether the bonus has been claimed for a campaign.
    function bonusClaimed(uint256 campaignId) external view returns (bool);
}
