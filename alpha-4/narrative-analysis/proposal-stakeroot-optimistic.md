# Proposal: Permissionless Bonded StakeRoot (Option B/B')

Replace `DatumStakeRoot`'s N-of-M owner-managed reporter set with a
permissionless bonded-proposer mechanism. This document sketches the
implementation, walks through a subtle gap that makes the naive
fraud-proof design incomplete, and recommends a hybrid that preserves
privacy while eliminating the owner-managed trusted set.

## Status: design proposal, NOT implemented

Captured here so a future session (or a different contributor) can pick
up the design without re-deriving the trade-offs. Two contributors who
each see this independently should arrive at the same conclusion.

## Goal

Remove the owner-managed reporter set on `DatumStakeRoot`. The current
trust model — "M-floor((M-1)/2)+1 reporters won't collude" — is
acceptable for testnet but isn't cypherpunk. Target end-state: anyone
can become a stake-root proposer for the cost of a bond; malicious
proposals are caught by fraud proofs that slash the proposer.

## Naive Option B (the one I described earlier — it has a gap)

```solidity
function proposeRoot(uint256 epoch, bytes32 root) external payable {
    require(msg.value >= reporterBond, "E11");
    require(epoch > latestEpoch, "E64");
    require(pendingProposer[epoch] == address(0), "E22");

    pendingRoot[epoch]      = root;
    pendingProposer[epoch]  = msg.sender;
    pendingBond[epoch]      = msg.value;
    pendingProposedAt[epoch] = uint64(block.number);
    emit RootProposed(epoch, root, msg.sender);
}

function challengeRoot(
    uint256 epoch,
    bytes32 leaf,
    uint256 leafIndex,
    bytes32[] calldata siblings,
    /* fraud-specific witness */
) external payable {
    require(msg.value >= challengerBond, "E11");
    require(pendingRoot[epoch] != bytes32(0), "E01");
    require(block.number <= pendingProposedAt[epoch] + challengeWindow, "E96");
    // Verify the fraud, slash on success
}

function finalizeRoot(uint256 epoch) external {
    require(pendingRoot[epoch] != bytes32(0), "E01");
    require(block.number > pendingProposedAt[epoch] + challengeWindow, "E96");
    require(!slashed[epoch], "E22");

    rootAt[epoch] = pendingRoot[epoch];
    if (epoch > latestEpoch) latestEpoch = epoch;

    // Refund proposer bond; clear pending state.
    _pending[pendingProposer[epoch]] += pendingBond[epoch];
    delete pendingRoot[epoch];
    delete pendingProposer[epoch];
    delete pendingBond[epoch];
    emit RootFinalized(epoch, rootAt[epoch]);
}
```

This API is clean. The problem is `challengeRoot` itself: **what is the
fraud proof, exactly?**

## The privacy gap in naive Option B

A leaf in the DatumStakeRoot tree is

```
leaf = Poseidon(userCommitment, datumBalance)
userCommitment = Poseidon(secret)
```

The whole point of the commitment scheme is that **the on-chain world
doesn't know which user a leaf belongs to.** That's the ZK privacy
property of Path A. A user later proves "I know a `secret` whose
`Poseidon(secret) = userCommitment`, and my balance ≥ minStake" without
revealing identity or balance.

A fraud proof needs to disprove the leaf. Three failure modes:

1. **Balance fraud:** Leaf encodes `Poseidon(c, b)` but the user behind
   `c` actually had balance `b' ≠ b` at the snapshot block.
2. **Phantom leaf (inclusion fraud):** A leaf exists for a commitment
   `c` that doesn't correspond to any real user. Lets attacker generate
   Sybil stake from thin air.
3. **Exclusion fraud:** A real user's commitment is missing from the
   tree. They can't prove their stake.

Compare to permissionless fraud proofs:

| Mode | Who can detect? | Cost to fraud-prove |
|---|---|---|
| 1. Balance fraud | Only the affected user (knows their own `secret`) | Cheap |
| 2. Phantom leaf | Nobody — there's no real user to come forward | **Impossible without re-doing the entire computation** |
| 3. Exclusion fraud | Only the affected user (knows their own commitment) | Cheap |

**Phantom-leaf fraud is the fatal case.** A bad-faith proposer can
inflate the tree with fake leaves claiming high balances. No honest
user comes forward to challenge those leaves because they don't
correspond to any real user. The only way to detect is to re-derive
the entire tree from the source-of-truth DATUM state — which is
exactly the work we were trying to delegate.

