# DatumSettlement architecture — two-Logic DELEGATECALL split

**Audience:** auditors, contributors picking up Settlement work, anyone
needing to reason about the storage / msg.sender / upgrade model
before touching the contracts.

**Why this exists.** After Stage 6 of the alpha-4 carve-out work,
DatumSettlement was still 9.8 KB over the EIP-170 24,576 B mainnet cap.
10 satellite carve-outs got us within the cap on Campaigns but not on
Settlement. The two-Logic split (phase 8d, commits `85b98ba` → `c5f69df`)
closed the gap by splitting Settlement's bytecode across three
contracts that share storage via DELEGATECALL.

## TL;DR

Settlement runs as a shell. The hot-path bytecode lives on two upgradable
Logic contracts that share Settlement's storage via DELEGATECALL.

```
DatumSettlement          11.5 KB   shell: storage owner, public ABI,
                                   setters, getters, dispatcher
DatumSettlementLogicA     5.3 KB   relay outer loops: settleClaims,
                                   settleClaimsMulti, per-batch auth
DatumSettlementLogicB    12.5 KB   per-batch inner pipeline: gates,
                                   payment math, vault credit, mint,
                                   reputation
```

All three inherit `DatumSettlementStorage` (abstract base, single source
of truth for storage layout). The slot-by-slot identity is enforced
at compile time by inheritance and at deploy time by the snapshot
gate in `scripts/deploy.ts`.

## Call flow

### Relay path (settleClaims, settleClaimsMulti)

```
caller (relay EOA / user / attestation verifier / publisher relay)
   │ CALL (regular)
   ▼
DatumSettlement.settleClaims          [shell, 2-line body: delegatecall msg.data]
   │ DELEGATECALL  (executes in Settlement's storage + address context)
   ▼
DatumSettlementLogicA.settleClaims    [outer loop, per-batch auth check]
   │ DELEGATECALL  (still in Settlement's context, chained)
   ▼  for each batch
DatumSettlementLogicB.processBatch    [per-claim pipeline body]
   │ CALL (regular, satellite contracts)
   ▼
DatumClaimValidator, DatumPaymentVault, DatumBudgetLedger, ...
```

Chained DELEGATECALL preserves the original `msg.sender` through both
hops -- the relay-EOA's address reaches LogicA's auth check and LogicB's
satellite invocations alike. The shell at the top is intentionally
minimal (essentially `delegatecall(msg.data)`); the auth check sits on
LogicA so future Logic rotations can adjust auth rules without redeploying
Settlement.

### Dual-sig path (processVerifiedBatch)

```
DatumDualSigSettlement (after verifying both EIP-712 signatures)
   │ CALL
   ▼
DatumSettlement.processVerifiedBatch  [thin entry, msg.sender == dualSig check]
   │ DELEGATECALL
   ▼
DatumSettlementLogicB.processBatch    [direct, no LogicA hop]
```

Dual-sig skips LogicA because there's no outer loop -- one batch per
call, validated upstream by DatumDualSigSettlement's signature checks.

## Storage layout

`DatumSettlementStorage` (abstract) is the single source of truth.
DatumSettlement, LogicA, and LogicB all inherit it and declare NO state
of their own. The current layout is 47 slots:

| Slot range | Owner | Purpose |
|---|---|---|
| 0-3 | DatumUpgradable + ReentrancyGuard | Inherited ancestor slots (owner, frozen, _status) |
| 4-89 | DatumSettlementStorage | Cross-contract refs, mappings, batch counters, gradient state |
| 90-91 | DatumSettlementStorage | Logic split: _logicA, _logicB, _logicLocked |

(Exact assignments in `alpha-4/settlement-layout.snapshot.json`.)

### Layout invariant

**Every contract in the chain must declare identical storage.** A drift
anywhere corrupts state at the first cross-call:
- A Settlement slot at index N maps to a LogicA SSTORE at index N.
- If LogicA's compiled layout puts a DIFFERENT variable at index N,
  LogicA's write lands on Settlement's unrelated state.

Three layers of enforcement:

1. **Inheritance.** All three inherit `DatumSettlementStorage`; none
   declare their own state. The compiler guarantees layout identity as
   long as the inheritance chain matches.

