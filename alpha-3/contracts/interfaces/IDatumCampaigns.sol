// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumCampaigns
/// @notice Interface for DATUM campaign state management (alpha-2 Core).
///         Budget fields extracted to IDatumBudgetLedger. Lifecycle transitions
///         extracted to IDatumCampaignLifecycle. This contract is the canonical
///         source of campaign struct data and status.
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
    // Structs (slimmed: budget fields moved to BudgetLedger)
    // -------------------------------------------------------------------------

    struct Campaign {
        address advertiser;
        address publisher;
        uint256 pendingExpiryBlock;
        uint256 terminationBlock;
        uint256 bidCpmPlanck;
        uint16 snapshotTakeRateBps;
        CampaignStatus status;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed advertiser,
        address indexed publisher,
        uint256 budgetPlanck,
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    );
    event CampaignMetadataSet(uint256 indexed campaignId, bytes32 metadataHash);
    event CampaignActivated(uint256 indexed campaignId);
    event CampaignPaused(uint256 indexed campaignId);
    event CampaignResumed(uint256 indexed campaignId);
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

    // -------------------------------------------------------------------------
    // Campaign lifecycle
    // -------------------------------------------------------------------------

    function createCampaign(
        address publisher,
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression
    ) external payable returns (uint256 campaignId);

    function setMetadata(uint256 campaignId, bytes32 metadataHash) external;

    function activateCampaign(uint256 campaignId) external;

    function togglePause(uint256 campaignId, bool pause) external;

    /// @notice Update campaign status. Gated to lifecycle contract.
    function setCampaignStatus(uint256 campaignId, CampaignStatus newStatus) external;

    /// @notice Record termination block. Gated to lifecycle contract.
    function setTerminationBlock(uint256 campaignId, uint256 blockNum) external;

    /// @notice Override pendingExpiryBlock. Gated to lifecycle contract.
    ///         Used by demotion: sets to type(uint256).max to block expiry-path conflicts.
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
    function getCampaignMetadata(uint256 campaignId) external view returns (bytes32);
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint16 snapshotTakeRateBps
    );
    function getPendingExpiryBlock(uint256 campaignId) external view returns (uint256);
    function nextCampaignId() external view returns (uint256);
    function getCampaignRewardToken(uint256 campaignId) external view returns (address);
    function getCampaignRewardPerImpression(uint256 campaignId) external view returns (uint256);
    function minimumCpmFloor() external view returns (uint256);
    function pendingTimeoutBlocks() external view returns (uint256);
    function settlementContract() external view returns (address);
    function governanceContract() external view returns (address);
    function lifecycleContract() external view returns (address);
}
