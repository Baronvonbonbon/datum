# Upgrade Ladder — Design

**Status:** **SHIPPED** as of 2026-05-18. Stages 1–6 complete across 22
commits (`16291e1` Stage 1 router registry → `bd59fa4` Stage 6 audit-prep).
~36 of ~38 contracts inherit DatumUpgradable. Lock-once functions
phase-gated on OpenGov. Web app reads addresses from the on-chain
registry. **Cypherpunk locking remains the roadmap end-state** — alpha
posture intentionally loosens those commitments so we can iterate
during testing.

**Date:** 2026-05-17 (design); shipped 2026-05-18

**Context:** Pre-mainnet flexibility play. Allow the protocol to upgrade
and replace any contract via a phased governance ladder (deploy admin →
Council → OpenGov) during alpha/beta. The cypherpunk "code-is-law" goal
becomes an _eventual_ commitment — locked in by OpenGov choosing to fire
the lock-once functions when the system is stable. Until then, every
contract is replaceable.

This doc supersedes the implicit "deploy and don't touch" model for
all 36 contracts in the alpha-4 tree (including token plane:
MintAuthority, Wrapper, Vesting, BootstrapPool, FeeShare).

## Approved decisions (recap)

| Decision | Answer |
|---|---|
| Upgrade mechanism | **Replaceable references** (new addresses, governance updates pointers via registry) |
| Phase granularity | **Global** — single `router.phase` controls all contracts simultaneously |
| Phase reversibility | **Revocable in emergencies** — OpenGov can step back to Council (48h timelocked) |
| Lock-once future | **Phase-gated** — locks blocked pre-OpenGov; OpenGov chooses when to fire them, ratifying cypherpunk end-state |
| Admin identity | **Deployer EOA → 3-of-5 Safe before mainnet** |
| State migration | **On-chain `migrate(oldContract)` per contract** (governance-only, pause v1 first) |
| Scope | **Everything upgradable**, including token-plane irrevocable-sunset contracts |

## 1. Architecture

```
                ┌────────────────────────────────────┐
                │   DatumGovernanceRouter (extended) │
                │   - phase                          │
                │   - phasePromote()/phaseRegress()  │
                │   - contractAddrs[name] → address  │
                │   - upgradeContract(name, newAddr) │
                └─────────────┬──────────────────────┘
                              │
                              │ phase-gated authority
                              ▼
        ┌────────────────────────────────────────────────┐
        │   Every contract:                               │
        │   - paused (bool)                              │
        │   - pause() / unpause() — onlyGovernance       │
        │   - migrate(address old) — onlyGovernance       │
        │   - lockX() functions — require phase==OpenGov │
        │   - owner = router (for upgrade authorization) │
        └────────────────────────────────────────────────┘
                              ▲
                              │ reads "current addr of X"
        ┌─────────────────────┴──────────────────────────┐
        │   Consumers (other contracts):                  │
        │   - cached reference, updated via setter when  │
        │     upgrade fires                              │
        │   - web/extension: registry.contractAddrs[X]   │
        └────────────────────────────────────────────────┘
```

The existing `DatumGovernanceRouter` already does this for the
governance role: it holds a phase value + a pointer to the current
governor. We extend it into a **contract registry**.

## 2. The registry (extended `DatumGovernanceRouter`)

### New storage
```solidity
mapping(bytes32 => address) public currentAddrOf;   // name → live address
mapping(bytes32 => address[]) public addressHistory;
mapping(bytes32 => uint256) public versionOf;       // name → current version
```

`bytes32` keys are `keccak256("contractName")`. We pre-define the
canonical name list off-chain to keep encoding consistent.

### New external functions
```solidity
/// Phase-gated. Admin = deployer/Safe. Council = council vote. OpenGov = passed proposal.
function upgradeContract(bytes32 name, address newAddr) external;

/// Promote phase one step. Monotonic from Admin → Council → OpenGov, but
/// can step back via regressPhase() (48h timelocked).
function promotePhase() external;
function regressPhase() external; // 48h timelock

/// Convenience read for consumers + UI.
function contractAddr(string calldata name) external view returns (address);
function contractVersion(string calldata name) external view returns (uint256);
```

### Authorization rules
| Phase | `upgradeContract` callable by |
|---|---|
| Admin | Owner of the router (deployer EOA / Safe) |
| Council | Council via `DatumCouncil.execute(...)` (existing pattern) |
| OpenGov | `DatumGovernanceV2` via `ParameterGovernance.execute(...)` |

`regressPhase()` is callable by the **current** phase's authority and
goes through the existing `DatumTimelock` for the 48h delay.

