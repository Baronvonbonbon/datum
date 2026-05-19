# Task Scope: DatumStakeRoot V2 Implementation

Concrete breakdown of the work to ship Resolution 2 (permissionless
bonded reporters) and Resolution 1 (commitment registry) from
`proposal-stakeroot-optimistic.md`. Resolution 3 (ZK validity proof)
is out of scope — deferred to a future cycle.

## Goal

Replace the owner-managed N-of-M reporter set in `DatumStakeRoot` with
a permissionless stake-bonded mechanism backed by ZK self-challenge
fraud proofs. Eliminate the social trust assumption; replace with an
economic-trust assumption (51% of bonded stake honest).

Migrate gracefully so live testnet deployments keep working through
the transition.

## Out of scope

- Resolution 3 (ZK validity proof). Tracked separately; deferred until
  prover infrastructure exists.
- Token storage layout changes. We assume DATUM is or becomes
  OZ-`ERC20Snapshot`-compatible so historical balances are readable.
  If that's not true at the time of implementation, a snapshot adapter
  contract is a sub-task.
- Removal of v1. v1 stays as a read-only fallback through the
  deprecation window. Removal is a follow-up.

## Branch strategy

One branch per stage. Land each as its own PR with green tests before
moving to the next. Stages can stretch across multiple sessions; this
doc is the resume point.

```
feature/stakeroot-v2-stage0   ← invariant tests on v1 (baseline)
feature/stakeroot-v2-stage1   ← scaffold v2 contract + types + tests
feature/stakeroot-v2-stage2   ← propose/approve/finalize/challenge
feature/stakeroot-v2-stage3   ← ClaimValidator multi-source acceptance
feature/stakeroot-v2-stage4   ← deploy.ts wiring + setup-testnet
feature/stakeroot-v2-stage5   ← commitment registry (R1)
feature/stakeroot-v2-stage6   ← migration utilities + v1 deprecation
```

## Stage 0 — V1 invariant baseline (PREREQUISITE)

Before touching anything, write tests that capture v1's current
behaviour so we can verify v2 produces equivalent or strictly-better
results.

**Files:**
- `alpha-4/test/stake-root-invariants.test.ts` (NEW, ~150 LOC)

**Invariants to capture:**
- Adding/removing reporters is owner-only.
- `threshold` clamps to `reporters.length` after removal.
- `commitStakeRoot` requires reporter, requires epoch ≥ latestEpoch,
  rejects bytes32(0).
- First-finalized-wins per epoch.
- `isRecent` returns true within LOOKBACK_EPOCHS, false beyond.
- Multiple reporters can co-sign the same (epoch, root) pair;
  threshold-th approval finalizes.

**Acceptance:** New test file passes; 0 changes to v1 code or
existing tests. Commit message: "Baseline v1 invariants before
stakeroot v2 work."

**Effort:** ~1 session.

## Stage 1 — V2 scaffold

Create the V2 contract with state, governance, and reporter-lifecycle
functions. No root-proposal logic yet — that's Stage 2.

