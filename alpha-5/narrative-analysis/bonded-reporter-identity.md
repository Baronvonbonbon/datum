# Bonded-Reporter Identity Attestations (Design)

**Status:** Design proposal — pre-mainnet hardening for the single-oracle
trust risk in `DatumPeopleChainIdentity` + `DatumPeopleChainXcmBridge`.

**Date:** 2026-05-17

**Context:** Phase D Paseo deployment ships with Diana as the single
`oracleReporter` and `peopleChainSovereign`. Per
`people-chain-return-leg.md`, Diana is durable for testnet but is a
real centralization risk for mainnet. This doc designs the bonded
multi-reporter pattern that replaces single-Diana before mainnet,
mirroring the proven `DatumStakeRootV2` architecture.

---

## 1. The problem

Today's identity attestation surface:

| Role | Single principal? | Authority |
|---|---|---|
| `cache.oracleReporter` | Yes — one EOA | Write any `(user, level, validity)` directly |
| `cache.xcmDispatcher` | Yes — one address (bridge) | Same write surface |
| `bridge.peopleChainSovereign` | Yes — one EOA (Diana on Paseo) | Authorize `xcmCallback` |

**What Diana CAN do:**
1. **False-positive attestations** — claim `KnownGood` for a user who
   doesn't have it on People Chain. Unlocks settlement on
   identity-gated campaigns for Sybils.
2. **Denial of service** — refuse to handle refresh requests, or
   selectively starve specific addresses.

**What Diana CANNOT do** (mitigated by existing design):
- Cause permanent damage: records auto-expire (~30d), users can
  `forgetMe()`.
- Suppress user-side gates: `userMinIdentityLevel` is self-set;
  Diana can't bypass it.
- Operate undetected: every attestation is verifiable against
  People Chain RPC by an independent observer.

**Why single-oracle is unacceptable for mainnet:** the cypherpunk
thesis is "trust math, not people." A single EOA deciding *"who is a
real person on People Chain"* doesn't satisfy that bar even if the
person behind it is honest. Key compromise is a single point of
failure for the entire identity gate.

## 2. The proposed pattern

Mirror `DatumStakeRootV2` (`contracts/DatumStakeRootV2.sol`):
permissionless bonded reporters, optimistic submission with a
challenge window, slash on bad-faith attestations.

### Architecture

```
Anyone with ≥ reporterMinStake DOT
  ↓ joinReporters() payable
[Reporter set, on-chain]
  ↓ submitAttestation(user, level, validity, attestProof)
[Pending attestation — challenge window open]
  ↓
  ├─ challenger calls challengeAttestation(...) with counter-evidence → slash
  └─ window expires → attestation finalized → written to cache
```

### Key contracts (sketch — same shape as StakeRootV2)

#### `DatumBondedIdentityReporter` (new contract, ~400 lines)

State:
- `mapping(address => Stake) reporterStake` — `{ amount, exitProposedAt }`.
- `address[] reporterList` + `mapping(address => uint256) reporterIndex`.
- `uint256 totalReporterStake` — drives approval-threshold math.
- `mapping(bytes32 => Attestation) pendingAttestations` —
  attestationKey = `keccak256(user, epoch)`, value = `{ level,
  validityBlocks, proposer, proposedAt, approvedStake, finalized,
  slashedToChallenger }`.
- Governable parameters (all `onlyOwner`, bounded):
  - `reporterMinStake` — min DOT to join reporter set (e.g. 10 DOT).
  - `reporterExitDelay` — blocks before exit completes (e.g. 14_400 ≈ 1d).
  - `attestationChallengeWindow` — blocks before finalization (e.g. 100 ≈ 10min).
  - `attestationApprovalThresholdBps` — stake fraction approving (e.g. 5100 bps).
  - `attestationProposerBond` — bond posted with each attestation (e.g. 0.1 DOT).
  - `challengerBond` — bond posted to challenge (e.g. 0.1 DOT).
  - `slashedToChallengerBps` — % of slashed bond to challenger (e.g. 5000).

External functions:
- `joinReporters() external payable` — deposit ≥ reporterMinStake; added
  to active set.
- `proposeReporterExit() external` — start exit timer. Immediately
  decrements `totalReporterStake` (per StakeRootV2 H3 fix).
- `finalizeReporterExit() external nonReentrant` — after delay, refund
  stake.
- `submitAttestation(address user, uint8 level, uint64 validityBlocks)
  external payable` — anyone in reporter set with ≥ proposerBond.
  Creates a Pending attestation; emits event.
- `approveAttestation(bytes32 key) external` — other reporters can
  approve to fast-finalize. Tracks `approvedStake` per attestation;
  threshold-met attestations skip the challenge window.
- `challengeAttestation(bytes32 key, AttestProof memory counterProof)
  external payable` — anyone, with ≥ challengerBond. counterProof =
  signed quote from a registered People Chain registrar +
  cryptographic anchor (e.g. block hash of People Chain block at
  attestation time). If valid AND contradicts the attestation,
  proposer + approvers slashed.
