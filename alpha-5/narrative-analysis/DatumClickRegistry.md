# DatumClickRegistry

Tracks impression→click sessions for CPC (cost-per-click) campaigns. The
fraud prevention property: one click per impression-nonce, one settlement
per click.

## The CPC flow

```
1. User sees ad → extension reports impression, relay records nonce N in claim chain (NOT here)
2. User clicks ad → extension fires AD_CLICK event with impressionNonce N
3. Relay calls recordClick(user, campaignId, N) → session 'recorded'
4. User submits type-1 claim with clickSessionHash = keccak(user, campaignId, N)
5. ClaimValidator.validateClaim Check 11 calls hasUnclaimed → must be 'recorded'
6. After Settlement processes the claim, it calls markClaimed → session 'claimed'
```

The session moves through three states: `0` (unrecorded), `1` (recorded
but unsettled), `2` (claimed). The `_sessions[hash]` storage is a uint8.

## Why a separate contract

CPC fraud is qualitatively different from CPM fraud. For impressions, the
defense is the protocol's ZK / PoW / stake stack. For clicks, the central
question is: did the user actually click? That's an off-chain event that
needs a server-side session anchor, and Settlement shouldn't carry that
state. ClickRegistry isolates it.

## Authorization

- **`recordClick`** — gated to `relay` contract. Reverts if the session
  already exists (one-click-per-impression).
- **`markClaimed`** — gated to `settlement` contract. Reverts if the
  session isn't in state `1` (must have been recorded, not yet claimed).
- **`hasUnclaimed`** — public view; ClaimValidator uses it to verify
  session existence at validation time.

Both refs are set via owner; `lockPlumbing()` freezes them.

## Session hash binding

`sessionHash = keccak256(abi.encode(user, campaignId, impressionNonce))`.
This binds the session to a specific user × campaign × impression, so a
relay can't reuse one user's session hash for another user, and an
impression nonce can't be claimed across campaigns. The binding lives
in the keccak preimage, not in any on-chain mapping — saves storage.

## Pause behavior

Reads `pausedSettlement()` (same as Settlement). A settlement pause halts
clicks just as it halts settles, by design — the two are part of the same
trust path.

## What it doesn't do

- It doesn't store user wallet, campaign ID, or impression nonce
  separately. Only the keccak hash of the triple. If a session needs
  reconstruction off-chain, the relay (which fired `recordClick` with the
  original inputs) must keep them.
- It doesn't expire sessions. A recorded-but-never-claimed click stays in
  storage indefinitely. Acceptable: each entry costs one SSTORE; abuse
  would require many spurious recordClicks, which the relay (the only
  authorized caller) wouldn't fire.
- It doesn't verify the click happened. The relay vouches for that
  off-chain. The on-chain protection is the *one-session-per-tuple*
  property, not a server-attestation property.

## Why type-1 specifically

ClickRegistry is only consulted for `actionType == 1`. Type-0 (view) and
type-2 (action) have their own flows (ZK gate for type-0; pot-defined
`actionVerifier` EIP-712 sig for type-2). Three action types, three
distinct fraud-resistance models.
