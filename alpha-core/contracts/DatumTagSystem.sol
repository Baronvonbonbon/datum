// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumTagSystem.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumTagRegistry.sol";
import "./interfaces/IDatumTagCurator.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title  DatumTagSystem
/// @notice Unified tag plumbing carved out of DatumCampaigns for mainnet
///         EIP-170. Owns:
///           - Governance tag dictionary (approved tag list, curator hook,
///             stake-gated registry pointer, lane mode + lane lock).
///           - Per-publisher tag sets + post-removal grace window.
///           - Per-campaign required tags + publisher-tags snapshot.
///           - Per-campaign tag mode (Any / StakeGated / Curated).
///
/// @dev    Two writer surfaces:
///           - `initializeCampaignTags` gated to `onlyCampaigns`. Called
///             from DatumCampaigns._createCampaign with the campaign's
///             required tags + the campaign's chosen publisher (so the
///             snapshot of the publisher's current tag set can be taken).
///           - `setPublisherTags` is publisher-facing.
///
///         Consumers:
///           - DatumCampaignAllowlist reads `hasAllTags` during
///             `_validateAndSeat` to check tag match per allowlist-add.
///           - DatumClaimValidator reads `hasAllRequiredTags` per claim
///             in ALLOWLIST/OPEN gate logic.
contract DatumTagSystem is IDatumTagSystem, DatumUpgradable {
    function version() public pure virtual override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    address public campaigns;
    IDatumPublishers public publishers;
    IDatumPauseRegistry public pauseRegistry;
    IDatumTagRegistry public tagRegistry;       // stake-gated tag governance
    address public tagCurator;                  // external curator OR over approvedTags
    bool public plumbingLocked;
    bool public tagCuratorLocked;
    bool public lanesLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────

    uint16 public constant MAX_PUBLISHER_TAGS_CEILING = 256;
    uint16 public constant MAX_CAMPAIGN_TAGS_CEILING  = 64;
    uint256 public constant TAG_REMOVAL_GRACE_BLOCKS  = 14400; // ~24h @ 6s

    // ─────────────────────────────────────────────────────────────────────
    // Tunable caps
    // ─────────────────────────────────────────────────────────────────────

    uint16 public maxPublisherTags = 64;
    uint16 public maxCampaignTags  = 16;

    // ─────────────────────────────────────────────────────────────────────
    // Governance kill-switch for the local tag dictionary
    // ─────────────────────────────────────────────────────────────────────

    bool public enforceTagRegistry; // false = local mapping permissive in Curated mode

    // ─────────────────────────────────────────────────────────────────────
    // Tag dictionary
    // ─────────────────────────────────────────────────────────────────────

    mapping(bytes32 => bool) public override approvedTags;
    mapping(bytes32 => uint256) private _approvedTagIndex; // 1-based
    bytes32[] private _approvedTagList;

    // ─────────────────────────────────────────────────────────────────────
    // Per-publisher
    // ─────────────────────────────────────────────────────────────────────

    mapping(address => bytes32[]) private _publisherTags;
    mapping(address => mapping(bytes32 => bool)) private _publisherTagSet;
    /// @notice Drop a tag from a publisher and the tag is still considered
    ///         held until this block (post-removal grace) so in-flight
    ///         claims aren't suddenly invalidated.
    mapping(address => mapping(bytes32 => uint256)) public tagRemovalEffectiveBlock;

    // ─────────────────────────────────────────────────────────────────────
    // Per-campaign
    // ─────────────────────────────────────────────────────────────────────

    mapping(uint256 => bytes32[]) private _campaignTags;
    mapping(uint256 => bytes32[]) private _campaignPublisherTags;
    mapping(uint256 => uint8) public override campaignTagMode;

    // ── Enumeration for upgrade migration (tags are not iterable mappings) ──
    address[] private _tagPublishers;
    mapping(address => bool) private _tagPublisherTracked;
    uint256[] private _tagCampaigns;
    mapping(uint256 => bool) private _tagCampaignTracked;

    function _trackTagPublisher(address p) internal {
        if (!_tagPublisherTracked[p]) { _tagPublisherTracked[p] = true; _tagPublishers.push(p); }
    }
    function _trackTagCampaign(uint256 c) internal {
        if (!_tagCampaignTracked[c]) { _tagCampaignTracked[c] = true; _tagCampaigns.push(c); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event TagsUpdated(address indexed publisher, bytes32[] tagHashes);
    event TagRemovalScheduled(address indexed publisher, bytes32 indexed tag, uint256 effectiveBlock);
    event TagApproved(bytes32 indexed tag);
    event TagRemoved(bytes32 indexed tag);
    event TagRegistryEnforced(bool enforced);
    event TagRegistrySet(address indexed registry);
    event TagCuratorSet(address indexed curator);
    event TagCuratorLocked();
    event LanesLocked();
    event MaxPublisherTagsSet(uint16 value);
    event MaxCampaignTagsSet(uint16 value);
    event CampaignTagModeSet(uint256 indexed campaignId, uint8 mode);
    event CampaignsSet(address indexed campaigns);
    event PublishersSet(address indexed publishers);
    event PauseRegistrySet(address indexed registry);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E01();
    error E11();
    error E15();
    error E21();
    error E62();
    error E64();
    error E65();
    error E66();
    error E81();
    error E82();
    error E83();
    error E84();
    error Paused();
    error NotRegistered();
    error LaneLocked();
    error CuratorLocked();
    error AlreadySet();
    error RegistryUnset();
    error OnlyCampaigns();
    error LockedAlready();

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setCampaigns(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        campaigns = addr;
        emit CampaignsSet(addr);
    }

    function setPublishers(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        publishers = IDatumPublishers(addr);
        emit PublishersSet(addr);
    }

    function setPauseRegistry(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        pauseRegistry = IDatumPauseRegistry(addr);
        emit PauseRegistrySet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (campaigns == address(0)) revert E00();
        if (address(publishers) == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tag-registry / curator wiring
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Wire the stake-gated tag registry. Must be set before
    ///         `lockLanes()` -- the lock pins this pointer permanently.
    function setTagRegistry(address registry) external onlyOwner {
        if (lanesLocked) revert LaneLocked();
        tagRegistry = IDatumTagRegistry(registry);
        emit TagRegistrySet(registry);
    }

    /// @notice Wire the external tag curator (orred with the local
    ///         approvedTags mapping in `_isTagApproved`).
    function setTagCurator(address curator) external onlyOwner {
        if (tagCuratorLocked) revert CuratorLocked();
        tagCurator = curator;
        emit TagCuratorSet(curator);
    }

    function lockTagCurator() external onlyOwner whenOpenGovPhase {
        if (tagCuratorLocked) revert AlreadySet();
        tagCuratorLocked = true;
        emit TagCuratorLocked();
    }

    function lockLanes() external onlyOwner whenOpenGovPhase {
        if (lanesLocked) revert AlreadySet();
        if (address(tagRegistry) == address(0)) revert RegistryUnset();
        lanesLocked = true;
        emit LanesLocked();
    }

    function setEnforceTagRegistry(bool enforced) external onlyOwner {
        enforceTagRegistry = enforced;
        emit TagRegistryEnforced(enforced);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Caps
    // ─────────────────────────────────────────────────────────────────────

    function setMaxPublisherTags(uint16 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_PUBLISHER_TAGS_CEILING)) revert E11();
        maxPublisherTags = v;
        emit MaxPublisherTagsSet(v);
    }

    function setMaxCampaignTags(uint16 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_CAMPAIGN_TAGS_CEILING)) revert E11();
        maxCampaignTags = v;
        emit MaxCampaignTagsSet(v);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tag dictionary admin
    // ─────────────────────────────────────────────────────────────────────

    function approveTag(bytes32 tag) external onlyOwner {
        if (lanesLocked) revert LaneLocked();
        if (tag == bytes32(0)) revert E00();
        if (approvedTags[tag]) revert E15();
        approvedTags[tag] = true;
        _approvedTagList.push(tag);
        _approvedTagIndex[tag] = _approvedTagList.length;
        emit TagApproved(tag);
    }

    function removeApprovedTag(bytes32 tag) external onlyOwner {
        if (lanesLocked) revert LaneLocked();
        if (!approvedTags[tag]) revert E01();
        approvedTags[tag] = false;
        uint256 idx = _approvedTagIndex[tag] - 1;
        uint256 lastIdx = _approvedTagList.length - 1;
        if (idx != lastIdx) {
            bytes32 lastTag = _approvedTagList[lastIdx];
            _approvedTagList[idx] = lastTag;
            _approvedTagIndex[lastTag] = idx + 1;
        }
        _approvedTagList.pop();
        delete _approvedTagIndex[tag];
        emit TagRemoved(tag);
    }

    function approveTags(bytes32[] calldata tags) external onlyOwner {
        if (lanesLocked) revert LaneLocked();
        for (uint256 i = 0; i < tags.length; i++) {
            if (tags[i] == bytes32(0)) revert E00();
            if (!approvedTags[tags[i]]) {
                approvedTags[tags[i]] = true;
                _approvedTagList.push(tags[i]);
                _approvedTagIndex[tags[i]] = _approvedTagList.length;
                emit TagApproved(tags[i]);
            }
        }
    }

    function _isTagApproved(bytes32 tag) internal view returns (bool) {
        if (approvedTags[tag]) return true;
        if (tagCurator != address(0)) {
            try IDatumTagCurator(tagCurator).isTagApproved(tag) returns (bool ok) {
                return ok;
            } catch {
                return false;
            }
        }
        return false;
    }

    function listApprovedTags() external view returns (bytes32[] memory) {
        return _approvedTagList;
    }

    /// @notice Lane-aware tag validation.
    function _requireTagAllowedForLane(bytes32 tag, uint8 mode) internal view {
        if (mode == 0) return;
        if (mode == 1) {
            if (address(tagRegistry) == address(0)) revert RegistryUnset();
            if (!tagRegistry.isTagBonded(tag)) revert E82();
            return;
        }
        if (mode != 2) revert E83();
        if (enforceTagRegistry && !_isTagApproved(tag)) revert E81();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Per-publisher
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Publisher sets their supported tags. Replaces previous set.
    function setPublisherTags(bytes32[] calldata tagHashes) external whenNotFrozen {
        if (address(pauseRegistry) != address(0) && pauseRegistry.pausedCampaignCreation()) revert Paused();
        IDatumPublishers.Publisher memory pub = publishers.getPublisher(msg.sender);
        if (!pub.registered) revert NotRegistered();
        if (tagHashes.length > maxPublisherTags) revert E65();

        bytes32[] storage oldTags = _publisherTags[msg.sender];
        for (uint256 i = 0; i < oldTags.length; i++) {
            bytes32 ot = oldTags[i];
            bool kept = false;
            for (uint256 j = 0; j < tagHashes.length; j++) {
                if (tagHashes[j] == ot) { kept = true; break; }
            }
            _publisherTagSet[msg.sender][ot] = false;
            if (kept) {
                tagRemovalEffectiveBlock[msg.sender][ot] = 0;
            } else {
                uint256 eff = block.number + TAG_REMOVAL_GRACE_BLOCKS;
                tagRemovalEffectiveBlock[msg.sender][ot] = eff;
                emit TagRemovalScheduled(msg.sender, ot, eff);
            }
        }

        delete _publisherTags[msg.sender];
        uint8 mode = publishers.publisherTagMode(msg.sender);
        for (uint256 i = 0; i < tagHashes.length; i++) {
            if (tagHashes[i] == bytes32(0)) revert E00();
            _requireTagAllowedForLane(tagHashes[i], mode);
            _publisherTags[msg.sender].push(tagHashes[i]);
            _publisherTagSet[msg.sender][tagHashes[i]] = true;
            tagRemovalEffectiveBlock[msg.sender][tagHashes[i]] = 0;
            _trackTagPublisher(msg.sender);

            // Best-effort: refresh usage in the stake-gated registry.
            if (mode == 1 && address(tagRegistry) != address(0)) {
                try tagRegistry.recordUsage(tagHashes[i]) {} catch {}
            }
        }

        emit TagsUpdated(msg.sender, tagHashes);
    }

    function getPublisherTags(address publisher) external view returns (bytes32[] memory) {
        return _publisherTags[publisher];
    }

    /// @notice Backwards-compat alias matching the historic DatumCampaigns surface.
    function getPublisherTags2(address publisher) external view returns (bytes32[] memory) {
        return _publisherTags[publisher];
    }

    function publisherHasTag(address publisher, bytes32 tag) external view returns (bool) {
        return _publisherTagSet[publisher][tag];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Per-campaign — write side (Campaigns-only)
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumTagSystem
    function initializeCampaignTags(
        uint256 campaignId,
        address publisher,
        bytes32[] calldata requiredTags
    ) external {
        if (msg.sender != campaigns) revert OnlyCampaigns();
        if (requiredTags.length > maxCampaignTags) revert E66();

        // Validate publisher tag match (skipped for open campaigns where
        // publisher == address(0); their per-publisher tag-match runs at
        // allowlist-add time via hasAllTags).
        if (publisher != address(0) && requiredTags.length > 0) {
            for (uint256 i = 0; i < requiredTags.length; i++) {
                if (!_publisherTagSet[publisher][requiredTags[i]]) revert E62();
            }
        }

        // Store required tags + snapshot of publisher's tags at create time.
        for (uint256 i = 0; i < requiredTags.length; i++) {
            _campaignTags[campaignId].push(requiredTags[i]);
            _trackTagCampaign(campaignId);
        }
        if (publisher != address(0)) {
            bytes32[] storage pubTags = _publisherTags[publisher];
            for (uint256 i = 0; i < pubTags.length; i++) {
                _campaignPublisherTags[campaignId].push(pubTags[i]);
            }
        }
    }

    /// @notice Advertiser tightens the lane for their campaign before
    ///         activation (Any -> StakeGated or Curated). All existing
    ///         requiredTags must satisfy the new lane.
    function setCampaignTagMode(uint256 campaignId, uint8 mode) external whenNotFrozen {
        // Advertiser auth + status gate via Campaigns view. (Campaigns
        // exposes the lookup but does not hold the tag mode itself.)
        // We accept any caller that matches `campaign.advertiser`; status
        // gate is performed via the bytes here -- the IDatumCampaigns
        // interface returns it as `CampaignStatus`.
        ICampaignsView c = ICampaignsView(campaigns);
        address adv = c.getCampaignAdvertiser(campaignId);
        if (adv == address(0)) revert E01();
        if (msg.sender != adv) revert E21();
        if (uint8(c.getCampaignStatus(campaignId)) != 0) revert E64(); // Pending only
        if (mode > 2) revert E11();

        uint8 current = campaignTagMode[campaignId];
        if (!(current == 0 || current == mode)) revert E84();

        bytes32[] storage reqTags = _campaignTags[campaignId];
        for (uint256 i = 0; i < reqTags.length; i++) {
            _requireTagAllowedForLane(reqTags[i], mode);
        }

        campaignTagMode[campaignId] = mode;
        _trackTagCampaign(campaignId);
        emit CampaignTagModeSet(campaignId, mode);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Per-campaign — read side
    // ─────────────────────────────────────────────────────────────────────

    function getCampaignTags(uint256 campaignId) external view returns (bytes32[] memory) {
        return _campaignTags[campaignId];
    }

    function getCampaignPublisherTags(uint256 campaignId) external view returns (bytes32[] memory) {
        return _campaignPublisherTags[campaignId];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Hot path: tag membership
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumTagSystem
    function hasAllTags(address publisher, bytes32[] calldata requiredTags) external view returns (bool) {
        if (requiredTags.length == 0) return true;
        if (requiredTags.length > maxCampaignTags) revert E66();
        for (uint256 i = 0; i < requiredTags.length; i++) {
            if (_publisherTagSet[publisher][requiredTags[i]]) continue;
            uint256 eff = tagRemovalEffectiveBlock[publisher][requiredTags[i]];
            if (eff != 0 && block.number < eff) continue;
            return false;
        }
        return true;
    }

    /// @inheritdoc IDatumTagSystem
    function hasAllRequiredTags(address publisher, uint256 campaignId) external view returns (bool) {
        bytes32[] storage reqTags = _campaignTags[campaignId];
        if (reqTags.length == 0) return true;
        for (uint256 i = 0; i < reqTags.length; i++) {
            if (_publisherTagSet[publisher][reqTags[i]]) continue;
            uint256 eff = tagRemovalEffectiveBlock[publisher][reqTags[i]];
            if (eff != 0 && block.number < eff) continue;
            return false;
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Upgrade migration (tag dictionary + per-publisher + per-campaign tags)
    // ─────────────────────────────────────────────────────────────────────

    function tagPublisherCount() external view returns (uint256) { return _tagPublishers.length; }
    function tagPublisherAt(uint256 i) external view returns (address) { return _tagPublishers[i]; }
    function tagCampaignCount() external view returns (uint256) { return _tagCampaigns.length; }
    function tagCampaignAt(uint256 i) external view returns (uint256) { return _tagCampaigns[i]; }

    /// @dev Copy config + the approved-tag dictionary + every publisher's tag set
    ///      + every campaign's required/publisher tag snapshot + mode from a
    ///      frozen predecessor. Structural refs are re-wired. (Removed-but-grace
    ///      tags no longer in a publisher's active set are not carried — the
    ///      grace window is short-lived.)
    function _migrate(address oldContract) internal override {
        DatumTagSystem old = DatumTagSystem(oldContract);
        enforceTagRegistry = old.enforceTagRegistry();
        maxPublisherTags = old.maxPublisherTags();
        maxCampaignTags = old.maxCampaignTags();
        bytes32[] memory tags = old.listApprovedTags();
        for (uint256 i = 0; i < tags.length; i++) {
            if (!approvedTags[tags[i]]) {
                approvedTags[tags[i]] = true;
                _approvedTagList.push(tags[i]);
                _approvedTagIndex[tags[i]] = _approvedTagList.length;
            }
        }
        uint256 np = old.tagPublisherCount();
        for (uint256 i = 0; i < np; i++) {
            address p = old.tagPublisherAt(i);
            bytes32[] memory pt = old.getPublisherTags(p);
            for (uint256 j = 0; j < pt.length; j++) {
                _publisherTags[p].push(pt[j]);
                _publisherTagSet[p][pt[j]] = true;
                tagRemovalEffectiveBlock[p][pt[j]] = old.tagRemovalEffectiveBlock(p, pt[j]);
            }
            _trackTagPublisher(p);
        }
        uint256 nc = old.tagCampaignCount();
        for (uint256 i = 0; i < nc; i++) {
            uint256 cid = old.tagCampaignAt(i);
            bytes32[] memory ct = old.getCampaignTags(cid);
            for (uint256 j = 0; j < ct.length; j++) _campaignTags[cid].push(ct[j]);
            bytes32[] memory cpt = old.getCampaignPublisherTags(cid);
            for (uint256 j = 0; j < cpt.length; j++) _campaignPublisherTags[cid].push(cpt[j]);
            campaignTagMode[cid] = old.campaignTagMode(cid);
            _trackTagCampaign(cid);
        }
    }
}

/// @dev Inline read interface to avoid pulling the full IDatumCampaigns
///      enum dependency. Mirrors the two getters this module needs.
interface ICampaignsView {
    function getCampaignAdvertiser(uint256 campaignId) external view returns (address);
    function getCampaignStatus(uint256 campaignId) external view returns (uint8);
}