- `finalizeAttestation(bytes32 key) external nonReentrant` — anyone,
  after challenge window. Reads finalized attestation and writes
  through to `cache.submitAttestation(user, level, validity)`. Returns
  bond to proposer.
- `claim() external nonReentrant` — pull-payment for refunded /
  rewarded amounts.

#### `DatumPeopleChainIdentity` (existing — minimal change)

- Add this new reporter contract as an authorized writer alongside
  `oracleReporter` and `xcmDispatcher`. Either:
  - Add a third lock-once `setBondedReporter(addr)` slot, OR
  - Allow `xcmDispatcher` to point at the bonded reporter contract
    (cleanest — same slot, repurposed).

Recommendation: **reuse the `xcmDispatcher` slot**. The cache treats
`xcmDispatcher` as "the trustless writer"; the bonded contract IS the
trustless writer.

#### `DatumPeopleChainXcmBridge` (existing — no change today)

The bridge becomes one of several authorized writers. Its
`xcmCallback` path continues to work for the future XCM-based return
leg; the bonded path operates in parallel.

### Trust properties

| Property | Single-Diana today | Bonded reporters |
|---|---|---|
| **False-positive attestations** | Diana can write at will | Anyone can challenge with counter-evidence; proposer slashed |
| **DoS by single party** | Diana can starve users | Any honest bonded reporter can attest; one bad actor doesn't gate the system |
| **Key compromise** | Catastrophic — full attest control | Damage bounded by single reporter's stake; slashed if caught |
| **Identity sourcing** | Diana decides | Reporters decide; multiple eyes on the same People Chain state |
| **Speed** | Instant | Either approve-fast (multi-stake threshold) or finalize-after-challenge-window |

## 3. The hard parts

### 3a. What is "valid counter-evidence"?

This is the load-bearing question. A challenger needs to prove:
*"the attestation says level X, but the truth on People Chain at
block N is level Y, and Y ≠ X."*

**Option α — Trusted block anchor + RPC quote (simplest):**
- Attestation includes a People Chain block hash + height.
- Counter-evidence is a signed quote from a People Chain RPC
  attesting to a different value at that block.
- Challenger submits the quote; on-chain logic checks the quote's
  signature against a known People Chain validator set.
- **Limitation:** the validator set on Hub needs to be known. This is
  itself an oracle problem.

**Option β — Direct Merkle proof against state root (clean):**
- Attestation includes the People Chain state root at block N.
- Counter-evidence is a Merkle proof of `pallet_identity::IdentityOf[user]`
  against that state root, decoded to a different judgement.
- **Requires:** Solidity-side state-proof verification + a trusted
  People Chain state root on Hub.
- **Blocked on:** the same "how does Hub know People Chain state
  roots" question as Option 4 in `people-chain-return-leg.md`. If
  Track C unblocks it, this option becomes viable.

**Option γ — Social slash via governance (slow but works today):**
- Counter-evidence is just an off-chain claim + signature.
- A council/governance vote arbitrates within the challenge window.
- Slashing requires a passed proposal.
- **Limitation:** slow; politicizes the slash. But works without new
  primitives.

**Recommendation:** **Option α with a publicly-known People Chain
registrar set as the "validator" anchor.** The People Chain registrar
set is small, on-chain, and queryable; a counter-evidence quote signed
by any registrar (the entity who issued the original judgement) is
strong evidence. If the attestation is wrong, the registrar can sign a
contradicting message.

### 3b. The proposer needs to provide a proof too

Symmetric requirement: the proposer's `submitAttestation` should
include an `attestProof` that gives challengers something to refute.
Without it, the challenger must independently verify off-chain, which
is fine in practice but doesn't scale.

Practical compromise:
- Attestation requires only `(user, level, validity, peopleChainBlock)`.
- The challenge window IS the verification time — observers query
  People Chain at the attested block and challenge if they disagree.
- Bonds + slashing create the incentive.

This is what StakeRootV2 does too: the proposer doesn't have to prove
anything upfront; the bond is the commitment.

### 3c. Identity changes within the validity window

A user's People Chain identity can change between attestation and
expiry. E.g.:
- T=0: User has KnownGood.
- T=0: Diana / reporter writes level=2, validity=30d.
- T=10d: User's judgement is downgraded to OutOfDate on People Chain.
- T=10d to T=30d: Cache still says level=2 — stale.

This is **not** a bonded-reporter problem; it's a cache-staleness
problem and exists today.

Mitigations:
- Anyone can call `cache.forgetMe()` for their own record — but only
  the user can do this for themselves.
- A "downgrade attestation" path: any reporter can submit a
  `(user, levelLower < currentLevel, validity)` attestation that's
  finalized without the challenge window (downgrades are
  permissionless and self-correcting; can't be wrong in a Sybil
  direction).
- Shorter `validityBlocks` for higher-trust attestations.

This is worth designing for explicitly but isn't a blocker.

### 3d. Sybil resistance on the reporter set

Reporter slot cost = `reporterMinStake` DOT. Locked while active.
Exit delay slows churn.

