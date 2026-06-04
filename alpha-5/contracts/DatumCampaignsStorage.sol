// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumPlumbingLockable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumChallengeBonds.sol";
import "./interfaces/IDatumAdvertiserStake.sol";
import "./interfaces/IDatumCampaignAllowlist.sol";
import "./interfaces/IDatumTagSystem.sol";

/// @title  DatumCampaignsStorage
/// @notice Single source of truth for DatumCampaigns' storage layout, shared by
///         DatumCampaigns (the contract) and DatumCampaignsMigrationLogic (the
///         DELEGATECALL target that holds the heavy upgrade-import code). Both
///         inherit this base, so their storage slots match exactly — the same
///         pattern as DatumSettlementStorage ↔ DatumSettlementLogicA/B. Keeping
///         the migration import in a delegatecall'd logic contract keeps it off
///         DatumCampaigns' (EIP-170-bound) bytecode without adding any
///         cross-contract staticcall to the per-claim hot path.
///
/// @dev    Only STORAGE lives here. `pauseRegistry` (immutable, no slot),
///         constants, errors, events, and all functions stay on DatumCampaigns.
///         Children must NOT reorder these fields.
abstract contract DatumCampaignsStorage is IDatumCampaigns, DatumPlumbingLockable, PaseoSafeSender {
    uint16 public defaultTakeRateBps = 5000;
    uint256 public maxCampaignBudget;
    uint256 public minimumCpmFloor;
    uint256 public pendingTimeoutBlocks;
    bool public minimumCpmFloorLocked;
    bool public pendingTimeoutBlocksLocked;
    address public parameterGovernance;
    address public settlementContract;
    address public governanceContract;
    address public lifecycleContract;
    IDatumPublishers public publishers;
    IDatumBudgetLedger public budgetLedger;
    address public pendingSettlementContract;
    address public pendingGovernanceContract;
    address public pendingLifecycleContract;
    address public pendingBudgetLedger;
    bool public bootstrapped;
    uint256 public nextCampaignId;
    mapping(uint256 => Campaign) internal _campaigns;
    mapping(uint256 => ActionPotConfig[]) internal _campaignPots;
    IDatumChallengeBonds public challengeBonds;
    address public activationBonds;
    IDatumTagSystem public tagSystem;
    mapping(address => address) public advertiserRelaySigner;
    IDatumAdvertiserStake public advertiserStake;
    mapping(uint256 => bool) public campaignAllowlistEnabled;
    mapping(uint256 => mapping(address => bool)) public campaignAllowlistSnapshot;
    IDatumCampaignAllowlist public allowlist;
    mapping(uint256 => uint8) public campaignAssuranceLevel;
    mapping(uint256 => uint256) public campaignMinStake;
    uint256 public maxAllowedMinStake;
    mapping(uint256 => bytes32) public campaignRequiredCategory;
    mapping(uint256 => uint32) public userEventCapPerWindow;
    mapping(uint256 => uint32) public userCapWindowBlocks;
    mapping(uint256 => uint32) public minUserSettledHistory;
    mapping(uint256 => uint8) public campaignMinIdentityLevel;

    /// @notice DELEGATECALL target holding the heavy upgrade-import code
    ///         (DatumCampaignsMigrationLogic). Lock-once via setMigrationLogic.
    ///         MUST be the last storage slot — the logic contract mirrors this
    ///         exact layout (see DatumCampaignsMigrationLogic + the layout test).
    address public migrationLogic;
}
