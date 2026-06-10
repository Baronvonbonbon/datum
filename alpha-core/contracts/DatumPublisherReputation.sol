// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./interfaces/IDatumPublisherReputation.sol";

/// @title  DatumPublisherReputation
/// @notice Publisher acceptance-rate tracker + anomaly detector. Carved out
///         of DatumSettlement so the module is independently upgradable
///         and Settlement fits under EIP-170 on mainnet.
///
/// @dev    Counters are written by Settlement via `recordSettlement`. The
///         external reporter-EOA entry point that existed in alpha-3 is
///         deliberately NOT restored (threat-model #4: a compromised
///         reporter EOA could poison every publisher's reputation). All
///         settlement paths flow through DatumSettlement._processBatch,
///         which is the sole authorized writer here.
///
///         Score: bps in [0, 10000] = settled / (settled + rejected). New
///         publishers with no data return 10000 (perfect) so they are not
///         blocked by the optional `minReputationScore` gate during
///         bootstrap.
///
///         BM-9 anomaly: per-campaign rejection rate > 2× global rejection
///         rate with a minimum sample of 10 claims.
contract DatumPublisherReputation is IDatumPublisherReputation, DatumUpgradable {
    function version() public pure virtual override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Settlement contract permitted to call `recordSettlement`.
    ///         Lock-once via `lockPlumbing` after wiring is verified.
    address public settlement;

    /// @notice Cypherpunk plumbing-lock. While false, owner can rewire the
    ///         settlement pointer (testnet / migration). Once true, frozen.
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────

    uint256 public constant REP_MIN_SAMPLE = 10;
    uint256 public constant REP_ANOMALY_FACTOR = 2;

    /// @notice Minimum acceptance score (bps) required to settle. 0 = gate
    ///         disabled. Per-claim publisher reputation gate.
    uint16 public minReputationScore;

    // ─────────────────────────────────────────────────────────────────────
    // Counters
    // ─────────────────────────────────────────────────────────────────────

    // Private storage; the public getters below chain to a frozen predecessor
    // (cumulative counters survive an upgrade without copying — see _migrate).
    mapping(address => uint256) private _repTotalSettled;
    mapping(address => uint256) private _repTotalRejected;
    mapping(address => mapping(uint256 => uint256)) private _repCampaignSettled;
    mapping(address => mapping(uint256 => uint256)) private _repCampaignRejected;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event SettlementRecorded(address indexed publisher, uint256 indexed campaignId, uint256 settled, uint256 rejected);
    event MinReputationScoreSet(uint16 score);
    event SettlementSet(address indexed settlement);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error OnlySettlement();
    error LockedAlready();

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setSettlement(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        settlement = addr;
        emit SettlementSet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (settlement == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────

    function setMinReputationScore(uint16 score) external onlyOwner whenNotFrozen {
        minReputationScore = score;
        emit MinReputationScoreSet(score);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement entry point
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDatumPublisherReputation
    function recordSettlement(
        address publisher,
        uint256 campaignId,
        uint256 settled,
        uint256 rejected
    ) external {
        if (msg.sender != settlement) revert OnlySettlement();
        if (publisher == address(0)) return;
        if (settled == 0 && rejected == 0) return;
        _repTotalSettled[publisher] += settled;
        _repTotalRejected[publisher] += rejected;
        _repCampaignSettled[publisher][campaignId] += settled;
        _repCampaignRejected[publisher][campaignId] += rejected;
        emit SettlementRecorded(publisher, campaignId, settled, rejected);
    }

    /// @inheritdoc IDatumPublisherReputation
    function canSettle(address publisher) external view returns (bool) {
        uint16 floor = minReputationScore;
        if (floor == 0) return true;
        return _score(publisher) >= floor;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Returns the publisher's global acceptance score in bps (0-10000).
    ///         Returns 10000 (perfect) if no data yet.
    function getReputationScore(address publisher) external view returns (uint16) {
        return _score(publisher);
    }

    /// @notice BM-9: true if per-campaign rejection rate exceeds 2× global
    ///         rate with a minimum sample of 10 claims.
    function isAnomaly(address publisher, uint256 campaignId) external view returns (bool) {
        uint256 cs = _campSettledOf(publisher, campaignId);
        uint256 cr = _campRejectedOf(publisher, campaignId);
        uint256 cTotal = cs + cr;
        if (cTotal < REP_MIN_SAMPLE) return false;

        uint256 gs = _settledOf(publisher);
        uint256 gr = _rejectedOf(publisher);

        if (gr == 0) return cr > 0;
        return cr * (gs + gr) > REP_ANOMALY_FACTOR * gr * cTotal;
    }

    function getPublisherStats(address publisher)
        external
        view
        returns (uint256 settled, uint256 rejected, uint16 score)
    {
        settled = _settledOf(publisher);
        rejected = _rejectedOf(publisher);
        uint256 total = settled + rejected;
        score = total == 0 ? 10000 : uint16((settled * 10000) / total);
    }

    function getCampaignRepStats(address publisher, uint256 campaignId)
        external
        view
        returns (uint256 settled, uint256 rejected)
    {
        settled = _campSettledOf(publisher, campaignId);
        rejected = _campRejectedOf(publisher, campaignId);
    }

    function _score(address publisher) internal view returns (uint16) {
        uint256 s = _settledOf(publisher);
        uint256 r = _rejectedOf(publisher);
        uint256 total = s + r;
        if (total == 0) return 10000;
        return uint16((s * 10000) / total);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Public counter getters (chain to a frozen predecessor) + migration
    // ─────────────────────────────────────────────────────────────────────

    function repTotalSettled(address p) external view returns (uint256) { return _settledOf(p); }
    function repTotalRejected(address p) external view returns (uint256) { return _rejectedOf(p); }
    function repCampaignSettled(address p, uint256 c) external view returns (uint256) { return _campSettledOf(p, c); }
    function repCampaignRejected(address p, uint256 c) external view returns (uint256) { return _campRejectedOf(p, c); }

    function _settledOf(address p) internal view returns (uint256 v) {
        v = _repTotalSettled[p];
        address pred = migrationSource;
        if (pred != address(0)) v += DatumPublisherReputation(pred).repTotalSettled(p);
    }
    function _rejectedOf(address p) internal view returns (uint256 v) {
        v = _repTotalRejected[p];
        address pred = migrationSource;
        if (pred != address(0)) v += DatumPublisherReputation(pred).repTotalRejected(p);
    }
    function _campSettledOf(address p, uint256 c) internal view returns (uint256 v) {
        v = _repCampaignSettled[p][c];
        address pred = migrationSource;
        if (pred != address(0)) v += DatumPublisherReputation(pred).repCampaignSettled(p, c);
    }
    function _campRejectedOf(address p, uint256 c) internal view returns (uint256 v) {
        v = _repCampaignRejected[p][c];
        address pred = migrationSource;
        if (pred != address(0)) v += DatumPublisherReputation(pred).repCampaignRejected(p, c);
    }

    /// @dev Cumulative counters are append-only, so the successor adds the frozen
    ///      predecessor's totals on read (via migrationSource) rather than copying
    ///      them. Only the scalar config is copied here.
    function _migrate(address oldContract) internal override {
        minReputationScore = DatumPublisherReputation(oldContract).minReputationScore();
    }
}