If `reporterMinStake` is small (e.g. 10 DOT), a determined attacker
could run many reporters. They can't fabricate identity attestations
collusively (because challenges + slashing apply per attestation), but
they could:
- Approve each other's attestations to fast-finalize within the
  threshold.
- Selectively choose to attest only for "their" users.

Mitigations:
- `approvalThresholdBps` set high (e.g. 51%+ of total reporter stake).
- Approvals are stake-weighted, not headcount.
- The cache continues to expose `forgetMe()` and downgrade-everyone-can-write.

This is the same Sybil-vs-cost trade-off StakeRootV2 manages. Same
playbook applies.

## 4. Implementation plan

### Phase A — design + governance signal (~1 week)
- This doc.
- Discuss in design review.
- Confirm bonded-reporter is the chosen pre-mainnet posture.

### Phase B — contract + tests (~2 weeks)
- `contracts/DatumBondedIdentityReporter.sol` — mirror StakeRootV2
  reporter-stake + approval + challenge machinery.
- `test/bonded-identity-reporter.test.ts` — unit tests for join /
  exit / submit / approve / finalize / challenge / slash.
- Modify `DatumPeopleChainIdentity.setXcmDispatcher` to allow the
  bonded contract as a writer.
- Estimated: 600 lines contract + 400 lines tests.

### Phase C — integration + deploy script (~3 days)
- Add to `scripts/deploy.ts`. Initial reporter set: deployer +
  Diana for testnet, Council multi-sig members for mainnet.
- Web admin page for reporter set inspection (read-only initially).
- Diana daemon: update to call `bondedReporter.submitAttestation`
  instead of `cache.submitAttestation`. Three-line change.

### Phase D — Paseo validation (~1 week)
- Deploy alongside the current bridge.
- Diana submits + approves her own attestations (single bonded
  reporter at first).
- Add a second test reporter (Eve?) to validate the
  multi-reporter path.
- Test the challenge path: submit a wrong attestation deliberately
  and verify slashing works.

### Phase E — mainnet flip (months)
- Couples to the Polkadot OpenGov runtime upgrade for whichever
  trustless path matures first (custom pallet / XCQ / state proofs).
- At mainnet flip: `cache.setXcmDispatcher(bondedReporterAddr)`,
  `cache.lockXcmDispatcher()`, `cache.lockOracleReporter()`.
- The bonded reporter becomes the sole writer.

## 5. What this DOESN'T solve

Worth being explicit:

- **The EVM ↔ Substrate identity binding problem.** A user's People
  Chain identity is keyed by AccountId32; their Hub address is an
  H160. The standard pallet-revive padding maps H160 → AccountId32
  deterministically, but that derived account may not be where the
  user registered identity. Solving this requires user-driven
  identity binding (probably via signed message + on-chain record).
  Tracked separately.

- **People Chain identity correctness itself.** Bonded reporters can
  only report what People Chain says. If People Chain's registrar set
  is captured, the source data is wrong and no on-chain mechanism on
  Hub can detect it. People Chain is itself a trust root.

- **Fast finality.** The challenge window introduces 10–60 min
  latency for non-approval-threshold attestations. For high-trust
  attestations (multi-reporter approve), this can be near-instant,
  but the design trades latency for correctness.

## 6. Recommendation

**Build Phase B (contract + tests) during the same window as the
FRAME pallet work (Track B in the main plan).** They're complementary
and don't conflict:

- Bonded reporter mitigates single-Diana risk **today** (Paseo with
  Diana + Eve as bonded reporters).
- FRAME pallet brings full trustlessness **later** (months) and the
  bonded reporter cleanly retires once the pallet is live (its
  attestations are mooted by the on-chain XCM-callback path).

Or: ship the bonded reporter and **never** retire it. It's a
permissionless oracle for any future identity attestation source —
not just XCM. New writers can join without code changes; that's the
cypherpunk thesis.

## 7. Open questions

These need conversation before implementation:

1. **Counter-evidence shape (§3a).** Option α (registrar signature),
   β (state proof, blocked on Track C), or γ (governance)?
2. **Approval threshold.** 51% of bonded stake feels right; need to
   model adversarial scenarios.
3. **Initial reporter set sourcing.** Who funds the first 3–5
   reporters on mainnet? Treasury? Founder allocation?
4. **Bond sizing.** What's the right `reporterMinStake` to discourage
   Sybils but allow new reporters to join?
5. **Validity window per attestation level.** Should KnownGood
   attestations expire faster than Reasonable? Higher stakes →
   shorter window?
6. **Pause integration.** Should `CAT_IDENTITY_ATTEST` be a new
   pause category? (Probably yes — circuit-breaker if the reporter
   set is detected to be compromised.)

## Sources

- `DatumStakeRootV2.sol` — the pattern being mirrored
- `narrative-analysis/proposal-stakeroot-optimistic.md` — original
  design rationale for the optimistic approval pattern
- `narrative-analysis/people-chain-return-leg.md` — companion doc
  on the trustless return-leg options
- `narrative-analysis/migration-stakeroot-v1-to-v2.md` — playbook
  for migrating from a centralized single-writer to a bonded
  permissionless set
