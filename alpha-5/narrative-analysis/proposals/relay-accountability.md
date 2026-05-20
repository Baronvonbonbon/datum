# Proposal — Relay Accountability (G-1 first close)

**Status:** design scope, pre-implementation.
**Closes:** `gaps-in-checks-and-balances.md` G-1 (Relay has zero
on-chain accountability) — partially. Censorship-via-governance and
identity-via-bond are closed; MEV / front-running stay open and
need separate primitives (see §10).
**Pattern reused:** mirrors `DatumPublisherStake + DatumPublisherGovernance`
and `DatumAdvertiserStake + DatumAdvertiserGovernance`.

## 1. Goals + non-goals

### Goals

- Give every authorized relay an on-chain identity (an EOA bonded
  in a stake contract) that the protocol can slash.
- Make the authorized-relayer set self-selecting via bond floor —
  remove the "owner manages a list" surface that today makes
  `Relay.lockRelayerOpen()` a hollow commitment.
- Adjudicate censorship complaints through conviction voting on a
  bond-secured proposal — same audit-trail shape the rest of the
  protocol uses.
- Preserve hot-path gas: no new SSTORE per settled batch on
  Settlement.

### Non-goals

- Real-time slash. Governance is the resolution layer; a single
  proven censorship event takes a vote cycle to slash. If observed
  censorship rate makes that too slow, add Approach A or B (§9).
- On-chain MEV / front-running proofs. Not feasible with the
  primitives the EVM offers; needs a different mechanism class.
- Relay reputation curves. Flat minimum stake; reputation can be
  layered later if useful.

## 2. Why this first

The protocol already has the publisher-side pair (`PublisherStake +
PublisherGovernance`) and the advertiser-side pair (`AdvertiserStake
+ AdvertiserGovernance`). Adding the relay pair restores
**symmetry**: every economic actor in the system has the same shape
of accountability — bond → slashable via conviction vote. An
auditor reads three pairs of contracts that look identical instead
of asking "why is relay the only role with no slash surface?"

Cost: ~2 new contracts (~400 LOC each, by analogy). No Settlement
changes. No new hot-path gas. The bond gate replaces an
owner-managed list with an economically self-selecting one.

## 3. Architecture

```
                    ┌────────────────────────┐
                    │  DatumRelayStake       │  ← bond + auth view
                    │  - stake / requestExit │
                    │  - isAuthorized(addr)  │
                    │  - slash(...) hook     │
                    └─────────┬──────────────┘
                              │ isAuthorized
                              ▼
                    ┌────────────────────────┐
                    │  DatumRelay (existing) │
                    │  - authorizedRelayers  │ ← reads stake gate
                    │  - lockRelayerOpen()   │
                    └────────────────────────┘
                              ▲
                              │ slash() callable by
                              │
                    ┌────────────────────────┐
                    │  DatumRelayGovernance  │  ← conviction vote
                    │  - propose(relay, ...) │
                    │  - vote(p, aye, conv)  │
                    │  - finalize → slash    │
                    └────────────────────────┘
```

Two new contracts; one existing contract gets a small change to
consult the stake gate.

## 4. DatumRelayStake — interface sketch

