// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaigns.sol";

/// @title DatumSettlement
/// @notice Processes claim batches, validates hash chains, and distributes payments.
///
/// Fixes applied (vs. PoC spec):
///   Issue 1:  Revenue split formula: publisher takeRate, 75/25 user/protocol of remainder.
///   Issue 2:  No solo-match floor; clearingCpmPlanck must be <= bidCpmPlanck (no minimum).
///   Issue 3:  Stop-on-first-gap: process nonces in order; reject gap and all subsequent.
///   Issue 5:  Settlement reads snapshotTakeRateBps from campaign struct (not live publisher rate).
///   Issue 6:  Hash chain validated inline; genesis requires previousClaimHash=0.
///   Issue 7:  Per-batch require(msg.sender == batch.user).
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
    // Constants
    // -------------------------------------------------------------------------

    /// @dev Maximum claims per batch. settleClaims scales at ~5.3x per 10x claims.
    uint256 public constant MAX_CLAIMS_PER_BATCH = 5;

    // -------------------------------------------------------------------------
    // Cross-contract references
    // -------------------------------------------------------------------------

    IDatumCampaigns public campaigns;

    // -------------------------------------------------------------------------
    // Pull payment balances (Issue 4)
    // -------------------------------------------------------------------------

    mapping(address => uint256) private _publisherBalance;
    mapping(address => uint256) private _userBalance;
    uint256 private _protocolBalance;

    // -------------------------------------------------------------------------
    // Claim tracking per (user, campaignId)
    // -------------------------------------------------------------------------

    // user => campaignId => last settled nonce
    mapping(address => mapping(uint256 => uint256)) private _lastNonce;

    // user => campaignId => hash of last settled claim
    mapping(address => mapping(uint256 => bytes32)) private _lastClaimHash;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _campaigns) Ownable(msg.sender) {
        require(_campaigns != address(0), "E00");
        campaigns = IDatumCampaigns(_campaigns);
    }

    // -------------------------------------------------------------------------
    // Settlement (Issue 3, 6, 7)
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    /// @dev Issue 7: Each batch must be called by batch.user.
    ///      Issue 3: Stop-on-first-gap; settledCount + rejectedCount = total in batch.
    function settleClaims(ClaimBatch[] calldata batches)
        external
        nonReentrant
        returns (SettlementResult memory result)
    {
        for (uint256 b = 0; b < batches.length; b++) {
            ClaimBatch calldata batch = batches[b];

            // Issue 7: caller must be the claim owner
            require(msg.sender == batch.user, "Caller must be claim owner");

            _processBatch(batch, result);
        }
    }

    /// @dev Process one user's claims in a batch.
    ///      A4 fix: all claims must match batch.campaignId.
    ///      A3 fix: campaign is fetched once in _validateClaim and passed through.
    function _processBatch(ClaimBatch calldata batch, SettlementResult memory result) internal {
        require(batch.claims.length <= MAX_CLAIMS_PER_BATCH, "E28");
        address user = batch.user;
        bool gapFound = false;

        for (uint256 i = 0; i < batch.claims.length; i++) {
            Claim calldata claim = batch.claims[i];

            // A4 fix: reject claims that don't match the batch-level campaignId
            if (claim.campaignId != batch.campaignId) {
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

            // A3 fix: _validateClaim returns the campaign it fetched to avoid re-fetching
            (bool ok, uint8 reasonCode, IDatumCampaigns.Campaign memory c) = _validateClaim(claim, user);
            if (!ok) {
                // Check if this is a gap (nonce mismatch) vs. other error
                if (reasonCode == 7) {
                    gapFound = true;
                }
                result.rejectedCount++;
                emit ClaimRejected(claim.campaignId, user, claim.nonce, reasonCode);
                continue;
            }

            // All validations passed — settle this claim using the already-fetched campaign
            _settleSingleClaim(claim, user, c, result);
        }
    }

    /// @dev Validate a single claim. Returns (true, 0, campaign) on success or (false, reasonCode, empty) on failure.
    ///      A3 fix: returns the Campaign fetched during validation to avoid a second cross-contract call.
    ///      Issue 6: claimHash computed inline (computeClaimHash removed as public function for PVM size).
    function _validateClaim(Claim calldata claim, address user)
        internal
        view
        returns (bool, uint8, IDatumCampaigns.Campaign memory)
    {
        IDatumCampaigns.Campaign memory empty;

        // zkProof is accepted as-is; ZK verification: not implemented in MVP
        // A2 fix: Reject zero-impression claims (produce zero payment, pollute hash chain)
        if (claim.impressionCount == 0) return (false, 2, empty);

        // Campaign must exist and be Active
        IDatumCampaigns.Campaign memory c = campaigns.getCampaign(claim.campaignId);
        if (c.id == 0) return (false, 3, empty);
        if (c.status != IDatumCampaigns.CampaignStatus.Active) return (false, 4, empty);

        // Publisher must match campaign
        if (claim.publisher != c.publisher) return (false, 5, empty);

        // Issue 2: CPM validation — no floor, just <= bidCpmPlanck
        if (claim.clearingCpmPlanck > c.bidCpmPlanck) return (false, 6, empty);

        // Issue 3: Nonce must be exactly lastNonce + 1
        uint256 expectedNonce = _lastNonce[user][claim.campaignId] + 1;
        if (claim.nonce != expectedNonce) return (false, 7, empty);

        // Issue 6: Hash chain validation
        bytes32 expectedPrevHash = _lastClaimHash[user][claim.campaignId];
        if (claim.nonce == 1) {
            // Genesis claim: previousClaimHash must be bytes32(0)
            if (claim.previousClaimHash != bytes32(0)) return (false, 8, empty);
        } else {
            if (claim.previousClaimHash != expectedPrevHash) return (false, 9, empty);
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
        if (claim.claimHash != expectedHash) return (false, 10, empty);

        // Check budget sufficiency (amounts in planck)
        uint256 totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
        if (totalPayment > c.remainingBudget) return (false, 11, empty);

        return (true, 0, c);
    }

    /// @dev Execute a validated claim: deduct budget, update state, record balances.
    ///      A3 fix: accepts pre-fetched Campaign to avoid a second cross-contract call.
    ///      A5 fix: dailyClaimCount removed — was tracked but never enforced.
    function _settleSingleClaim(
        Claim calldata claim,
        address user,
        IDatumCampaigns.Campaign memory c,
        SettlementResult memory result
    ) internal {
        // Issue 1: Revenue split formula (amounts in planck)
        uint256 totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
        uint256 publisherPayment = (totalPayment * c.snapshotTakeRateBps) / 10000; // Issue 5
        uint256 remainder = totalPayment - publisherPayment;
        uint256 userPayment = (remainder * 7500) / 10000; // 75%
        uint256 protocolFee = remainder - userPayment;    // 25%

        // Deduct from campaign budget (enforces daily cap)
        campaigns.deductBudget(claim.campaignId, totalPayment);

        // Update hash chain tracking (Issue 6)
        _lastNonce[user][claim.campaignId] = claim.nonce;
        _lastClaimHash[user][claim.campaignId] = claim.claimHash;

        // Accumulate pull payment balances (Issue 4)
        _publisherBalance[claim.publisher] += publisherPayment;
        _userBalance[user] += userPayment;
        _protocolBalance += protocolFee;

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
        uint256 amount = _publisherBalance[msg.sender];
        require(amount > 0, "E03");
        _publisherBalance[msg.sender] = 0;
        emit PublisherWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumSettlement
    function withdrawUser() external nonReentrant {
        uint256 amount = _userBalance[msg.sender];
        require(amount > 0, "E03");
        _userBalance[msg.sender] = 0;
        emit UserWithdrawal(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @inheritdoc IDatumSettlement
    function withdrawProtocol(address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "E00");
        uint256 amount = _protocolBalance;
        require(amount > 0, "E03");
        _protocolBalance = 0;
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

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function publisherBalance(address publisher) external view returns (uint256) {
        return _publisherBalance[publisher];
    }

    function userBalance(address user) external view returns (uint256) {
        return _userBalance[user];
    }

    function protocolBalance() external view returns (uint256) {
        return _protocolBalance;
    }

    function lastNonce(address user, uint256 campaignId) external view returns (uint256) {
        return _lastNonce[user][campaignId];
    }

    function lastClaimHash(address user, uint256 campaignId) external view returns (bytes32) {
        return _lastClaimHash[user][campaignId];
    }
}
