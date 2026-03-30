// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IDatumCampaignValidator.sol";
import "./interfaces/IDatumPublishers.sol";

/// @title DatumCampaignValidator
/// @notice Validates campaign creation: S12 blocklist, per-publisher allowlist,
///         publisher registration, and take rate snapshot.
///         Extracted from DatumCampaigns (SE-3) to free PVM headroom and
///         enable MG-1 (timelock-gated blocklist migration).
contract DatumCampaignValidator is IDatumCampaignValidator {
    uint16 private constant DEFAULT_TAKE_RATE_BPS = 5000;

    address public owner;
    IDatumPublishers public publishers;

    constructor(address _publishers) {
        require(_publishers != address(0), "E00");
        owner = msg.sender;
        publishers = IDatumPublishers(_publishers);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setPublishers(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        publishers = IDatumPublishers(addr);
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
        address publisher
    ) external view override returns (bool, uint16) {
        // S12: reject blocked advertisers
        if (publishers.isBlocked(advertiser)) return (false, 0);

        if (publisher != address(0)) {
            // Targeted campaign: check publisher blocklist, registration, allowlist
            if (publishers.isBlocked(publisher)) return (false, 0);

            IDatumPublishers.Publisher memory pub = publishers.getPublisher(publisher);
            if (!pub.registered) return (false, 0);

            // S12: per-publisher allowlist
            if (publishers.allowlistEnabled(publisher)) {
                if (!publishers.isAllowedAdvertiser(publisher, advertiser)) return (false, 0);
            }

            return (true, pub.takeRateBps);
        }

        // Open campaign: default take rate
        return (true, DEFAULT_TAKE_RATE_BPS);
    }
}
