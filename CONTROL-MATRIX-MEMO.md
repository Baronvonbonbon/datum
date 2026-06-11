# DATUM — Per-Phase Fund-Control Matrix

- **Date:** 2026-06-11
- **Author:** Internal (engineering), prepared for regulatory counsel
- **Purpose:** Document *who can move or seize which pools of value, in which
  governance phase*, grounded in contract `file:line`. This is the artifact a
  money-transmission / MSB analysis turns on: FinCEN's controlling question is
  whether a **person has independent control** over value that belongs to
  someone else. This memo answers "who has control" per phase, per fund pool.
- **NOT legal advice.** Engineering description of control surfaces only.
  Classification (FinCEN MSB, state money-transmitter, EU MiCA, etc.) is a legal
  determination for counsel. All paths reference `alpha-core/contracts/`.

---

## 1. The two control planes

Every fund pool in DATUM is reachable through two independent authority planes.
A control analysis must consider both — seizing the *owner* key is not required
if you hold the *upgrade* key, and vice-versa.

### Plane A — Upgrade plane (the master key)

`DatumGovernanceRouter.upgradeContract(name, newAddr)` is `onlyGovernor`
(`DatumGovernanceRouter.sol:476`). It repoints the registry entry for any
registered contract to attacker-chosen code and atomically fires
`freeze(old)` + `migrate(new)` (`:494-496`). **Whoever is `governor` can replace
the code of `DatumSettlement`, `DatumPaymentVault`, `DatumBudgetLedger`, the
token plane — any registered contract — and thereby reach every pooled fund.**
This plane dominates the analysis: it is custody-by-upgradeability.

- `governor` identity is set by `setGovernor(newPhase, newGovernor)`, which is
  `onlyOwner` of the router (`:138`) — the owner is the `DatumTimelock`.
- Handoff is two-step: the new governor must `acceptGovernor()` from its own
  address (`:168`), and a `phaseFloor` / `hardFloor` ratchet
  (`:82,97,138-147`) prevents a compromised governor from regressing the phase
  below the hardest floor reached.

### Plane B — Owner plane (per-contract setters & sweeps)

Each fund contract inherits `DatumOwnable` (two-step ownership). Its `onlyOwner`
functions — wiring setters, treasury setters, dust sweeps, protocol-fee
withdrawal — are controlled by that contract's owner. At deploy the deployer is
owner; **PHASE 3 of `deploy.ts` transfers every contract's ownership to the
`DatumTimelock`** via two-step `transferOwnership` → `acceptOwnership`
(`scripts/deploy.ts:2574-2625`). The Timelock gates these behind
`propose` (`onlyOwner`, `DatumTimelock.sol:42`) + a delay + permissionless
`execute` (`:63`); proposals expire after 7 days (`:16`).

### The phase gate

`whenOpenGovPhase` (`DatumUpgradable.sol:141-145`) requires `router.phase() == 2`.
Every cypherpunk `lock*()` commitment — `lockPlumbing`, `lockTreasury`,
`stageIssuerTransfer`, etc. — is gated on it, so **no lock can fire until
OpenGov (Phase 2).** Pre-Phase-2 the system is intentionally fully malleable.

---

## 2. Phase model

`DatumGovernanceRouter.GovernancePhase`: `0 = Admin`, `1 = Council`,
`2 = OpenGov` (`:47`). The active `governor` differs per phase; the router
`owner` (Timelock) is constant.

| Phase | `governor` (holds Plane A) | Upgrade friction | Locks (`lock*`) |
|---|---|---|---|
| **0 — Admin** | Deployer EOA / AdminGovernance (`deploy.ts:861`) | **Instant** — one tx, one key | Cannot fire (gated to Phase 2) |
| **1 — Council** | `DatumCouncil` (N-of-M) | Council vote + execution + veto window | Cannot fire |
| **2 — OpenGov** | `DatumGovernanceV2` (conviction-weighted, open) | Open vote + 48h Timelock | **Can be fired one-by-one** |

---

## 3. Master control matrix — who can reach each fund pool

Legend: **● full/independent control** · **◐ controlled by a defined group /
behind timelock** · **○ no privileged control (permissionless / beneficiary-only)**.