This isn't a minor edge case. It's the dominant attack: stake a tiny
bond, propose a root with 100 phantom high-balance leaves, finalize
after the challenge window, then use those phantom leaves to prove
stake against any campaign requiring it. Sybil staking at scale.

## Why this gap doesn't appear in optimistic rollups

Rollups face the same shape (off-chain computation, on-chain
commitment, fraud-proof challenge) but the state is **public**. Anyone
can re-execute and detect any divergence. DATUM's stake-root is
**private** — no public ground truth a watcher can compare against.

The fraud-proof model fundamentally requires a public ground truth.
Privacy and permissionless fraud proofs are in tension.

## Three resolutions

### Resolution 1: Bound the tree by an on-chain commitment set

```solidity
// New contract or extension of DatumStakeRoot
mapping(bytes32 => bool) public registeredCommitments;
bytes32[] public commitmentList; // for enumeration
uint256 public commitmentBond;   // cost to register

function registerCommitment(bytes32 commitment) external payable {
    require(msg.value >= commitmentBond, "E11");
    require(!registeredCommitments[commitment], "E22");
    registeredCommitments[commitment] = true;
    commitmentList.push(commitment);
    emit CommitmentRegistered(commitment, msg.sender);
}
```

The tree is now constrained: it MUST contain exactly one leaf per
registered commitment, and only those commitments. Phantom-leaf fraud
becomes detectable:

- Anyone can prove `"the proposed root contains a leaf at index I
  encoding commitment c, but c is not in registeredCommitments"`.
  Slash.

But there's a chicken-and-egg here: the `registerCommitment` setup
costs DATUM (the `commitmentBond`). A Sybil with deep pockets can still
register many commitments. The bond just sets a price floor on the
attack, it doesn't make it impossible.

**Trade-off:** The bond becomes a Sybil-pricing parameter for the
stake tree itself. If `commitmentBond` is high enough to make Sybil
unattractive relative to the value of fraudulent stake, this works.
But you've moved the trust question from "reporter set" to "is
commitmentBond high enough?" — a continuous parameter rather than a
discrete trust assumption.

### Resolution 2: Stake-bonded permissionless reporter set (Option B')

Keep the reporter set, but make it permissionless and stake-bonded:

- Anyone can `joinReporters()` by posting a bond (e.g., 1000 DATUM).
- Roots are approved by threshold of **bonded stake** (e.g., 51%
  of total bonded), not threshold of distinct accounts.
- Any user with a stake-tree commitment can challenge their own leaf
  via ZK proof of "I am user X, my balance was Y, the root claims Z."
- Successful challenge slashes the proposer's stake (and the stake of
  every reporter who approved).

This is essentially **PoS-style oracle**. Stake-weighted attestation
+ slashable bond + ZK self-challenge.

**Sybil safety:** an attacker buying 51% of bonded reporter stake is
expensive (the bonded stake is real DATUM at risk). Phantom-leaf
fraud requires a stake-weighted majority of reporters to collude,
same as a 51% attack on a PoS chain.

**Trade-off:** still has a trust assumption (majority of bonded
stake is honest), but the trust is now economic + permissionless
rather than social + owner-managed. Significantly stronger than
status-quo Option A.

### Resolution 3: ZK validity proof of root correctness (Option C)

Reporter proves in zero-knowledge that the proposed root is the
correct accumulator of {leaf_i for c_i in registeredCommitments where
leaf_i = Poseidon(c_i, DATUM.balanceOf(addr(c_i)) at snapshotBlock)}.

This requires the circuit to verify storage proofs against the DATUM
contract's storage trie. Heavy circuit, but on-chain verification is
~300k gas (standard Groth16).

**Trade-off:** trust collapses to zero (math only), but the
engineering cost is significant. Circuit construction for ~1M leaves
takes hours of GPU prover time per epoch. Worth doing once DATUM is
mature; overkill for early stages.

## Recommendation

**Near-term (post-Paseo, pre-mainnet):** ship **Resolution 2**
(stake-bonded permissionless reporters with ZK self-challenge). Keeps
the proven N-of-M structure but removes the owner-managed reporter
set, swapping social trust for economic trust.

