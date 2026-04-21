// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumNullifierRegistry.sol";

/// @title DatumSettlement
/// @notice Processes claim batches and distributes payments.
///
///         Alpha-3 restructuring (SE-1):
///           - Claim validation extracted to DatumClaimValidator satellite.
///           - Settlement no longer holds campaigns/publishers refs or ISystem import.
///           - Frees ~2.5 KB PVM headroom for future features.
///
///         Revenue formula (unchanged):
///           totalPayment    = (clearingCpmPlanck * impressionCount) / 1000
///           publisherPayment = totalPayment * snapshotTakeRateBps / 10000
///           remainder       = totalPayment - publisherPayment
///           userPayment     = remainder * 7500 / 10000   (75%)
///           protocolFee     = remainder - userPayment     (25%)
contract DatumSettlement is IDatumSettlement, ReentrancyGuard {
    address public owner;
    address public pendingOwner;
    address public budgetLedger;
    address public paymentVault;
    address public lifecycle;
    address public relayContract;
    address public pauseRegistry;
    address public attestationVerifier;
    address public claimValidator;
    // BM-5: optional rate limiter (address(0) = disabled)
    address public rateLimiter;
    // S12: publishers ref for settlement-level blocklist check (address(0) = disabled)
    address public publishers;
    // Token reward vault (address(0) = no token rewards)
    address public tokenRewardVault;
    // Campaigns ref for reading reward token config
    address public campaigns;
    // FP-1: optional publisher stake enforcement (address(0) = disabled)
    address public publisherStake;
    // FP-5: optional nullifier registry for per-user per-campaign per-window replay prevention (address(0) = disabled)
    address public nullifierRegistry;
    // FP-16: optional publisher reputation recorder (address(0) = disabled)
    address public publisherReputation;
    // Safe rollout: minimum reputation score to settle (0 = disabled, in bps)
    uint16 public minReputationScore;

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);

    mapping(address => mapping(uint256 => uint256)) public lastNonce;
    mapping(address => mapping(uint256 => bytes32)) public lastClaimHash;

    // BM-2: Per-user per-campaign cumulative settlement tracking
    mapping(address => mapping(uint256 => uint256)) public userCampaignSettled;
    uint256 public constant MAX_USER_IMPRESSIONS = 100000;

    // BM-10: Minimum blocks between settlement batches per user per campaign (0 = disabled)
    uint16 public minClaimInterval;
    mapping(address => mapping(uint256 => uint256)) public lastSettlementBlock;

    constructor(address _pauseRegistry) {
        require(_pauseRegistry != address(0), "E00");
        owner = msg.sender;
        pauseRegistry = _pauseRegistry;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function configure(
        address _budgetLedger,
        address _paymentVault,
        address _lifecycle,
        address _relay
    ) external {
        require(msg.sender == owner, "E18");
        require(_budgetLedger != address(0), "E00");
        require(_paymentVault != address(0), "E00");
        require(_lifecycle != address(0), "E00");
        require(_relay != address(0), "E00");
        budgetLedger = _budgetLedger;
        paymentVault = _paymentVault;
        lifecycle = _lifecycle;
        relayContract = _relay;
        emit SettlementConfigured(_budgetLedger, _paymentVault, _lifecycle, _relay);
    }

    function setClaimValidator(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        claimValidator = addr;
    }

    function setAttestationVerifier(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        attestationVerifier = addr;
    }

    /// @notice Set the BM-5 rate limiter satellite. Pass address(0) to disable.
    function setRateLimiter(address addr) external {
        require(msg.sender == owner, "E18");
        rateLimiter = addr;
    }

    /// @notice Set minimum blocks between settlement batches per user per campaign. 0 = disabled.
    function setMinClaimInterval(uint16 interval) external {
        require(msg.sender == owner, "E18");
        minClaimInterval = interval;
    }

    /// @notice Set publishers ref for S12 settlement-level blocklist check. Pass address(0) to disable.
    function setPublishers(address addr) external {
        require(msg.sender == owner, "E18");
        publishers = addr;
    }

    /// @notice Set token reward vault. Pass address(0) to disable token rewards.
    function setTokenRewardVault(address addr) external {
        require(msg.sender == owner, "E18");
        tokenRewardVault = addr;
    }

    /// @notice Set campaigns ref for reading reward token config.
    function setCampaigns(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    /// @notice Set publisher stake enforcement satellite. Pass address(0) to disable.
    function setPublisherStake(address addr) external {
        require(msg.sender == owner, "E18");
        publisherStake = addr;
    }

    /// @notice Set FP-5 nullifier registry. Pass address(0) to disable.
    function setNullifierRegistry(address addr) external {
        require(msg.sender == owner, "E18");
        nullifierRegistry = addr;
    }

    /// @notice Set FP-16 publisher reputation recorder. Pass address(0) to disable.
    function setPublisherReputation(address addr) external {
        require(msg.sender == owner, "E18");
        publisherReputation = addr;
    }

    /// @notice Set minimum publisher reputation score required to settle. 0 = disabled.
    function setMinReputationScore(uint16 score) external {
        require(msg.sender == owner, "E18");
        minReputationScore = score;
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

    /// @notice Reject accidental ETH deposits (S6)
    receive() external payable { revert("E03"); }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    function settleClaims(ClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        require(claimValidator != address(0), "E00");

        // Pause check via plain staticcall (no typed interface import)
        (bool pOk, bytes memory pRet) = pauseRegistry.staticcall(
            abi.encodeWithSelector(bytes4(0x5c975abb))  // paused()
        );
        require(pOk && pRet.length >= 32 && !abi.decode(pRet, (bool)), "P");

        require(batches.length <= 10, "E28");

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

            // Per-publisher relay auth: check if msg.sender is the registered relaySigner
            // for this batch's publisher (uses publishers ref, same one used for blocklist checks).
            // Falls back to global relayContract for backwards compatibility.
            bool isPublisherRelay = false;
            if (publishers != address(0) && batch.claims.length > 0) {
                (bool rsOk, bytes memory rsRet) = publishers.staticcall(
                    abi.encodeWithSelector(bytes4(keccak256("relaySigner(address)")), batch.claims[0].publisher)
                );
                if (rsOk && rsRet.length >= 32) {
                    address pubRelay = abi.decode(rsRet, (address));
                    isPublisherRelay = pubRelay != address(0) && msg.sender == pubRelay;
                }
            }

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
        require(claimValidator != address(0), "E00");

        // Pause check
        (bool pOk, bytes memory pRet) = pauseRegistry.staticcall(
            abi.encodeWithSelector(bytes4(0x5c975abb))  // paused()
        );
        require(pOk && pRet.length >= 32 && !abi.decode(pRet, (bool)), "P");

        require(batches.length <= 10, "E28");

        for (uint256 u = 0; u < batches.length; u++) {
            UserClaimBatch calldata ub = batches[u];
            require(ub.campaigns.length <= 10, "E28");

            // Auth: same rules as settleClaims — relay, attestation verifier, or self
            // Per-publisher relay signer checked per campaign-batch below if needed.
            for (uint256 c = 0; c < ub.campaigns.length; c++) {
                CampaignClaims calldata cc = ub.campaigns[c];

                bool isPublisherRelay = false;
                if (publishers != address(0) && cc.claims.length > 0) {
                    (bool rsOk, bytes memory rsRet) = publishers.staticcall(
                        abi.encodeWithSelector(bytes4(keccak256("relaySigner(address)")), cc.claims[0].publisher)
                    );
                    if (rsOk && rsRet.length >= 32) {
                        address pubRelay = abi.decode(rsRet, (address));
                        isPublisherRelay = pubRelay != address(0) && msg.sender == pubRelay;
                    }
                }

                require(
                    msg.sender == ub.user || msg.sender == relayContract ||
                    msg.sender == attestationVerifier || isPublisherRelay,
                    "E32"
                );

                _processBatch(ub.user, cc.campaignId, cc.claims, result);
            }
        }
    }

    /// @dev Accumulator for per-batch aggregated payment and token reward totals.
    ///      Using a struct avoids Solidity's 16-slot stack depth limit.
    struct BatchAggregate {
        uint256 total;            // total DOT deducted across all settled claims
        uint256 publisherPayment; // publisher share of total
        uint256 userPayment;      // user share of total
        uint256 protocolFee;      // protocol share of total
        address publisher;        // publisher address (from first settled claim)
        uint256 tokenReward;      // accumulated token reward units
        address rewardToken;      // ERC-20 reward token address (cached once per batch)
        uint256 rewardPerImpression; // reward per impression (cached once per batch)
        bool exhausted;           // true if any claim exhausted the campaign budget
        uint256 campaignIdExhausted; // campaignId that triggered budget exhaustion (for deferred completion)
        uint256 impressionsSettled; // total impressions settled (for recordImpressions)
    }

    function _processBatch(
        address user,
        uint256 campaignId,
        Claim[] calldata claims,
        SettlementResult memory result
    ) internal {
        require(claims.length <= 10, "E28");

        // BM-10: Min claim interval — reject entire batch if too soon since last settlement
        uint16 interval = minClaimInterval;
        if (interval > 0) {
            uint256 lastBlock = lastSettlementBlock[user][campaignId];
            if (lastBlock != 0 && block.number < lastBlock + interval) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ClaimRejected(campaignId, user, claims[j].nonce, 18);
                }
                return;
            }
        }

        // Safe rollout: reputation gate — reject entire batch if publisher score is below minimum
        uint16 minRepScore = minReputationScore;
        if (publisherReputation != address(0) && minRepScore > 0 && claims.length > 0) {
            (bool repOk, bytes memory repRet) = publisherReputation.staticcall(
                abi.encodeWithSelector(bytes4(keccak256("getScore(address)")), claims[0].publisher)
            );
            if (repOk && repRet.length >= 32 && abi.decode(repRet, (uint16)) < minRepScore) {
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

        // Aggregate state for this batch — amortises paymentVault + tokenReward calls
        BatchAggregate memory agg;

        // Cache token reward config once per batch (2 staticcalls instead of 2N)
        // getCampaignRewardToken(uint256) → address
        // getCampaignRewardPerImpression(uint256) → uint256
        if (tokenRewardVault != address(0) && campaigns != address(0)) {
            (bool rtOk, bytes memory rtRet) = campaigns.staticcall(
                abi.encodeWithSelector(bytes4(0xf00b29a9), campaignId)
            );
            if (rtOk && rtRet.length >= 32) {
                agg.rewardToken = abi.decode(rtRet, (address));
                if (agg.rewardToken != address(0)) {
                    (bool rpOk, bytes memory rpRet) = campaigns.staticcall(
                        abi.encodeWithSelector(bytes4(0x25c1c08e), campaignId)
                    );
                    if (rpOk && rpRet.length >= 32) {
                        agg.rewardPerImpression = abi.decode(rpRet, (uint256));
                    }
                }
            }
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

            // S12: Settlement-level blocklist check
            // isBlocked(address publisher) → bool
            if (publishers != address(0)) {
                (bool blOk, bytes memory blRet) = publishers.staticcall(
                    abi.encodeWithSelector(bytes4(0xfbac3951), claim.publisher)
                );
                if (!blOk || blRet.length < 32 || abi.decode(blRet, (bool))) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                    gapFound = true;
                    continue;
                }
            }

            // Delegate validation to ClaimValidator satellite (SE-1)
            uint256 expectedNonce = lastNonce[user][claim.campaignId] + 1;
            bytes32 expectedPrevHash = lastClaimHash[user][claim.campaignId];

            (bool ok, uint8 reasonCode, uint16 cTakeRate, bytes32 computedHash) =
                IDatumClaimValidator(claimValidator).validateClaim(
                    claim, user, expectedNonce, expectedPrevHash
                );

            if (!ok) {
                if (reasonCode == 7) {
                    gapFound = true;
                }
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, reasonCode);
                continue;
            }

            // BM-2: Per-user settlement cap check
            uint256 newTotal = userCampaignSettled[user][claim.campaignId] + claim.impressionCount;
            if (newTotal > MAX_USER_IMPRESSIONS) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 13);
                gapFound = true;
                continue;
            }
            userCampaignSettled[user][claim.campaignId] = newTotal;

            // BM-5: Per-publisher window rate limit check (optional)
            if (rateLimiter != address(0)) {
                bool allowed = IDatumSettlementRateLimiter(rateLimiter).checkAndIncrement(
                    claim.publisher, claim.impressionCount
                );
                if (!allowed) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 14);
                    gapFound = true;
                    continue;
                }
            }

            // FP-1: Publisher stake adequacy check (optional)
            if (publisherStake != address(0)) {
                if (!IDatumPublisherStake(publisherStake).isAdequatelyStaked(claim.publisher)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 15);
                    gapFound = true;
                    continue;
                }
            }

            // FP-5: Nullifier replay check (optional). bytes32(0) nullifier skips the check.
            if (nullifierRegistry != address(0) && claim.nullifier != bytes32(0)) {
                if (IDatumNullifierRegistry(nullifierRegistry).isUsed(claim.campaignId, claim.nullifier)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI pattern): update chain state before any external calls
            lastClaimHash[user][claim.campaignId] = computedHash;
            lastNonce[user][claim.campaignId] = claim.nonce;
            // FP-5: Register nullifier before payment interactions — prevents reuse if payment reverts
            if (nullifierRegistry != address(0) && claim.nullifier != bytes32(0)) {
                // submitNullifier(bytes32 nullifier, uint256 campaignId)
                IDatumNullifierRegistry(nullifierRegistry).submitNullifier(claim.nullifier, claim.campaignId);
            }

            // Compute payment split for this claim
            uint256 totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
            uint256 publisherPayment = (totalPayment * cTakeRate) / 10000;
            uint256 rem = totalPayment - publisherPayment;
            uint256 userPayment = (rem * 7500) / 10000;
            uint256 protocolFee = rem - userPayment;

            // Interactions: deduct from budget — BudgetLedger enforces daily cap correctly.
            // DOT is transferred to PaymentVault by BudgetLedger on each deduction.
            // deductAndTransfer(uint256 campaignId, uint256 amount, address vault)
            (bool dOk, bytes memory dRet) = budgetLedger.call(
                abi.encodeWithSelector(bytes4(0xcdbb1755),
                    claim.campaignId, totalPayment, paymentVault)
            );
            require(dOk && dRet.length >= 32, "E16");
            if (abi.decode(dRet, (bool))) {
                agg.exhausted = true;
                agg.campaignIdExhausted = campaignId;
                gapFound = true;  // stop processing after budget exhausted
            }

            // Accumulate into batch aggregate (paymentVault credited once after loop)
            agg.total += totalPayment;
            agg.publisherPayment += publisherPayment;
            agg.userPayment += userPayment;
            agg.protocolFee += protocolFee;
            if (agg.publisher == address(0)) agg.publisher = claim.publisher;

            // Accumulate token reward (credited once after loop)
            if (agg.rewardToken != address(0) && agg.rewardPerImpression > 0) {
                agg.tokenReward += claim.impressionCount * agg.rewardPerImpression;
            }

            // Accumulate impression count for publisher stake bonding curve
            agg.impressionsSettled += claim.impressionCount;

            result.settledCount++;
            result.totalPaid += totalPayment;

            emit ClaimSettled(
                claim.campaignId,
                user,
                claim.publisher,
                claim.impressionCount,
                claim.clearingCpmPlanck,
                claim.nonce,
                publisherPayment,
                userPayment,
                protocolFee
            );
        }

        // ── Aggregate paymentVault credit (1 call per batch instead of N) ────────
        // DOT was already transferred to PaymentVault by each budgetLedger.deductAndTransfer.
        // This call records how to split the accumulated DOT among publisher/user/protocol.
        // recordSplit(address publisher, uint256 publisherAmt, address user, uint256 userAmt, uint256 protocolFee)
        if (agg.total > 0) {
            (bool vOk,) = paymentVault.call(
                abi.encodeWithSelector(bytes4(0xdb96c4a4),
                    agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee)
            );
            require(vOk, "E02");
        }

        // ── Aggregate token reward credit (1 call per batch instead of N) ────────
        // Non-critical: don't revert if token budget exhausted — vault handles gracefully.
        // creditReward(uint256 campaignId, address token, address user, uint256 amount)
        if (agg.tokenReward > 0) {
            tokenRewardVault.call(
                abi.encodeWithSelector(bytes4(0x113e0e1e),
                    campaignId, agg.rewardToken, user, agg.tokenReward)
            );
        }

        // ── FP-1: Record settled impressions on publisher stake bonding curve ────
        // Non-critical: don't revert if recordImpressions fails (e.g., feature disabled mid-flight).
        if (publisherStake != address(0) && agg.impressionsSettled > 0 && agg.publisher != address(0)) {
            IDatumPublisherStake(publisherStake).recordImpressions(agg.publisher, agg.impressionsSettled);
        }

        // ── FP-16: Record reputation stats — Settlement is sole trusted caller ────
        // Non-critical: don't revert if reputation call fails.
        if (publisherReputation != address(0) && agg.publisher != address(0)) {
            uint256 batchSettled = result.settledCount - prevSettledCount;
            uint256 batchRejected = result.rejectedCount - prevRejectedCount;
            if (batchSettled > 0 || batchRejected > 0) {
                publisherReputation.call(
                    abi.encodeWithSelector(
                        bytes4(keccak256("recordSettlement(address,uint256,uint256,uint256)")),
                        agg.publisher, campaignId, batchSettled, batchRejected
                    )
                );
            }
        }

        // ── Auto-complete campaign if budget exhausted (deferred to after all loop work) ──
        // completeCampaign(uint256 campaignId)
        if (agg.exhausted) {
            (bool lOk,) = lifecycle.call(
                abi.encodeWithSelector(bytes4(0x9553f180), agg.campaignIdExhausted)
            );
            require(lOk, "E02");
        }

        // BM-10: Record block of last successful settlement for this user/campaign
        if (interval > 0 && result.settledCount > prevSettledCount) {
            lastSettlementBlock[user][campaignId] = block.number;
        }
    }
}