2. **Test-time check (`test/settlement-layout.test.ts`).** Compiles all
   three contracts, reads storage layouts from the build-info, asserts:
   - All three contracts agree slot-by-slot.
   - The layout matches `alpha-4/settlement-layout.snapshot.json`
     (committed to repo).

3. **Deploy-time gate (`scripts/deploy.ts`,
   `validateSettlementLayoutMatchesSnapshot()`).** Runs BEFORE any
   contract is deployed. Asserts the same two properties. A build from
   a tree where the snapshot wasn't regenerated will fail this check
   before any tx is sent.

To regenerate the snapshot after an intentional storage-base change:
```
npx hardhat run scripts/dump-settlement-layout.ts
```
The diff must appear in the PR alongside the storage change for review.

## msg.sender preservation

DELEGATECALL semantics: when A delegate-calls B, B runs with A's
`msg.sender`, `address(this)`, and storage. **Chained delegatecalls
preserve the ORIGINAL caller's msg.sender all the way down.**

For our chain:

| Frame | msg.sender | address(this) | Storage |
|---|---|---|---|
| Original caller's tx | (external) | DatumSettlement | n/a |
| Settlement.settleClaims | originalCaller | Settlement | Settlement's |
| LogicA.settleClaims (via DELEGATECALL) | originalCaller | Settlement | Settlement's |
| LogicB.processBatch (via DELEGATECALL) | originalCaller | Settlement | Settlement's |
| Satellite.creditSettlement (via CALL) | Settlement | satellite | satellite's |

The last row is important: when LogicB calls out to a satellite
(paymentVault, claimValidator, etc.), that's a REGULAR CALL, so the
satellite sees `msg.sender == address(Settlement)`. This is what we
want -- satellites enforce `onlySettlement` gates against Settlement's
address as their authority.

`test/settlement-msgsender.test.ts` exercises both properties:
- A probe wired as paymentVault asserts the per-batch
  `creditSettlement` call lands with `msg.sender == address(settlement)`.
  Any DELEGATECALL hop accidentally written as CALL would show LogicA's
  or LogicB's address instead.
- A direct settleClaims from a specific signer asserts the auth check
  inside LogicA correctly identifies that signer (proving msg.sender
  survives Settlement -> LogicA).
- An unauthorized direct caller hits E32 (proving the auth check fires).

## ReentrancyGuard semantics

The `nonReentrant` modifier sits on LogicA's `settleClaims` /
`settleClaimsMulti` and on Settlement's `processVerifiedBatch` (dual-sig
entry) -- NOT on Settlement's relay-path dispatchers. The reasons:

- LogicA runs as Settlement (via DELEGATECALL), so its `_status` lock
  hits Settlement's shared slot. Same end result as if the guard were
  on Settlement.
- If `nonReentrant` were on BOTH Settlement's dispatcher AND LogicA's
  entry, the dispatcher would set `_status = 2` first, then LogicA's
  entry would see `_status == 2` and revert E57. Putting the guard
  only on LogicA avoids the double-lock.
- LogicB has NO `nonReentrant` because it's only ever reached AFTER
  LogicA / Settlement set the guard. The shared `_status` slot is
  already locked.

This is the right pattern, but it's the kind of thing easy to break in
a future Logic upgrade. If you add a new public entry on Logic that's
reachable WITHOUT going through Settlement.processVerifiedBatch /
LogicA, that entry needs its own `nonReentrant` modifier.

## Upgrade story

DatumSettlement is the **stable slot owner**; LogicA and LogicB are the
**upgradable surface**.

- `setLogic(logicA, logicB)` is owner-rotatable, NOT lock-once. The whole
  point of the split is that Logic is upgradable. In production the owner
  is the OpenGov Timelock, so a rotation requires a 48h proposal.

