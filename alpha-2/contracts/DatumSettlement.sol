// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IDatumSettlement.sol";

/// @title DatumSettlement
/// @notice Processes claim batches, validates hash chains, and distributes payments.
///
///         Alpha-2 restructuring:
///           - Pull-payment balances + withdrawals extracted to DatumPaymentVault.
///           - Budget deduction routed through DatumBudgetLedger (not Campaigns).
///           - Auto-complete on budget exhaustion calls DatumCampaignLifecycle.
///           - ZK proof verification moved to DatumRelay (saves ~4 KB PVM).
///
///         Revenue formula (unchanged):
///           totalPayment    = (clearingCpmPlanck * impressionCount) / 1000
///           publisherPayment = totalPayment * snapshotTakeRateBps / 10000
///           remainder       = totalPayment - publisherPayment
///           userPayment     = remainder * 7500 / 10000   (75%)
///           protocolFee     = remainder - userPayment     (25%)
contract DatumSettlement is IDatumSettlement, ReentrancyGuard {
    address public owner;
    address public campaigns;
    address public budgetLedger;
    address public paymentVault;
    address public lifecycle;
    address public relayContract;
    address public pauseRegistry;

    mapping(address => mapping(uint256 => uint256)) public lastNonce;
    mapping(address => mapping(uint256 => bytes32)) public lastClaimHash;

    constructor(address _campaigns, address _pauseRegistry) {
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        owner = msg.sender;
        campaigns = _campaigns;
        pauseRegistry = _pauseRegistry;
    }

    // -------------------------------------------------------------------------
    // Admin — single configure + relay setter (saves PVM vs 6 individual setters)
    // -------------------------------------------------------------------------

    function configure(
        address _budgetLedger,
        address _paymentVault,
        address _lifecycle
    ) external {
        require(msg.sender == owner, "E18");
        require(_budgetLedger != address(0), "E00");
        require(_paymentVault != address(0), "E00");
        require(_lifecycle != address(0), "E00");
        budgetLedger = _budgetLedger;
        paymentVault = _paymentVault;
        lifecycle = _lifecycle;
    }

    function setRelayContract(address addr) external {
        require(msg.sender == owner, "E18");
        relayContract = addr;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        owner = newOwner;
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
        // Pause check via plain staticcall (no typed interface import)
        (bool pOk, bytes memory pRet) = pauseRegistry.staticcall(
            abi.encodeWithSelector(bytes4(0x5c975abb))  // paused()
        );
        require(pOk && pRet.length >= 32 && !abi.decode(pRet, (bool)), "P");

        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];
            require(
                msg.sender == batch.user || msg.sender == relayContract,
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
        require(claims.length <= 5, "E28");
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

            (bool ok, uint8 reasonCode, uint16 cTakeRate) = _validateClaim(claim, user);
            if (!ok) {
                if (reasonCode == 7) {
                    gapFound = true;
                }
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, reasonCode);
                continue;
            }

            _settleSingleClaim(claim, user, cTakeRate, result);
        }
    }

    function _validateClaim(Claim calldata claim, address user)
        internal
        view
        returns (bool, uint8, uint16)
    {
        if (claim.impressionCount == 0) return (false, 2, 0);

        (bool cOk, bytes memory cRet) = campaigns.staticcall(
            abi.encodeWithSelector(bytes4(0xe3c76d2e), claim.campaignId)
        );
        require(cOk, "E01");
        (uint8 status, address cPublisher, uint256 cBidCpm, uint16 cTakeRate)
            = abi.decode(cRet, (uint8, address, uint256, uint16));

        if (cBidCpm == 0) return (false, 3, 0);
        if (status != 1) return (false, 4, 0);

        if (cPublisher != address(0)) {
            if (claim.publisher != cPublisher) return (false, 5, 0);
        } else {
            if (claim.publisher == address(0)) return (false, 5, 0);
        }

        if (claim.clearingCpmPlanck > cBidCpm) return (false, 6, 0);

        uint256 expectedNonce = lastNonce[user][claim.campaignId] + 1;
        if (claim.nonce != expectedNonce) return (false, 7, 0);

        bytes32 expectedPrevHash = lastClaimHash[user][claim.campaignId];
        if (claim.nonce == 1) {
            if (claim.previousClaimHash != bytes32(0)) return (false, 8, 0);
        } else {
            if (claim.previousClaimHash != expectedPrevHash) return (false, 9, 0);
        }

        bytes32 expectedHash = keccak256(abi.encodePacked(
            claim.campaignId,
            claim.publisher,
            user,
            claim.impressionCount,
            claim.clearingCpmPlanck,
            claim.nonce,
            claim.previousClaimHash
        ));
        if (claim.claimHash != expectedHash) return (false, 10, 0);

        return (true, 0, cTakeRate);
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
        require(dOk, "E16");
        bool exhausted = abi.decode(dRet, (bool));

        // Record balance split in PaymentVault (DOT already there from BudgetLedger)
        (bool vOk,) = paymentVault.call(
            abi.encodeWithSelector(bytes4(0xdb96c4a4),
                claim.publisher, publisherPayment, user, userPayment, protocolFee)
        );
        require(vOk, "E02");

        lastNonce[user][claim.campaignId] = claim.nonce;
        lastClaimHash[user][claim.campaignId] = claim.claimHash;

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
