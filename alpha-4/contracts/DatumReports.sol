// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumReports.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @dev Minimal Settlement read interface for the reporter-eligibility gate.
///      Replaces the previously-inline `ISettlementReportGate` declaration.
interface ISettlementReportGate {
    function userCampaignSettled(address user, uint256 campaignId, uint8 actionType)
        external view returns (uint256);
}

/// @title  DatumReports
/// @notice Community reporting for ad creatives and publisher pages.
///         Carved back out of DatumCampaigns for mainnet EIP-170; was an
///         alpha-3 satellite that got merged in to fight PVM bytecode
///         pressure.
///
/// @dev    Each (user, campaign) pair can submit at most one page report
///         and one ad report. Eligibility is gated on having at least
///         `MIN_EVENTS_TO_REPORT` settled events for the campaign in
///         question -- a sock-puppet sybil can't accumulate that without
///         actually serving real impressions through the protocol.
contract DatumReports is IDatumReports, DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    IDatumCampaigns public campaigns;
    address public settlement; // optional; if zero the eligibility gate is skipped
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────

    uint256 public constant MIN_EVENTS_TO_REPORT = 1;

    // ─────────────────────────────────────────────────────────────────────
    // Counters
    // ─────────────────────────────────────────────────────────────────────

    mapping(uint256 => uint256) public pageReports;
    mapping(uint256 => uint256) public adReports;
    mapping(address => uint256) public publisherReports;
    mapping(address => uint256) public advertiserReports;
    mapping(uint256 => mapping(address => bool)) private _hasReportedPage;
    mapping(uint256 => mapping(address => bool)) private _hasReportedAd;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event PageReported(uint256 indexed campaignId, address indexed publisher, address indexed reporter, uint8 reason);
    event AdReported(uint256 indexed campaignId, address indexed advertiser, address indexed reporter, uint8 reason);
    event CampaignsSet(address indexed campaigns);
    event SettlementSet(address indexed settlement);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E01();      // unknown campaign
    error E62();      // reporter not eligible (insufficient settled events)
    error E68();      // bad reason / duplicate report
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

    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        // address(0) is allowed here -- skips the eligibility gate (used in
        // test fixtures and pre-wired devnets). Settlement is wired before
        // the network goes live in production.
        settlement = addr;
        emit SettlementSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (address(campaigns) == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Reporting
    // ─────────────────────────────────────────────────────────────────────

    function _requireReporterEligible(uint256 campaignId) internal view {
        address s = settlement;
        if (s == address(0)) return;
        uint256 total = ISettlementReportGate(s).userCampaignSettled(msg.sender, campaignId, 0)
                      + ISettlementReportGate(s).userCampaignSettled(msg.sender, campaignId, 1)
                      + ISettlementReportGate(s).userCampaignSettled(msg.sender, campaignId, 2);
        if (total < MIN_EVENTS_TO_REPORT) revert E62();
    }

    /// @notice Report a campaign's publisher page (content violation).
    function reportPage(uint256 campaignId, uint8 reason) external whenNotFrozen {
        if (!(reason >= 1 && reason <= 5)) revert E68();
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (_hasReportedPage[campaignId][msg.sender]) revert E68();
        _requireReporterEligible(campaignId);
        _hasReportedPage[campaignId][msg.sender] = true;
        pageReports[campaignId]++;
        address pub = campaigns.getCampaignPublisher(campaignId);
        if (pub != address(0)) publisherReports[pub]++;
        emit PageReported(campaignId, pub, msg.sender, reason);
    }

    /// @notice Report a campaign's ad creative (advertiser content violation).
    function reportAd(uint256 campaignId, uint8 reason) external whenNotFrozen {
        if (!(reason >= 1 && reason <= 5)) revert E68();
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (_hasReportedAd[campaignId][msg.sender]) revert E68();
        _requireReporterEligible(campaignId);
        _hasReportedAd[campaignId][msg.sender] = true;
        adReports[campaignId]++;
        advertiserReports[advertiser]++;
        emit AdReported(campaignId, advertiser, msg.sender, reason);
    }
}
