# DATUM alpha-core — Security Audit 2026-06-11

- **Date:** 2026-06-11
- **Reviewer:** Internal (Claude, focused pass)
- **Scope:** `alpha-core/contracts/*.sol`. Emphasis on code that changed since
  the prior deep audit (`SECURITY-AUDIT-2026-05-20.md`, 39 findings, 31 closed):
  the 2026-06 denomination migration (`62fb488`, `756522b`), the U3 gas-paginated
  migration (`832b8b8`), and the alpha-5 → alpha-core rename (`78069ae`). Plus an
  independent re-read of the settlement money path and the contracts the prior
  audit flagged HIGH (`DatumWrapper` F-026, settlement F-001/F-002, `DatumStakeRootV2`).
- **Baseline:** `npx hardhat test` → **1671 passing, 1 pending** (clean recompile).
- **Severity bar:** pre-mainnet hardening, same scale as the 2026-05-20 pass.

## Executive summary

The codebase remains mature and the prior audit's fixes hold up: the settlement
two-Logic split enforces single-publisher batches (F-001/F-002) at `file:line`
below, CEI ordering is correct, the fail-closed/fail-soft gradient is applied
consistently, and the `DatumWrapper` atomic-wrap rewrite (F-026) removed the
open-commitment DoS surface cleanly.

The findings below are concentrated in the **incomplete 2026-06 denomination
migration** (the same root cause as `62fb488`/`756522b`, which themselves note
"the migration only covered settlement/campaign-budget paths") and in the **U3
paginated-migration rollout**, which introduces a live upgrade window that
nothing gates on-chain.

This pass surfaced **1 MEDIUM-HIGH, 3 MEDIUM, 2 LOW, 2 INFO**.

---

## MEDIUM-HIGH

### MH-1 — U3 paginated migration leaves the new Publishers contract live-but-incomplete with no on-chain `migrated` gate — **FIXED 2026-06-11**

**Fix:** `DatumPublishers.migrate` now self-`frozen`s the contract on any batch
that does not complete the migration and unfreezes on the final batch (a
single-batch migration never freezes). All `whenNotFrozen` writes
(registration, take-rate, allowlist) revert for the whole multi-batch window, so
a not-yet-copied publisher can no longer write state a later batch would clobber.
Reads still return partial state during the window, so off-chain consumers must
still gate on `migrated == true` (U6). Test coverage added in
`test/upgrade-u3-pagination.test.ts` (frozen mid-window, write reverts with
"frozen", unfrozen after the final batch). 1671 tests pass.

_Original finding:_

**Files:** `DatumPublishers.sol:519-565`, `DatumUpgradable.sol:203-217`,
`DatumGovernanceRouter.sol:476-497`

`DatumGovernanceRouter.upgradeContract` performs the upgrade atomically: it flips
`currentAddrOf[name]` to the new address, freezes the old contract, and fires a
**single** `migrate(old)` call. That contract was correct when every `migrate`
copied all state in one transaction.

The new U3 override (`832b8b8`) makes `DatumPublishers.migrate` copy only
`MIGRATION_BATCH_SIZE = 50` publishers per call and sets `migrated = true` only on
the batch that reaches the end. At mainnet scale (the commit cites 100k+
publishers) the single `migrate(old)` fired by `upgradeContract` copies just the
first 50; the remaining ~2000 batches are separate governor transactions.

During that window:
- The registry **already points at the new contract**, and the new contract is
  **not frozen** (`upgradeContract` only freezes `old`).
- `migrated == false` but **no on-chain path gates on it** — `registerPublisher`,
  `setRelaySigner`, etc. carry only `whenNotPaused whenNotFrozen`
  (`DatumPublishers.sol:212,415,440`). The contract's own doc-comment instructs
  only *off-chain* consumers to gate on `migrated`.
- Settlement therefore reads partial publisher state: every not-yet-copied
  publisher looks unregistered, so take-rate snapshots, allowlist checks, and
  stake gating mis-handle them for the whole multi-batch window.
