# DatumSettlementLogicA

First of the two Logic contracts in the Settlement two-Logic split.
Owns the relay-side **outer loops**:

- `settleClaims(ClaimBatch[])` — one user, many batches in one tx
- `settleClaimsMulti(UserClaimBatch[])` — many users × many campaigns
  in one tx

Each batch iteration delegatecalls into `DatumSettlementLogicB`'s
`processBatch` (via the inherited `_delegateProcessBatch` helper on
`DatumSettlementStorage`) for the per-claim pipeline. LogicA is a
thin dispatch + per-batch authorization layer; almost no business
logic lives in it.

## How it's called

Never directly. Settlement's external `settleClaims` and
`settleClaimsMulti` are thin pass-throughs that DELEGATECALL into
LogicA at the address stored in `_logicA`. From LogicA's perspective:

- `address(this)` is Settlement (DELEGATECALL inherits the caller's
  storage context).
- `msg.sender` is the original outer caller — a relay EOA, the
  attestation verifier, the user themselves, or a publisher's
  `relaySigner` key.
- SLOAD/SSTORE hit Settlement's slots because LogicA inherits the
  same `DatumSettlementStorage` base.

When LogicA then invokes `_delegateProcessBatch`, the helper does
another DELEGATECALL into LogicB. That's a chained DELEGATECALL:
LogicB runs in Settlement's context, `msg.sender` is still the
original outer caller, and `address(this)` is still Settlement.
The `msg.sender` preservation through this chain is verified by
`test/settlement-msgsender.test.ts` (audit-hedge #2).

## Direct-call inertness

Calling `LogicA.settleClaims` at LogicA's own address writes to
LogicA's storage, where `_claimValidator == address(0)`. The first
guard `if (!(address(_claimValidator) != address(0))) revert E00();`
fires and the call reverts. So non-DELEGATECALL invocations of LogicA
are inert — they can't accidentally settle anything.

## What `settleClaims` actually does

1. Holds `nonReentrant` + `whenNotFrozen` (the Settlement shell does
   NOT carry these — the lock lives here so there's no double-lock on
   the shared `_status` slot).
2. Confirms `_claimValidator` is wired, settlement isn't paused, and
   `batches.length <= _maxBatchSize`.
3. For each batch:
   - Resolves `_isPublisherRelay(batch.claims)` (the shared view
     helper on the storage base).
   - Requires `msg.sender` to be one of: `batch.user`,
     `_relayContract`, `_attestationVerifier`, or the publisher's
     relay signer. Reverts `E32` otherwise.
   - Calls `_delegateProcessBatch(batch.user, batch.campaignId,
     batch.claims, /*advertiserConsented=*/ false, result)`.

The `advertiserConsented = false` flag is what marks this as a
non-dual-sig submission. LogicB's pure `_assuranceDecision` helper
uses that, combined with the campaign's AssuranceLevel and the user's
floor, to decide whether the batch is acceptable on this submission
path.

## What `settleClaimsMulti` adds

Same shape but two nested loops:
outer for users, inner for campaigns per user. Per-inner-batch auth
check is identical (`batch.user` is replaced by `ub.user`). The
total inner-batch count is bounded by `_maxBatchSize × _maxBatchSize`
since each inner array is itself capped.

## Invariants

- Reverting `E32` (unauthorized caller) does NOT update any state.
- Reverting in the inner `_delegateProcessBatch` bubbles the original
  revert through the assembly `revert(add(ret, 0x20), size)` block —
  the outer caller sees the same custom error or require string a
  direct LogicB call would have produced.
- Per-claim chain-state writes (`_lastNonce`, `_lastClaimHash`,
  `_userCampaignSettled`, etc.) live in LogicB; LogicA never touches
  them directly.

## Upgrade

LogicA is one half of the lock-once Logic pair. Settlement's
`setLogic(addressA, addressB)` rotates both pointers atomically;
Settlement's `lockLogic()` (audit-hedge #3) freezes them. Pre-OpenGov
the lock reverts via `whenOpenGovPhase`. During alpha/beta, governance
can rotate LogicA for a fixed-bytecode upgrade so long as the storage
layout still matches the snapshot.

## What it does NOT do

- No state writes of its own.
- No claim validation, payment math, or external integrations
  (BudgetLedger, PaymentVault, etc.). All of that is LogicB.
- No EIP-712 logic — dual-sig flows through `DatumDualSigSettlement`
  → Settlement's `processVerifiedBatch` → LogicB directly, bypassing
  LogicA.
