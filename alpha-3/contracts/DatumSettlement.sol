// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";

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

    event SettlementConfigured(address budgetLedger, address paymentVault, address lifecycle, address relay);

    mapping(address => mapping(uint256 => uint256)) public lastNonce;
    mapping(address => mapping(uint256 => bytes32)) public lastClaimHash;

    // BM-2: Per-user per-campaign cumulative settlement tracking
    mapping(address => mapping(uint256 => uint256)) public userCampaignSettled;
    uint256 public constant MAX_USER_IMPRESSIONS = 100000;

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

    /// @notice Set publishers ref for S12 settlement-level blocklist check. Pass address(0) to disable.
    function setPublishers(address addr) external {
        require(msg.sender == owner, "E18");
        publishers = addr;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        owner = newOwner;
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
        // Pause check via plain staticcall (no typed interface import)
        (bool pOk, bytes memory pRet) = pauseRegistry.staticcall(
            abi.encodeWithSelector(bytes4(0x5c975abb))  // paused()
        );
        require(pOk && pRet.length >= 32 && !abi.decode(pRet, (bool)), "P");

        require(batches.length <= 10, "E28");

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];
            require(
                msg.sender == batch.user || msg.sender == relayContract || msg.sender == attestationVerifier,
                "E32"
            );
            _processBatch(batch.user, batch.campaignId, batch.claims, result);
        }
    }

    function _processBatch(
        address user,
        uint256 campaignId,
        Claim[] calldata claims,
        SettlementResult memory result
    ) internal {
        require(claims.length <= 50, "E28");
        bool gapFound = false;

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
                    abi.encodeWithSelector(bytes4(0xfbac3951), claim.publisher)  // isBlocked(address)
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

            // Store hash from validator before settling
            lastClaimHash[user][claim.campaignId] = computedHash;
            _settleSingleClaim(claim, user, cTakeRate, result);
        }
    }

    function _settleSingleClaim(
        Claim calldata claim,
        address user,
        uint16 cTakeRate,
        SettlementResult memory result
    ) internal {
        uint256 totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
        uint256 publisherPayment = (totalPayment * cTakeRate) / 10000;
        uint256 remainder = totalPayment - publisherPayment;
        uint256 userPayment = (remainder * 7500) / 10000;
        uint256 protocolFee = remainder - userPayment;

        // Deduct from budget — BudgetLedger sends DOT to PaymentVault
        (bool dOk, bytes memory dRet) = budgetLedger.call(
            abi.encodeWithSelector(bytes4(0xcdbb1755),
                claim.campaignId, totalPayment, paymentVault)
        );
        require(dOk && dRet.length >= 32, "E16");
        bool exhausted = abi.decode(dRet, (bool));

        // Record balance split in PaymentVault (DOT already there from BudgetLedger)
        (bool vOk,) = paymentVault.call(
            abi.encodeWithSelector(bytes4(0xdb96c4a4),
                claim.publisher, publisherPayment, user, userPayment, protocolFee)
        );
        require(vOk, "E02");

        lastNonce[user][claim.campaignId] = claim.nonce;

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

        // Auto-complete if budget exhausted
        if (exhausted) {
            (bool lOk,) = lifecycle.call(
                abi.encodeWithSelector(bytes4(0x9553f180), claim.campaignId)
            );
            require(lOk, "E02");
        }
    }
}
