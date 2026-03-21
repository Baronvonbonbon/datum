// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumPaymentVault.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";

/// @title DatumSettlement
/// @notice Processes claim batches, validates hash chains, and distributes payments.
///
///         Alpha-2 restructuring:
///           - Pull-payment balances + withdrawals extracted to DatumPaymentVault.
///           - Budget deduction routed through DatumBudgetLedger (not Campaigns).
///           - Auto-complete on budget exhaustion calls DatumCampaignLifecycle.
///           - S3: Events on contract reference changes.
///           - S4: ZK verifier empty-return guard.
///
///         Revenue formula (unchanged):
///           totalPayment    = (clearingCpmPlanck * impressionCount) / 1000
///           publisherPayment = totalPayment * snapshotTakeRateBps / 10000
///           remainder       = totalPayment - publisherPayment
///           userPayment     = remainder * 7500 / 10000   (75%)
///           protocolFee     = remainder - userPayment     (25%)
contract DatumSettlement is IDatumSettlement, ReentrancyGuard, Ownable {
    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    IDatumCampaignsSettlement public campaigns;
    IDatumBudgetLedger public budgetLedger;
    IDatumPaymentVault public paymentVault;
    IDatumCampaignLifecycle public lifecycle;

    address public relayContract;
    address public zkVerifier;

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public pauseRegistry;

    // -------------------------------------------------------------------------
    // Claim tracking per (user, campaignId)
    // -------------------------------------------------------------------------

    mapping(address => mapping(uint256 => uint256)) public lastNonce;
    mapping(address => mapping(uint256 => bytes32)) public lastClaimHash;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _campaigns, address _pauseRegistry) Ownable(msg.sender) {
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        campaigns = IDatumCampaignsSettlement(_campaigns);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    // -------------------------------------------------------------------------
    // Admin (S2 zero-addr, S3 events)
    // -------------------------------------------------------------------------

    function setRelayContract(address addr) external onlyOwner {
        emit ContractReferenceChanged("relay", relayContract, addr);
        relayContract = addr;
    }

    function setZKVerifier(address addr) external onlyOwner {
        emit ContractReferenceChanged("zkVerifier", zkVerifier, addr);
        zkVerifier = addr;
    }

    function setBudgetLedger(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("budgetLedger", address(budgetLedger), addr);
        budgetLedger = IDatumBudgetLedger(addr);
    }

    function setPaymentVault(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("paymentVault", address(paymentVault), addr);
        paymentVault = IDatumPaymentVault(addr);
    }

    function setLifecycle(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("lifecycle", address(lifecycle), addr);
        lifecycle = IDatumCampaignLifecycle(addr);
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
        require(!pauseRegistry.paused(), "P");
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

    /// @dev Validate a single claim. Alpha-2: remainingBudget check delegated to BudgetLedger.
    function _validateClaim(Claim calldata claim, address user)
        internal
        view
        returns (bool, uint8, uint16)
    {
        if (claim.impressionCount == 0) return (false, 2, 0);

        // Alpha-2: 4-value return (no remainingBudget)
        (uint8 status, address cPublisher, uint256 cBidCpm,
         uint16 cTakeRate) = campaigns.getCampaignForSettlement(claim.campaignId);

        if (cBidCpm == 0) return (false, 3, 0);
        if (status != 1) return (false, 4, 0);

        // Publisher validation
        if (cPublisher != address(0)) {
            if (claim.publisher != cPublisher) return (false, 5, 0);
        } else {
            if (claim.publisher == address(0)) return (false, 5, 0);
        }

        if (claim.clearingCpmPlanck > cBidCpm) return (false, 6, 0);

        // Nonce sequence
        uint256 expectedNonce = lastNonce[user][claim.campaignId] + 1;
        if (claim.nonce != expectedNonce) return (false, 7, 0);

        // Hash chain
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

        // Budget sufficiency check delegated to BudgetLedger.deductAndTransfer
        // (reverts there if insufficient — no pre-check needed, saves a cross-contract read)

        // ZK proof verification (S4: empty-return guard)
        if (zkVerifier != address(0) && claim.zkProof.length > 0) {
            (bool ok2, bytes memory ret) = zkVerifier.staticcall(
                abi.encodeWithSignature("verify(bytes,bytes32)", claim.zkProof, expectedHash)
            );
            // S4: guard against empty return from codeless address
            if (!ok2 || ret.length < 32 || !abi.decode(ret, (bool))) {
                return (false, 12, 0);
            }
        }

        return (true, 0, cTakeRate);
    }

    /// @dev Execute a validated claim: deduct budget via BudgetLedger,
    ///      credit payment via PaymentVault, handle auto-complete.
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

        // Deduct from budget and transfer DOT to PaymentVault
        bool exhausted = budgetLedger.deductAndTransfer(
            claim.campaignId, totalPayment, address(paymentVault)
        );

        // Record balance split in PaymentVault (DOT already there from BudgetLedger)
        paymentVault.creditSettlement(
            claim.publisher, publisherPayment,
            user, userPayment,
            protocolFee
        );

        // Update hash chain
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
            lifecycle.completeCampaign(claim.campaignId);
        }
    }
}