```solidity
contract DatumRelayStake is DatumUpgradable, PaseoSafeSender {
    function version() public pure override returns (uint256) { return 1; }

    // ── Wiring ──────────────────────────────────────────────────────────
    address public relayContract;               // DatumRelay
    address public governance;                  // DatumRelayGovernance (sole slasher)
    address public treasury;                    // slash treasury cut recipient
    bool public plumbingLocked;
    bool public stakeGateLocked;                // freezes relayMinStake at OpenGov

    // ── Parameters (governable, bounded) ────────────────────────────────
    uint256 public relayMinStake;               // floor; 0 = gate disabled
    uint64  public exitDelay;                   // blocks between requestExit + finalize
    uint16  public challengerBonusBps;          // bps of slash to challenger
    uint16  public treasuryBps;                 // bps of slash to treasury
    uint16  public constant MAX_PUNISHMENT_BPS = 8000;
    uint64  public constant MAX_EXIT_DELAY     = 1_209_600; // ~84d

    // ── State ───────────────────────────────────────────────────────────
    struct Stake {
        uint256 amount;
        uint64  joinedAtBlock;
        uint64  exitRequestedBlock;             // 0 = active
    }
    mapping(address => Stake) public stakeOf;
    address[] public relayList;
    mapping(address => uint256) private _index;
    uint256 public totalStaked;
    mapping(address => uint256) private _pending; // pull-pattern payout queue

    // ── Hot-path view consumed by DatumRelay ────────────────────────────
    /// @notice True iff the relay is staked at or above the floor AND has
    ///         not exit-requested. Used by DatumRelay's authorization gate.
    function isAuthorized(address relay) external view returns (bool) {
        Stake storage s = stakeOf[relay];
        if (relayMinStake == 0) return true;    // gate disabled — backwards-compat
        return s.amount >= relayMinStake && s.exitRequestedBlock == 0;
    }

    // ── Bond + exit flow ────────────────────────────────────────────────
    function stake() external payable whenNotFrozen;
    function topUp() external payable whenNotFrozen;
    function requestExit() external whenNotFrozen;     // starts exitDelay
    function finalizeExit() external whenNotFrozen;    // after delay → refund queue
    function cancelExit() external whenNotFrozen;      // re-arm before delay elapses

    // ── Slash hook (only governance) ────────────────────────────────────
    /// @dev Splits the slashed amount: challengerBonusBps → challenger,
    ///      treasuryBps → treasury, remainder back to relay's stake
    ///      (refund floor — relay always keeps ≥ 20% of bond, matching
    ///      ActivationBonds MAX_PUNISHMENT_BPS = 8000).
    function slash(
        address relay,
        address challenger,
        uint256 slashAmount,
        uint8 reasonCode
    ) external whenNotFrozen returns (uint256 slashed);

    function claim() external;                  // pull pending refunds + bonuses

    // ── Governance (owner = Timelock in production) ─────────────────────
    function setRelayMinStake(uint256 floor_) external onlyOwner whenNotFrozen; // reverts if stakeGateLocked
    function setExitDelay(uint64 d) external onlyOwner whenNotFrozen;           // ≤ MAX_EXIT_DELAY
    function setPunishmentBps(uint16 cBps, uint16 tBps) external onlyOwner whenNotFrozen; // sum ≤ MAX_PUNISHMENT_BPS
    function setRelayContract(address r) external onlyOwner;                    // lock-once
    function setGovernance(address g) external onlyOwner;                       // lock-once
    function setTreasury(address t) external onlyOwner whenNotFrozen;
    function lockStakeGate() external onlyOwner whenOpenGovPhase;               // makes floor immutable
    function lockPlumbing() external onlyOwner whenOpenGovPhase;
}
```

**Sizing reference:** `DatumPublisherStake` is ~400 LOC; we'd
target similar. No bonding curve (flat floor) drops ~40 LOC for the
curve math.

## 5. DatumRelayGovernance — interface sketch

Same conviction-vote shape as `DatumPublisherGovernance`. Reuse the
existing curve (`weight(c) = (A·c² + B·c)/100 + 1`) so voters
have one mental model. Audit-5 L6 fix (reject `setConvictionCurve(0,0)`)
applies here too.