## 3. Per-contract requirements

Every contract gets four additions:

### 3a. `version()` view
```solidity
function version() external pure returns (uint256) { return N; }
```
N starts at 1; each upgrade increments. Allows consumers + auditors to
verify which version they're talking to.

### 3b. `paused` flag + governance pause
```solidity
bool public paused;
function pause() external onlyGovernance { paused = true; emit Paused(); }
function unpause() external onlyGovernance { paused = false; emit Unpaused(); }

modifier whenNotPaused() { require(!paused, "paused"); _; }
```

Every state-mutating external function gets `whenNotPaused`. Reads stay
available so migration can read state.

Existing `DatumPauseRegistry` handles category-based pause across the
system; this is a per-contract pause for migration use specifically.
No overlap with the existing pause mechanism.

### 3c. `migrate(address oldContract)` function
```solidity
function migrate(address oldContract) external onlyGovernance {
    require(version() > IUpgradable(oldContract).version(), "downgrade");
    require(IUpgradable(oldContract).paused(), "old-not-paused");
    // Per-contract implementation reads old's storage and writes to self.
    _migrate(oldContract);
}
```

The `_migrate` internal implementation is per-contract specific. State-
heavy contracts have detailed implementations; stateless contracts
have a no-op.

### 3d. `onlyGovernance` modifier (replaces `onlyOwner` where applicable)
```solidity
modifier onlyGovernance() {
    require(msg.sender == router.governorForPhase(currentPhase), "E18");
    _;
}
```

The router's `governorForPhase` returns the address authorized for the
current phase. Backward-compatible with `onlyOwner` since the router IS
the owner.

## 4. Phase progression mechanics

### Admin → Council
- Council members must be configured + Council contract deployed
- Deployer calls `router.promotePhase()`
- Subsequent upgrades require Council vote

### Council → OpenGov
- DatumGovernanceV2 must be live + Timelock at appropriate windows
- Council votes to call `router.promotePhase()`
- Subsequent upgrades require OpenGov proposal (passed → Timelock 48h → executed)

### Regression (emergencies)
- Current governor calls `router.regressPhase()` — goes into Timelock
- 48h delay before regression takes effect
- After 48h, anyone can `router.executeRegression()`
- This gives the community 48h to scream-tweet about a malicious
  regression attempt before it takes effect

**Why regression matters:** if OpenGov votes go wrong during alpha
(adversarial proposal passes, governance attack, bug in OpenGov
itself), the Council can recover. The 48h delay prevents reflexive
downgrade abuse.

## 5. Lock-once retrofit

Every existing `lock*` function gets phase-gated:

```solidity
function lockSovereign() external onlyOwner {
    require(router.phase() == GovernancePhase.OpenGov, "E18");
    require(peopleChainSovereign != address(0), "E00");
    sovereignLocked = true;
    emit SovereignLocked();
}
```

**Functions affected (existing in `main`):**
- `DatumPeopleChainXcmBridge.lockSovereign`
- `DatumPeopleChainXcmBridge.lockPalletCallIndices`
- `DatumPeopleChainIdentity.lockOracleReporter`
- `DatumPeopleChainIdentity.lockXcmDispatcher`
- `DatumBondedIdentityReporter.lockCache`
- `DatumGovernanceRouter.raisePhaseFloor` (this is the router itself
  ratifying phase progression; meaning of "lock" here is different)
- `DatumPublishers.lockBlocklistCurator`
- `DatumCampaigns.lockTagCurator`
- `DatumCouncilBlocklistCurator.lockCouncil`
- `DatumTagCurator.lockCouncil`
- `DatumPublishers.lockWhitelistMode`, `lockStakeGate`
- `DatumChallengeBonds.lockCampaignsContract`, `lockLifecycleContract`,
  `lockGovernanceContract`
- `DatumMintAuthority.lockIssuer` (via `acceptIssuerRole`)
- `DatumCampaigns.lockPlumbing` (if exists; check)
- `DatumGovernanceRouter.lockPlumbing` (already exists)

**Migration plan**: each gets a one-line `require(router.phase() ==
OpenGov)` added at the top of the function. No other behavior change.

**Once OpenGov can fire a lock**, that lock IS the cypherpunk
commitment for that contract. After firing, the corresponding upgrade
ability is constrained or eliminated.

## 6. Per-contract upgrade matrix

For each contract: classification (stateless / state-light /
state-heavy) and migration approach.

