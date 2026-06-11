# Phase-Ladder Plan — custody + governance progression to core launch

**Scope:** RUNBOOK-CORE-LAUNCH.md Phase 5. This is the *executable operational
plan* for custody and the Admin → Council → OpenGov progression, and the schedule
for firing the `lock*()` cypherpunk commitments. The *mechanism* (router storage,
`migrate`, the lock-once retrofit) is specified in `upgrade-ladder-design.md`;
this doc says **who holds what, in what order, and which calls fire when**.

Governing principle (STATUS.md "Cypherpunk Roadmap"): **upgradable today, locked
tomorrow.** Through Admin + Council every contract stays governance-replaceable;
the `lock*()` functions all `revert not-opengov` pre-OpenGov. Only once OpenGov is
in charge does governance *choose* to fire locks per-contract, ratifying the
code-is-law end-state piecemeal.

---

## 1. Custody model (who owns what)

Two independent authorities per upgradable contract (`DatumUpgradable`):

| Pointer | Holds | Purpose |
|---|---|---|
| `owner` (2-step `DatumOwnable`) | the **Timelock** (48h) | operational control: one-shot wiring (`setRouter`), `lock*()` (`onlyOwner whenOpenGovPhase`), ownership-gated params |
| `router` (lock-once) | the **GovernanceRouter** | phase + `governor`; `onlyGovernance` = `router.governor()` |

`router.governor()` resolves per phase:
- **Admin (0):** a **multisig / Safe** (NOT a bare EOA on mainnet)
- **Council (1):** the `DatumCouncil` contract (N-of-M)
- **OpenGov (2):** `DatumGovernanceV2` (conviction voting → ParameterGovernance/Timelock)

`Timelock` (the contract `owner`) executes on behalf of whoever governance is:
48h `TIMELOCK_DELAY`, 7d `PROPOSAL_TIMEOUT`, ≤10 concurrent. So every
owner-gated action (including `setGovernor` and every `lock*()`) inherits a 48h delay.

**Today (Paseo MVP / Phase 0):** `owner` was transferred to the Timelock as
*pendingOwner only* (2-step; `acceptOwnership` never called), so the deployer EOA
is still the effective owner for fast iteration. `governor` = deployer EOA.
`phase = 0`, `phaseFloor = 0`.

### Phase-5 custody gate (must complete before mainnet)
1. Deploy / designate a **Safe** (≥ 3-of-5 recommended) as the Admin-phase
   governor and as Timelock proposer.
2. `Timelock` set as `owner` of every upgradable, and **`acceptOwnership` executed**
   (not just pending) so the Timelock is the real owner.
3. `router.owner` = Timelock; `router.governor` = Safe; `phase = Admin`,
   `phaseFloor = Admin`, `hardFloor = Admin`.
