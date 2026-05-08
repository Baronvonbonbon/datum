// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaigns
/// @notice Interface for DATUM campaign state management (alpha-3 multi-pricing).
///         Campaigns hold one or more action pots (view/click/remote-action), each
///         with independent budget, daily cap, and rate. Budget is escrowed in
///         DatumBudgetLedger on a per-(campaignId, actionType) basis.
interface IDatumCampaigns {
    // -------------------------------------------------------------------------
    // Enums
    // -------------------------------------------------------------------------

    enum CampaignStatus {
        Pending,    // Created, awaiting governance activation
        Active,     // Activated by governance; accepting claims
        Paused,     // Temporarily halted by advertiser
        Completed,  // Budget exhausted or manually completed
        Terminated, // Governance nay vote passed; slashed + refunded
        Expired     // Pending timeout elapsed; budget returned
    }

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    /// @notice Configuration for a single action-type pot within a campaign.
    struct ActionPotConfig {
        uint8   actionType;      // 0=view (CPM), 1=click (CPC), 2=remote-action (CPA)
        uint256 budgetPlanck;    // DOT budget allocated to this pot
        uint256 dailyCapPlanck;  // daily spend cap for this pot
        uint256 ratePlanck;      // rate: per-1000 events for view, flat per-event for click/action
        address actionVerifier;  // type-2 only: EOA whose ECDSA sig is required; address(0) for type-0/1
    }

    /// @notice Core campaign state (budget fields live in DatumBudgetLedger).
    struct Campaign {
        address advertiser;
        address publisher;
        uint256 pendingExpiryBlock;
        uint256 terminationBlock;
        uint16  snapshotTakeRateBps;
        CampaignStatus status;
        // Consolidated scalar fields (formerly separate mappings)
        address relaySigner;        // publisher relay signer snapshot at creation
        bool    requiresZkProof;    // ZK proof required for view claims
        bytes32 metadata;           // mutable metadata hash
        address rewardToken;        // optional ERC-20 reward token
        uint256 rewardPerImpression; // token reward per settled view event
        uint256 viewBid;            // ratePlanck from the view (type-0) pot
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed advertiser,
        address indexed publisher,
        uint256 totalBudgetPlanck,
        uint16  snapshotTakeRateBps
    );
    event CampaignMetadataSet(uint256 indexed campaignId, bytes32 metadataHash);
    event CampaignActivated(uint256 indexed campaignId);
    event CampaignPaused(uint256 indexed campaignId);
    event CampaignResumed(uint256 indexed campaignId);
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);
    event MaxCampaignBudgetSet(uint256 amount);

    // Targeting registry events
    event TagsUpdated(address indexed publisher, bytes32[] tagHashes);
    event TagRegistryEnforced(bool enforced);
    event TagApproved(bytes32 indexed tag);
    event TagRemoved(bytes32 indexed tag);

    // Community report events
    event PageReported(uint256 indexed campaignId, address indexed publisher, address indexed reporter, uint8 reason);
    event AdReported(uint256 indexed campaignId, address indexed advertiser, address indexed reporter, uint8 reason);

    // -------------------------------------------------------------------------
    // Campaign lifecycle
    // -------------------------------------------------------------------------

    /// @notice Create a campaign with one or more action pots.
    /// @param publisher      Target publisher (address(0) = open campaign).
    /// @param pots           Action pot configs. At least one required; max 3. Budgets must sum to msg.value - bondAmount.
    /// @param requiredTags   Publisher tag requirements (max 8).
    /// @param requireZkProof Whether ZK proof is required for view claims.
    /// @param rewardToken    Optional ERC-20 token reward address (address(0) = disabled).
    /// @param rewardPerImpression Token reward per settled view event (0 if no token reward).
    /// @param bondAmount     Advertiser challenge bond (deducted from msg.value before budgeting).
    function createCampaign(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount
    ) external payable returns (uint256 campaignId);

    function setMetadata(uint256 campaignId, bytes32 metadataHash) external;

    function activateCampaign(uint256 campaignId) external;

    function togglePause(uint256 campaignId, bool pause) external;

    /// @notice Update campaign status. Gated to lifecycle contract.
    function setCampaignStatus(uint256 campaignId, CampaignStatus newStatus) external;

    /// @notice Record termination block. Gated to lifecycle contract.
    function setTerminationBlock(uint256 campaignId, uint256 blockNum) external;

    /// @notice Override pendingExpiryBlock. Gated to lifecycle contract.
    function setPendingExpiryBlock(uint256 campaignId, uint256 blockNum) external;

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getCampaignStatus(uint256 campaignId) external view returns (CampaignStatus);
    function getCampaignAdvertiser(uint256 campaignId) external view returns (address);
    function getCampaignPublisher(uint256 campaignId) external view returns (address);
    function getCampaignTags(uint256 campaignId) external view returns (bytes32[] memory);
    function getCampaignRelaySigner(uint256 campaignId) external view returns (address);
    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory);
    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool);
    /// @notice Per-campaign dual-sig settlement requirement.
    ///         Advertiser-controlled toggle; default false. When true, only the
    ///         DatumSettlement.settleSignedClaims path may settle this campaign's claims.
    function getCampaignRequiresDualSig(uint256 campaignId) external view returns (bool);
    function getCampaignMetadata(uint256 campaignId) external view returns (bytes32);

    /// @notice Returns campaign settlement data (3-tuple — no bidCpmPlanck, pots handle rates).
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint16 snapshotTakeRateBps
    );

    /// @notice Returns the ActionPotConfig for a specific action type. Reverts if pot not configured.
    function getCampaignPot(uint256 campaignId, uint8 actionType) external view returns (ActionPotConfig memory);

    /// @notice Returns all configured action pots for a campaign.
    function getCampaignPots(uint256 campaignId) external view returns (ActionPotConfig[] memory);

    /// @notice Returns ratePlanck from the view (type-0) pot. Used by the auction.
    ///         Returns 0 if no view pot is configured.
    function getCampaignViewBid(uint256 campaignId) external view returns (uint256);

    function getPendingExpiryBlock(uint256 campaignId) external view returns (uint256);
    function nextCampaignId() external view returns (uint256);
    function getCampaignRewardToken(uint256 campaignId) external view returns (address);
    function getCampaignRewardPerImpression(uint256 campaignId) external view returns (uint256);
    function minimumCpmFloor() external view returns (uint256);
    function pendingTimeoutBlocks() external view returns (uint256);
    function settlementContract() external view returns (address);
    function governanceContract() external view returns (address);
    function lifecycleContract() external view returns (address);

    // Allowlist snapshot views (merged from CampaignValidator)
    function campaignAllowlistEnabled(uint256 campaignId) external view returns (bool);
    function campaignAllowlistSnapshot(uint256 campaignId, address advertiser) external view returns (bool);

    // Targeting views (merged from TargetingRegistry)
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool);
    function getPublisherTags2(address publisher) external view returns (bytes32[] memory);

    // Report views (merged from Reports)
    function pageReports(uint256 campaignId) external view returns (uint256);
    function adReports(uint256 campaignId) external view returns (uint256);
    function publisherReports(address publisher) external view returns (uint256);
    function advertiserReports(address advertiser) external view returns (uint256);
}
