// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumNullifierRegistry.sol";
import "./interfaces/IDatumClickRegistry.sol";

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
contract DatumSettlement is IDatumSettlement, ReentrancyGuard, Ownable2Step {
    address public budgetLedger;
    address public paymentVault;
    address public lifecycle;
    address public relayContract;
    IDatumPauseRegistry public pauseRegistry;
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
    // CPC: click registry for type-1 session tracking (address(0) = disabled)
    address public clickRegistry;

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);

    // Triple-keyed chain state: (user, campaignId, actionType)
    mapping(address => mapping(uint256 => mapping(uint8 => uint256)))  public lastNonce;
    mapping(address => mapping(uint256 => mapping(uint8 => bytes32))) public lastClaimHash;

    // BM-2: Per-user per-campaign per-actionType cumulative settlement tracking
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public userCampaignSettled;
    uint256 public constant MAX_USER_EVENTS = 100000;

    // BM-10: Minimum blocks between settlement batches per user per campaign (0 = disabled)
    uint16 public minClaimInterval;
    mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public lastSettlementBlock;

    constructor(address _pauseRegistry) Ownable(msg.sender) {
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
        budgetLedger = _budgetLedger;
        paymentVault = _paymentVault;
        lifecycle = _lifecycle;
        relayContract = _relay;
        emit SettlementConfigured(_budgetLedger, _paymentVault, _lifecycle, _relay);
    }

    function setClaimValidator(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        claimValidator = addr;
    }

    function setAttestationVerifier(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        attestationVerifier = addr;
    }

    function setRateLimiter(address addr) external onlyOwner {
        rateLimiter = addr;
    }

    function setMinClaimInterval(uint16 interval) external onlyOwner {
        minClaimInterval = interval;
    }

    function setPublishers(address addr) external onlyOwner {
        publishers = addr;
    }

    function setTokenRewardVault(address addr) external onlyOwner {
        tokenRewardVault = addr;
    }

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    function setPublisherStake(address addr) external onlyOwner {
        publisherStake = addr;
    }

    function setNullifierRegistry(address addr) external onlyOwner {
        nullifierRegistry = addr;
    }

    function setPublisherReputation(address addr) external onlyOwner {
        publisherReputation = addr;
    }

    function setMinReputationScore(uint16 score) external onlyOwner {
        minReputationScore = score;
    }

    function setClickRegistry(address addr) external onlyOwner {
        clickRegistry = addr;
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

        require(!pauseRegistry.paused(), "P");

        require(batches.length <= 10, "E28");

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

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

        require(!pauseRegistry.paused(), "P");

        require(batches.length <= 10, "E28");

        for (uint256 u = 0; u < batches.length; u++) {
            UserClaimBatch calldata ub = batches[u];
            require(ub.campaigns.length <= 10, "E28");

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
        uint8 batchActionType = claims.length > 0 ? claims[0].actionType : 0;

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

        // Safe rollout: reputation gate
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

        BatchAggregate memory agg;

        // Cache token reward config once per batch (view claims only)
        if (tokenRewardVault != address(0) && campaigns != address(0) && batchActionType == 0) {
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
            uint256 expectedNonce  = lastNonce[user][claim.campaignId][claim.actionType] + 1;
            bytes32 expectedPrevHash = lastClaimHash[user][claim.campaignId][claim.actionType];

            (bool ok, uint8 reasonCode, uint16 cTakeRate, bytes32 computedHash) =
                IDatumClaimValidator(claimValidator).validateClaim(
                    claim, user, expectedNonce, expectedPrevHash
                );

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

            // BM-5: Per-publisher window rate limit (optional; rate limiter gates type-0 only)
            if (rateLimiter != address(0)) {
                bool allowed = IDatumSettlementRateLimiter(rateLimiter).checkAndIncrement(
                    claim.publisher, claim.eventCount, claim.actionType
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

            // FP-5: Nullifier replay check (view claims only, optional)
            if (claim.actionType == 0 && nullifierRegistry != address(0) && claim.nullifier != bytes32(0)) {
                if (IDatumNullifierRegistry(nullifierRegistry).isUsed(claim.campaignId, claim.nullifier)) {
                    result.rejectedCount++;
                    emit ClaimRejected(claim.campaignId, user, claim.nonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI): update chain state before external calls
            lastClaimHash[user][claim.campaignId][claim.actionType] = computedHash;
            lastNonce[user][claim.campaignId][claim.actionType] = claim.nonce;

            // FP-5: Register nullifier (view claims only)
            if (claim.actionType == 0 && nullifierRegistry != address(0) && claim.nullifier != bytes32(0)) {
                IDatumNullifierRegistry(nullifierRegistry).submitNullifier(claim.nullifier, claim.campaignId);
            }

            // CPC: mark click session as claimed (type-1 only)
            if (claim.actionType == 1 && clickRegistry != address(0) && claim.clickSessionHash != bytes32(0)) {
                IDatumClickRegistry(clickRegistry).markClaimed(user, claim.campaignId, claim.clickSessionHash);
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

            uint256 publisherPayment = (totalPayment * cTakeRate) / 10000;
            uint256 rem = totalPayment - publisherPayment;
            uint256 userPayment = (rem * 7500) / 10000;
            uint256 protocolFee = rem - userPayment;

            // deductAndTransfer(uint256 campaignId, uint8 actionType, uint256 amount, address vault)
            (bool dOk, bytes memory dRet) = budgetLedger.call(
                abi.encodeWithSignature(
                    "deductAndTransfer(uint256,uint8,uint256,address)",
                    claim.campaignId, claim.actionType, totalPayment, paymentVault
                )
            );
            require(dOk && dRet.length >= 32, "E16");
            if (abi.decode(dRet, (bool))) {
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

        // Aggregate paymentVault credit
        // recordSplit(address publisher, uint256 publisherAmt, address user, uint256 userAmt, uint256 protocolFee)
        if (agg.total > 0) {
            (bool vOk,) = paymentVault.call(
                abi.encodeWithSelector(bytes4(0xdb96c4a4),
                    agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee)
            );
            require(vOk, "E02");
        }

        // Aggregate token reward credit (view claims only, non-critical)
        if (agg.tokenReward > 0) {
            tokenRewardVault.call(
                abi.encodeWithSelector(bytes4(0x113e0e1e),
                    campaignId, agg.rewardToken, user, agg.tokenReward)
            );
        }

        // FP-1: Record settled events on publisher stake bonding curve
        if (publisherStake != address(0) && agg.eventsSettled > 0 && agg.publisher != address(0)) {
            IDatumPublisherStake(publisherStake).recordImpressions(agg.publisher, agg.eventsSettled);
        }

        // FP-16: Record reputation stats
        if (publisherReputation != address(0) && agg.publisher != address(0)) {
            uint256 batchSettled  = result.settledCount  - prevSettledCount;
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

        // Auto-complete campaign if budget exhausted
        // completeCampaign(uint256 campaignId)
        if (agg.exhausted) {
            (bool lOk,) = lifecycle.call(
                abi.encodeWithSelector(bytes4(0x9553f180), agg.campaignIdExhausted)
            );
            require(lOk, "E02");
        }

        // BM-10: Record block of last successful settlement
        if (interval > 0 && result.settledCount > prevSettledCount) {
            lastSettlementBlock[user][campaignId][batchActionType] = block.number;
        }
    }
}
