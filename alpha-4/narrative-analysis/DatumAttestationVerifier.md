# DatumAttestationVerifier

A wrapper around `Settlement.settleClaims` that makes publisher EIP-712
attestation *mandatory*. Unlike `DatumRelay`, which is one of several
allowed callers of Settlement, this contract enforces the cosig requirement
on every batch — regardless of the campaign's AssuranceLevel.

## Use case

Some deployments may want stronger guarantees than the campaign-level
AssuranceLevel can express. A deployer who plugs `AttestationVerifier`'s
address into `Settlement.setAttestationVerifier(...)` (lock-once) creates a
fourth allowed caller into Settlement — one whose code path requires the
publisher to have signed every batch.

## The single entrypoint

`settleClaimsAttested(user, campaign, claims, publisherSig, deadlineBlock)`
hashes the batch into the `PublisherAttestation` typehash, recovers the
signer, requires it to match the campaign's designated publisher (or, for
open campaigns, `claims[0].publisher`), then forwards into Settlement.

## EIP-712 typehash

Same as Relay's: `PublisherAttestation(uint256 campaignId, address user,
bytes32 claimsHash, uint256 deadlineBlock)`. The A1 audit fix binds
claimsHash and deadlineBlock, so a captured cosig is content- and
time-locked.

## Immutability

All three external references — `settlement`, `campaigns`, `pauseRegistry` —
are `immutable`, set at construction. This contract is intentionally rigid:
deploy once, wire once, never touch.

## Pause behavior

Reads `pauseRegistry.pausedSettlement()`. A settlement-domain pause halts
attestation-mediated settles same as direct settles.

## Compared to Relay

| | Relay | AttestationVerifier |
|---|---|---|
| Authorization | Authorized relayer list with liveness fallback | Anyone may call |
| Publisher cosig | Required when present, optional otherwise | Always required |
| State mutability | Mutable settlement/campaigns refs (H-6) | Immutable |
| Use case | Standard publisher-mediated settlement | Strict "every claim must be cosigned" |

In the standard ladder, deployers wire Relay for the production publisher
flow and leave AttestationVerifier unwired (`address(0)` on
`Settlement.setAttestationVerifier`). Only deployments with extreme
fraud-sensitivity (or experimental high-assurance campaigns) wire it.

## Why have it at all

It's a defense-in-depth option. The protocol shouldn't presume that every
deployment can rely on publishers being honest by reputation alone. Some
operators may want to enforce "cryptographic proof per batch" as a hard
floor, independent of campaign-level opt-ins. This contract makes that
possible with one wiring change and no Settlement modifications.