| Fund pool | Custody location | Phase 0 (Admin) | Phase 1 (Council) | Phase 2 (OpenGov, locks fired) |
|---|---|---|---|---|
| **Campaign escrow** (advertiser budget awaiting settlement) | `DatumBudgetLedger` | ● deployer (upgrade plane) | ◐ Council vote | ○ open vote + 48h timelock only |
| **Pending settled balances** (user + publisher) | `DatumPaymentVault` | ● deployer (upgrade plane) | ◐ Council vote | ○ open vote + 48h timelock only |
| **Protocol fee share** | `DatumPaymentVault` | ● deployer (owner: `withdrawProtocol`) | ◐ Timelock-gated owner | ◐ Timelock-gated owner |
| **User/publisher dust** | `DatumPaymentVault` sweeps | ● deployer (owner, ≤ `MAX_DUST_THRESHOLD`) | ◐ Timelock-gated | ◐ Timelock-gated |
| **Staked DOT** (publisher/advertiser/relay/ZK) | respective `*Stake` | ◐ slash via gov; ● upgrade plane | ◐ Council | ○ open vote only |
| **DATUM issuance** (mint) | `DatumMintAuthority` / `MintCoordinator` | ● deployer (upgrade + owner wiring) | ◐ Council | ◐ open vote; issuer transfer lockable |
| **WDATUM ↔ canonical** | `DatumWrapper` | ● deployer (upgrade plane) | ◐ Council | ○ atomic 1:1, no privileged mover |
| **Fee-share dividends** | `DatumFeeShare` | ● deployer (upgrade plane) | ◐ Council | ○ beneficiary stake/claim only |

---

## 4. Per-pool detail (control surfaces, with evidence)

### 4.1 Campaign escrow — `DatumBudgetLedger`

Held value: advertiser budgets between funding and settlement.

- **No direct owner drain exists.** State changes are role-gated to the wired
  contracts: `initializeBudget` only by Campaigns (`:170`), `deductAndTransfer`
  only by Settlement (`:200`), refunds only by Lifecycle (`:237,282`).
- **Indirect owner control:** owner can repoint those roles —
  `setCampaigns`/`setSettlement`/`setLifecycle` (`:135-149`) — so a malicious
  owner can install a contract that drains escrow. Gated `whenOpenGovPhase` for
  the lock (`lockTreasury` `:120`) but the *setters themselves* are owner-only.
- **Upgrade-plane control:** the whole ledger can be replaced via
  `upgradeContract`. **Phase 0 = deployer can do this in one tx.**

### 4.2 Pending settled balances — `DatumPaymentVault`

Held value: user + publisher earnings after settlement, before withdrawal.

- **Steady-state is non-custodial:** withdrawals are pull-payment,
  beneficiary-only — `withdrawUser`/`withdrawPublisher` zero `msg.sender`'s own
  balance (`:235-267`); `emergencyWithdraw` routes to a *user-configured*
  recovery address, not the operator (`:377`); `withdrawUserBySig` is a gas
  relayer that still pays the user (`:288`). The operator **cannot** redirect a
  beneficiary's balance to a third party through the owner plane.
- **Owner can move *user* funds in two bounded ways:** `sweepPublisherDust` /
  `sweepUserDust` (`:439,458`) move balances below `MAX_DUST_THRESHOLD`
  (0.01 DOT, `:432`) to treasury. Bounded, but any owner ability to move user
  value is a custodial indicator. `withdrawProtocol` (`:323`) takes only the
  protocol's own fee, not user funds.
- **Upgrade-plane control overrides all of the above** — the vault can be
  replaced wholesale. **Phase 0 = deployer, one tx.**

### 4.3 Token plane — `DatumMintAuthority` / `MintCoordinator` / `Wrapper`

Higher regulatory salience: issuing/redeeming a CVC is "administrator of a CVC."

- Mint is role-gated: `mintForSettlement` only by settlement (`MintAuthority.sol:157`),
  `mintForVesting` only by vesting (`:180`), hard-capped at `MINTABLE_CAP`
  (95M, `:47,160`).
- Owner wires the plane: `setWrapper`/`setSettlement`/`setVesting`
  (`:107-121`); `MintCoordinator.setMintRate` is `onlyOwnerOrPG` (`:189`).
- Issuer transfer is `onlyOwner whenOpenGovPhase` + two-step (`:203,232`) —
  i.e. the issuer key can only be handed off once OpenGov is live.
- **Phase 0:** deployer (owner + upgrade plane) effectively controls issuance.

### 4.4 Stakes

User-supplied bonds (`DatumPublisherStake`, `AdvertiserStake`, `RelayStake`,
`ZKStake`). Withdrawals are user-initiated after a lockup; slashing is governed
by the matching `*Governance`. Upgrade plane still applies (Phase 0 = deployer).