4. **No `lock*()` fired** (they'd revert; deliberately stay malleable in alpha/beta).
5. Verify: `owner()` == Timelock on all upgradables; `router.governor()` == Safe;
   no EOA holds `owner` or `governor`.

---

## 2. Phase progression (exact calls)

The router uses 2-step governor handoff + a monotonic `phaseFloor` ratchet and a
hard `hardFloor`. `setGovernor` is `onlyOwner` (→ Timelock, 48h).

### Phase 0 → 1 (Admin → Council)
1. Stand up `DatumCouncil` with the production N-of-M membership.
2. Timelock executes `router.setGovernor(Council, councilAddr)` (48h delay).
3. `DatumCouncil` calls `router.acceptGovernor()` → `phase = Council`,
   `governor = council`.
4. After confidence in the Council set, anyone calls `router.raisePhaseFloor()`
   → `phaseFloor = Council` (no future `setGovernor` can regress below Council via
   the soft floor; emergency `executeRegression` can still step back but not below
   `hardFloor`).
5. *(Optional, pre-mainnet checklist "Curator locks" are NOT here — they are
   OpenGov-phase, see §3.)*

### Phase 1 → 2 (Council → OpenGov)
1. Stand up `DatumGovernanceV2` (conviction voting), wired to ParameterGovernance
   + Timelock.
2. Council passes, Timelock executes `router.setGovernor(OpenGov, govV2Addr)`.
3. `DatumGovernanceV2` calls `router.acceptGovernor()` → `phase = OpenGov`.
4. After confidence, `router.raisePhaseFloor()` → `phaseFloor = OpenGov`. The
   system is now permanently at OpenGov (modulo the hard-floored emergency path).

### Emergency regression
`proposeRegression(newPhase, newGovernor)` (current governor) → 48h
(`regressionTimelockBlocks`) → permissionless `executeRegression()`. Resets the
**soft** `phaseFloor` down with it; cannot go below `hardFloor`. Use only to
recover from a captured/bricked governor.

---

## 3. Lock-firing schedule (OpenGov only)

Every commitment below is `onlyOwner whenOpenGovPhase` → fires **only at Phase 2**,
via the Timelock (48h each), as an explicit OpenGov decision. They are
**irreversible**. Fire in dependency order, subsystem by subsystem, validating
each before the next. Recommended order:

**Tier A — structural plumbing (rug protection first).** `lockPlumbing()` on the
funds/settlement cluster freezes the canonical cross-refs so even a captured owner
can't re-point escrow at an attacker: `DatumSettlement` (umbrella),
`DatumPaymentVault.lockSettlementRef`, `DatumBudgetLedger` (+ `lockTreasury`),
`DatumClaimValidator`, `DatumNullifierRegistry`, `DatumMintCoordinator`,
`DatumDualSigSettlement`, `DatumRelay`, `DatumCampaignLifecycle`,
`DatumCampaignAllowlist`, `DatumCampaignCreative`, `DatumClickRegistry`,
`DatumPowEngine`, `DatumPublisherReputation`, `DatumReports`, `DatumRelayStake`,
`DatumRelayGovernance`, `DatumGovernanceRouter.lockPlumbing`, `DatumCampaigns.lockBootstrap`.

**Tier B — policy / curator anchoring.** `DatumGovernanceRouter.lockCouncil`
(anchors the CB5 bicameral veto Council), `DatumCouncilBlocklistCurator.lockCouncil`,
`DatumPublishers.lockBlocklistCurator`, `DatumTagSystem.lockTagCurator` / `lockLanes`,
`DatumPublishers.lockWhitelistMode` / `lockStakeGate` / `lockPauseRegistry`,
`DatumParameterGovernance.lockWhitelist`, `DatumZKStake.lockSlashers`.

**Tier C — economic parameter floors.** `DatumCampaigns.lockMinimumCpmFloor` /
`lockPendingTimeoutBlocks`, `DatumCampaignLifecycle.lockInactivityTimeoutBlocks`,
`DatumPauseRegistry.lockGuardianSet` / `lockPauseParams`,
`DatumPaymentVault.lockFeeShareRecipient`, `DatumSettlement.lockLogic`
(freeze the DELEGATECALL logic split).

**Tier D — relay + token + identity end-state.** `DatumRelay.lockRelayerOpen`
(NB: this commits the relay to **permissionless-forever**, the cypherpunk
end-state — *not* a curation lockdown; do it only when the open-relay path is the
intended final design), the token-plane locks (MintAuthority/Wrapper/Vesting/
FeeShare), and the identity/oracle sunset:
`DatumPeopleChainIdentity.lockOracleReporter` (retire the oracle reporter) /
`lockXcmDispatcher`, `DatumPeopleChainXcmBridge.lockSovereign` /
`lockPalletCallIndices`, `DatumBondedIdentityReporter.lockCache`.

**Pre-OpenGov reality:** none of the above can fire. The PRE-MAINNET-CHECKLIST
"Curator locks / Phase floor / relay lockRelayerOpen" items are therefore
**OpenGov-phase commitments, not launch steps** — on a fresh Admin-phase deploy
they are deliberately deferred.

---

## 4. End-state (cypherpunk target)

Every `lock*()` fired, `oracleReporter` retired, the relay committed to its final
mode, plumbing frozen, `phaseFloor = hardFloor = OpenGov`. At that point the
original "code-is-law" guarantees are OpenGov-ratified commitments rather than
owner-mutable config — the system is fully decentralized and immutable in its
core invariants. Until then, each phase trades a measured amount of mutability
for decentralization, on governance's schedule.

---

## 5. Phase-5 deliverable checklist
- [ ] Safe (N-of-M) deployed; designated Admin-phase governor + Timelock proposer.
- [ ] Timelock owns every upgradable (`acceptOwnership` executed, not pending).
- [ ] `router.owner = Timelock`, `router.governor = Safe`, `phase/floor = Admin`.
- [ ] No EOA holds `owner` or `governor` anywhere.
- [ ] This plan reviewed; the Tier A–D firing order signed off as the OpenGov
      ratification sequence.
- [ ] (Deferred to OpenGov) the lock-firing campaign itself.