- The two pointers update **atomically as a pair** -- single tx, single
  function. An A/B mismatch (e.g., a new LogicA expecting a slot that
  the old LogicB doesn't write to) would corrupt storage at the first
  cross-call. The single-tx update ensures the pair is co-deployed and
  co-audited.

- `lockLogic()` (phase 8d hedge #3) is the production cypherpunk lock.
  After it fires, `setLogic` reverts. Pattern matches
  `lockLanes` / `lockSlashers` / `lockMintAuthority`. Don't fire it during
  alpha/beta; production governance fires it after the Logic pair has
  been audited and stabilized.

- The storage layout itself is NOT designed to be migrated. New state
  may be APPENDED to `DatumSettlementStorage` (the snapshot will record
  the new slot), but never inserted, reordered, or removed -- any of
  those would orphan existing storage on the deployed Settlement.

## Adversarial-Campaigns risk + the Safe-view hedge

Settlement reads several views from DatumCampaigns on the hot path
(`getCampaignAdvertiser`, `getCampaignAssuranceLevel`, etc.). Without
mitigation, a captured or buggy Campaigns upgrade could selectively
revert these getters to either:

- DoS the entire settlement path (if Settlement's call is unprotected).
- Force fail-closed behavior on specific campaigns (a grief vector
  against competitors) if Settlement's call is in a `try/catch` with
  fail-closed default.

Phase 8d hedge #4 introduced `*Safe` variants
(`getCampaignAdvertiserSafe`, etc.) on Campaigns. Each Safe variant
must NOT revert for any input -- they use only mapping reads (which
default-zero for unknown keys) and a single
`campaigns[id].advertiser != address(0)` existence check. Settlement's
LogicB calls the Safe variants on the hot path. A revert from a Safe
variant is now a Campaigns contract bug, not user-data-driven, and
still triggers Settlement's fail-closed gradient via natural revert
propagation.

The trade-off: a captured Campaigns upgrade can STILL revert the Safe
variants if it's malicious enough. The Safe variant doesn't fully close
that vector; it just raises the bar so the attacker needs root-level
Campaigns access (governance upgrade), not just the ability to construct
a specific campaign ID. Defense-in-depth: layout enforcement +
`lockLogic` + the Safe-view contract + Campaigns governance behind
Timelock.

## SAFETY-annotated try/catch sites

Every remaining `try/catch` and low-level `.call(...)` in LogicB has a
`// SAFETY:` comment naming:

- The gradient rule (e.g., M2-fix, H2-fix, M1-fix, L-4).
- Whether the catch is fail-OPEN or fail-CLOSED.
- The reason -- and the consequence of the OPPOSITE choice.

Auditors should be able to verify each gate's posture without consulting
external references. If a SAFETY comment is wrong (e.g., a fail-open
gate is documented as fail-closed), that's a finding to write up.

## What to look at first (auditor index)

1. **Storage layout.** `contracts/DatumSettlementStorage.sol` is the
   single source. `alpha-4/settlement-layout.snapshot.json` shows the
   committed layout.

2. **Dispatcher pattern.** Settlement.settleClaims +
   settleClaimsMulti collapse to `_delegateToLogicA()`. Verify
   `msg.data` forwarding + `abi.decode(ret, (SettlementResult))` is
   correct.

3. **Inner pipeline.** `DatumSettlementLogicB.processBatch` is the
   ~520-line per-batch body. The fail-open/fail-closed gradient sits
   here. Cross-reference SAFETY comments against the M2/H2/M1 fix
   commits.

4. **Pure helper.** `_assuranceDecision` on the storage base is the
   only pure function in the gradient. Table-tested exhaustively in
   `test/assurance-gradient.test.ts`.

5. **Safe views.** `getCampaign*Safe` variants on `DatumCampaigns`.
   Verify each one is non-revertable for any input.

6. **Lock-once cluster.** `setClaimValidator`, `setPublishers`,
   `setNullifierRegistry`, ..., and `lockLogic`. All single-write
   followed by revert pattern.

## File index

| Concern | File |
|---|---|
| Storage base | `contracts/DatumSettlementStorage.sol` |
| Shell + dispatchers | `contracts/DatumSettlement.sol` |
| Relay outer loop | `contracts/DatumSettlementLogicA.sol` |
| Inner pipeline | `contracts/DatumSettlementLogicB.sol` |
| Layout snapshot | `alpha-4/settlement-layout.snapshot.json` |
| Snapshot regen | `alpha-4/scripts/dump-settlement-layout.ts` |
| Layout test | `alpha-4/test/settlement-layout.test.ts` |
| msg.sender test | `alpha-4/test/settlement-msgsender.test.ts` |
| Gradient test | `alpha-4/test/assurance-gradient.test.ts` |
| Deploy gate | `alpha-4/scripts/deploy.ts` (`validateSettlementLayoutMatchesSnapshot`) |
| Phase-by-phase history | `alpha-4/SETTLEMENT-EIP170-PLANNING.md` |
| Pre-audit hedges | `alpha-4/AUDIT-HEDGES.md` |