### Token plane (6 contracts) — previously irrevocable, now upgradable
| Contract | State | Migration approach |
|---|---|---|
| `DatumMintAuthority` | Mint allowance counters | `migrate()` reads totalMinted + per-recipient cumulative amounts |
| `DatumWrapper` | WDATUM total supply, balances, allowances (ERC20) | `migrate()` reads full balance + allowance map; v2 paused-init |
| `DatumVesting` | Per-recipient schedule + claimed counters | `migrate()` per-recipient entry |
| `DatumBootstrapPool` | Per-claim flag map, remaining pool | `migrate()` per-claim-flag entry + remaining counter |
| `DatumFeeShare` | Per-staker fee accumulator state | `migrate()` per-staker + accDotPerShare |
| `AssetHubPrecompileMock` | Devnet only | No migration needed (replaced by real precompile on mainnet) |

**Note:** the existing `DatumMintAuthority.acceptIssuerRole` was
"irrevocable forever." With upgradability, the upgraded v2 can re-
acquire the issuer role only if the precompile permits. This is a
**material change to token economics guarantees** — needs called out
in TOKENOMICS.md.

### Identity plane (3 contracts) — newest, designed with upgrades in mind
| Contract | State | Migration approach |
|---|---|---|
| `DatumPeopleChainIdentity` | Per-user IdentityRecord | `migrate()` iterates registered users (event-sourced or list-tracked) |
| `DatumPeopleChainXcmBridge` | Per-user `lastRefreshBlock`, per-campaign escrow | `migrate()` reads both maps |
| `DatumBondedIdentityReporter` | Reporter set + pending attestations | `migrate()` reporters + pendingPayout (drop in-flight attestations or wait for them to finalize first) |

### Governance plane (5 contracts)
| Contract | State | Migration approach |
|---|---|---|
| `DatumGovernanceRouter` | Phase + contract registry — itself the upgrade hub | Special handling: a router upgrade is the most dangerous. Document a recovery runbook |
| `DatumGovernanceV2` | Active proposals + conviction stakes | `migrate()` reads pending proposals; in-flight votes need explicit settle-or-cancel decision |
| `DatumPublisherGovernance` | Active fraud claims | `migrate()` reads pending claims |
| `DatumAdvertiserGovernance` | Active fraud claims | Same pattern |
| `DatumCouncil` | Member set | `migrate()` reads member list |
| `DatumParameterGovernance` | Per-target/selector whitelist | `migrate()` rebuilds the whitelist |

### Settlement plane (5 contracts) — most state-heavy
| Contract | State | Migration approach |
|---|---|---|
| `DatumSettlement` | Per-claim history, per-publisher reputation, dust accumulators | Large `migrate()` — paginated to avoid out-of-gas. May need 10+ tx to complete |
| `DatumCampaigns` | Per-campaign record (status, advertiser, tags, etc.) | Paginated migration; per-campaign iteration |
| `DatumCampaignLifecycle` | Per-campaign lifecycle timers | Same pattern |
| `DatumBudgetLedger` | Per-campaign budget escrow | Paginated migration |
| `DatumPaymentVault` | Per-user pending DOT | Paginated migration |

### Publisher + targeting (5 contracts)
| Contract | State | Migration approach |
|---|---|---|
| `DatumPublishers` | Per-publisher registration + relay signer + tags | Paginated |
| `DatumPublisherStake` | Per-publisher stake + pending unstake | Paginated |
| `DatumTagRegistry` | Per-tag commitments + jurors | Paginated |
| `DatumTagCurator` | Curator pointers | Stateless-light, simple migrate |
| `DatumCouncilBlocklistCurator` | Blocklist + reasons | Paginated |

### Fraud / FP plane (4 contracts)
| Contract | State | Migration approach |
|---|---|---|
| `DatumChallengeBonds` | Per-campaign bond state | Paginated |
| `DatumActivationBonds` | Per-campaign activation + mute state | Paginated |
| `DatumAttestationVerifier` | EIP-712 nonces | Paginated |
| `DatumClaimValidator` | Stateless (validates only); pointer-only | Stateless migrate |

### Oracle plane (3 contracts)
| Contract | State | Migration approach |
|---|---|---|
| `DatumStakeRoot` (V1) | Reporter set | Paginated |
| `DatumStakeRootV2` | Reporter set + pending roots + commitments | Paginated |
| `DatumIdentityVerifier` | VK + plumbing state | Tiny, easy migrate |

### Pause + token reward (2 contracts)
| Contract | State | Migration approach |
|---|---|---|
| `DatumPauseRegistry` | Pause categories + guardian set | Tiny, easy migrate |
| `DatumTokenRewardVault` | Per-user pending ERC20 by token | Paginated |