---

## 5. Control reading per phase (for the MSB question)

- **Phase 0 (Admin) — single point of control.** The deployer is the router
  `governor` and can `upgradeContract` *any* fund-holding contract in one
  transaction (`DatumGovernanceRouter.sol:476`), and (if it also holds the
  Timelock proposer key — see §6) can reach every owner-plane lever after the
  delay. One identifiable person has **independent control over third-party
  value** (advertiser escrow, user/publisher pending balances, the mint). This
  is the phase most exposed to a money-transmission reading; the non-custodial
  pull-payment design of the vault does **not** neutralize it, because upgrade
  control sits above it.

- **Phase 1 (Council) — controlling coalition.** Control of Plane A moves to a
  known N-of-M body (`DatumCouncil`) behind a vote + execution + veto window.
  No single person, but a defined, identifiable group still controls the funds.
  Whether that is "sufficiently decentralized" is exactly the contested legal
  question — not a bright line.

- **Phase 2 (OpenGov, `lock*()` fired) — Plane A decentralized, Plane B root
  NOT.** Plane A (`upgradeContract`) moves to an open conviction-weighted vote:
  the deployer is no longer `governor` and cannot replace contract code. The
  `lock*()` commitments freeze structural references and lock the issuer key
  (`whenOpenGovPhase`, `DatumUpgradable.sol:141`). **However** — per the trace in
  §6.1 — the deployer still owns the `DatumTimelock`, which owns every fund
  contract and the router. So the deployer can still `propose` (→ 48h →
  permissionless `execute`) any *un-locked* owner-plane lever: the dust sweeps,
  any structural setter whose `lock*()` has not been fired, and
  `router.setGovernor` itself (bounded by the `hardFloor` ratchet, which blocks
  regression below the hardest floor but not arbitrary owner-plane calls). The
  "developers published software they no longer control" posture is therefore
  **only true once Timelock ownership is also moved to a governance-controlled
  account AND every relevant `lock*()` has fired.** Until then, an identifiable
  person retains delayed-but-real control of owner-plane funds even in OpenGov
  phase. (cf. FinCEN 2019 CVC guidance on independent control of value.)
  **This is the pre-remediation reading; §8 documents the Option-2 fix that moves
  the admin root to the Council.**

**Trajectory:** the governance ladder is, in control terms, a migration *out of*
the most MSB-exposed posture and *into* the least. The regulatory exposure is
therefore highest during the alpha/beta window the project is in today.

---

## 6. Open items counsel must pin down

These determine cells in the matrix and are operational, not yet fixed in code:

1. **Who owns the `DatumTimelock`? — TRACED 2026-06-11: the deployer, in every
   phase.** `DatumOwnable` sets `owner = msg.sender` at construction
   (`DatumOwnable.sol:16`); the Timelock is deployed with no constructor args
   (`deploy.ts:575`), so the **deployer becomes its owner**. Its
   `propose`/`cancel` are `onlyOwner` (`DatumTimelock.sol:42,82`), so the owner
   is the sole proposer. `deploy.ts` PHASE 3 transfers the *GovernanceRouter*
   and the core fund contracts **to** the Timelock (`:2620-2643`) — but the
   **Timelock is never itself a subject of `transferOwnershipIfNeeded`** in
   `deploy.ts` or `deploy-token.ts`; it is only ever a *recipient*.
   **Consequence:** the deployer retains sole proposer authority over the
   Timelock across Phases 0/1/2, and therefore controls `router.setGovernor`
   (the phase lever itself) and every `onlyOwner` fund lever — behind the 48h
   delay — even in OpenGov phase. The ladder decentralizes Plane A (the
   `governor`); the root of Plane B (the Timelock owner) stays with the deployer
   **unless moved by a manual, unscripted ownership transfer.** This materially
   weakens the "no identifiable controller" reading even at Phase 2. Counsel
   should treat moving Timelock ownership to a governance-controlled account as
   a prerequisite for any "sufficiently decentralized" argument; engineering
   should confirm whether `DatumGovernanceV2` can even drive `timelock.propose`
   (it is not structured as a Timelock proposer today) or whether a governance
   multisig is intended. **RESOLVED — see §8:** `GovernanceV2` is campaign-only
   and cannot drive the Timelock or `upgradeContract`; the chosen remediation
   (Option 2) makes the **Council** the Timelock owner and the standing
   admin/upgrade executor.
