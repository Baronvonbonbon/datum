// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumSettlementStorage.sol";
import "./interfaces/IDatumSettlement.sol";

/// @title  DatumSettlementLogicA
/// @notice First half of the Settlement bytecode split (alpha-4 EIP-170
///         phase 8d-2 stub, phase 8d-4 body). Owns the relay-side outer
///         loops -- settleClaims (one user, many batches) and
///         settleClaimsMulti (many users * many campaigns) -- plus their
///         per-batch auth checks. Each iteration delegatecalls into
///         DatumSettlementLogicB.processBatch (via the inherited
///         `_delegateProcessBatch` helper on the storage base) for the
///         per-claim pipeline.
///
/// @dev    LogicA is only ever invoked via DELEGATECALL from
///         DatumSettlement. The shared `DatumSettlementStorage` base
///         guarantees identical storage layout so every SLOAD/SSTORE
///         hits Settlement's slot. When LogicA then delegatecalls
///         LogicB, that's a chained delegatecall: LogicB also runs in
///         Settlement's context, msg.sender stays as the original caller
///         (the relay EOA, attestation verifier, user, or publisher
///         relay).
///
/// @dev    NOT direct-callable. Calling LogicA.settleClaims at LogicA's
///         own address writes to LogicA's storage, where _claimValidator
///         et al are zero -- the first guard reverts E00. So
///         non-delegatecall invocations are inert.
///
/// @dev    LAYOUT INVARIANT: never declare additional state in this
///         contract. New state goes on DatumSettlementStorage.
contract DatumSettlementLogicA is DatumSettlementStorage {
    function version() public pure override returns (uint256) { return 1; }

    /// @notice Single-user, many-batches relay path. See DatumSettlement's
    ///         settleClaims for the public docs -- this is the body it
    ///         delegatecalls into. ReentrancyGuard / whenNotFrozen are
    ///         applied HERE rather than on Settlement's dispatcher so the
    ///         shell stays thin and there's no double-lock on _status.
    function settleClaims(IDatumSettlement.ClaimBatch[] calldata batches)
        external
        nonReentrant
        whenNotFrozen
        returns (IDatumSettlement.SettlementResult memory result)
    {
        if (!(address(_claimValidator) != address(0))) revert E00();
        if (!(!_pauseRegistry.pausedSettlement())) revert Paused();
        if (!(batches.length <= _maxBatchSize)) revert E28();

        for (uint256 b = 0; b < batches.length; b++) {
            IDatumSettlement.ClaimBatch calldata batch = batches[b];

            bool isPublisherRelay = _isPublisherRelay(batch.claims);
            if (!(
                msg.sender == batch.user ||
                msg.sender == _relayContract ||
                msg.sender == _attestationVerifier ||
                isPublisherRelay
            )) revert E32();

            _delegateProcessBatch(batch.user, batch.campaignId, batch.claims, false, result);
        }
    }

    /// @notice Multi-user, many-campaigns relay path. See DatumSettlement's
    ///         settleClaimsMulti for the public docs.
    function settleClaimsMulti(IDatumSettlement.UserClaimBatch[] calldata batches)
        external
        nonReentrant
        whenNotFrozen
        returns (IDatumSettlement.SettlementResult memory result)
    {
        if (!(address(_claimValidator) != address(0))) revert E00();
        if (!(!_pauseRegistry.pausedSettlement())) revert Paused();
        if (!(batches.length <= _maxBatchSize)) revert E28();

        for (uint256 u = 0; u < batches.length; u++) {
            IDatumSettlement.UserClaimBatch calldata ub = batches[u];
            if (!(ub.campaigns.length <= _maxBatchSize)) revert E28();

            for (uint256 c = 0; c < ub.campaigns.length; c++) {
                IDatumSettlement.CampaignClaims calldata cc = ub.campaigns[c];

                bool isPublisherRelay = _isPublisherRelay(cc.claims);
                if (!(
                    msg.sender == ub.user ||
                    msg.sender == _relayContract ||
                    msg.sender == _attestationVerifier ||
                    isPublisherRelay
                )) revert E32();

                _delegateProcessBatch(ub.user, cc.campaignId, cc.claims, false, result);
            }
        }
    }
}
