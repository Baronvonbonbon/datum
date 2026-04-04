// SPDX-License-Identifier: Apache-2.0
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
    IDatumPublishers public publishers;
    IDatumTargetingRegistry public targetingRegistry;

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

    function setTargetingRegistry(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        targetingRegistry = IDatumTargetingRegistry(addr);
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumCampaignValidator
    function validateCreation(
        address advertiser,
        address publisher,
        bytes32[] calldata requiredTags
    ) external view override returns (bool, uint16, address, bytes32[] memory) {
        // S12: reject blocked advertisers
        if (publishers.isBlocked(advertiser)) return (false, 0, address(0), new bytes32[](0));

        if (publisher != address(0)) {
            // Targeted campaign: check publisher blocklist, registration, allowlist
            if (publishers.isBlocked(publisher)) return (false, 0, address(0), new bytes32[](0));

            IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
            if (!pub.registered) return (false, 0, address(0), new bytes32[](0));

            // S12: per-publisher allowlist
            if (publishers.allowlistEnabled(publisher)) {
                if (!publishers.isAllowedAdvertiser(publisher, advertiser)) return (false, 0, address(0), new bytes32[](0));
            }

            // TX-1: tag matching — publisher must have ALL required tags
            if (requiredTags.length > 0 && address(targetingRegistry) != address(0)) {
                if (!targetingRegistry.hasAllTags(publisher, requiredTags)) return (false, 0, address(0), new bytes32[](0));
            }

            // Snapshot relay signer and publisher tag set at creation time
            address snapRelaySigner = publishers.relaySigner(publisher);
            bytes32[] memory snapTags = (address(targetingRegistry) != address(0))
                ? targetingRegistry.getTags(publisher)
                : new bytes32[](0);

            return (true, pub.takeRateBps, snapRelaySigner, snapTags);
        }

        // Open campaign: default take rate, no relay signer, no tags
        return (true, DEFAULT_TAKE_RATE_BPS, address(0), new bytes32[](0));
    }
}