2. **Time spent in Phase 0.** The longer the live system sits in Admin phase,
   the longer the single-controller posture persists. Counsel will want a
   committed timeline for Phase 1 / Phase 2 transitions.
3. **The dust sweeps** (`sweepUserDust`/`sweepPublisherDust`) — any owner ability
   to move user balances, even sub-ED, is worth a deliberate keep/remove
   decision given its custodial-indicator weight.
4. **Token plane as a separate determination.** Wrapper/Mint/FeeShare
   (CVC issuance/redemption) should be analyzed distinctly from the settlement
   plane; it has a more direct "administrator of a CVC" nexus.
5. **Relay operator posture.** The relay broadcasts signed batches and never
   takes custody (funds move contract → vault → beneficiary). Confirm with
   counsel that this "broadcaster/validator" framing holds and that no off-chain
   relay variant accepts user funds into an operator-controlled account.

---

## 7. Engineering levers that strengthen a non-MSB position

Surfaced for the design discussion, not as legal conclusions:

- Shorten time in Admin phase; commit to a published phase-transition timeline.
- Move the Timelock proposer key off the deployer EOA toward the Council as
  early as the ladder allows.
- Reconsider / further constrain owner movement of user balances (dust sweeps).
- Fire the `lock*()` commitments as soon as OpenGov is live to make the
  no-independent-control posture provable on-chain.
- Keep the relay strictly non-custodial and document it.

---

## 8. Admin-control remediation (Option 2 — implemented 2026-06-11)

The §6.1 finding (deployer is the sole admin root in every phase) is being
remediated by moving the admin root from the deployer EOA to the **Council**
(N-of-M). Two parts:

### 8.1 Router admin/campaign governor split (`DatumGovernanceRouter.sol`)

The router had a single `governor` slot doing both campaign lifecycle *and*
`upgradeContract` + phase regression. At Phase 2 the governor is `GovernanceV2`,
which is campaign-only and has **no call path to `upgradeContract`** — so with
the Timelock hand-off alone, upgrades would freeze at OpenGov.

Fix: a second authority, **`adminGovernor`**, now gates the admin-class
functions independently of the campaign `governor`:

- `upgradeContract`, `proposeRegression`, `cancelRegression` → `onlyAdminGovernor`.
- `activateCampaign` / `terminateCampaign` / `demoteCampaign` / `proposeHighTier`
  → remain on `governor` (the open campaign body).
- `adminGovernor` defaults to the constructor `_governor` (Phase-0 deployer), so
  single-key behavior is unchanged until `setAdminGovernor` (owner/Timelock-gated)
  points it at the Council.

Result: campaign governance = open `GovernanceV2`; admin + upgrades + emergency
regression = Council, at all phases. Tests:
`test/governance-router-registry.test.ts` ("adminGovernor split" + OpenGov-phase
blocks). 1674 tests pass.

### 8.2 Timelock ownership → Council (`scripts/transfer-timelock-to-council.ts`)

A guarded, deliberate operational script (the relinquishment is end-of-alpha, not
every deploy):

1. Pre-flight: assert the Council is functional (`memberCount > 0`) and print the
   full current control state.
2. `setAdminGovernor(Council)` via a Timelock proposal (router is Timelock-owned
   post-deploy; the deployer still owns the Timelock so it can propose) → 48h →
   execute.
3. `timelock.transferOwnership(Council)` (deployer-direct; sets `pendingOwner`).
4. Runbook for the Council-side steps the deployer cannot perform: the Council
   executes `timelock.acceptOwnership()` via a Council proposal.

### 8.3 Post-remediation control reading

After 8.1 + 8.2, the controlling party for the admin/upgrade surface is the
**Council (defined N-of-M)**, not the deployer — materially stronger than the
single-key posture and a defensible "controlling group, behind a 48h timelock"
story. It is **not** "no identifiable controller": per the kept-upgradable
decision the system is **upgradable via governance indefinitely** (there is no
registry-disable function and `renounceOwnership` is disabled,
`DatumOwnable.sol:40`). "Finalization" means firing the per-contract `lock*()`
commitments + the `hardFloor` ratchet, **not** code immutability. A compromised
Council therefore = compromised admin root (and, since `timelock` stays in the
upgradable registry, could replace the Timelock); this is the accepted trust
model, mitigated by Council-membership hygiene and firing `lock*()` to shrink the
reachable surface.

---

_Maintenance: re-generate on any change to the governance ladder, the owner of
a fund-holding contract, the Timelock owner, the router `adminGovernor`, or the
PaymentVault/BudgetLedger withdrawal surface._
