// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDatumPublisherReputation.sol";

/// @title DatumPublisherReputation
/// @notice BM-8: Tracks per-publisher settlement acceptance rates as a reputation score.
///         BM-9: Flags cross-campaign anomalies when a publisher's per-campaign rejection
///         rate is significantly higher than their global rate.
///
///         Architecture:
///         - FP-16: Settlement calls recordSettlement() directly after each batch.
///           No relay-bot reporter needed — reputation is fully on-chain and trustless.
///         - Score = accepted impressions / total impressions as bps (0–10000).
///           Computed on-read from raw counters; no decay or EMA needed at alpha scale.
///         - Anomaly (BM-9): campaign rejection rate > ANOMALY_FACTOR × global rate,
///           with MIN_SAMPLE guard to avoid false positives on tiny datasets.
///         - Optional integration: ClaimValidator or off-chain tooling can query
///           getScore() / isAnomaly() to weight decisions. No hard enforcement in alpha-3.
contract DatumPublisherReputation is IDatumPublisherReputation, Ownable2Step {
    /// @notice The Settlement contract — only caller allowed to record stats (FP-16).
    address public settlement;

    // -------------------------------------------------------------------------
    // Global per-publisher counters
    // -------------------------------------------------------------------------

    /// @dev publisher => total impressions settled across all campaigns
    mapping(address => uint256) public totalSettled;

    /// @dev publisher => total impressions rejected across all campaigns
    mapping(address => uint256) public totalRejected;

    // -------------------------------------------------------------------------
    // Per-campaign counters (BM-9 anomaly detection)
    // -------------------------------------------------------------------------

    /// @dev publisher => campaignId => impressions settled in that campaign
    mapping(address => mapping(uint256 => uint256)) public campaignSettled;

    /// @dev publisher => campaignId => impressions rejected in that campaign
    mapping(address => mapping(uint256 => uint256)) public campaignRejected;

    // -------------------------------------------------------------------------
    // Anomaly parameters
    // -------------------------------------------------------------------------

    /// @notice Minimum total claims (settled + rejected) in a campaign before anomaly
    ///         detection fires. Guards against false positives on tiny samples.
    uint256 public constant MIN_SAMPLE = 10;

    /// @notice Multiplier for anomaly threshold. Campaign rejection rate must exceed
    ///         ANOMALY_FACTOR × global rejection rate to be flagged.
    uint256 public constant ANOMALY_FACTOR = 2;

    // -------------------------------------------------------------------------
    // Constructor / admin
    // -------------------------------------------------------------------------

    constructor() Ownable(msg.sender) {}

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = addr;
    }

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }

    // -------------------------------------------------------------------------
    // Core
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumPublisherReputation
    function recordSettlement(
        address publisher,
        uint256 campaignId,
        uint256 settled,
        uint256 rejected
    ) external override {
        require(msg.sender == settlement, "E18");
        require(publisher != address(0), "E00");
        if (settled == 0 && rejected == 0) return;

        totalSettled[publisher] += settled;
        totalRejected[publisher] += rejected;
        campaignSettled[publisher][campaignId] += settled;
        campaignRejected[publisher][campaignId] += rejected;

        emit SettlementRecorded(publisher, campaignId, settled, rejected);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumPublisherReputation
    /// @dev AUDIT-028: Returns 10000 (perfect) for publishers with no recorded activity.
    ///      This avoids penalising newly registered publishers before they have settled any claims.
    ///      Callers that require proven history should also check totalSettled > 0.
    function getScore(address publisher) external view override returns (uint16 score) {
        uint256 s = totalSettled[publisher];
        uint256 r = totalRejected[publisher];
        uint256 total = s + r;
        if (total == 0) return 10000; // No data: assume perfect (see AUDIT-028 note above)
        return uint16((s * 10000) / total);
    }

    /// @inheritdoc IDatumPublisherReputation
    function isAnomaly(address publisher, uint256 campaignId) external view override returns (bool) {
        uint256 cs = campaignSettled[publisher][campaignId];
        uint256 cr = campaignRejected[publisher][campaignId];
        uint256 cTotal = cs + cr;

        // Require minimum sample in this campaign
        if (cTotal < MIN_SAMPLE) return false;

        uint256 gs = totalSettled[publisher];
        uint256 gr = totalRejected[publisher];
        uint256 gTotal = gs + gr;

        // If global rejection rate is zero, any campaign rejection is anomalous
        // (only if campaign has MIN_SAMPLE, already checked above)
        if (gr == 0) return cr > 0;

        // campaignRejectionRate > ANOMALY_FACTOR * globalRejectionRate
        // cr/cTotal > ANOMALY_FACTOR * (gr/gTotal)
        // cr * gTotal > ANOMALY_FACTOR * gr * cTotal
        return cr * gTotal > ANOMALY_FACTOR * gr * cTotal;
    }

    /// @inheritdoc IDatumPublisherReputation
    function getPublisherStats(address publisher)
        external
        view
        override
        returns (uint256 settled, uint256 rejected, uint16 score)
    {
        settled = totalSettled[publisher];
        rejected = totalRejected[publisher];
        uint256 total = settled + rejected;
        score = total == 0 ? 10000 : uint16((settled * 10000) / total);
    }

    /// @inheritdoc IDatumPublisherReputation
    function getCampaignStats(address publisher, uint256 campaignId)
        external
        view
        override
        returns (uint256 settled, uint256 rejected)
    {
        settled = campaignSettled[publisher][campaignId];
        rejected = campaignRejected[publisher][campaignId];
    }
}
