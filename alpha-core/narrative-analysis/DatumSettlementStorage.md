# DatumSettlementStorage

The shared storage base for the Settlement two-Logic split. Abstract by
design — never deployed on its own. Everything that needs to read or
mutate Settlement state inherits this contract so the storage layout
stays identical across the four participating contracts:
`DatumSettlement`, `DatumSettlementLogicA`, `DatumSettlementLogicB`,
and (when delegate-routed back into the Settlement context) any
future helper. Layout drift across this set would corrupt slots on
the first chained DELEGATECALL.

## Why a separate base contract

Settlement runtime bytecode crossed EIP-170 (24,576 B) after the alpha-4
hardening passes. The clean way to fit under the cap without throwing
away the function surface was to move the heavy logic into a pair of
"Logic" contracts and DELEGATECALL into them from a thin Settlement
shell. That requires all three contracts to share an identical storage
layout — even a one-slot difference would mean the LogicA / LogicB code
reads/writes the wrong slot when called from Settlement's context.

`DatumSettlementStorage` codifies the layout. Everything is declared
here, in the original order it had on the monolithic Settlement.
Logic contracts add zero state of their own (the LAYOUT INVARIANT
comment forbids it). The snapshot test
`test/settlement-layout.test.ts` compiles each contract, compares
slot-by-slot, and asserts they match a committed
`settlement-layout.snapshot.json`. `scripts/deploy.ts` runs the same
check before any contract is deployed (audit-hedge #1, phase 8d-5).

## Inherited layout

`DatumSettlementStorage` inherits `ReentrancyGuard` and
`DatumUpgradable`. That puts the OZ `_status` slot, the Ownable2Step
slots, and the upgradable router/frozen/migrated/migrationSource +
50-slot `__upgradeGap` at the top — the same ancestor chain Settlement
had before the split, so existing storage positions are preserved.

`IDatumSettlement` is deliberately NOT inherited here. Interfaces
contribute no storage so it would be layout-neutral, but pulling it in
would force LogicA / LogicB to implement every settle entry point.
Settlement itself re-declares `is IDatumSettlement` so it remains the
public ABI surface.

## What lives on the base

Cross-contract references (one slot each):
`_budgetLedger`, `_paymentVault`, `_lifecycle`, `_relayContract`,
`_pauseRegistry`, `_attestationVerifier`, `_claimValidator`,
`_publishers`, `_tokenRewardVault`, `_campaigns`, `_publisherStake`,
`_advertiserStake`, `_clickRegistry`, `_mintCoordinator`,
`_rateLimiter`, `_nullifiers`, `_reputation`, `_powEngine`,
`_identityRegistry`.

`_pauseRegistry` was demoted from `immutable` to storage in phase 8d-1
so Logic contracts can read it through shared storage. Set once in
Settlement's constructor; there is no setter.

User-side policy:
`_userMinAssurance`, `_userMinIdentityLevel`, `_userBlocksPublisher`,
`_userBlocksAdvertiser`, `_userPaused`.

Per-claim chain state:
`_lastNonce`, `_lastClaimHash`, `_userCampaignSettled`,
`_userCampaignWindowEvents`, `_userTotalSettled`,
`_lastSettlementBlock`.

Revenue / safety params:
`_userShareBps` (default 7500, min 5000, max 9000),
`_maxBatchSize` (default 50, ceiling 200), `_minClaimInterval`,
`_maxSettlementPerBlock` / `_cbBlock` / `_cbTotal` (L-7 global
per-block circuit breaker).

Two-Logic split tail (slots 89–91):
`_dualSig`, `_logicA`, `_logicB`, `_logicLocked`. These are at the END
of the layout — append-only and layout-invariant safe. `_logicLocked`
is the audit-hedge #3 lock-once: once flipped from Settlement via
`lockLogic()`, any future `setLogic()` reverts. Pre-OpenGov the lock
itself reverts via `whenOpenGovPhase`.

## Shared helpers

Three helpers hoisted onto the base so both Settlement and Logic
contracts can reach them:

- **`_isPublisherRelay(claims)`** — fail-CLOSED view check. Reads
  `publishers.relaySigner(claims[0].publisher)` and returns
  `msg.sender == that key`. A revert from `relaySigner` returns false
  (caller falls back to the broader auth list). The opposite (treat
  revert as "yes") would let a captured Publishers upgrade authorize
  any settler as a publisher relay.
- **`_assuranceDecision(...)`** — pure helper (audit-hedge #5) that
  encodes the AssuranceLevel gradient. Inputs: campaign level, user
  floor, whether the submission is dual-sig, whether the caller is
  the relay contract, whether the caller is a publisher's relaySigner.
  Returns `(accept, reasonCode)`. Pulled out of `_processBatch` so the
  64-cell input grid can be table-tested in isolation in
  `test/assurance-gradient.test.ts`.
- **`_delegateProcessBatch(...)`** — the canonical chained-DELEGATECALL
  helper that forwards a batch into `LogicB.processBatch` and bubbles
  the original revert reason via assembly. Used by both Settlement
  (dual-sig path, via `processVerifiedBatch`) and LogicA (relay
  outer loops). Reverts with `E00` if `_logicB == address(0)`.

## Shared types and events

- **`BatchAggregate`** — memory-only struct that accumulates one
  batch's payouts (total, publisher payment, user payment, protocol
  fee, token reward, exhaustion flag) before the per-batch
  `creditSettlement` call.
- **`E00` / `E11` / `E18` / `E28` / `E32` / `E34` / `E80` / ...** —
  custom errors used by Settlement + LogicA + LogicB. Declared here
  so revert selectors stay shared across the family.
- **`SettlementConfigured` / `RewardCreditFailed` / `BlocklistCheckFailed`
  / `AssuranceLookupFailed` / `BlocklistFailedClosed` /
  `ZKAssuranceFailed` / `UserBlocklistRejected` / ...** — all events
  emitted via this base, originating from Settlement's address in
  every DELEGATECALL frame.

## Trust model

The contract has no callable surface of its own. Its integrity rests on:

1. The layout invariant (snapshot test + deploy-time gate).
2. The lock-once `_logicLocked` flag, which Settlement governance
   should fire after the deployed Logic pair has been audited.
3. The inherited `whenNotFrozen` / `whenOpenGovPhase` modifiers from
   `DatumUpgradable`, which apply consistently across the family.

## Upgrade path

Storage additions must always go to the END of the layout, never
inserted between existing fields. `__upgradeGap` is the inherited
50-slot reserve from `DatumUpgradable`; once that's consumed, future
fields go after `_logicLocked` (slot 91 offset 20) by extending the
same base contract. Every change must be paired with a regenerated
snapshot and a PR-diff-visible bump to `slotCount`.
