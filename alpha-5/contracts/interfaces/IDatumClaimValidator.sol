// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./IDatumSettlement.sol";

/// @title IDatumClaimValidator
/// @notice Validates settlement claims — extracted from Settlement.
interface IDatumClaimValidator {
    /// @notice Resolved once-per-batch context: every campaign- and
    ///         publisher-invariant read a batch's claims share. Computed once
    ///         by `resolveBatchContext` and passed into `validateClaimWithContext`
    ///         for each claim, so the ~8 invariant external staticcalls
    ///         (campaign status, mute, allowlist gate, take-rate snapshot,
    ///         blocklist, pot rate, ZK-required flag, PoW-enforced flag) run
    ///         once per batch instead of once per claim.
    /// @dev    Valid only for a batch that shares one campaignId, one
    ///         publisher, and one actionType — which the settle paths already
    ///         enforce (single-publisher E34, single-campaign, single-type).
    struct BatchContext {
        bool    ok;                 // false => reject the whole batch with reasonCode
        uint8   reasonCode;         // rejection reason when !ok
        uint16  takeRate;           // publisher take rate in bps (allowlist snapshot or campaign default)
        uint256 potRate;            // clearing-rate ceiling for this actionType
        address potActionVerifier;  // type-2 actionSig signer (CPA)
        bool    requiresZk;         // campaign requires a ZK proof (view claims)
        bool    enforcePow;         // PoW engine is enforcing for this batch
    }

    /// @notice Resolve the once-per-batch invariant context. Does every
    ///         campaign/publisher-invariant read and gate (status, mute,
    ///         allowlist, blocklist, pot, history, ZK-required, PoW-enforced).
    /// @param campaignId   Shared campaign for the batch.
    /// @param publisher    Shared publisher for the batch (claims[0].publisher).
    /// @param actionType   Shared action type for the batch.
    /// @param user         The claiming user.
    /// @return ctx         Context with ok=false + reasonCode on any batch-level reject.
    function resolveBatchContext(
        uint256 campaignId,
        address publisher,
        uint8 actionType,
        address user
    ) external view returns (BatchContext memory ctx);

    /// @notice Per-claim validation using a pre-resolved batch context. Runs
    ///         only the claim-varying checks (event range, rate ceiling, hash
    ///         recompute, PoW target, ZK proof, click session, actionSig). No
    ///         campaign/publisher staticcalls.
    /// @dev    SLIM (#2): nonce and prevHash are no longer on the claim; the
    ///         caller passes the on-chain-assigned `assignedNonce`
    ///         (= lastNonce+1) and `prevHash` (= stored lastClaimHash). The
    ///         claim-hash preimage is rebuilt from these + the batch
    ///         `campaignId`. There is no nonce/prevHash/claimHash equality
    ///         check anymore — the contract derives them, it doesn't verify
    ///         a supplied copy.
    /// @return valid        Whether the claim passed.
    /// @return reasonCode   Rejection reason (0 = valid).
    /// @return computedHash The computed claim hash for storage.
    function validateClaimWithContext(
        IDatumSettlement.Claim calldata claim,
        address user,
        uint256 campaignId,
        uint256 assignedNonce,
        bytes32 prevHash,
        BatchContext memory ctx
    ) external view returns (bool valid, uint8 reasonCode, bytes32 computedHash);

    /// @notice Validate a single claim against on-chain state. Back-compat
    ///         monolithic entry: resolveBatchContext + validateClaimWithContext
    ///         in one call. Used by direct callers/tests; the settle hot path
    ///         uses the split form to hoist the invariant reads.
    /// @param claim          The (slim) claim to validate.
    /// @param user           The claiming user.
    /// @param campaignId     The batch campaign id (carried at batch level now).
    /// @param assignedNonce  The on-chain-assigned nonce (lastNonce + 1).
    /// @param prevHash       The stored previous claim hash.
    /// @return valid        Whether the claim passed all checks.
    /// @return reasonCode   Rejection reason (0 = valid).
    /// @return takeRate     Publisher take rate in bps.
    /// @return computedHash The computed claim hash for storage.
    function validateClaim(
        IDatumSettlement.Claim calldata claim,
        address user,
        uint256 campaignId,
        uint256 assignedNonce,
        bytes32 prevHash
    ) external view returns (bool valid, uint8 reasonCode, uint16 takeRate, bytes32 computedHash);
}
