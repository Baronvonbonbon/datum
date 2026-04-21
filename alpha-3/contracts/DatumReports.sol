// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumReports.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @title DatumReports
/// @notice Alpha-3 satellite: community reporting for campaign pages and ads.
///         Any wallet can report a campaign's page (counts against publisher)
///         or ad (counts against advertiser).
///         AUDIT-023: Per-address dedup prevents a single wallet from inflating counts.
///         Sybil filtering and weighting still happen off-chain via event indexing.
///         No pause check — reports are a safety mechanism that should work
///         regardless of protocol state.
contract DatumReports is IDatumReports {
    IDatumCampaigns public immutable campaigns;

    mapping(uint256 => uint256) public pageReports;       // per-campaign
    mapping(uint256 => uint256) public adReports;         // per-campaign
    mapping(address => uint256) public publisherReports;  // cumulative per publisher
    mapping(address => uint256) public advertiserReports; // cumulative per advertiser

    // AUDIT-023: Per-address dedup — one report per address per campaign per type
    mapping(address => mapping(uint256 => bool)) private _hasReportedPage;
    mapping(address => mapping(uint256 => bool)) private _hasReportedAd;

    constructor(address _campaigns) {
        require(_campaigns != address(0), "E00");
        campaigns = IDatumCampaigns(_campaigns);
    }

    /// @notice Report a publisher's page for a campaign.
    /// @param campaignId The campaign whose page is being reported.
    /// @param reason 1=spam, 2=misleading, 3=inappropriate, 4=broken, 5=other
    function reportPage(uint256 campaignId, uint8 reason) external {
        require(reason >= 1 && reason <= 5, "E68");
        // Validate campaign exists via advertiser (publisher can be address(0) for open campaigns)
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");
        require(!_hasReportedPage[msg.sender][campaignId], "E68"); // AUDIT-023: dedup
        _hasReportedPage[msg.sender][campaignId] = true;
        address publisher = campaigns.getCampaignPublisher(campaignId);
        pageReports[campaignId]++;
        if (publisher != address(0)) {
            publisherReports[publisher]++;
        }
        emit PageReported(campaignId, publisher, msg.sender, reason);
    }

    /// @notice Report an advertiser's ad for a campaign.
    /// @param campaignId The campaign whose ad is being reported.
    /// @param reason 1=spam, 2=misleading, 3=inappropriate, 4=broken, 5=other
    function reportAd(uint256 campaignId, uint8 reason) external {
        require(reason >= 1 && reason <= 5, "E68");
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        require(advertiser != address(0), "E01");
        require(!_hasReportedAd[msg.sender][campaignId], "E68"); // AUDIT-023: dedup
        _hasReportedAd[msg.sender][campaignId] = true;
        adReports[campaignId]++;
        advertiserReports[advertiser]++;
        emit AdReported(campaignId, advertiser, msg.sender, reason);
    }
}
