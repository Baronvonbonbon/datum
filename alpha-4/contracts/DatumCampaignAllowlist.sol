// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumUpgradable.sol";
import "./interfaces/IDatumCampaignAllowlist.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumChallengeBonds.sol";

/// @title  DatumCampaignAllowlist
/// @notice Per-campaign publisher allowlist + take-rate snapshot. Carved
///         out of DatumCampaigns for mainnet EIP-170.
///
/// @dev    Two writer paths:
///           1. `initializeFor(campaignId, publisher, takeRate)` -- gated
///              to `onlyCampaigns`. Called from DatumCampaigns._createCampaign
///              when a single-publisher campaign seeds its allowlist with the
///              named publisher at creation time.
///           2. `addAllowedPublisher` / `addAllowedPublishers` /
///              `removeAllowedPublisher` -- advertiser-only, called directly
///              by the campaign advertiser to add or remove publishers
///              after creation (open-campaign multi-publisher mode).
///
///         ClaimValidator reads the per-claim views (`isAllowedPublisher`,
///         `getCampaignPublisherTakeRate`, `campaignAllowedPublisherCount`)
///         via its own pointer to this module.
contract DatumCampaignAllowlist is
    IDatumCampaignAllowlist,
    DatumUpgradable,
    ReentrancyGuard
{
    function version() public pure override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    IDatumCampaigns    public campaigns;
    IDatumPublishers   public publishers;
    IDatumChallengeBonds public challengeBonds; // optional; address(0) disables bond locking
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────

    uint16 public constant MAX_ALLOWED_PUBLISHERS_CEILING = 256;
    uint256 public constant MAX_ADD_PUBLISHERS_BATCH = 32;
    uint16 public maxAllowedPublishers = 64;

    // ─────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────

    mapping(uint256 => mapping(address => bool)) public allowed;
    mapping(uint256 => uint16) public override campaignAllowedPublisherCount;
    mapping(uint256 => mapping(address => uint16)) public takeRateSnapshot;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event PublisherAllowed(uint256 indexed campaignId, address indexed publisher, uint16 takeRateBps);
    event PublisherRemoved(uint256 indexed campaignId, address indexed publisher);
    event MaxAllowedPublishersSet(uint16 value);
    event CampaignsSet(address indexed campaigns);
    event PublishersSet(address indexed publishers);
    event ChallengeBondsSet(address indexed challengeBonds);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E01();
    error E11();
    error E21();
    error E22();
    error E62();
    error E71();
    error OnlyCampaigns();
    error LockedAlready();

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setCampaigns(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        campaigns = IDatumCampaigns(addr);
        emit CampaignsSet(addr);
    }

    function setPublishers(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        publishers = IDatumPublishers(addr);
        emit PublishersSet(addr);
    }

    function setChallengeBonds(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        challengeBonds = IDatumChallengeBonds(addr); // address(0) is valid (feature off)
        emit ChallengeBondsSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (address(campaigns) == address(0)) revert E00();
        if (address(publishers) == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    function setMaxAllowedPublishers(uint16 v) external onlyOwner whenNotFrozen {
        if (!(v > 0 && v <= MAX_ALLOWED_PUBLISHERS_CEILING)) revert E11();
        maxAllowedPublishers = v;
        emit MaxAllowedPublishersSet(v);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Campaigns-only writer (single-publisher seeding at create-time)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Seed the allowlist for a single-publisher campaign. Idempotent
    ///         per (campaignId, publisher) -- reverts on double-init to keep
    ///         counter invariants intact.
    function initializeFor(uint256 campaignId, address publisher, uint16 takeRateBps) external {
        if (msg.sender != address(campaigns)) revert OnlyCampaigns();
        if (publisher == address(0)) revert E00();
        if (allowed[campaignId][publisher]) revert E71();
        allowed[campaignId][publisher] = true;
        takeRateSnapshot[campaignId][publisher] = takeRateBps;
        campaignAllowedPublisherCount[campaignId] = 1;
        emit PublisherAllowed(campaignId, publisher, takeRateBps);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Advertiser-driven add / remove
    // ─────────────────────────────────────────────────────────────────────

    function addAllowedPublisher(uint256 campaignId, address publisher) external payable nonReentrant whenNotFrozen {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        IDatumCampaigns.CampaignStatus st = campaigns.getCampaignStatus(campaignId);
        if (!(st == IDatumCampaigns.CampaignStatus.Pending || st == IDatumCampaigns.CampaignStatus.Active)) revert E22();
        if (publisher == address(0)) revert E00();
        if (allowed[campaignId][publisher]) revert E71();
        if (campaignAllowedPublisherCount[campaignId] >= maxAllowedPublishers) revert E11();

        _validateAndSeat(campaignId, publisher, msg.sender);

        if (msg.value > 0) {
            if (address(challengeBonds) == address(0)) revert E00();
            challengeBonds.lockBond{value: msg.value}(campaignId, msg.sender, publisher);
        }
    }

    function addAllowedPublishers(
        uint256 campaignId,
        address[] calldata pubs,
        uint256[] calldata bondAmounts
    ) external payable nonReentrant whenNotFrozen {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        IDatumCampaigns.CampaignStatus st = campaigns.getCampaignStatus(campaignId);
        if (!(st == IDatumCampaigns.CampaignStatus.Pending || st == IDatumCampaigns.CampaignStatus.Active)) revert E22();
        if (pubs.length != bondAmounts.length) revert E11();
        if (!(pubs.length > 0 && pubs.length <= MAX_ADD_PUBLISHERS_BATCH)) revert E11();
        if (campaignAllowedPublisherCount[campaignId] + pubs.length > maxAllowedPublishers) revert E11();

        uint256 sumBonds;
        for (uint256 i = 0; i < bondAmounts.length; i++) sumBonds += bondAmounts[i];
        if (sumBonds != msg.value) revert E11();
        if (!(sumBonds == 0 || address(challengeBonds) != address(0))) revert E00();

        for (uint256 i = 0; i < pubs.length; i++) {
            address publisher = pubs[i];
            if (publisher == address(0)) revert E00();
            if (allowed[campaignId][publisher]) revert E71();
            _validateAndSeat(campaignId, publisher, msg.sender);
            if (bondAmounts[i] > 0) {
                challengeBonds.lockBond{value: bondAmounts[i]}(campaignId, msg.sender, publisher);
            }
        }
    }

    function removeAllowedPublisher(uint256 campaignId, address publisher) external whenNotFrozen {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        if (!allowed[campaignId][publisher]) revert E01();

        allowed[campaignId][publisher] = false;
        campaignAllowedPublisherCount[campaignId] -= 1;
        // Note: take-rate snapshot retained so any in-flight bond keeps stable ref data.
        emit PublisherRemoved(campaignId, publisher);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal validation
    // ─────────────────────────────────────────────────────────────────────

    function _validateAndSeat(uint256 campaignId, address publisher, address advertiser) internal {
        if (publishers.isBlocked(publisher)) revert E62();
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
        if (!pub.registered) revert E62();
        if (publishers.allowlistEnabled(publisher)) {
            if (!publishers.isAllowedAdvertiser(publisher, advertiser)) revert E62();
        }

        bytes32[] memory reqTags = campaigns.getCampaignTags(campaignId);
        if (reqTags.length > 0) {
            if (!campaigns.hasAllTags(publisher, reqTags)) revert E62();
        }

        uint16 rate = pub.takeRateBps;
        allowed[campaignId][publisher] = true;
        takeRateSnapshot[campaignId][publisher] = rate;
        campaignAllowedPublisherCount[campaignId] += 1;
        emit PublisherAllowed(campaignId, publisher, rate);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views (IDatumCampaignAllowlist)
    // ─────────────────────────────────────────────────────────────────────

    function isAllowedPublisher(uint256 campaignId, address publisher) external view returns (bool) {
        return allowed[campaignId][publisher];
    }

    function getCampaignPublisherTakeRate(uint256 campaignId, address publisher) external view returns (uint16) {
        return takeRateSnapshot[campaignId][publisher];
    }

    /// @notice 0 = OPEN, 1 = ALLOWLIST. Mirrors the historic DatumCampaigns surface.
    function campaignMode(uint256 campaignId) external view returns (uint8) {
        return campaignAllowedPublisherCount[campaignId] > 0 ? 1 : 0;
    }
}
