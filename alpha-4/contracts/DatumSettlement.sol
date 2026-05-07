// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DatumOwnable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumClickRegistry.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumPaymentVault.sol";
import "./interfaces/IDatumTokenRewardVault.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";

/// @title DatumSettlement
/// @notice Processes claim batches and distributes payments.
///
///         Alpha-3 multi-pricing changes:
///           - Claim struct: impressionCount→eventCount, clearingCpmPlanck→ratePlanck,
///             plus actionType, clickSessionHash, actionSig fields.
///           - Chain state triple-keyed: (user, campaignId, actionType).
///           - Payment formula: view (type-0) = (ratePlanck × eventCount) / 1000;
///             click/action (type-1/2) = ratePlanck × eventCount.
///           - BudgetLedger.deductAndTransfer now takes actionType.
///           - Type-1 claims: Settlement calls clickRegistry.markClaimed after success.
///           - rateLimiter.checkAndIncrement now takes actionType.
///
///         Revenue formula:
///           totalPayment    = (ratePlanck × eventCount / 1000) for view
///                           = (ratePlanck × eventCount) for click/action
///           publisherPayment = totalPayment × snapshotTakeRateBps / 10000
///           remainder       = totalPayment - publisherPayment
///           userPayment     = remainder × 7500 / 10000   (75%)
///           protocolFee     = remainder - userPayment     (25%)
contract DatumSettlement is IDatumSettlement, ReentrancyGuard, DatumOwnable {
    IDatumBudgetLedger public budgetLedger;
    IDatumPaymentVault public paymentVault;
    IDatumCampaignLifecycle public lifecycle;
    address public relayContract;
    IDatumPauseRegistry public immutable pauseRegistry;
    address public attestationVerifier;
    IDatumClaimValidator public claimValidator;
    // S12: publishers ref for settlement-level blocklist check (address(0) = disabled)
    IDatumPublishers public publishers;
    // Token reward vault (address(0) = no token rewards)
    IDatumTokenRewardVault public tokenRewardVault;
    // Campaigns ref for reading reward token config
    IDatumCampaigns public campaigns;
    // FP-1: optional publisher stake enforcement (address(0) = disabled)
    IDatumPublisherStake public publisherStake;
    // CPC: click registry for type-1 session tracking (address(0) = disabled)
    IDatumClickRegistry public clickRegistry;

    // ── BM-5: Rate limiter (merged from DatumSettlementRateLimiter) ──
    uint256 public constant MIN_RL_WINDOW_SIZE = 10;
    uint256 public rlWindowBlocks;
    uint256 public rlMaxEventsPerWindow;
    /// @dev publisher => windowId => cumulative view events settled in that window
    mapping(address => mapping(uint256 => uint256)) public publisherWindowEvents;

    // ── FP-5: Nullifier registry (merged from DatumNullifierRegistry) ──
    uint256 public nullifierWindowBlocks;
    /// @dev campaignId => nullifier => used
    mapping(uint256 => mapping(bytes32 => bool)) private _nullifierUsed;

    // ── BM-8/BM-9: Publisher reputation (merged from DatumPublisherReputation) ──
    uint256 public constant REP_MIN_SAMPLE = 10;
    uint256 public constant REP_ANOMALY_FACTOR = 2;
    mapping(address => uint256) public repTotalSettled;
    mapping(address => uint256) public repTotalRejected;
    mapping(address => mapping(uint256 => uint256)) public repCampaignSettled;
    mapping(address => mapping(uint256 => uint256)) public repCampaignRejected;
    mapping(address => bool) public authorizedReporters;
    // Safe rollout: minimum reputation score to settle (0 = disabled, in bps)
    uint16 public minReputationScore;

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);
    event RateLimitsUpdated(uint256 windowBlocks, uint256 maxEventsPerWindow);
    event NullifierSubmitted(uint256 indexed campaignId, bytes32 indexed nullifier);
    event NullifierWindowBlocksUpdated(uint256 oldValue, uint256 newValue);
    event SettlementRecorded(address indexed publisher, uint256 indexed campaignId, uint256 settled, uint256 rejected);
    event ReporterAuthorized(address indexed reporter, bool authorized);

    // Triple-keyed chain state: (user, campaignId, actionType)
    mapping(address => mapping(uint256 => mapping(uint8 => uint256)))  public lastNonce;
    mapping(address => mapping(uint256 => mapping(uint8 => bytes32))) public lastClaimHash;

    // BM-2: Per-user per-campaign per-actionType cumulative settlement tracking
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public userCampaignSettled;
    uint256 public constant MAX_USER_EVENTS = 100000;

    // M-1: Revenue split — user gets 75% of remainder after publisher take rate
    uint256 private constant USER_SHARE_BPS = 7500;
    uint256 private constant BPS_DENOMINATOR = 10000;

    // BM-10: Minimum blocks between settlement batches per user per campaign (0 = disabled)
    uint16 public minClaimInterval;
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public lastSettlementBlock;

    // L-7: Global per-block settlement circuit breaker (0 = disabled)
    uint256 public maxSettlementPerBlock;
    uint256 private _cbBlock;
    uint256 private _cbTotal;

    constructor(address _pauseRegistry) {
        require(_pauseRegistry != address(0), "E00");
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function configure(
        address _budgetLedger,
        address _paymentVault,
        address _lifecycle,
        address _relay
    ) external onlyOwner {
        require(_budgetLedger != address(0), "E00");
        require(_paymentVault != address(0), "E00");
        require(_lifecycle != address(0), "E00");
        require(_relay != address(0), "E00");
        budgetLedger = IDatumBudgetLedger(_budgetLedger);
        paymentVault = IDatumPaymentVault(_paymentVault);
        lifecycle = IDatumCampaignLifecycle(_lifecycle);
        relayContract = _relay;
        emit SettlementConfigured(_budgetLedger, _paymentVault, _lifecycle, _relay);
    }

    function setClaimValidator(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        claimValidator = IDatumClaimValidator(addr);
    }

    function setAttestationVerifier(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        attestationVerifier = addr;
    }

    /// @notice BM-5: Update rate limiter window size and per-publisher event cap.
    function setRateLimits(uint256 _windowBlocks, uint256 _maxEventsPerWindow) external onlyOwner {
        require(_windowBlocks >= MIN_RL_WINDOW_SIZE, "E11");
        require(_maxEventsPerWindow > 0, "E11");
        rlWindowBlocks = _windowBlocks;
        rlMaxEventsPerWindow = _maxEventsPerWindow;
        emit RateLimitsUpdated(_windowBlocks, _maxEventsPerWindow);
    }

    function setMinClaimInterval(uint16 interval) external onlyOwner {
        minClaimInterval = interval;
    }

    function setPublishers(address addr) external onlyOwner {
        publishers = IDatumPublishers(addr);
    }

    function setTokenRewardVault(address addr) external onlyOwner {
        tokenRewardVault = IDatumTokenRewardVault(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaigns = IDatumCampaigns(addr);
    }

    function setPublisherStake(address addr) external onlyOwner {
        publisherStake = IDatumPublisherStake(addr);
    }

    /// @notice FP-5: Update nullifier window size.
    function setNullifierWindowBlocks(uint256 _windowBlocks) external onlyOwner {
        require(_windowBlocks > 0, "E11");
        emit NullifierWindowBlocksUpdated(nullifierWindowBlocks, _windowBlocks);
        nullifierWindowBlocks = _windowBlocks;
    }

    function setMinReputationScore(uint16 score) external onlyOwner {
        minReputationScore = score;
    }

    /// @notice L-5: Add or remove an authorized reputation reporter.
    function setReporterAuthorized(address reporter, bool authorized) external onlyOwner {
        require(reporter != address(0), "E00");
        authorizedReporters[reporter] = authorized;
        emit ReporterAuthorized(reporter, authorized);
    }

    function setClickRegistry(address addr) external onlyOwner {
        clickRegistry = IDatumClickRegistry(addr);
    }

    /// @notice L-7: Set global per-block settlement cap in planck. 0 = disabled.
    function setMaxSettlementPerBlock(uint256 cap) external onlyOwner {
        maxSettlementPerBlock = cap;
    }

    receive() external payable { revert("E03"); }

    // -------------------------------------------------------------------------
    // H-7: Configuration validation
    // -------------------------------------------------------------------------

    /// @notice Check that all required references are configured. Returns (valid, missingField).
    ///         Call after deploy/wiring as a smoke test.
    function validateConfiguration() external view returns (bool valid, string memory missingField) {
        if (address(budgetLedger) == address(0)) return (false, "budgetLedger");
        if (address(paymentVault) == address(0)) return (false, "paymentVault");
        if (address(lifecycle) == address(0)) return (false, "lifecycle");
        if (relayContract == address(0)) return (false, "relayContract");
        if (address(pauseRegistry) == address(0)) return (false, "pauseRegistry");
        if (address(claimValidator) == address(0)) return (false, "claimValidator");
        if (address(campaigns) == address(0)) return (false, "campaigns");
        // Optional references (address(0) = disabled feature, not misconfigured):
        // publishers, tokenRewardVault, publisherStake, clickRegistry, attestationVerifier
        // Inline features (rate limiter, nullifier registry, reputation) have no external refs
        return (true, "");
    }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    function settleClaims(ClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        require(address(claimValidator) != address(0), "E00");

        require(!pauseRegistry.paused(), "P");

        require(batches.length <= 10, "E28");

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

            bool isPublisherRelay = _isPublisherRelay(batch.claims);

            require(
                msg.sender == batch.user || msg.sender == relayContract ||
                msg.sender == attestationVerifier || isPublisherRelay,
                "E32"
            );
            _processBatch(batch.user, batch.campaignId, batch.claims, result);
        }
    }

    /// @inheritdoc IDatumSettlement
    function settleClaimsMulti(UserClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        require(address(claimValidator) != address(0), "E00");

        require(!pauseRegistry.paused(), "P");

        require(batches.length <= 10, "E28");

        for (uint256 u = 0; u < batches.length; u++) {
            UserClaimBatch calldata ub = batches[u];
            require(ub.campaigns.length <= 10, "E28");

            for (uint256 c = 0; c < ub.campaigns.length; c++) {
                CampaignClaims calldata cc = ub.campaigns[c];

                bool isPublisherRelay = _isPublisherRelay(cc.claims);

                require(
                    msg.sender == ub.user || msg.sender == relayContract ||
                    msg.sender == attestationVerifier || isPublisherRelay,
                    "E32"
                );

                _processBatch(ub.user, cc.campaignId, cc.claims, result);
            }
        }
    }

    function _isPublisherRelay(Claim[] calldata claims) internal view returns (bool) {
        if (address(publishers) == address(0) || claims.length == 0) return false;
        try publishers.relaySigner(claims[0].publisher) returns (address pubRelay) {
            return pubRelay != address(0) && msg.sender == pubRelay;
        } catch {
            return false;
        }
    }

    struct BatchAggregate {
        uint256 total;
        uint256 publisherPayment;
        uint256 userPayment;
        uint256 protocolFee;
        address publisher;
        uint256 tokenReward;
        address rewardToken;
        uint256 rewardPerImpression;
        bool exhausted;
        uint256 campaignIdExhausted;
        uint256 eventsSettled;
    }

    function _processBatch(
        address user,
        uint256 campaignId,
        Claim[] calldata claims,
        SettlementResult memory result
    ) internal {
        require(claims.length <= 10, "E28");

        // All claims in a batch must share the same actionType (validated by chain state key)
        // We read actionType from the first claim for batch-level checks
        uint8 batchActionType = 0;
        if (claims.length > 0) {
            batchActionType = claims[0].actionType;
        }

        // BM-10: Min claim interval
        uint16 interval = minClaimInterval;
        if (interval > 0) {
            uint256 lastBlock = lastSettlementBlock[user][campaignId][batchActionType];
            if (lastBlock != 0 && block.number < lastBlock + interval) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(campaignId, user, claims[j].nonce, 18);
                }
                return;
            }
        }

        // Safe rollout: reputation gate (inline — merged from DatumPublisherReputation)
        uint16 minRepScore = minReputationScore;
        if (minRepScore > 0 && claims.length > 0) {
            uint16 score = _getReputationScore(claims[0].publisher);
            if (score < minRepScore) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(claims[j].campaignId, user, claims[j].nonce, 20);
                }
                return;
            }
        }

        uint256 prevSettledCount = result.settledCount;
        uint256 prevRejectedCount = result.rejectedCount;
        bool gapFound = false;

        BatchAggregate memory agg;

        // Cache token reward config once per batch (view claims only)
        if (claims.length > 0 && address(tokenRewardVault) != address(0) && address(campaigns) != address(0) && batchActionType == 0) {
            try campaigns.getCampaignRewardToken(campaignId) returns (address rt) {
                agg.rewardToken = rt;
                if (rt != address(0)) {
                    try campaigns.getCampaignRewardPerImpression(campaignId) returns (uint256 rpi) {
                        agg.rewardPerImpression = rpi;
                    } catch {}
                }
            } catch {}
        }

        for (uint256 i = 0; i < claims.length; i++) {
            Claim calldata claim = claims[i];

            if (claim.campaignId != campaignId) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 0);
                continue;
            }

            if (gapFound) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 1);
                continue;
            }

            // S12: Settlement-level blocklist check (fail-safe: treat call failure as blocked)
            if (address(publishers) != address(0)) {
                try publishers.isBlocked(claim.publisher) returns (bool blocked) {
                    if (blocked) {
                        result.rejectedCount++;
                        emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                } catch {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                    gapFound = true;
                    continue;
                }
            }

            // Delegate validation to ClaimValidator satellite (SE-1)
            uint256 expectedNonce  = lastNonce[user][claim.campaignId][claim.actionType] + 1;
            bytes32 expectedPrevHash = lastClaimHash[user][claim.campaignId][claim.actionType];

            (bool ok, uint8 reasonCode, uint16 cTakeRate, bytes32 computedHash) =
                claimValidator.validateClaim(claim, user, expectedNonce, expectedPrevHash);

            if (!ok) {
                if (reasonCode == 7) gapFound = true;
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, reasonCode);
                continue;
            }

            // BM-2: Per-user settlement cap check (per actionType)
            uint256 newTotal = userCampaignSettled[user][claim.campaignId][claim.actionType] + claim.eventCount;
            if (newTotal > MAX_USER_EVENTS) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 13);
                gapFound = true;
                continue;
            }
            userCampaignSettled[user][claim.campaignId][claim.actionType] = newTotal;

            // BM-5: Per-publisher window rate limit (inline; view claims only)
            if (rlWindowBlocks > 0 && claim.actionType == 0) {
                uint256 windowId = block.number / rlWindowBlocks;
                uint256 current = publisherWindowEvents[claim.publisher][windowId];
                if (current + claim.eventCount > rlMaxEventsPerWindow) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 14);
                    gapFound = true;
                    continue;
                }
                publisherWindowEvents[claim.publisher][windowId] = current + claim.eventCount;
            }

            // FP-1: Publisher stake adequacy check (optional)
            if (address(publisherStake) != address(0)) {
                if (!publisherStake.isAdequatelyStaked(claim.publisher)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 15);
                    gapFound = true;
                    continue;
                }
            }

            // FP-5: Nullifier replay check (view claims only, inline)
            if (claim.actionType == 0 && claim.nullifier != bytes32(0)) {
                if (_nullifierUsed[claim.campaignId][claim.nullifier]) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI): update chain state before external calls
            lastClaimHash[user][claim.campaignId][claim.actionType] = computedHash;
            lastNonce[user][claim.campaignId][claim.actionType] = claim.nonce;

            // FP-5: Register nullifier (view claims only, inline)
            if (claim.actionType == 0 && claim.nullifier != bytes32(0)) {
                require(!_nullifierUsed[claim.campaignId][claim.nullifier], "E73");
                _nullifierUsed[claim.campaignId][claim.nullifier] = true;
                emit NullifierSubmitted(claim.campaignId, claim.nullifier);
            }

            // CPC: mark click session as claimed (type-1 only)
            if (claim.actionType == 1 && address(clickRegistry) != address(0) && claim.clickSessionHash != bytes32(0)) {
                clickRegistry.markClaimed(user, claim.campaignId, claim.clickSessionHash);
            }

            // Compute payment
            uint256 totalPayment;
            if (claim.actionType == 0) {
                // CPM: rate per 1000 events
                totalPayment = (claim.ratePlanck * claim.eventCount) / 1000;
            } else {
                // CPC / CPA: flat rate per event
                totalPayment = claim.ratePlanck * claim.eventCount;
            }

            uint256 publisherPayment = (totalPayment * cTakeRate) / BPS_DENOMINATOR;
            uint256 rem = totalPayment - publisherPayment;
            uint256 userPayment = (rem * USER_SHARE_BPS) / BPS_DENOMINATOR;
            uint256 protocolFee = rem - userPayment;

            // Deduct from budget ledger and transfer DOT to payment vault
            bool exhausted = budgetLedger.deductAndTransfer(
                claim.campaignId, claim.actionType, totalPayment, address(paymentVault)
            );
            if (exhausted) {
                agg.exhausted = true;
                agg.campaignIdExhausted = campaignId;
                gapFound = true;
            }

            agg.total += totalPayment;
            agg.publisherPayment += publisherPayment;
            agg.userPayment += userPayment;
            agg.protocolFee += protocolFee;
            if (agg.publisher == address(0)) agg.publisher = claim.publisher;

            // Token reward (view claims only)
            if (claim.actionType == 0 && agg.rewardToken != address(0) && agg.rewardPerImpression > 0) {
                agg.tokenReward += claim.eventCount * agg.rewardPerImpression;
            }

            // Track events for publisher stake bonding curve
            agg.eventsSettled += claim.eventCount;

            result.settledCount++;
            result.totalPaid += totalPayment;

            emit ClaimSettled(
                claim.campaignId,
                user,
                claim.publisher,
                claim.eventCount,
                claim.ratePlanck,
                claim.actionType,
                claim.nonce,
                publisherPayment,
                userPayment,
                protocolFee
            );
        }

        // L-7: Global per-block circuit breaker
        if (agg.total > 0 && maxSettlementPerBlock > 0) {
            if (_cbBlock != block.number) {
                _cbBlock = block.number;
                _cbTotal = 0;
            }
            _cbTotal += agg.total;
            require(_cbTotal <= maxSettlementPerBlock, "E80");
        }

        // Aggregate paymentVault credit
        if (agg.total > 0) {
            paymentVault.creditSettlement(
                agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee
            );
        }

        // Aggregate token reward credit (view claims only, non-critical)
        if (agg.tokenReward > 0) {
            try tokenRewardVault.creditReward(campaignId, agg.rewardToken, user, agg.tokenReward) {} catch {}
        }

        // FP-1: Record settled events on publisher stake bonding curve
        if (address(publisherStake) != address(0) && agg.eventsSettled > 0 && agg.publisher != address(0)) {
            publisherStake.recordImpressions(agg.publisher, agg.eventsSettled);
        }

        // FP-16: Record reputation stats (inline)
        if (agg.publisher != address(0)) {
            uint256 batchSettled  = result.settledCount  - prevSettledCount;
            uint256 batchRejected = result.rejectedCount - prevRejectedCount;
            if (batchSettled > 0 || batchRejected > 0) {
                repTotalSettled[agg.publisher] += batchSettled;
                repTotalRejected[agg.publisher] += batchRejected;
                repCampaignSettled[agg.publisher][campaignId] += batchSettled;
                repCampaignRejected[agg.publisher][campaignId] += batchRejected;
                emit SettlementRecorded(agg.publisher, campaignId, batchSettled, batchRejected);
            }
        }

        // Auto-complete campaign if budget exhausted
        if (agg.exhausted) {
            lifecycle.completeCampaign(agg.campaignIdExhausted);
        }

        // BM-10: Record block of last successful settlement
        if (interval > 0 && result.settledCount > prevSettledCount) {
            lastSettlementBlock[user][campaignId][batchActionType] = block.number;
        }
    }

    // -------------------------------------------------------------------------
    // Reputation: external reporter (L-5)
    // -------------------------------------------------------------------------

    /// @notice Record settled/rejected counts from an authorized reporter (relay bot).
    function recordSettlement(
        address publisher,
        uint256 campaignId,
        uint256 settled,
        uint256 rejected
    ) external {
        require(authorizedReporters[msg.sender], "E18");
        require(publisher != address(0), "E00");
        if (settled == 0 && rejected == 0) return;

        repTotalSettled[publisher] += settled;
        repTotalRejected[publisher] += rejected;
        repCampaignSettled[publisher][campaignId] += settled;
        repCampaignRejected[publisher][campaignId] += rejected;

        emit SettlementRecorded(publisher, campaignId, settled, rejected);
    }

    // -------------------------------------------------------------------------
    // Views: Rate limiter
    // -------------------------------------------------------------------------

    /// @notice Returns current rate-limit window usage for a publisher.
    function currentWindowUsage(address publisher)
        external
        view
        returns (uint256 windowId, uint256 events, uint256 limit)
    {
        if (rlWindowBlocks == 0) return (0, 0, 0);
        windowId = block.number / rlWindowBlocks;
        events = publisherWindowEvents[publisher][windowId];
        limit = rlMaxEventsPerWindow;
    }

    // -------------------------------------------------------------------------
    // Views: Nullifier registry
    // -------------------------------------------------------------------------

    /// @notice Returns true if the nullifier has already been submitted for this campaign.
    function isNullifierUsed(uint256 campaignId, bytes32 nullifier) external view returns (bool) {
        return _nullifierUsed[campaignId][nullifier];
    }

    // -------------------------------------------------------------------------
    // Views: Publisher reputation
    // -------------------------------------------------------------------------

    /// @notice Returns the publisher's global acceptance score in bps (0–10000).
    ///         Returns 10000 (perfect) if no data yet.
    function getReputationScore(address publisher) external view returns (uint16) {
        return _getReputationScore(publisher);
    }

    /// @notice BM-9: Returns true if the publisher's per-campaign rejection rate exceeds
    ///         2× their global rejection rate with a minimum sample of 10 claims.
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

    /// @notice Global reputation stats for a publisher.
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

    /// @notice Per-campaign reputation stats for a publisher.
    function getCampaignRepStats(address publisher, uint256 campaignId)
        external
        view
        returns (uint256 settled, uint256 rejected)
    {
        settled = repCampaignSettled[publisher][campaignId];
        rejected = repCampaignRejected[publisher][campaignId];
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _getReputationScore(address publisher) internal view returns (uint16) {
        uint256 s = repTotalSettled[publisher];
        uint256 r = repTotalRejected[publisher];
        uint256 total = s + r;
        if (total == 0) return 10000;
        return uint16((s * 10000) / total);
    }
}