**Long-term (mainnet maturity):** migrate to **Resolution 3** (ZK
validity proof). Once the prover infrastructure exists, validity
proofs eliminate trust entirely. Resolution 2 lives alongside as a
fallback when prover infrastructure is unavailable.

## Resolution 2 — concrete proposal

### State changes

```solidity
// Remove (deprecated):
//   mapping(address => bool) public isReporter;
//   address[] public reporters;
//   uint256 public threshold;
//   function addReporter, removeReporter, setThreshold

// Add:
struct ReporterStake {
    uint256 amount;
    uint64  joinedAtBlock;
    uint64  exitProposedBlock; // 0 = active
}
mapping(address => ReporterStake) public reporterStake;
address[] public reporterList;
uint256 public totalReporterStake;

uint256 public reporterMinStake;      // governable, default 1000 DATUM
uint64  public reporterExitDelay;     // governable, default 14400 blocks
uint16  public approvalThresholdBps;  // governable, default 5100 (51%)

// Per-pending-root state:
struct PendingRoot {
    bytes32 root;
    uint64  proposedAt;
    address proposer;
    uint128 proposerBond;
    uint256 approvedStake;
    mapping(address => bool) approved;
    bool    slashed;
}
mapping(uint256 => PendingRoot) private _pending;

uint64  public challengeWindow;       // governable, default 14400 blocks
uint256 public proposerBond;          // governable, default 100 DATUM
uint16  public slashedToChallengerBps; // governable, default 8000
```

### Functions