```solidity
contract DatumRelayGovernance is DatumUpgradable, PaseoSafeSender {
    function version() public pure override returns (uint256) { return 1; }

    // ── Wiring ──────────────────────────────────────────────────────────
    IDatumRelayStake public relayStake;
    IDatumPauseRegistry public pauseRegistry;
    bool public plumbingLocked;

    // ── Conviction curve (same shape as GovernanceV2) ──────────────────
    uint16 public convictionA = 25;
    uint16 public convictionB = 50;
    uint256[9] public convictionLockups;        // 0d..365d

    // ── Per-proposal config ─────────────────────────────────────────────
    uint256 public proposerBond;                // PAS locked to propose
    uint16  public slashBps;                    // % of locked vote slashed from losers
    uint16  public slashAmountBps;              // % of relay's stake slashed on uphold
    uint256 public quorumWeighted;              // min ayeWeighted for uphold
    uint64  public votingPeriodBlocks;          // proposal lifetime

    // ── Proposal state ──────────────────────────────────────────────────
    enum Status { Active, Upheld, Rejected, Expired }

    struct Proposal {
        address proposer;
        address relay;                          // accused
        uint64  openedAtBlock;
        uint64  deadlineBlock;
        uint8   reasonCode;                     // 1 = censorship, 2 = front-run, 3 = MEV, 4 = collusion
        bytes32 evidenceHash;                   // IPFS or off-chain pointer
        uint128 proposerBondLocked;
        uint128 ayeWeighted;
        uint128 nayWeighted;
        Status  status;
    }
    mapping(uint256 => Proposal) public proposals;
    uint256 public proposalCount;

    struct Vote {
        bool    direction;                      // true = aye (slash relay)
        uint8   conviction;
        uint128 lockAmount;
        uint64  lockedUntilBlock;
        uint128 lockedConvictionWeight;
    }
    mapping(uint256 => mapping(address => Vote)) public votes;

    // ── Proposal lifecycle ──────────────────────────────────────────────
    function propose(
        address relay,
        uint8 reasonCode,
        bytes32 evidenceHash
    ) external payable nonReentrant whenNotFrozen returns (uint256 proposalId);

    function vote(
        uint256 proposalId,
        bool aye,
        uint8 conviction
    ) external payable nonReentrant whenNotFrozen;

    function finalize(uint256 proposalId) external nonReentrant whenNotFrozen;
    // → calls relayStake.slash(relay, proposer, slashAmount, reasonCode) on uphold

    function withdrawVote(uint256 proposalId) external nonReentrant whenNotFrozen;
    function claimSlashShare(uint256 proposalId) external nonReentrant whenNotFrozen;

    // ── Governance (parameters) ─────────────────────────────────────────
    function setConvictionCurve(uint16 a, uint16 b) external onlyOwner whenNotFrozen;
        // Reverts (0, 0) per audit-5 L6 mirror
    function setConvictionLockups(uint256[9] calldata l) external onlyOwner whenNotFrozen;
    function setProposerBond(uint256 b) external onlyOwner whenNotFrozen;
    function setSlashParams(uint16 sBps, uint16 saBps, uint256 quorum) external onlyOwner whenNotFrozen;
    function setVotingPeriod(uint64 blocks_) external onlyOwner whenNotFrozen;
    function setRelayStake(address s) external onlyOwner;       // lock-once
    function setPauseRegistry(address p) external onlyOwner;    // lock-once
    function lockPlumbing() external onlyOwner whenOpenGovPhase;
}
```

**Sizing reference:** `DatumPublisherGovernance` is ~530 LOC.
Target similar.

## 6. DatumRelay integration

`DatumRelay` already has `authorizedRelayers[address] → bool` +
`relayerOpen` + `lockRelayerOpen()`. Three migration patterns,
ordered by conservatism:

### (a) Replace — clean cypherpunk

Authorization comes ONLY from the stake gate.

```solidity
// In DatumRelay:
function _isAuthorized(address relayer) internal view returns (bool) {
    return address(relayStake) != address(0)
        && relayStake.isAuthorized(relayer);
}
```

`authorizedRelayers` mapping can stay for backward-compat reads but
isn't consulted. Cleanest end-state. Requires a phase-2 lockdown
move.

### (b) Augment — additive transition (recommended for first deploy)

```solidity
function _isAuthorized(address relayer) internal view returns (bool) {
    if (authorizedRelayers[relayer]) return true;     // existing path
    if (address(relayStake) != address(0)
        && relayStake.isAuthorized(relayer)) return true;     // new path
    return false;
}
```

Existing manually-authorized relays continue to work; staked relays
join in addition. Easy migration; no behavior break.

### (c) Layered — strict

```solidity
function _isAuthorized(address relayer) internal view returns (bool) {
    return authorizedRelayers[relayer]
        && (address(relayStake) == address(0) || relayStake.isAuthorized(relayer));
}
```

