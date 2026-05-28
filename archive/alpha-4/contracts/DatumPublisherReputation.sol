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
    function version() public pure override returns (uint256) { return 1; }

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

    mapping(address => uint256) public repTotalSettled;
    mapping(address => uint256) public repTotalRejected;
    mapping(address => mapping(uint256 => uint256)) public repCampaignSettled;
    mapping(address => mapping(uint256 => uint256)) public repCampaignRejected;

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
        repTotalSettled[publisher] += settled;
        repTotalRejected[publisher] += rejected;
        repCampaignSettled[publisher][campaignId] += settled;
        repCampaignRejected[publisher][campaignId] += rejected;
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
        uint256 cs = repCampaignSettled[publisher][campaignId];
        uint256 cr = repCampaignRejected[publisher][campaignId];
        uint256 cTotal = cs + cr;
        if (cTotal < REP_MIN_SAMPLE) return false;

        uint256 gs = repTotalSettled[publisher];
        uint256 gr = repTotalRejected[publisher];

        if (gr == 0) return cr > 0;
        return cr * (gs + gr) > REP_ANOMALY_FACTOR * gr * cTotal;
    }

    function getPublisherStats(address publisher)
        external
        view
        returns (uint256 settled, uint256 rejected, uint16 score)
    {
        settled = repTotalSettled[publisher];
        rejected = repTotalRejected[publisher];
        uint256 total = settled + rejected;
        score = total == 0 ? 10000 : uint16((settled * 10000) / total);
    }

    function getCampaignRepStats(address publisher, uint256 campaignId)
        external
        view
        returns (uint256 settled, uint256 rejected)
    {
        settled = repCampaignSettled[publisher][campaignId];
        rejected = repCampaignRejected[publisher][campaignId];
    }

    function _score(address publisher) internal view returns (uint16) {
        uint256 s = repTotalSettled[publisher];
        uint256 r = repTotalRejected[publisher];
        uint256 total = s + r;
        if (total == 0) return 10000;
        return uint16((s * 10000) / total);
    }
}