```solidity
function joinReporters() external payable {
    require(msg.value >= reporterMinStake, "E11");
    ReporterStake storage s = reporterStake[msg.sender];
    require(s.amount == 0, "E22");
    s.amount = msg.value;
    s.joinedAtBlock = uint64(block.number);
    totalReporterStake += msg.value;
    reporterList.push(msg.sender);
    emit ReporterJoined(msg.sender, msg.value);
}

function proposeRootExit() external {
    ReporterStake storage s = reporterStake[msg.sender];
    require(s.amount > 0 && s.exitProposedBlock == 0, "E01");
    s.exitProposedBlock = uint64(block.number);
    emit ReporterExitProposed(msg.sender);
}

function finalizeExit() external {
    ReporterStake storage s = reporterStake[msg.sender];
    require(s.exitProposedBlock != 0, "E01");
    require(block.number >= s.exitProposedBlock + reporterExitDelay, "E96");
    uint256 amount = s.amount;
    totalReporterStake -= amount;
    // swap-and-pop from reporterList ...
    delete reporterStake[msg.sender];
    _pending[0]; // careful with storage; pseudocode
    _pendingPayout[msg.sender] += amount;
    emit ReporterExited(msg.sender, amount);
}

function proposeRoot(uint256 epoch, bytes32 root) external payable {
    require(reporterStake[msg.sender].amount > 0, "E01");
    require(msg.value >= proposerBond, "E11");
    require(epoch > latestEpoch, "E64");
    PendingRoot storage p = _pending[epoch];
    require(p.proposer == address(0), "E22"); // first-finalised-wins
    p.root = root;
    p.proposedAt = uint64(block.number);
    p.proposer = msg.sender;
    p.proposerBond = uint128(msg.value);
    p.approved[msg.sender] = true;
    p.approvedStake = reporterStake[msg.sender].amount;
    emit RootProposed(epoch, root, msg.sender);
}

function approveRoot(uint256 epoch) external {
    PendingRoot storage p = _pending[epoch];
    require(p.proposer != address(0), "E01");
    require(!p.approved[msg.sender], "E22");
    require(reporterStake[msg.sender].amount > 0, "E01");
    require(block.number <= p.proposedAt + challengeWindow, "E96");
    p.approved[msg.sender] = true;
    p.approvedStake += reporterStake[msg.sender].amount;
    emit RootApproved(epoch, msg.sender);
}

function challengeRootBalance(
    uint256 epoch,
    bytes32 commitment,
    uint256 claimedBalance,
    uint256 actualBalance,
    bytes32[] calldata merkleSiblings,
    uint256 leafIndex,
    /* ZK proof: prover knows secret s.t. Poseidon(secret) = commitment */
    bytes32[8] calldata identityProof
) external payable {
    require(msg.value >= challengerBond, "E11");
    PendingRoot storage p = _pending[epoch];
    require(p.proposer != address(0) && !p.slashed, "E01");
    require(block.number <= p.proposedAt + challengeWindow, "E96");

    // Step 1: verify the leaf actually is in the proposed root
    bytes32 leaf = poseidon2(commitment, claimedBalance);
    require(verifyMerkle(p.root, leaf, leafIndex, merkleSiblings), "E53");

    // Step 2: verify the challenger knows the secret behind `commitment`
    require(zkVerifier.verifyIdentity(commitment, identityProof, msg.sender), "E53");

    // Step 3: verify actualBalance is the DATUM balance of msg.sender at
    //         snapshot block. Approximation: use balance now; require
    //         challenger to be the affected user.
    require(DATUM.balanceOf(msg.sender) == actualBalance, "E53");
    require(actualBalance != claimedBalance, "E53"); // must actually differ

    _slashProposer(epoch, msg.sender);
}

function challengePhantomLeaf(
    uint256 epoch,
    bytes32 commitment,
    uint256 claimedBalance,
    bytes32[] calldata merkleSiblings,
    uint256 leafIndex
) external payable {
    // Only effective if a commitments-registry sub-mechanism is added
    // (Resolution 1). Without that, phantom-leaf fraud is undetectable
    // by this layer alone.
    require(msg.value >= challengerBond, "E11");
    PendingRoot storage p = _pending[epoch];
    require(p.proposer != address(0) && !p.slashed, "E01");

    bytes32 leaf = poseidon2(commitment, claimedBalance);
    require(verifyMerkle(p.root, leaf, leafIndex, merkleSiblings), "E53");
    require(!registeredCommitments[commitment], "E53"); // phantom!

    _slashProposer(epoch, msg.sender);
}

function _slashProposer(uint256 epoch, address challenger) internal {
    PendingRoot storage p = _pending[epoch];
    p.slashed = true;

    uint256 totalSlash = p.proposerBond;
    // Also slash every approver's bonded stake proportionally
    for (uint256 i = 0; i < reporterList.length; i++) {
        address r = reporterList[i];
        if (p.approved[r] && r != p.proposer) {
            uint256 cut = reporterStake[r].amount * slashApproverBps / 10000;
            reporterStake[r].amount -= cut;
            totalReporterStake -= cut;
            totalSlash += cut;
        }
    }

    uint256 toChallenger = totalSlash * slashedToChallengerBps / 10000;
    uint256 toTreasury = totalSlash - toChallenger;
    _pendingPayout[challenger] += toChallenger;
    _pendingPayout[treasury] += toTreasury;
    emit RootSlashed(epoch, challenger, totalSlash);
}

function finalizeRoot(uint256 epoch) external {
    PendingRoot storage p = _pending[epoch];
    require(p.proposer != address(0), "E01");
    require(block.number > p.proposedAt + challengeWindow, "E96");
    require(!p.slashed, "E22");
    require(p.approvedStake * 10000 >= totalReporterStake * approvalThresholdBps, "E46");

    rootAt[epoch] = p.root;
    if (epoch > latestEpoch) latestEpoch = epoch;
    _pendingPayout[p.proposer] += p.proposerBond;
    delete _pending[epoch];
    emit RootCommitted(epoch, p.root);
}
```

## Trade-offs summary

