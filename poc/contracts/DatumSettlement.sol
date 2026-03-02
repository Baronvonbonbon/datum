// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";

/// @title DatumSettlement
/// @notice Processes claim batches, validates hash chains, and distributes payments.
///
/// Fixes applied (vs. PoC spec):
///   Issue 1:  Revenue split formula: publisher takeRate, 75/25 user/protocol of remainder.
///   Issue 2:  No solo-match floor; clearingCpmPlanck must be <= bidCpmPlanck (no minimum).
///   Issue 3:  Stop-on-first-gap: process nonces in order; reject gap and all subsequent.
///   Issue 5:  Settlement reads snapshotTakeRateBps from campaign struct (not live publisher rate).
///   Issue 6:  Hash chain validated inline; genesis requires previousClaimHash=0.
///   Issue 7:  Per-batch require(msg.sender == batch.user) or authorized relay contract.
///   Issue 4:  Pull payment for all parties; ReentrancyGuard.
///   Pausable removed (PVM size); Ownable kept for protocol withdraw access control.
///
/// Revenue formula (Issue 1):
///   totalPayment    = (clearingCpmPlanck * impressionCount) / 1000
///   publisherPayment = totalPayment * snapshotTakeRateBps / 10000
///   remainder       = totalPayment - publisherPayment
///   userPayment     = remainder * 7500 / 10000   (75%)
///   protocolFee     = remainder - userPayment     (25%)
///   All amounts in planck (1 DOT = 10^10 planck)
contract DatumSettlement is IDatumSettlement, ReentrancyGuard, Ownable {
    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    IDatumCampaignsSettlement public campaigns;

    /// @dev Authorized relay contract that can call settleClaims on behalf of users
    address public relayContract;

    // -------------------------------------------------------------------------
    // Pull payment balances (Issue 4) — public mappings replace manual getters
    // -------------------------------------------------------------------------

    mapping(address => uint256) public publisherBalance;
    mapping(address => uint256) public userBalance;
    uint256 public protocolBalance;

    // -------------------------------------------------------------------------
    // Claim tracking per (user, campaignId) — public mappings replace manual getters
    // -------------------------------------------------------------------------

    // user => campaignId => last settled nonce
    mapping(address => mapping(uint256 => uint256)) public lastNonce;

    // user => campaignId => hash of last settled claim
    mapping(address => mapping(uint256 => bytes32)) public lastClaimHash;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _campaigns) Ownable(msg.sender) {
        require(_campaigns != address(0), "E00");
        campaigns = IDatumCampaignsSettlement(_campaigns);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set the authorized relay contract address
    function setRelayContract(address _relay) external onlyOwner {
        relayContract = _relay;
    }

    // -------------------------------------------------------------------------
    // Settlement (Issue 3, 6, 7)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    /// @dev Issue 7: Each batch must be called by batch.user or the authorized relay contract.
    ///      Issue 3: Stop-on-first-gap; settledCount + rejectedCount = total in batch.
    function settleClaims(ClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

            // Issue 7: caller must be the claim owner or authorized relay
            require(
                msg.sender == batch.user || msg.sender == relayContract,
                "E32"
            );

            _processBatch(batch.user, batch.campaignId, batch.claims, result);
        }
    }

    /// @dev Process one user's claims in a batch.
    ///      A4 fix: all claims must match batch-level campaignId.
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

            // A4 fix: reject claims that don't match the batch-level campaignId
            if (claim.campaignId != campaignId) {
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, 0);
                continue;
            }

            // Issue 3: Once a gap is found, reject all remaining claims in this batch
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

            // All validations passed — settle this claim
            _settleSingleClaim(claim, user, cTakeRate, result);
        }
    }

    /// @dev Validate a single claim. Returns (true, 0, takeRate) on success
    ///      or (false, reasonCode, 0) on failure.
    ///      Uses slim getCampaignForSettlement to avoid full Campaign struct ABI decode.
    function _validateClaim(Claim calldata claim, address user)
        internal
        view
        returns (bool, uint8, uint16)
    {
        // zkProof is accepted as-is; ZK verification: not implemented in MVP
        // A2 fix: Reject zero-impression claims (produce zero payment, pollute hash chain)
        if (claim.impressionCount == 0) return (false, 2, 0);

        // Fetch only the 5 fields we need (no full struct ABI decode)
        (uint8 status, address cPublisher, uint256 cBidCpm,
         uint256 cRemaining, uint16 cTakeRate) = campaigns.getCampaignForSettlement(claim.campaignId);

        // Campaign must exist (id field would be 0 → status defaults to 0 = Pending, publisher = 0)
        if (cPublisher == address(0)) return (false, 3, 0);
        // Campaign must be Active (status == 1)
        if (status != 1) return (false, 4, 0);

        // Publisher must match campaign
        if (claim.publisher != cPublisher) return (false, 5, 0);

        // Issue 2: CPM validation — no floor, just <= bidCpmPlanck
        if (claim.clearingCpmPlanck > cBidCpm) return (false, 6, 0);

        // Issue 3: Nonce must be exactly lastNonce + 1
        uint256 expectedNonce = lastNonce[user][claim.campaignId] + 1;
        if (claim.nonce != expectedNonce) return (false, 7, 0);

        // Issue 6: Hash chain validation
        bytes32 expectedPrevHash = lastClaimHash[user][claim.campaignId];
        if (claim.nonce == 1) {
            // Genesis claim: previousClaimHash must be bytes32(0)
            if (claim.previousClaimHash != bytes32(0)) return (false, 8, 0);
        } else {
            if (claim.previousClaimHash != expectedPrevHash) return (false, 9, 0);
        }

        // Verify the claim hash matches the canonical formula (inlined — no external call)
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

        // Check budget sufficiency (amounts in planck)
        uint256 totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
        if (totalPayment > cRemaining) return (false, 11, 0);

        return (true, 0, cTakeRate);
    }

    /// @dev Execute a validated claim: deduct budget, update state, record balances.
    function _settleSingleClaim(
        Claim calldata claim,
        address user,
        uint16 cTakeRate,
        SettlementResult memory result
    ) internal {
        // Issue 1: Revenue split formula (amounts in planck)
        uint256 totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
        uint256 publisherPayment = (totalPayment * cTakeRate) / 10000; // Issue 5
        uint256 remainder = totalPayment - publisherPayment;
        uint256 userPayment = (remainder * 7500) / 10000; // 75%
        uint256 protocolFee = remainder - userPayment;    // 25%

        // Deduct from campaign budget (enforces daily cap)
        campaigns.deductBudget(claim.campaignId, totalPayment);

        // Update hash chain tracking (Issue 6)
        lastNonce[user][claim.campaignId] = claim.nonce;
        lastClaimHash[user][claim.campaignId] = claim.claimHash;

        // Accumulate pull payment balances (Issue 4)
        publisherBalance[claim.publisher] += publisherPayment;
        userBalance[user] += userPayment;
        protocolBalance += protocolFee;

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

    // -------------------------------------------------------------------------
    // Pull payment withdrawals (Issue 4)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    /// @dev Uses _send() internal helper — single transfer() call in the contract
    ///      to work around resolc codegen bug with multiple transfer() sites.
    function withdrawPublisher() external nonReentrant {
        uint256 amount = publisherBalance[msg.sender];
        require(amount > 0, "E03");
        publisherBalance[msg.sender] = 0;
        emit PublisherWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumSettlement
    function withdrawUser() external nonReentrant {
        uint256 amount = userBalance[msg.sender];
        require(amount > 0, "E03");
        userBalance[msg.sender] = 0;
        emit UserWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumSettlement
    function withdrawProtocol(address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "E00");
        uint256 amount = protocolBalance;
        require(amount > 0, "E03");
        protocolBalance = 0;
        emit ProtocolWithdrawal(recipient, amount);
        _send(recipient, amount);
    }

    /// @dev Single native-transfer site using .call{value} — avoids resolc codegen bug
    ///      where multiple transfer() sites produce broken RISC-V code.
    ///      Using .call{value} instead of .transfer() because resolc's transfer heuristic
    ///      may inline _send() back into each caller, recreating the multi-site bug.
    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "E02");
    }

    // -------------------------------------------------------------------------
    // Receive DOT from DatumCampaigns.deductBudget()
    // -------------------------------------------------------------------------

    receive() external payable {
        // DOT (planck) forwarded from campaign escrow; accounted in pull-payment mappings by settleClaims()
    }
}
