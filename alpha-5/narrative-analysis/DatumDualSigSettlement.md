# DatumDualSigSettlement

The EIP-712 publisher + advertiser cosig path. Carved out of
DatumSettlement (alpha-4 EIP-170 C8c) so the dual-sig entry point
doesn't bloat the Settlement shell's bytecode. Verifies two
signatures over a `ClaimBatch` envelope, then forwards each verified
batch to Settlement via `processVerifiedBatch`, which DELEGATECALLs
into LogicB.

This is the only settlement path that satisfies AssuranceLevel 2.
Both parties — publisher AND advertiser — have signed off-chain on
the exact claims batch and its deadline. Either party can refute by
withholding their signature; there is no on-chain dispute, only
non-cooperation.

## EIP-712 domain

Pinned to `("DatumSettlement", "1")` in the constructor. The carve-out
preserves the historic domain so off-chain signers (extension SDK,
publisher backends, advertiser ad-consoles) keep producing valid
digests against the same domain separator they had pre-carve-out.

`CLAIM_BATCH_TYPEHASH` is the historic hash:

```
ClaimBatch(
  address user,
  uint256 campaignId,
  bytes32 claimsHash,
  uint256 deadlineBlock,
  address expectedRelaySigner,
  address expectedAdvertiserRelaySigner
)
```

`claimsHash` is `keccak256(abi.encodePacked(claim.claimHash[i]))` over
the batch. `deadlineBlock` is in block.number units (matches DatumRelay).

## Signature flow

`settleSignedClaims(SignedClaimBatch[])` does, per batch:

1. **I-3 empty-batch reject** (E28). Sigs over zero claims burn gas
   for no work.
2. **A9 deadline check** (E81). `block.number > batch.deadlineBlock`
   reverts.
3. **Digest construction**. `claimsHash` over claim hashes; struct
   hash over the typehash; `_hashTypedDataV4` returns the EIP-712
   digest.
4. **Publisher sig recovery**.
   - Recovers `pubSigner` from `digest + publisherSig`.
   - `expectedPublisher = claims[0].publisher`. Every claim must
     share that publisher (M-3 / SM-1) or revert E34.
   - If `expectedRelaySigner != 0`: confirm
     `publishers.relaySigner(expectedPublisher) == expectedRelaySigner`
     (anti-rotation, E84), then `pubSigner == expectedRelaySigner`
     (E82).
   - If `expectedRelaySigner == 0`: strict publisher EOA — `pubSigner
     == expectedPublisher` (E82).
5. **Advertiser sig recovery**. Same pattern, against
   `campaigns.getCampaignAdvertiser(campaignId)` and
   `campaigns.getAdvertiserRelaySigner(advertiser)`. Reverts E83 on
   sig mismatch, E85 on rotation mismatch.
6. **Forward** — `settlement.processVerifiedBatch(user, campaignId,
   claims)`. Settlement's `processVerifiedBatch` is gated to
   `msg.sender == _dualSig` (this contract), then DELEGATECALLs into
   LogicB with `advertiserConsented = true`.

## Anti-staleness

The `expectedRelaySigner` / `expectedAdvertiserRelaySigner` fields are
the A1 + M6 anti-staleness hedges. Without them, a publisher could
sign a batch with relayKey-v1, rotate to relayKey-v2 via
`Publishers.setRelaySigner`, and the in-flight cosig would still be
valid — letting a stale (compromised) v1 key submit. The on-chain
checks confirm the publisher's current relay-signer mapping AGREES
with the value baked into the signature, so a rotation invalidates
any in-flight sig that referenced the old key.

The advertiser side gets the same protection via
`expectedAdvertiserRelaySigner` after audit pass 4 added
`getAdvertiserRelaySigner` to Campaigns.

## Wiring + lock-once

Four setters: `setSettlement`, `setPauseRegistry`, `setPublishers`,
`setCampaigns`. Each one reverts `LockedAlready` after
`lockPlumbing()` has been called. `lockPlumbing` itself is gated on
`whenOpenGovPhase` and requires all four references to be wired.

`setCampaigns` is mandatory; the advertiser recovery path requires
both `getCampaignAdvertiser` and `getAdvertiserRelaySigner`.

`setPauseRegistry` is optional in that the check is `if (address(pauseRegistry)
!= address(0) && pauseRegistry.pausedSettlement())`. A zero registry
just skips the pause check, which is fine for early Paseo.

## Error codes

- **E00** — uninitialized references / address(0) success-conditions
- **E28** — batch caps (empty batch, oversized batch outer array)
- **E34** — multi-publisher claims in one batch (M-3 / SM-1)
- **E81** — deadline expired
- **E82** — publisher sig mismatch
- **E83** — advertiser sig mismatch
- **E84** — publisher relaySigner rotated (anti-staleness)
- **E85** — advertiser relaySigner rotated (anti-staleness)
- **Paused** — settlement category paused
- **LockedAlready** — setter called after `lockPlumbing()`

## Trust assumptions

- The publisher's `relaySigner` mapping in DatumPublishers is the
  authoritative source for accepted publisher cosigs.
- The advertiser's `getAdvertiserRelaySigner` mapping in DatumCampaigns
  is the same authority for advertiser cosigs.
- A hot-key rotation invalidates in-flight sigs (anti-staleness).
- The EIP-712 domain is pinned to "DatumSettlement", "1" — chain ID
  is dynamic (OZ default), so a forked-chain replay produces a
  different digest.

## Upgrade

Lock-once via `lockPlumbing()` post-OpenGov. Pre-OpenGov, governance
can rotate any of the four references. The carve-out's purpose is
bytecode budget — replacing the entire dual-sig contract is a
governance-driven upgrade via `DatumGovernanceRouter.upgradeContract("DatumDualSigSettlement", v2)`.

The EIP-712 typehash is committed to the on-chain bytecode (constant).
Any change to `CLAIM_BATCH_TYPEHASH` is an off-chain protocol break —
existing in-flight sigs would stop verifying. Don't change it casually.
