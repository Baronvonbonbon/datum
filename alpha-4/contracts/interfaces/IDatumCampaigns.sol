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

    /// @notice Core campaign state (budget fields live in DatumBudgetLedger,
    ///         creative storage in DatumCampaignCreative).
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
    /// @notice A3: AssuranceLevel changed for a campaign. Levels:
    ///   0 = Permissive (any registered publisher, any settle path)
    ///   1 = PublisherSigned (publisher cosig required on every batch)
    ///   2 = DualSigned (publisher + advertiser cosigs required)
    event CampaignAssuranceLevelSet(uint256 indexed campaignId, uint8 level);
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

    // Community reports moved to DatumReports (alpha-4 EIP-170 carve-out);
    // PageReported / AdReported are emitted from the carved-out contract.

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

    /// @notice Like createCampaign but also opens an activation bond on the
    ///         optimistic activation path. Locked in ActivationBonds at
    ///         creation; refunded after permissionless activate() if
    ///         uncontested, or slashed/refunded per governance resolution if
    ///         a challenger posted a counter-bond. activationBondAmount > 0
    ///         required (use createCampaign for the legacy vote path).
    function createCampaignWithActivation(
        address publisher,
        ActionPotConfig[] calldata pots,
        bytes32[] calldata requiredTags,
        bool requireZkProof,
        address rewardToken,
        uint256 rewardPerImpression,
        uint256 bondAmount,
        uint256 activationBondAmount
    ) external payable returns (uint256 campaignId);

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
    /// @notice M6: advertiser-side hot-key delegation reader. Zero means
    ///         strict-EOA path; non-zero is the advertiser's authorized relay
    ///         key. Settlement.settleSignedClaims uses this to verify cosigs
    ///         when an advertiser uses the delegated path.
    function getAdvertiserRelaySigner(address advertiser) external view returns (address);
    function getCampaignPublisher(uint256 campaignId) external view returns (address);
    function getCampaignTags(uint256 campaignId) external view returns (bytes32[] memory);
    function getCampaignRelaySigner(uint256 campaignId) external view returns (address);
    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory);
    function getCampaignRequiresZkProof(uint256 campaignId) external view returns (bool);
    /// @notice A3: effective AssuranceLevel (0/1/2).
    function getCampaignAssuranceLevel(uint256 campaignId) external view returns (uint8);
    /// @notice People Chain identity gate (0=disabled, 1=Reasonable, 2=KnownGood).
    function getCampaignMinIdentityLevel(uint256 campaignId) external view returns (uint8);

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

    // -------------------------------------------------------------------------
    // Non-reverting safe view variants (alpha-4 phase 8d hedge #4)
    //
    // The Safe variants return `(false, ZERO)` for unknown campaigns and
    // `(true, value)` otherwise. Settlement's hot path calls these instead
    // of the unsafe variants + try/catch so that "campaign deleted /
    // unknown" is a normal return rather than a revert -- a captured or
    // mis-wired Campaigns contract can no longer use a selective revert
    // as a grief vector against specific campaigns. A genuine revert from
    // these now indicates a contract-level bug (not user-data-driven) and
    // still triggers Settlement's fail-closed gradient.
    // -------------------------------------------------------------------------

    function getCampaignAdvertiserSafe(uint256 campaignId) external view returns (bool ok, address advertiser);
    function getCampaignAssuranceLevelSafe(uint256 campaignId) external view returns (bool ok, uint8 level);
    function getCampaignMinIdentityLevelSafe(uint256 campaignId) external view returns (bool ok, uint8 level);
    function getCampaignRequiresZkProofSafe(uint256 campaignId) external view returns (bool ok, bool requires);
    function getCampaignRewardTokenSafe(uint256 campaignId) external view returns (bool ok, address token);
    function getCampaignRewardPerImpressionSafe(uint256 campaignId) external view returns (bool ok, uint256 rate);
    function getCampaignUserCapSafe(uint256 campaignId) external view returns (bool ok, uint32 maxEvents, uint32 windowBlocks);
    function minimumCpmFloor() external view returns (uint256);
    function pendingTimeoutBlocks() external view returns (uint256);
    function settlementContract() external view returns (address);
    function governanceContract() external view returns (address);
    function lifecycleContract() external view returns (address);

    // Allowlist snapshot views (merged from CampaignValidator).
    // NOTE: these are the PUBLISHER's advertiser allowlist snapshot (publisher
    // controls which advertisers may run on their inventory). Distinct from
    // the CAMPAIGN's publisher allowlist (`campaignAllowedPublisher` below).
    function campaignAllowlistEnabled(uint256 campaignId) external view returns (bool);
    function campaignAllowlistSnapshot(uint256 campaignId, address advertiser) external view returns (bool);

    // Multi-publisher allowlist views moved to DatumCampaignAllowlist
    // (alpha-4 EIP-170 carve-out).

    // Targeting views moved to DatumTagSystem (alpha-4 EIP-170 carve-out).

    // Report views moved to DatumReports (alpha-4 EIP-170 carve-out).
}
