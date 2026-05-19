// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./IDatumSettlement.sol";

/// @title  IDatumDualSigSettlement
/// @notice External surface for the carved-out dual-signature settlement
///         path. Verifies publisher + advertiser EIP-712 signatures over
///         a `ClaimBatch` envelope, then forwards the batch to Settlement
///         via the gated `processVerifiedBatch` entry. The non-signed
///         settle paths (settleClaims / settleClaimsMulti) remain on
///         Settlement.
interface IDatumDualSigSettlement {
    function settleSignedClaims(IDatumSettlement.SignedClaimBatch[] calldata batches)
        external returns (IDatumSettlement.SettlementResult memory);
}