Both gates must pass. Most conservative; defeats the
self-selecting property. Probably not what we want.

### Recommended path

1. **Deploy A5R1 (alpha-5 release 1)** with pattern **(b)** —
   additive. `relayMinStake = 0` initially so stake gate is a no-op.
   No behavior change for existing relays.
2. **Trial period.** Relays opt-in to staking. Observe rate of
   stake adoption, gas costs in production, governance proposals
   if any.
3. **Calibrate `relayMinStake`** based on relayer-set composition.
   Start conservative (e.g. 10 PAS) and raise via owner setter once
   the production relayer set has stabilized.
4. **Flip to (a)** by setting `authorizedRelayers[*] = false` for
   addresses that haven't staked and emptying the mapping. Lock
   `Relay.lockRelayerOpen()` and `RelayStake.lockStakeGate()`
   post-OpenGov. Final state: stake gate is the sole authorization
   source.

Pattern (b) means the small contract change to `DatumRelay` is
the only Solidity edit to the existing tree. Everything else is
new contracts.

## 7. Slash flow walk-through

Worst case: a relay censors batches from User X over several days.

1. **User X** assembles evidence: the off-chain batches they
   handed to the relay, log entries showing the relay's accept
   response, the absence of corresponding `ClaimSettled` events
   on-chain. Hashes everything → `evidenceHash`. Posts the
   evidence package off-chain (IPFS, etc.).
2. **User X (or anyone)** calls `relayGovernance.propose(relay,
   reasonCode = 1, evidenceHash)` with `msg.value >= proposerBond`.
   Proposal opens with `deadlineBlock = block.number +
   votingPeriodBlocks`.
3. **Voters** read the evidence off-chain, decide aye/nay, call
   `vote(proposalId, aye, conviction) payable`. PAS locks for the
   conviction's lockup window; voters can't withdraw until then.
4. **Anyone** calls `finalize(proposalId)` after the deadline.
   - If `ayeWeighted >= quorumWeighted` and `aye > nay`:
     - `proposal.status = Upheld`.
     - `slashAmount = relayStake.stakeOf(relay).amount * slashAmountBps / 10000`.
     - `relayStake.slash(relay, proposer, slashAmount, reasonCode = 1)`.
     - Inside RelayStake: `challengerBonusBps` → proposer pending
       queue; `treasuryBps` → treasury pending queue; `slashBps`
       on losing-vote pool accumulated in the proposal for winning
       voters to claim.
   - Otherwise: `Rejected`. Proposer bond stays with proposer
     (returned via vote withdraw path); losing voters can still
     withdraw their locked stakes once lockup expires.
5. **Winners** call `claimSlashShare(proposalId)` after `finalize`
   to pull their proportional share.
6. **Voters** call `withdrawVote(proposalId)` after their personal
   lockup expires to recover the unlock amount minus any slash.

The whole cycle takes one `votingPeriodBlocks` (call it ~3-7 days
on production calibration).

## 8. Lock-once posture

Matches the upgrade ladder pattern. Pre-OpenGov, `lock*()` revert
`not-opengov`; post-OpenGov, governance fires each:

| Lock | Effect |
|---|---|
| `DatumRelayStake.lockStakeGate()` | `relayMinStake` becomes immutable |
| `DatumRelayStake.lockPlumbing()` | Freezes `relayContract`, `governance`, `treasury` |
| `DatumRelayGovernance.lockPlumbing()` | Freezes `relayStake`, `pauseRegistry` |
| `DatumRelay.lockRelayerOpen()` | (existing) Authorization closed to the locked set |

The migration sequence post-OpenGov: empty `authorizedRelayers` →
`Relay.lockRelayerOpen()` → `RelayStake.lockStakeGate()` →
`RelayStake.lockPlumbing()` → `RelayGovernance.lockPlumbing()`.
After all five fire, the relay tier is permanently a pure stake-gate
+ governance-slash regime.

## 9. Future upgrade paths

If observed conditions show governance arbitration is too slow, add
one of:

### 9.1 Approach A — Settlement-side mark + off-chain receipt