- A not-yet-copied publisher can re-`registerPublisher` on the new contract
  (their `_publishers[p].registered` is false there); a later batch then does
  `_publishers[p] = old.getPublisher(p)` and blindly clobbers it.

This is the exact mainnet-scale scenario U3 was built for, so the window is not
hypothetical. It is governance-operated, which bounds it, hence MEDIUM-HIGH
rather than HIGH.

**Recommendation:** make the partial window safe on-chain rather than by
convention. Any of: (a) gate user writes (and ideally the settlement-facing
reads) on `migrated == true`; (b) deploy/leave the new contract `frozen` and
unfreeze only after the final batch; or (c) have `upgradeContract` not flip
`currentAddrOf` for paginated targets until `migrated()` reports true (two-phase
register-then-activate).

---

## MEDIUM

### M-1 — `DatumCampaignCreative` bulletin renewer reward never migrated to 18-dec wei

**File:** `DatumCampaignCreative.sol:55,67,313-318,345-353`

The renewal escrow is funded with native value:
`bulletinRenewalEscrow[campaignId] += msg.value` (`:348`), i.e. 18-decimal wei on
Hub. But the reward paid out of it is planck-sized:

- `bulletinRenewerReward = 10**8` labelled "0.01 DOT default" (`:67`) — in 18-dec
  wei that is 1e-10 DOT, effectively zero.
- `MAX_BULLETIN_RENEWER_REWARD = 10 * 10**10` labelled "10 DOT" (`:55`) — the cap
  is ~1e-7 DOT, so `setBulletinRenewerReward` (`:199`) cannot even be used to set
  a meaningful reward.

Net effect: non-advertiser renewers are paid essentially nothing and governance
has no path to fix it. Same class as the bugs fixed in `62fb488`/`756522b`; this
path was missed. Bulletin creative is a deferred feature, hence MEDIUM not higher.

**Recommendation:** rescale ×10^8 — `bulletinRenewerReward = 10**16` (0.01 DOT),
`MAX_BULLETIN_RENEWER_REWARD = 10 * 10**18` (10 DOT) — matching the wei intent.

### M-2 — `DatumPublishers.MAX_STAKE_GATE_AT_LOCK` not migrated; bricks `lockStakeGate()`

**File:** `DatumPublishers.sol:197,202-209`

`stakeGate` is compared against `publisherStake.staked(msg.sender)` (`:221-223`),
which is native PAS in 18-dec wei. The lock-time ceiling is still planck-sized:
`MAX_STAKE_GATE_AT_LOCK = 10**14` (`:197`, "10000 DOT (10^14 planck)") = 0.0001
DOT in wei.

`lockStakeGate()` requires `stakeGate <= MAX_STAKE_GATE_AT_LOCK` (`:206`). Any
realistic gate (e.g. 1000 DOT = 10^21 wei) now exceeds 10^14 and the lock
reverts — so the A9-fix ceiling, intended to ensure the gate is *reachable* at
lock, instead makes the lock-once cypherpunk commitment unreachable for any
non-trivial gate. The `756522b` rescaling of the other stake ceilings missed
this constant.

**Recommendation:** set `MAX_STAKE_GATE_AT_LOCK = 10**22` (10,000 DOT in 18-dec
wei), consistent with the `maxRequiredStake = 10**22` rescaling in `756522b`.

### M-3 — `DatumPeopleChainXcmBridge.refreshFee` planck-sized and dual-denominated

**File:** `DatumPeopleChainXcmBridge.sol:104,234-254,257-269`

`refreshFee = 1_000_000_000` ("0.1 DOT / PAS at 10^10 planck", `:104`) is used in
two different denominations:
1. as the local floor `require(msg.value >= refreshFee)` (`:236`) — `msg.value`
   is Hub-native 18-dec wei; and
2. as the XCM `withdrawAsset`/`payFees` amount forwarded to the relay
   (`_dispatch` → `encodeIdentityQueryXcm`, `:257-269`,
   `lib/XcmTransactEncoder.sol:216` "Fee amount in relay-native planck").

