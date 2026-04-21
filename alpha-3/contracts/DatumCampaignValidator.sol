// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaignValidator.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumTargetingRegistry.sol";

/// @title DatumCampaignValidator
/// @notice Validates campaign creation: S12 blocklist, per-publisher allowlist,
///         publisher registration, take rate snapshot, and TX-1 tag matching.
///         Extracted from DatumCampaigns (SE-3) to free PVM headroom and
///         enable MG-1 (timelock-gated blocklist migration).
contract DatumCampaignValidator is IDatumCampaignValidator {
    uint16 private constant DEFAULT_TAKE_RATE_BPS = 5000;

    address public owner;
    address public pendingOwner;
    IDatumPublishers public publishers;
    IDatumTargetingRegistry public targetingRegistry;

    // AUDIT-005: Reference to Campaigns (access control for storeAllowlistSnapshot)
    address public campaigns;

    // AUDIT-005: Allowlist snapshots — frozen at campaign creation time
    mapping(uint256 => bool) public campaignAllowlistEnabled;
    mapping(uint256 => mapping(address => bool)) public campaignAllowlistSnapshot;

    constructor(address _publishers, address _targetingRegistry) {
        require(_publishers != address(0), "E00");
        owner = msg.sender;
        publishers = IDatumPublishers(_publishers);
        // targetingRegistry can be address(0) initially — tag checks skipped
        if (_targetingRegistry != address(0)) {
            targetingRegistry = IDatumTargetingRegistry(_targetingRegistry);
        }
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setPublishers(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        publishers = IDatumPublishers(addr);
    }

    // AUDIT-025: Allow clearing the targeting registry; emit event for auditability
    function setTargetingRegistry(address addr) external {
        require(msg.sender == owner, "E18");
        targetingRegistry = IDatumTargetingRegistry(addr);
        if (addr == address(0)) {
            emit TargetingRegistryCleared();
        }
    }

    // AUDIT-005: Set Campaigns reference (used for storeAllowlistSnapshot access control)
    function setCampaigns(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    /// @inheritdoc IDatumCampaignValidator
    function storeAllowlistSnapshot(uint256 campaignId, address advertiser, bool isAllowed) external {
        require(msg.sender == campaigns, "E18");
        campaignAllowlistEnabled[campaignId] = true;
        campaignAllowlistSnapshot[campaignId][advertiser] = isAllowed;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaignValidator
    function validateCreation(
        address advertiser,
        address publisher,
        bytes32[] calldata requiredTags
    ) external view override returns (bool, uint16, address, bytes32[] memory, bool allowlistWasEnabled) {
        // S12: reject blocked advertisers
        if (publishers.isBlocked(advertiser)) return (false, 0, address(0), new bytes32[](0), false);

        // AUDIT-008: Fail-closed — if required tags are specified, registry must be set
        if (requiredTags.length > 0) {
            require(address(targetingRegistry) != address(0), "E77");
        }

        if (publisher != address(0)) {
            // Targeted campaign: check publisher blocklist, registration, allowlist
            if (publishers.isBlocked(publisher)) return (false, 0, address(0), new bytes32[](0), false);

            IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
            if (!pub.registered) return (false, 0, address(0), new bytes32[](0), false);

            // S12: per-publisher allowlist — snapshot whether it was enabled (AUDIT-005)
            bool allowlistOn = publishers.allowlistEnabled(publisher);
            if (allowlistOn) {
                if (!publishers.isAllowedAdvertiser(publisher, advertiser)) return (false, 0, address(0), new bytes32[](0), false);
            }

            // TX-1: tag matching — publisher must have ALL required tags
            if (requiredTags.length > 0) {
                if (!targetingRegistry.hasAllTags(publisher, requiredTags)) return (false, 0, address(0), new bytes32[](0), false);
            }

            // Snapshot relay signer and publisher tag set at creation time
            address snapRelaySigner = publishers.relaySigner(publisher);
            bytes32[] memory snapTags = (address(targetingRegistry) != address(0))
                ? targetingRegistry.getTags(publisher)
                : new bytes32[](0);

            return (true, pub.takeRateBps, snapRelaySigner, snapTags, allowlistOn);
        }

        // Open campaign: default take rate, no relay signer, no tags, no allowlist
        return (true, DEFAULT_TAKE_RATE_BPS, address(0), new bytes32[](0), false);
    }
}
