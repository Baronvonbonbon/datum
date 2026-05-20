# DatumRelay

The publisher-cosigned relay path. Publishers (or their delegated relay
operators) submit batches of claims to this contract; the contract verifies
the publisher's EIP-712 signature, then forwards to
`DatumSettlement.settleClaims`.

This is the canonical Level-1-assurance entry point. Users at L1 campaigns
don't submit claims themselves; they hand them to the relay, which holds
the publisher's hot key, signs the batch, and submits on-chain.

## EIP-712 envelope

Two typehashes:

- `ClaimBatch(address user, uint256 campaignId, uint256 firstNonce, uint256 lastNonce, uint256 claimCount, uint256 deadlineBlock)` — the relay's own user-signed envelope when the user authorises the batch.
- `PublisherAttestation(uint256 campaignId, address user, bytes32 claimsHash, uint256 deadlineBlock)` — the publisher's cosig over the actual claim contents.

The A1 audit fix (2026-05-12) bound `claimsHash` and `deadlineBlock` into the
publisher typehash. Before that, a captured publisher cosig could be replayed
with altered claim rates or event counts. Now the cosig is content-bound; any
mutation breaks the signature.

## Authorized relayers (H-4 + G-1)

`authorizedRelayers[addr]` controls who may submit. The fallback design: if
the authorized list is empty (and no stake-gate is wired), anyone may submit
(the "liveness fallback"). This keeps the protocol from getting bricked by
a misconfigured relayer set, while letting publishers tighten the list when
they want to.

### G-1 stake-gate augment (2026-05-20) — optional staking, three paths

**Important framing.** `DatumRelay` is the **third-party shared-relay
service**. Publishers and advertisers running their own relay
infrastructure use direct-to-Settlement paths and do NOT touch
`DatumRelay` at all. The protocol has three authorization paths,
only one of which is governed by `DatumRelay`'s authorization:

1. **Publisher self-operates** via `Publishers.setRelaySigner(hotKey)`
   — that hot key calls `Settlement.settleClaims` directly. The
   `_isPublisherRelay` check on `DatumSettlementStorage` recognizes
   the relaySigner; `DatumRelay` is bypassed entirely. No stake.
2. **Advertiser self-operates** via `DatumDualSigSettlement.settleSignedClaims`
   — submission is permissionless; auth is via the EIP-712 cosig.
   `DatumRelay` is bypassed entirely. No stake.
3. **Third-party shared relay** via `DatumRelay.settleClaimsFor` —
   subject to the augment-pattern authorization below.

For Path 3, `setRelayStake(addr)` wires an optional pointer to
[`DatumRelayStake`](./DatumRelayStake.md). A relay passes
authorization if EITHER manually allowlisted via `authorizedRelayers`
OR adequately staked per `relayStake.isAuthorized`:

```solidity
function isAuthorizedRelayer(address relayer) public view returns (bool) {
    if (authorizedRelayers[relayer]) return true;
    if (address(relayStake) != address(0) && relayStake.isAuthorized(relayer)) return true;
    return false;
}
```

Both paths are **permanent**. Pattern (b) augment is the production
end-state — there's no planned cutover to "stake-only" pattern (a).
The allowlist serves Council-curated parties (network's own relay,
exchange relays, etc.) that have other accountability mechanisms;
the stake gate serves independent operators who want to self-select
into on-chain accountability + reputation.

This closes the identity + bond layer of G-1 (Relay has zero on-chain
accountability) — independent third-party relays now have a
slashable economic identity via `DatumRelayStake`, adjudicated by
conviction vote through
[`DatumRelayGovernance`](./DatumRelayGovernance.md). The full
proposal, including the censorship-fast-track upgrade path (Approach
A or B), is in
[`proposals/relay-accountability.md`](./proposals/relay-accountability.md).

The stake gate is **disabled at deploy** (`RELAY_MIN_STAKE = 0`).
Governance raises the floor via `RelayStake.setRelayMinStake(floor)`
once independent operators want to participate. Before then,
authorization is allowlist-only on Path 3, which is fine for an
early network with a small curated relay set.

The liveness fallback considers BOTH paths. If neither a manually-
authorized relayer nor a staked one has submitted within
`livenessThresholdBlocks`, anyone may submit — anti-brick property
preserved.

## Pause check

Reads `pauseRegistry.pausedSettlement()` — the same category as Settlement.
A settlement pause halts both the direct settle and the relay path.

## Flow

```
user signs ClaimBatch envelope → hands to relay
publisher signs PublisherAttestation (binds claimsHash + deadline)
relay calls Relay.settle(user, campaign, claims, userSig, publisherSig)
Relay verifies both signatures, fan-outs to Settlement.settleClaims
Settlement runs the full validation + payment pipeline
```

## Settlement vs Relay vs AttestationVerifier

Three entrypoints into the same Settlement contract:

- **Direct (`settleClaims`)**: caller is the user themselves; suitable for L0 self-attestation.
- **Relay**: publisher cosigns each batch's claimsHash; suitable for L1.
- **AttestationVerifier**: a thin wrapper that *requires* publisher attestation for ALL campaigns (more restrictive than Relay's authorized-relayer model).

Relay and AttestationVerifier overlap. Relay is the production path; the
AttestationVerifier exists for deployments that want a stricter "no claim
without publisher cosig, ever" stance, even at L0.

## Why settlement and campaigns are mutable here

H-6 audit choice: this contract's `settlement` and `campaigns` references
are NOT lock-once (most refs are). The reason: Relay sits at the edge of the
protocol and might need to repoint at a fresh Settlement during major
version upgrades without a relay redeploy + publisher hot-key migration. The
risk is contained because Relay only *forwards* — it doesn't hold value.