As a local wei floor, 1e9 wei is ~1e-9 DOT (no real floor); as a relay fee the
planck sizing may be intended. The two uses cannot both be correct with one
constant. Deferred (People Chain bridge), and the comment already flags
"tunable post-Paseo," hence MEDIUM.

**Recommendation:** separate the local-value floor (18-dec wei) from the
relay-fee amount (relay planck), or document explicitly that `refreshFee` is the
relay-fee and add a distinct wei floor for `msg.value`.

---

## LOW

### L-1 — Stale planck-denominated comments after the wei migration

**Files:** `DatumSettlement.sol:401` ("per-block settlement cap in planck"),
`DatumSettlement.sol` `MAX_DUST_THRESHOLD = 1e16` comment "1e16 planck = 0.001
DOT" (wrong in both denominations: 1e16 wei = 0.01 DOT, 1e16 planck = 1e6 DOT),
`DatumPaymentVault.sol:430` ("1e16 planck = 0.001 DOT").

The values are governance-set (per-block cap) or coincidentally acceptable
(dust threshold ≈ 0.01 DOT in wei), so no exploit — but the comments will
mislead the next operator/auditor calibrating these post-migration. Sweep the
remaining "planck" comments on live wei paths.

### L-2 — `migrate` lacks `nonReentrant`; relies on cursor + frozen-source invariant

**File:** `DatumPublishers.sol:519`, `DatumUpgradable.sol:203`

The U3 override is not `nonReentrant`. The doc-comment's reasoning (reads come
from the frozen predecessor, `migrationCursor` prevents reprocessing,
governance-gated) is sound today, but unlike the base `migrate` it cannot set
`migrated = true` up-front as a reentrancy guard (that's the whole point of
pagination). Defensive: add `nonReentrant`, cheap insurance against a future
predecessor whose getters are made to re-enter.

---

## INFO

### I-1 — NullifierRegistry predecessor-chain read depth grows per upgrade

**File:** `DatumNullifierRegistry.sol:125-138`

`_migrate` deliberately does **not** copy the unbounded replay set; instead
`_usedAnywhere` consults `migrationSource` on a local miss
(`:129-138`). Clean and correct — and the right call versus a U3 copy of a 1M+
set. Note that each successive upgrade adds one external staticcall hop to the
hot `tryConsume` path; after many upgrades a nullifier check is N hops deep. Fine
at realistic (governance-paced, rare) upgrade counts; flagged so it is a
conscious tradeoff rather than a surprise.

### I-2 — U3 pattern applied only to Publishers

**File:** `DatumPublishers.sol` (commit `832b8b8`)

The commit notes the pagination pattern "is reusable for NullifierRegistry / the
enumerable fund-holders if their sets grow unbounded." NullifierRegistry is
covered by its own predecessor-chain design (I-1), but any other contract whose
`_migrate` does a single-shot copy of an unbounded set shares the pre-U3 problem
(migrate reverts on gas at scale). Inventory the remaining single-shot
`_migrate` copiers before mainnet and confirm none can grow unbounded.

---

## Verified intact (re-read this pass)

- **F-001/F-002** single-publisher batch enforcement — `DatumSettlementLogicB.sol:68-73`
  (`E34` on any `claims[i].publisher != claims[0].publisher`); aggregate payout
  credits `agg.publisher == claims[0].publisher` consistently
  (`:506-510,554-558`). CEI ordering correct (chain state written before external
  calls, `:475-477`). Token-reward / stake / advertiser-stake side effects all
  fail-soft.
- **F-026** `DatumWrapper` open-commitment DoS — replaced by atomic
  `transferFrom`+mint; `requestWrap`/`cancelWrapRequest` are deprecated no-ops
  (`token/DatumWrapper.sol:120-142`).
- **F-029/F-030** `DatumStakeRootV2` challenge quorum snapshot + approver list
  present (`DatumStakeRootV2.sol:491-516`).
- **Denomination migration** core paths — emission engine wei→10-dec normalize
  (`DatumEmissionEngine.sol:204-214`), advertiser-stake budget divisor
  (`DatumAdvertiserStake.sol:200`), stake/bond/quorum ceilings
  (`756522b`) all correct.