Adds `_settledBatchBlock[bytes32] → uint256` mapping to
`DatumSettlementStorage` (append-only, layout-safe). LogicB writes
this on every settled batch (~22K gas/batch one-time, ~5K on
overwrite). A new `DatumRelayCensorshipSlasherA` contract verifies
EIP-712 receipts from the relay against the absence of a settled
mark; calls `RelayStake.slash` directly (no governance vote).

**When to deploy this:** observed censorship frequency justifies
the permanent Settlement gas tax. Estimate: > N proven cases per
week.

**Settlement migration:** layout snapshot regen + LogicB upgrade
via the existing two-Logic pattern. Storage gap on
`DatumSettlementStorage` accommodates one new mapping.

### 9.2 Approach B — On-chain commitment

A new `DatumRelayCommitter` contract that relays call BEFORE
submitting batches, recording `commitments[batchHash] → (relay,
deadline, settled)`. Anyone can slash via `challengeMissedDeadline`
after the deadline. `commitAndSubmit` is the atomic fast-path.

**When to deploy this:** observed censorship is concentrated at
high-value batches, where the relay's 22K-gas commit cost is
acceptable in exchange for fast-resolution slash.

**No Settlement change needed.** Drops in as a sibling contract.

### 9.3 MEV / front-running primitives

Neither A nor B closes the MEV vector. Future research direction
(not committed):

- **Enshrined ordering.** Verifiable Sequencing Service. Expensive;
  needs an external service or a pallet-revive primitive.
- **Oracle-arbitrated timing.** Off-chain MEV detector publishes
  proof; governance votes. Same shape as 9 above but with a
  different evidence type. Slow.
- **Encrypted mempool / commit-reveal on the user-relay handoff.**
  User encrypts batch to relay; relay can't see contents until
  commit reveal. Heavy UX cost; prevents specific attack classes
  but not all.

These are post-mainnet research items. The G-1 close documented
here doesn't preclude any of them — adding a future MEV layer is a
separate `DatumRelay*` contract that talks to `RelayStake.slash`
under a new reasonCode.

## 10. What this does NOT close

- **Front-running** — relay reordering competing batches within
  their bundle. Not provable on-chain.
- **MEV timing** — relay submitting batches at MEV-optimal block.
  Same.
- **Conspiracy** — relay colluding with a publisher or advertiser
  to forge settlements. Detectable via the existing
  `PublisherReputation` anomaly mechanism + `PublisherGovernance`,
  but not specifically through this relay-tier surface.
- **Soft censorship** — relay deprioritizing User X without
  outright dropping (slower service, but still serves). Hard to
  distinguish from variable load.

These are documented as design-acknowledged for now. None of them
were previously closed either; the G-1 close is meaningful at the
identity + bond layer, and the rest needs future primitives.

## 11. Testing strategy

Mirror the existing test files for the publisher / advertiser pairs:

- `test/relay-stake.test.ts` — stake / topUp / exit flow,
  bond gate semantics, slash hook authorization, refund queue,
  parameter bounds.
- `test/relay-governance.test.ts` — propose / vote / finalize /
  withdraw / claimSlashShare, conviction snapshot semantics,
  quorum math, slash-pool distribution.
- `test/relay-integration.test.ts` — end-to-end censorship
  scenario with Relay + Settlement + RelayStake + RelayGovernance
  wired together. Pattern (b) augment behavior, then transition to
  (a) replace.
- `test/relay-locks.test.ts` — phase-gated locks revert
  pre-OpenGov, succeed post-OpenGov, are one-way.

Target ~80-100 new tests across the four files.

## 12. Deploy.ts wiring

Adds to the existing 30-contract deploy:

```typescript
// 1. Deploy RelayStake
const relayStake = await deployOrReuse("DatumRelayStake", "DatumRelayStake", []);
addresses.relayStake = relayStake;

// 2. Deploy RelayGovernance
const relayGovernance = await deployOrReuse("DatumRelayGovernance", "DatumRelayGovernance", []);
addresses.relayGovernance = relayGovernance;

// 3. Wire RelayStake → Relay (lock-once)
await relayStakeContract.setRelayContract(addresses.relay);
await relayStakeContract.setGovernance(addresses.relayGovernance);
await relayStakeContract.setTreasury(deployer.address);  // rotate before mainnet

// 4. Wire RelayGovernance → RelayStake (lock-once)
await relayGovernanceContract.setRelayStake(addresses.relayStake);
await relayGovernanceContract.setPauseRegistry(addresses.pauseRegistry);

// 5. Initial parameters
await relayStakeContract.setRelayMinStake(0n);          // gate disabled for trial
await relayStakeContract.setExitDelay(50400n);          // ~3.5d @ 6s
await relayStakeContract.setPunishmentBps(2000, 1000);  // 20% challenger, 10% treasury

// 6. Wire Relay → RelayStake (small Relay edit per §6 pattern b)
await relayContract.setRelayStake(addresses.relayStake);
```

`PRE-ALPHA-5-BACKLOG` items added:
- Set `relayMinStake` to production-calibrated value before
  mainnet (currently 0 = gate disabled).
- Rotate `RelayStake.treasury` to the protocol treasury Safe.
- Decide pattern (a) vs (b) cutover timing — likely during
  the Phase 1 → 2 transition.

## 13. Open questions

1. **Bonding curve vs flat floor.** This proposal recommends flat.
   Counter-argument: a curve based on cumulative relayed batches
   would discourage low-stakes-high-throughput griefing. Recommend
   flat for v1; revisit if the data shows it matters.
2. **Slash amount as bps of stake vs absolute.** This proposal
   uses bps (`slashAmountBps`). Counter-argument: absolute amounts
   are easier to reason about (e.g. "5 PAS per upheld proposal").
   Bps scales with the relay's stake — small relays lose
   proportionally less, which matches the publisher pattern.
3. **Who funds `treasury` in the slash split?** Currently going
   to a configurable treasury address. Could alternatively flow
   into `DatumFeeShare` (WDATUM stakers earn relay-slash DOT).
   Aligns incentives: WDATUM stakers benefit from a clean relay
   set. Defer decision to OpenGov.
4. **Should `setRelayMinStake` ratchet up only?** Like
   `raisePhaseFloor`. Argument for: prevents governance from
   lowering the floor to admit a captured relay. Argument
   against: legitimate operational reasons to lower (e.g. DOT
   price 10×ed). Recommend NO ratchet; rely on lock-once
   `lockStakeGate` for cypherpunk closure.

## 14. Sequencing

Recommended sequence within an alpha-5 release:

1. Implement `DatumRelayStake` + tests.
2. Implement `DatumRelayGovernance` + tests.
3. Small `DatumRelay` edit for pattern (b) + integration tests.
4. Update `deploy.ts` + `setup-testnet.ts`.
5. Update `STATUS.md` + `SYSTEM-OVERVIEW.md §7.1` to mark G-1 as
   "partially closed (identity + bond + governance-arbitrated
   slash); censorship-fast-track and MEV still open."
6. Add `narrative-analysis/DatumRelayStake.md` and
   `DatumRelayGovernance.md` per-contract narratives.
7. Cross-reference from `narrative-analysis/DatumRelay.md`.

Estimated effort: ~2-3 days of focused work, including tests and
docs.

## 15. Cross-references

- `narrative-analysis/gaps-in-checks-and-balances.md` — G-1 entry.
- `narrative-analysis/DatumPublisherStake.md` /
  `DatumPublisherGovernance.md` — template pair.
- `narrative-analysis/DatumAdvertiserStake.md` /
  `DatumAdvertiserGovernance.md` — second template pair.
- `narrative-analysis/DatumActivationBonds.md` — bond + slash
  pattern with conviction-vote integration (similar shape).
- `SYSTEM-OVERVIEW.md §7.1` — G-1 in the gap inventory.
- `PRE-ALPHA-5-BACKLOG.md §3.2 (FUTURE-WORK / CB items)` —
  this proposal slots into the "deferred design" category but is
  much smaller scope than CB8 / CB9.