### Misc (4 contracts)
| Contract | State | Migration approach |
|---|---|---|
| `DatumClickRegistry` | Per-impression click data | Paginated |
| `DatumInterestCommitments` | Per-user interest commitments | Paginated |
| `DatumZKVerifier` | VK + nullifier set | Paginated nullifier set |
| `DatumZKStake` | Per-user stake | Paginated |
| `DatumEmissionEngine` | Daily cap counters | Tiny, easy migrate |
| `DatumTimelock` | Per-proposal state | Paginated (active proposals only) |
| `DatumRelay` | Authorized relayer set | Paginated |

**Total: 36 contracts get the four additions** (version, pause, migrate, onlyGovernance).

## 7. Consumer re-wiring

When an upgrade fires, every consumer of the upgraded contract needs
its reference updated. Two paths:

### Path A — re-wire via setters (preferred)
Most contracts already have setters for their dependencies (e.g.,
`cache.setXcmDispatcher(addr)`, `bridge.setCampaignsContract(addr)`).
A governance batch transaction re-wires all consumers atomically.

### Path B — read from registry on hot path (heavy)
For consumers that don't have setters (or where the dependency is too
embedded), read `router.contractAddr("name")` on each call. Adds a
SLOAD per call. We only use this for new contracts; existing
constructor-fixed references stay as Path A.

### Re-wiring runbook
Upgrade procedure for contract X:
1. Deploy X.v2 (with same constructor as v1 + new state)
2. `governance.exec(X.v1.pause())`
3. `governance.exec(X.v2.migrate(X.v1))`
4. For each consumer C of X: `governance.exec(C.setX(X.v2))`
5. `governance.exec(router.upgradeContract("X", X.v2))`
6. Optionally: keep X.v1 deployed but inert (paused). Don't delete.

All five steps wrapped in a single Timelock proposal (at OpenGov phase)
or Council batch (at Council phase). Atomic from the user perspective.

## 8. Web + extension consumer changes

Currently `web/src/shared/contracts.ts` hardcodes addresses from
`deployed-addresses.json`. With upgrades, this approach goes stale.

Two-step path:
1. **Short term (now):** add `router.contractAddr()` lookup; consumers
   call this once at app start, cache the result.
2. **Long term:** consumers subscribe to `router.ContractUpgraded`
   events and auto-refresh their reference. Web app gets a "live
   upgrade detected, refreshing..." UX flash.

For Phase D (Paseo) this is overkill. Implement Step 1 only.

## 9. Implementation order

Stages, each independently committable + testable:

### Stage 1 — Router extension (~3 days)
- Add registry storage + functions to `DatumGovernanceRouter`
- `upgradeContract`, `promotePhase`, `regressPhase` with timelock
- Phase-aware authorization helper
- Tests: phase transitions, regression timelock, upgrade auth per phase

### Stage 2 — Base "Upgradable" abstract (~2 days)
- New `contracts/DatumUpgradable.sol` (replaces `DatumOwnable` for
  contracts that opt in)
- Holds `version`, `paused`, `pause()`, `unpause()`, `onlyGovernance`
- Sets default storage layout patterns (storage gap for future fields)
- Tests: pause prevents writes; owner = router; auth checks

### Stage 3 — Migrate every contract to inherit Upgradable (~2 weeks)
- 36 contracts × ~30 lines each
- Each contract gets: `version() returns 1`, pause/unpause, basic
  `migrate(old)` stub
- Storage layout audit: ensure no immutable fields where state migration
  is needed; add storage gaps in inheritance hierarchies
- Per-contract migration logic for state-heavy contracts (Settlement,
  Campaigns, PaymentVault, BudgetLedger most complex)
- Tests: pause works; basic migration round-trip; version reads correctly

### Stage 4 — Lock-once retrofit (~3 days)
- Add `require(router.phase() == OpenGov)` to every `lock*` function
- Tests: pre-OpenGov, lock calls revert; OpenGov + lock works

### Stage 5 — Deploy + web wiring (~3 days)
- Update `scripts/deploy.ts`: register every contract in router after deploy
- `web/src/shared/contracts.ts`: read from router; fallback to
  `deployed-addresses.json` for the router address itself
- Extension same

### Stage 6 — Runbook + audit prep (~1 week)
- Update `deploy-runbook-paseo.md` with upgrade procedure
- Run a test upgrade end-to-end on Paseo (e.g., deploy Bridge v2, do
  the migration dance, verify state preserved)
- Re-audit pass: every contract has new functions; review pause-
  during-migration edge cases; review re-entrancy in migrate()
