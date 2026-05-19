# DatumPeopleChainIdentity

On-chain cache of Polkadot People Chain identity-pallet judgements,
read by Settlement's per-batch identity gate.

People Chain is a separate system parachain from Polkadot Hub (where
pallet-revive runs our EVM bytecode). Synchronous cross-chain
identity lookups aren't possible from inside `_processBatch` today
— pallet-revive lacks a synchronous XCM-Query precompile, and even
when it ships, gating settlement on People Chain liveness would be
an anti-pattern. So this contract is a **request/response cache**:
the canonical source remains People Chain; a per-user snapshot
lives here with an expiry block; Settlement reads only the snapshot.

Companions:
- [`bonded-reporter-identity.md`](./bonded-reporter-identity.md)
  — the bridge architecture
- [`people-chain-return-leg.md`](./people-chain-return-leg.md) —
  the (deferred) trustless return path
- [`DatumPeopleChainXcmBridge.md`](./DatumPeopleChainXcmBridge.md)
  — the XCM dispatcher side

## Two writer paths

1. **Oracle bridge (today).** An EOA the deployer designates
   (`oracleReporter`) reads People Chain off-chain and writes
   attestations here via `submitAttestationOracle`. Same threat
   model as the existing reputation reporter. Deployable on Paseo
   today.
2. **XCM dispatcher (target).** Once pallet-revive ships a trusted
   XCM-response precompile, People Chain (or a permissionless
   requester) delivers `Transact` calls into `submitAttestation`
   via the dispatcher. The dispatcher holds the `WRITER_XCM` role
   bit.

Both paths terminate in the same `_setRecord` internal call.
Settlement's `isVerified(user, minLevel)` view is identical
regardless of which writer produced the record.

## User-side controls

- **`forgetMe()`** — any user can purge their own cached record at
  any time. Useful after revoking identity on People Chain or for
  users who object to a public cache.
- **Expiry** — every record has a `validityUntilBlock`. Past that,
  `isVerified` returns false even if the level is non-zero. The
  user must re-trigger an attestation via the bridge to refresh.

There is NO admin path to delete or modify another user's record.
Expiry and `forgetMe` are the only removal paths.

## Levels

```
0 = None / Unknown
1 = Reasonable
2 = KnownGood
```

Mirrors People Chain registrar judgements. Monotone — `minLevel = 1`
gates pass for KnownGood records, etc.

## Validity windows

`MIN_VALIDITY_BLOCKS = 600` (~1h) and `MAX_VALIDITY_BLOCKS = 1.44M`
(~100d) bound every write. The floor stops a malicious writer from
filing one-block flapping records; the ceiling stops stale records
from outlasting realistic People Chain judgement timescales.
`defaultValidityBlocks = 100_800` (~7 days) is owner-tunable within
the bounds.

## How Settlement reads it

`_processBatch` computes `effMinId = max(campaign.minIdentityLevel,
user.userMinIdentityLevel)`. If non-zero, fetches
`isVerified(user, effMinId)`. The call is wrapped in try/catch that
fails CLOSED on revert (no silent downgrade of identity gates).
Verification false → batch rejected with reason 30.

## Trust assumptions

- People Chain registrars are the trust root.
- The off-chain oracle reporter is owner-set. A captured reporter
  can poison every user's cache, downgrading or upgrading identity
  arbitrarily. Mitigated by:
  - The expiry mechanism — bad data ages out.
  - Users can `forgetMe()` themselves.
  - `lockOracleReporter()` permanently disables this path once the
    XCM dispatcher is proven (mainnet path).
- The XCM dispatcher path requires People Chain → Hub trustless
  bridging. As of 2026-05-19, the return leg is research-blocked
  (custom FRAME pallet via OpenGov, XCQ when it ships, or relay-
  chain state proofs — see `people-chain-return-leg.md`).

## Locks (post-OpenGov)

- **`lockOracleReporter()`** — owner-only, `whenOpenGovPhase`,
  one-way. After this, only the XCM dispatcher can submit
  attestations. Mainnet target.
- **`lockXcmDispatcher()`** — owner-only, `whenOpenGovPhase`,
  one-way. Freezes the dispatcher reference. Set true after Paseo
  validation; mainnet deploys assert it's true before first
  settlement.

`MAINNET-DEFERRED §2`: do NOT call `lockOracleReporter` until the
trustless return-leg path is proven. Diana (or production bridge
EOA) stays as fallback until then.

## Governance surface

- **`setOracleReporter(addr)`** — owner-only; locked by
  `lockOracleReporter` (one-way).
- **`setXcmDispatcher(addr)`** — owner-only; locked by
  `lockXcmDispatcher` (one-way).
- **`setDefaultValidityBlocks(blocks)`** — owner-only, bounded.

## Upgrade

Upgradable via DatumGovernanceRouter, but the cache is purely
observational — losing the cache state on upgrade just forces a
re-attestation cycle for every user. Not catastrophic.