| Concern | Status quo (A) | Resolution 1 (commitment registry) | Resolution 2 (bonded reporters) | Resolution 3 (ZK validity) |
|---|---|---|---|---|
| Phantom-leaf fraud | Reporters caught it (or didn't) | Detectable; bond-priced Sybil | Stake-majority must collude | Impossible (math) |
| Balance fraud | Reporters caught it (or didn't) | Detectable by affected user | Detectable by affected user | Impossible (math) |
| Trust assumption | M-of-N social | Bond-pricing parameter | 51% of bonded stake honest | Zero |
| Owner-managed set? | Yes | No | No | No |
| Operating cost | Low (threshold txs) | Medium (registration txs) | Medium (threshold-of-stake txs) | High (prover infrastructure) |
| Per-epoch latency | Immediate | Immediate | Challenge window (~24h) | Prover time + verify (~mins) |
| Implementation cost | Done | +200 LOC | +300 LOC | +1000s LOC + circuit |
| Audit surface | Small | Medium | Medium-large | Large + circuit |
| Privacy preserved | Yes | Yes | Yes | Yes |
| User UX | Transparent | Must register commitment | Must register commitment | Transparent |

## Hidden trade-offs worth naming

1. **Resolution 2 introduces dust attacks.** A spammer can join with
   minimum stake and grief proposals (approve every root). Mitigation:
   require minimum continuous stake AND minimum-block-age to approve;
   griefing approvers get slashed if any of their approvals are
   challenged successfully.

2. **The challenger UX is intricate.** A challenger needs to: know
   their commitment, generate an identity ZK proof, build a Merkle
   inclusion proof against the proposed root, submit on-chain. Most
   users won't do this themselves. Realistically, a third-party
   "challenge service" emerges that monitors all proposed roots and
   auto-challenges discrepancies for users who pre-register. This is
   a new social actor — better than a trusted reporter set, but not
   zero-actor.

3. **Snapshot-block ambiguity.** "What was user X's balance at snapshot
   block B?" depends on B being well-defined. The proposer chooses B;
   the challenger must use the same B. Different choices ⇒
   different actual balances ⇒ false challenges. Mitigation: bake B
   into the proposed root commitment itself (proposeRoot takes
   `(epoch, snapshotBlock, root)`), and challengers verify against
   that B.

4. **DATUM token storage layout coupling.** The challenger's "actual
   balance" check is `DATUM.balanceOf(msg.sender)`. That works if
   DATUM is on the same chain and the balance hasn't moved between
   snapshot block and challenge time. If snapshot block is older than
   the last few blocks, you need a way to read historical state —
   either EVM block hashes + storage proofs, or a snapshot mechanism
   in DATUM itself (e.g., OZ ERC20Snapshot).

5. **Reporter cartel risk.** If `reporterMinStake` is high enough that
   only a few reporters exist, you've re-introduced an oligarchy.
   Mitigation: set `reporterMinStake` low and let the approval
   threshold do the work. But low minimum stake means more Sybil
   approvers — see #1.

6. **Composition with ActivationBonds economics.** DATUM is used both
   as the medium for these bonds AND as the staked asset being
   attested to. A circular dependency: if the reporter set is corrupt
   and produces fake high-stake leaves, those fake leaves can be used
   to "stake" against activation challenges or mutes. Need to be
   careful about which protocol mechanisms accept stake-root proofs
   vs which read directly from the DATUM token.

7. **Migration from current StakeRoot.** Existing committed roots
   under the old N-of-M scheme are valid; the new scheme starts
   accepting proposals from a fresh epoch onward. There's no need to
   re-attest history. But during the transition window, the old
   `commitStakeRoot` interface exists alongside the new
   `proposeRoot`; the old code path should be removed (`onlyOwner`
   migration) once enough bonded reporters exist for the new scheme
   to be safe.

## What this proposal does NOT solve

- It does not eliminate the privacy/fraud-proof tension for phantom
  leaves WITHOUT a commitment registry (Resolution 1 add-on). If
  you ship Resolution 2 alone, phantom-leaf fraud is only deterred
  by the bonded-stake-majority assumption, not by permissionless
  fraud proofs.
- It does not improve worst-case latency. The challenge window adds
  ~24h to root finalization. For high-frequency epoch updates this
  may be unacceptable; for daily epochs it's fine.
- It does not address the "majority-of-bonded-stake honest"
  assumption. That's still a trust statement, even if it's economic
  rather than social.

## Bottom line

Resolution 2 (bonded permissionless reporters) is the right next step.
It eliminates the owner-managed set, prices attacks at the level of
total bonded stake, and keeps the privacy of Path A intact.

Resolution 1 (commitment registry) is the natural follow-up that
closes the phantom-leaf gap. Combined, R2 + R1 = "permissionless +
honest-stake-majority + Sybil-priced commitments." That's a serious
trust property.

Resolution 3 (ZK validity proof) is the end-state target. Defer until
prover infrastructure is mature and the protocol has grown to where
trust assumptions are economically attackable.

## Implementation order if approved

1. Add `DatumStakeRoot` v2 alongside v1 (don't replace yet).
2. Wire ClaimValidator to accept stake-root from EITHER v1 or v2 via
   `addAllowedStakeRoot(address)`.
3. Bootstrap reporters: deployer joins as bonded reporter to keep
   things working during migration.
4. After a successful epoch under v2, deprecate v1 (set v1 to read-only).
5. Add Resolution 1 (commitment registry) in a second pass once R2 is
   bedded in.
6. Consider Resolution 3 once R2 has been live for several months
   and the prover bottleneck is engineered around.
