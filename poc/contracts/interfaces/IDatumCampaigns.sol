// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumCampaigns
/// @notice Interface for DATUM campaign lifecycle management.
///         Publisher management has been extracted to IDatumPublishers.
interface IDatumCampaigns {
    // -------------------------------------------------------------------------
    // Enums
    // -------------------------------------------------------------------------

    enum CampaignStatus {
        Pending,    // Created, awaiting governance activation
        Active,     // Activated by governance; accepting claims
        Paused,     // Temporarily halted by advertiser
        Completed,  // Budget exhausted or manually completed
        Terminated, // Governance nay vote passed; escrow slashed
        Expired     // Pending timeout elapsed; budget returned
    }

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct Campaign {
        uint256 id;
        address advertiser;
        address publisher;
        uint256 budgetPlanck;         // Total escrowed budget
        uint256 remainingBudget;      // Budget remaining for claims
        uint256 dailyCapPlanck;       // Max spend per day
        uint256 bidCpmPlanck;         // Max CPM bid in planck per 1000 impressions
        uint256 dailySpent;           // Amount spent today
        uint256 lastSpendDay;         // Timestamp / 86400 for today
        uint256 pendingExpiryBlock;   // Block after which Pending → Expired is allowed
        uint256 terminationBlock;     // Block at which nay vote terminated campaign (0 if not terminated)
        uint16 snapshotTakeRateBps;   // Publisher take rate locked at campaign creation
        CampaignStatus status;
        uint8 categoryId;             // 0 = uncategorized, 1-10 per taxonomy
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
        uint16 snapshotTakeRateBps,
        uint8 categoryId
    );
    event CampaignMetadataSet(uint256 indexed campaignId, bytes32 metadataHash);
    event CampaignActivated(uint256 indexed campaignId);
    event CampaignPaused(uint256 indexed campaignId);
    event CampaignResumed(uint256 indexed campaignId);
    event CampaignCompleted(uint256 indexed campaignId);
    event CampaignTerminated(uint256 indexed campaignId, uint256 terminationBlock);
    event CampaignExpired(uint256 indexed campaignId);
    event BudgetDeducted(uint256 indexed campaignId, uint256 amount, uint256 remaining);

    // -------------------------------------------------------------------------
    // Campaign lifecycle
    // -------------------------------------------------------------------------

    /// @notice Create a new campaign, escrowing the full budget
    /// @param publisher Address of the registered publisher
    /// @param dailyCapPlanck Maximum spend per day in planck
    /// @param bidCpmPlanck Maximum CPM bid in planck per 1000 impressions
    /// @param categoryId Taxonomy category (0=uncategorized, 1-10 per taxonomy)
    /// @return campaignId Newly created campaign ID
    function createCampaign(
        address publisher,
        uint256 dailyCapPlanck,
        uint256 bidCpmPlanck,
        uint8 categoryId
    ) external payable returns (uint256 campaignId);

    /// @notice Set or update IPFS metadata hash for a campaign (advertiser only)
    /// @param metadataHash keccak256 of the IPFS CID string (extension maps hash → CID off-chain)
    function setMetadata(uint256 campaignId, bytes32 metadataHash) external;

    /// @notice Activate a Pending campaign (governance only)
    /// @param campaignId Campaign to activate
    function activateCampaign(uint256 campaignId) external;

    /// @notice Toggle pause state: pause=true Active→Paused, pause=false Paused→Active
    /// @param campaignId Campaign to toggle
    /// @param pause true to pause, false to resume
    function togglePause(uint256 campaignId, bool pause) external;

    /// @notice Mark a campaign as Completed (settlement contract or advertiser)
    /// @param campaignId Campaign to complete
    function completeCampaign(uint256 campaignId) external;

    /// @notice Terminate a campaign via governance nay vote (governance only)
    /// @param campaignId Campaign to terminate
    function terminateCampaign(uint256 campaignId) external;

    /// @notice Expire a Pending campaign that exceeded its pending timeout
    /// @dev Callable by anyone; returns full budget to advertiser
    /// @param campaignId Campaign to expire
    function expirePendingCampaign(uint256 campaignId) external;

    // -------------------------------------------------------------------------
    // Budget management
    // -------------------------------------------------------------------------

    /// @notice Deduct an amount from campaign budget, enforcing daily cap
    /// @dev Called exclusively by the settlement contract
    /// @param campaignId Campaign to deduct from
    /// @param amount Amount to deduct in planck
    function deductBudget(uint256 campaignId, uint256 amount) external;

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getCampaign(uint256 campaignId) external view returns (Campaign memory);
    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status, address publisher, uint256 bidCpmPlanck,
        uint256 remainingBudget, uint16 snapshotTakeRateBps
    );
    function nextCampaignId() external view returns (uint256);
    function minimumCpmFloor() external view returns (uint256);
    function pendingTimeoutBlocks() external view returns (uint256);
    function settlementContract() external view returns (address);
    function governanceContract() external view returns (address);
}