**Files:**
- `alpha-4/contracts/DatumStakeRootV2.sol` (NEW, ~250 LOC)
- `alpha-4/contracts/interfaces/IDatumStakeRoot.sol` (MODIFY: add
  `acceptedRoot(bytes32)` view so V2 satisfies the same interface
  as V1 from ClaimValidator's perspective)
- `alpha-4/test/stake-root-v2-scaffold.test.ts` (NEW, ~200 LOC)

**State variables:**
```solidity
struct ReporterStake {
    uint256 amount;
    uint64  joinedAtBlock;
    uint64  exitProposedBlock;   // 0 = active
}
mapping(address => ReporterStake) public reporterStake;
address[] public reporterList;
mapping(address => uint256) private _reporterIndex;
uint256 public totalReporterStake;

// Governable params (with ceilings)
uint256 public reporterMinStake;       // default 1000 DATUM
uint64  public reporterExitDelay;      // default 14400 blocks
uint16  public approvalThresholdBps;   // default 5100 (51%)
uint64  public challengeWindow;        // default 14400 blocks
uint256 public proposerBond;           // default 100 DATUM
uint256 public challengerBond;         // default 50 DATUM
uint16  public slashedToChallengerBps; // default 8000
uint16  public slashApproverBps;       // default 1000 (10% of stake)

uint256 public constant MAX_APPROVAL_THRESHOLD_BPS = 9900;
uint256 public constant MAX_CHALLENGE_WINDOW = 1_209_600; // ~84d

mapping(address => uint256) private _pendingPayout;
address public treasury;

IERC20 public immutable datumToken;
```

**Functions in this stage (the easy half):**
- Constructor: takes (datumToken, treasury, initial param values)
- `joinReporters() external payable` — register + bond
- `proposeReporterExit() external` — start unbonding clock
- `finalizeReporterExit() external` — claim stake after exitDelay
- Governance setters for every param (owner-only, bounded by ceilings)
- `claim()` / `claimTo()` pull-pattern (mirrors ActivationBonds)
- Views: `reporterCount()`, `isReporter(addr)`, `pending(addr)`

**Tests (~10-15 cases):**
- Join with bond ≥ min → reporter active, totalStake += bond
- Join with bond < min → reverts E11
- Double-join reverts E22
- Exit proposal sets exitProposedBlock
- Finalize before delay reverts E96
- Finalize after delay clears state, queues payout
- Param setters bounded by ceilings (E11)
- Param setters owner-only (E18)
- Claim with zero pending reverts E03
- ClaimTo zero address reverts E00

**Acceptance:** Tests pass; contract compiles; no behavioural changes
to v1 or anywhere else.

**Effort:** ~1-2 sessions.

## Stage 2 — Root proposal, approval, finalization, challenge

The meat. Implements the optimistic-with-fraud-proof flow.

**Files:**
- `alpha-4/contracts/DatumStakeRootV2.sol` (MODIFY: add ~250 LOC)
- `alpha-4/test/stake-root-v2-proposals.test.ts` (NEW, ~400 LOC)

**New state:**
```solidity
struct PendingRoot {
    bytes32 root;
    uint64  proposedAtBlock;
    uint64  snapshotBlock;       // baked into proposal
    address proposer;
    uint128 proposerBond;
    uint256 approvedStake;       // cumulative bonded stake of approvers
    bool    slashed;
    mapping(address => bool) approved;
}
mapping(uint256 => PendingRoot) private _pending;

// Finalized roots from V2 (analogous to V1's rootAt)
mapping(uint256 => bytes32) public rootAt;
uint256 public latestEpoch;

uint256 public constant LOOKBACK_EPOCHS = 8;
```

**Functions:**
- `proposeRoot(uint256 epoch, uint64 snapshotBlock, bytes32 root) external payable`
  - Caller must be active reporter (stake > 0, exitProposedBlock == 0)
  - msg.value ≥ proposerBond
  - epoch > latestEpoch
  - No existing pending for this epoch
  - Proposer's own stake auto-approves
- `approveRoot(uint256 epoch) external`
  - Caller must be active reporter
  - Within challenge window
  - Not double-approve
- `finalizeRoot(uint256 epoch) external`
  - After challenge window
  - approvedStake / totalReporterStake ≥ approvalThresholdBps
  - Not slashed
  - Writes rootAt[epoch], refunds proposerBond
- `challengeRootBalance(uint256 epoch, bytes32 commitment, uint256 claimedBalance, uint256 leafIndex, bytes32[] siblings, bytes32[8] identityProof) external payable`
  - msg.value ≥ challengerBond
  - Within challenge window, not slashed
  - Verify leaf is in proposed root (Merkle path)
  - Verify caller knows the secret behind commitment (ZK identity proof)
  - Verify caller's actual DATUM balance differs from claimed
  - Slash proposer + approvers
- `_slashProposer(uint256 epoch, address challenger) internal`
  - Set slashed=true
  - Distribute proposerBond + slashApproverBps% of each approver's stake
- View: `isRecent(bytes32 root)` — same shape as v1 for ClaimValidator
  compatibility

**ZK identity proof:** The circuit proves `Poseidon(secret) == commitment`
where the prover knows `secret`. This is a simple 1-input ZK statement
already supported by Path A infrastructure. Reuses `DatumZKVerifier`
if a 1-pub-input mode exists, otherwise needs a new circuit
`identity.circom` (~50 lines) and a separate verifier deployment.

**Sub-task in Stage 2:** decide whether to extend `DatumZKVerifier` or
deploy `DatumIdentityVerifier`. If verifier slots are at a premium, a
single `verify(uint256[1] pubInputs, ...)` mode added to ZKVerifier is
cheaper. Coordinate with the existing circuit owners.

**Tests (~25 cases):**
- Propose with insufficient bond → revert E11
- Propose from non-reporter → revert E01
- Propose during pending exit → revert E01
- Approve before propose → revert E01
- Double approve → revert E22
- Approve after window → revert E96
- Finalize before window → revert E96
- Finalize with sub-threshold stake → revert E46
- Finalize after slash → revert E22
- Successful proposal+approval+finalize → rootAt set, proposerBond
  refunded, latestEpoch advances
- Challenge with wrong Merkle path → revert E53
- Challenge with valid path + wrong identity proof → revert E53
- Challenge with matching balance (not actually fraud) → revert E53
- Successful challenge slashes proposer bond + slashApproverBps% of
  every approver
- Challenger payout = totalSlash * slashedToChallengerBps / 10000
- Approver who didn't approve isn't slashed
- isRecent returns true within LOOKBACK_EPOCHS, false beyond

**Acceptance:** All tests pass; v1 still works untouched; compile clean.

**Effort:** ~2-3 sessions, depending on ZK identity verifier reuse vs
new circuit decision.

## Stage 3 — ClaimValidator multi-source acceptance

Make `DatumClaimValidator` accept stake-roots from either v1 OR v2 (or
any future v3+).

**Files:**
- `alpha-4/contracts/DatumClaimValidator.sol` (MODIFY: ~50 LOC)
- `alpha-4/test/claim-validator-stakeroot.test.ts` (NEW, ~100 LOC)

**Approach:** replace the single `stakeRoot` reference with an
allowlisted set of acceptable stake-root contracts. Validator checks
`isRecent` on each, returns true if any match.

```solidity
// Replace:
//   IDatumStakeRoot public stakeRoot;
// With:
mapping(address => bool) public acceptedStakeRoots;
address[] public stakeRootList;
event StakeRootAdded(address indexed root);
event StakeRootRemoved(address indexed root);

function addStakeRoot(address addr) external onlyOwner {
    require(!plumbingLocked, "locked");
    require(addr != address(0), "E00");
    require(!acceptedStakeRoots[addr], "E22");
    acceptedStakeRoots[addr] = true;
    stakeRootList.push(addr);
    emit StakeRootAdded(addr);
}
function removeStakeRoot(address addr) external onlyOwner {
    require(!plumbingLocked, "locked");
    require(acceptedStakeRoots[addr], "E01");
    // swap-and-pop
    ...
}
```

In `validateClaim`, the `isRecent` check loops:
```solidity
bool recent = false;
for (uint256 i = 0; i < stakeRootList.length; i++) {
    if (IDatumStakeRoot(stakeRootList[i]).isRecent(sRoot)) {
        recent = true; break;
    }
}
if (!recent) return false;
```

**Tests:**
- addStakeRoot adds + emits
- addStakeRoot zero rejects E00
- addStakeRoot duplicate rejects E22
- removeStakeRoot rejects unknown E01
- After plumbingLocked, both setters revert
- validateClaim accepts a root from v1
- validateClaim accepts a root from v2
- validateClaim rejects a root from neither

**Acceptance:** Tests pass; ClaimValidator stays size-budget-clean
(no Spurious Dragon regression).

**Effort:** ~1 session.

## Stage 4 — deploy.ts + setup-testnet wiring

Plumb v2 through the deploy ladder.

**Files:**
- `alpha-4/scripts/deploy.ts` (MODIFY: ~60 LOC)
- `alpha-4/scripts/setup-testnet.ts` (MODIFY: ~30 LOC)
- `alpha-4/narrative-analysis/predeploy-checklist-2026-05-14.md`
  (MODIFY: note v2 in checklist)

**Deploy.ts changes:**
- Add `stakeRootV2` to REQUIRED_KEYS.
- Deploy step: `deployOrReuse("stakeRootV2", "DatumStakeRootV2", [datum, treasury, ...defaults])`
- Wire ClaimValidator: `addStakeRoot(stakeRootV2)`. Also keep
  `addStakeRoot(stakeRootV1)` since v1 continues to work.
- Deployer joins as initial bonded reporter so the seed flow can
  produce v2 roots. Use `joinReporters{value: reporterMinStake}`.
- Place V2 stake-root wiring in **STAGE 1/2 soft wiring** (NOT
  STAGE 3 lock-once): the `addStakeRoot` setter is plumbingLocked-
  gated, not per-call lock-once. Goes before `lockPlumbing`.

**Setup-testnet.ts changes:**
- After v2 deploy, generate a small test stake tree off-chain
  (e.g., 5 test commitments with mock balances).
- Submit `proposeRoot(epoch=1, snapshotBlock, root)` from deployer.
- Approve from deployer.
- Wait challengeWindow blocks (testnet override: shrink to 10).
- Finalize.
- Verify ClaimValidator can read the root via `isRecent`.

**Acceptance:** A full deploy + setup-testnet run produces a v2
committed root, ClaimValidator can validate proofs against it.

**Effort:** ~1 session.

## Stage 5 — Commitment registry (R1)

Add the on-chain commitment registry so phantom-leaf fraud is
detectable.

**Files:**
- `alpha-4/contracts/DatumStakeRootV2.sol` (MODIFY: ~80 LOC for
  registry storage + setter + `challengePhantomLeaf`)
- `alpha-4/test/stake-root-v2-phantom-leaf.test.ts` (NEW, ~200 LOC)

**State:**
```solidity
mapping(bytes32 => bool) public registeredCommitments;
bytes32[] public commitmentList;
uint256 public commitmentBond; // governable, default 10 DATUM
event CommitmentRegistered(bytes32 indexed commitment, address indexed registrant);
```

**Functions:**
- `registerCommitment(bytes32 commitment) external payable`
  - msg.value ≥ commitmentBond
  - Not already registered
  - Bond is non-refundable (or refundable on commitment deletion —
    decision point; see "Trade-offs to resolve" below)
- `challengePhantomLeaf(uint256 epoch, bytes32 commitment, uint256 claimedBalance, uint256 leafIndex, bytes32[] siblings) external payable`
  - Verify leaf is in proposed root
  - Verify commitment is NOT in registeredCommitments
  - Slash proposer

**Tests:**
- Register with bond → emits event, set updated
- Register with low bond → revert E11
- Double-register → revert E22
- challengePhantomLeaf with registered commitment → revert (not actually phantom)
- challengePhantomLeaf with unregistered commitment in proposed root → slash succeeds
- Challenge after window → revert E96

**Trade-offs to resolve before implementing:**
- **Commitment bond refundable?** If yes, the registry isn't really a
  Sybil deterrent — attackers post bonds and reclaim. If no, users pay
  a permanent cost to participate. **Lean: non-refundable** to give
  the bond Sybil-pricing teeth.
- **Bond amount?** 10 DATUM is a guess. The right value depends on the
  expected value of forged stake. If campaign stake gates are 100 DATUM,
  the commitment bond should be at least that. Configure as governable.
- **Mass-deregister?** What if commitment-list grows to millions and
  the `for (i = 0; i < commitmentList.length; i++)` enumeration in
  `proposeRoot` (for tree-size validation) becomes prohibitive?
  Alternative: don't enumerate on-chain; assume proposer correctness
  + rely on phantom-leaf challenge. **Lean: don't enumerate.** This is
  what `challengePhantomLeaf` is for.

**Acceptance:** Tests pass; phantom-leaf attack scenario is provably
catchable in test.

**Effort:** ~1-2 sessions.

## Stage 6 — Migration + v1 deprecation

Lay the groundwork for retiring v1 once v2 has been live for some
period.

**Files:**
- `alpha-4/contracts/DatumStakeRoot.sol` (V1) (MODIFY: add a
  `deprecated` flag + warning event; commitStakeRoot still works)
- `alpha-4/narrative-analysis/migration-stakeroot-v1-to-v2.md`
  (NEW, ~100 LOC) — operator runbook for the cutover

**V1 changes:**
- Add `bool public deprecated` + `function setDeprecated(bool) external onlyOwner`.
- `commitStakeRoot` emits `DeprecatedCommitAttempt` event when
  `deprecated == true` but still works (don't break existing relays
  mid-flight).
- After deprecation grace period, governance proposal to remove v1
  from ClaimValidator via `removeStakeRoot(v1)`.

**Runbook outline:**
1. Day 0: v2 live, v1 active.
2. Day N: governance proposal — `v1.setDeprecated(true)`.
3. Day N+T: governance proposal — `ClaimValidator.removeStakeRoot(v1)`.
4. Day N+T+grace: v1 storage drained (any remaining reporter stakes
   withdrawn manually).

**Acceptance:** Runbook reviewed; v1 deprecation path tested in
isolation (a v1 with `deprecated=true` still commits roots and emits
the warning event).

**Effort:** ~1 session.

## Open design decisions (deferred to implementation)

These need answers from the implementer (or me, in a follow-up session)
but don't block scoping:

1. **ZK identity verifier:** new circuit vs. extending DatumZKVerifier?
   The simpler path is a new tiny verifier contract since it's only one
   public input. Estimate ~150 LOC + circuit work.

2. **Historical balance reads:** Stage 2's `challengeRootBalance` checks
   `DATUM.balanceOf(msg.sender)` against `claimedBalance`. If the
   snapshotBlock is more than a few blocks old, balances have moved
   and this comparison is wrong. Options:
   - (a) Use OZ `ERC20Snapshot` on the DATUM token (requires DATUM
     contract change).
   - (b) Use EVM block-hash storage proofs (heavyweight, ~150k extra gas).
   - (c) Restrict snapshotBlock to `block.number - 1` at proposal time
     and challenger must challenge within the same block-window
     (challengeWindow becomes effectively "must challenge within a few
     blocks of snapshot, before balances drift").
   - **Lean: (c)** for v2, plan migration to (a) when DATUM token adds
     Snapshot. Document the assumption clearly in the contract.

3. **Slashing math:** what fraction of approver stake gets slashed?
   `slashApproverBps = 1000` (10%) is a starting guess. The right
   value depends on how often we expect false positives. Approvers
   should be punished for endorsing fraud but not wiped out for one
   mistake — 10% lets them survive a single incident, 100% (full
   wipeout) might be too aggressive for early operations.

4. **Treasury destination for slashed funds:** the `treasury` address
   in the constructor. Same as DatumActivationBonds — initially
   deployer, later Council-controlled treasury. Document the migration
   expectation.

5. **Approval-phase griefing:** if a malicious low-stake reporter
   approves every root proactively (including fraudulent ones), they
   get slashed. But a malicious reporter could ALSO approve every
   honest root to be in good standing, then propose one fraudulent
   root. Detection requires careful approver-slash semantics — only
   slash approvers whose approval was for THIS slashed root, not
   their full stake. The Stage 2 spec already does this; flag for
   review during implementation.

## Risk surface + rollback

**Risk:** the new contract introduces a fund-bearing surface
(reporter stakes, proposer/challenger bonds). A bug in
`_slashProposer` or `claim()` could strand funds.

**Mitigation:**
- Stage 1's claim/joinReporters/exit functions are the simplest
  fund-bearing surface — these get most test coverage.
- Stage 2 is the fraud-detection logic. Tested against synthetic
  fraud scenarios with manually-constructed Merkle paths and
  identity proofs.
- Both stages get their own audit pass per the existing project
  audit-pass cadence before deploy.

**Rollback:** v2 is deployed alongside v1; if a bug is found post-
deploy, `ClaimValidator.removeStakeRoot(v2)` disables v2 acceptance
immediately. v1 remains the authoritative root source until v2 is
fixed. Reporter stakes in v2 are still claimable via `exit` +
`claim` — the bug must be in a path that doesn't block those.

## Total effort estimate

Stages 0+1+2+3+4 = MVP that ships v2 alongside v1. **~8-10 sessions
of focused work.** Stage 5+6 = full vision with phantom-leaf
catchability and v1 deprecation path. **+3-4 sessions.**

Total: **~12-14 sessions** for the full task as scoped.

## Acceptance criteria for the full task

- [ ] Stage 0 v1 invariants test file landed.
- [ ] `DatumStakeRootV2.sol` deployed alongside v1, all tests passing.
- [ ] `DatumClaimValidator.addStakeRoot/removeStakeRoot` accepts proofs
      from either v1 or v2.
- [ ] `deploy.ts` + `setup-testnet.ts` produce a working v2 deployment
      that creates a committed root via the proposeRoot → approveRoot
      → finalizeRoot flow.
- [ ] Commitment registry (R1) detects phantom-leaf attacks; tests
      prove the slash path works.
- [ ] v1 deprecation flag added; migration runbook reviewed.
- [ ] Web/extension ABI sync for the new contract (out of scope as a
      separate task but flagged here).
- [ ] No regressions in the existing 909-test suite.

## Next action

When the user is ready: invoke this doc's Stage 0 — write the v1
invariant baseline test. That's ~150 LOC, one session, low-risk, and
establishes the contract being preserved before any rewrite begins.