- Update `MAINNET-DEFERRED-ITEMS.md`: which lock-once functions remain
  pre-mainnet decisions

**Total: ~4-5 weeks focused work.**

## 10. Risks + open questions

### Risks

- **Settlement EIP-170**: already 39KB over the 24KB limit. Adding
  `migrate()` + pause + version makes it worse. Need to extract more
  logic into libraries OR accept that EIP-170 enforcement on Paseo is
  off (it is). Document the choice.

- **Re-audit needed**: AUDIT-PASS-5 closed multiple findings with
  "fine because immutable" or "fine because lock-once". These
  invariants are weaker now. Specifically:
  - H1 (ActivationBonds bps snapshot) — still fine because snapshot is
    at the time of writeback, but worth re-verifying
  - M1 (mute strand) — `setTreasury` is no longer the only path to
    fix; upgrade also fixes. Re-verify trust assumptions
  - L6 (conviction curve (0,0)) — still fine
  - All "lock-once" defenses — need re-verifying that the pre-OpenGov
    "no lock" state doesn't enable new exploits

- **Re-entrancy in migrate()**: reading from the old contract while
  writing to self. If the old contract has callbacks (it shouldn't,
  but…) this could be a vector. Auditor should check.

- **State drift during migration**: if v1 isn't paused before
  `migrate()` is called, writes to v1 during migration are lost.
  Migrate function must require `oldContract.paused() == true`.

- **Storage layout safety**: solc inheritance can shift slots if base
  changes. Use `solc-storage-layout` to audit each contract's slot map
  pre/post upgrade.

### Open questions for implementation review

1. **Token plane sunset path**: with token contracts upgradable, what
   is the new "definitively done" commitment? Probably: governance
   can vote to renounce upgrade ability of MintAuthority via
   `lockUpgrade()`. Need to spec this.

2. **In-flight transactions during pause**: a user's `requestRefresh`
   tx submitted just before pause may revert with "paused". Whose
   problem is this — user, or the protocol should defer pause to a
   block boundary? (Lean toward "user retries; pauses are rare.")

3. **Router upgrade itself**: the router IS the registry. Upgrading
   the router is the most dangerous operation. Document an explicit
   3-phase router upgrade: deploy v2 → migrate state → ensure all
   contracts now read v2 → flip the "router" reference in
   deployed-addresses.json. Probably needs a manual operator step.

4. **Multiple in-flight upgrades**: can we upgrade two contracts in
   one Timelock proposal? Yes; the Timelock supports batch calls.
   Document the pattern.

5. **Versioning interface stability**: across versions, the contract
   ABI may differ. Consumers reading from the registry need a way to
   detect ABI changes. Convention: bump `version()` for any breaking
   ABI change; UI checks expected version before calling.

## 11. Decision summary table

| Question | Decision | Why |
|---|---|---|
| Mechanism | Replaceable references | Lower retrofit; no proxy bugs; each version auditable |
| Phase | Global ladder | Matches existing GovernanceRouter; simpler |
| Regression | OpenGov → Council, 48h timelock | Escape valve for governance attacks |
| Locks | Gated on OpenGov phase | Cypherpunk end-state via OpenGov choice, not unilaterally |
| Admin | Deployer EOA → 3-of-5 Safe pre-mainnet | Fast iteration in alpha, hardened pre-mainnet |
| State migration | On-chain `migrate(old)` per contract | Trust-minimised; verifiable |
| Scope | Everything upgradable | No carve-outs; OpenGov decides what to lock |
| Token plane | Upgradable; sunset guarantees deferred to OpenGov | Consistency; flag in TOKENOMICS |

## 12. Companion docs to update

After Stage 1-6 complete:
- `MAINNET-DEFERRED-ITEMS.md` §1 (lock-down items now phase-gated)
- `deploy-runbook-paseo.md` (add upgrade procedure)
- `TOKENOMICS.md` (token plane upgrade implications)
- `people-chain-return-leg.md` §7 (lock-once retrofit reference)
- `bonded-reporter-identity.md` (cache writer slot via router lookup)
- `MEMORY.md` (architectural shift recorded)

## 13. Sources / referenced contracts

- `contracts/DatumGovernanceRouter.sol` — existing phase tracker;
  extended in this design
- `contracts/DatumOwnable.sol` — existing ownership base; replaced
  by `DatumUpgradable` for opted-in contracts
- `contracts/DatumTimelock.sol` — existing 48h delay infrastructure;
  reused for `regressPhase`
- `contracts/DatumPauseRegistry.sol` — existing category-based pause;
  unrelated, kept as-is
- AUDIT-PASS-5 findings — need re-verification after Stage 4
