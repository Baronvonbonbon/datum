# Task Scope: ZK Identity Verifier

Concrete breakdown of the work to add a ZK identity verifier that
unlocks **balance-fraud** challenges on `DatumStakeRootV2`. Follow-on
to `task-stakeroot-v2-implementation.md` — the V2 contract was
deliberately shipped without this verifier, so phantom-leaf was the
only permissionless fraud-proof path. This task closes that gap.

## Goal

Enable any user to prove on-chain that:
1. They control the `secret` behind a `commitment` registered in
   the on-chain set, AND
2. The leaf for that commitment in the pending root has a balance
   that disagrees with the user's actual DATUM balance.

Result: the user gets the slashed proposer bond + their share of
slashed approver stakes. The trust model improves from "honest
51% bonded stake catches phantom Sybils, balance fraud against
real users requires off-chain monitoring" to "honest 51% bonded
stake catches phantom Sybils, real users catch balance fraud on
themselves cryptographically."

## Out of scope

- **Exclusion-fraud challenge** (proving a registered commitment
  is *missing* from a proposed root). Requires non-inclusion proof,
  which standard Merkle trees don't support efficiently. Resolutions:
  Sparse Merkle Tree migration OR sorted-leaf-neighbour-proof OR
  off-chain monitoring + manual re-include. Tracked as a separate
  follow-up.
- **Leaf-hash function unification** (Poseidon for ZK vs keccak for
  on-chain Merkle verification). Already documented in the V1→V2
  migration runbook; this verifier task assumes a decision has been
  made and the tree-builder is consistent.
- **Trusted-setup MPC ceremony.** Single-party setup is fine for
  testnet; mainnet wants a real MPC. Tracked separately.

## Architecture decision: where the verifier lives

Three options:

### Option A — Separate `DatumIdentityVerifier` contract (recommended)

A new ~200 LOC contract with one purpose: verify a Groth16 proof
that the prover knows `secret` such that `Poseidon(secret) == commitment`.
Public inputs: `commitment`. Private witness: `secret`.

**Pros:** Clear ownership, smallest possible verifier (one constraint
~= one constant + one Poseidon), separate trusted setup ceremony
(can be small and quick).

**Cons:** Another contract to deploy, wire, version.

### Option B — Extend `DatumZKVerifier` with a 1-input variant

Add `verifyIdentity(proof, commitment)` alongside the existing
`verifyA(proof, pubs[7])`. Requires a second `VerifyingKey` slot on
the contract.

**Pros:** One verifier contract, single deploy.

**Cons:** Two VKs to manage, mixes two unrelated circuits in one
contract, makes the existing audited verifier surface larger.

### Option C — Bake identity check into a refactored phantom-leaf path

Make `challengeRootBalance` require the user to prove ownership of
the contested commitment AND the discrepancy in one combined
circuit. Tightest coupling, most expensive proof.

**Pros:** Single ZK proof for the whole challenge.

**Cons:** Bigger circuit (Poseidon + Merkle path + balance lookup),
slower prover, harder to debug.

**Decision: Option A.** Smallest blast radius. The identity proof
is its own primitive that other contracts (future blocklist, future
governance) may also want — keeping it standalone makes it reusable.

## Stages

### Stage 0 — Circuit design + trusted setup

**Files:**
- `alpha-4/circuits/identity.circom` (NEW, ~30 lines)
- `alpha-4/scripts/setup-zk-identity.mjs` (NEW, ~80 lines — mirrors
  existing `setup-zk.mjs` for the impression circuit)
- `alpha-4/circuits/identity.zkey` (build artifact)
- `alpha-4/circuits/identity_vk.json` (build artifact)
- `alpha-4/circuits/identity-setVK-calldata.json` (build artifact)

**Circuit shape (identity.circom):**

```circom
pragma circom 2.0.0;
include "../node_modules/circomlib/circuits/poseidon.circom";

template Identity() {
    signal input commitment;          // public — the registered commitment
    signal input secret;              // private — the prover's secret

    component h = Poseidon(1);
    h.inputs[0] <== secret;

    // Constrain: Poseidon(secret) == commitment
    commitment === h.out;
}

component main { public [commitment] } = Identity();
```

That's it. Two constraints (one Poseidon, one equality).

**Setup script (setup-zk-identity.mjs):**

Mirror of the existing setup-zk.mjs. Uses ptau12 (probably overkill
but matches existing infrastructure). Outputs:
- `identity.zkey` (proving key, ~few MB)
- `identity_vk.json` (verifying key as JSON)
- `identity-setVK-calldata.json` (calldata for `setVerifyingKey` on
  the deployed verifier — same format as the existing impression
  setVK-calldata.json)

**Acceptance:** Circuit compiles, trusted setup completes, sample
proof verifies via snarkjs CLI.

**Effort:** ~1 session, contingent on the existing circuit tooling
working without surprises.

### Stage 1 — DatumIdentityVerifier contract

**Files:**
- `alpha-4/contracts/DatumIdentityVerifier.sol` (NEW, ~180 LOC)
- `alpha-4/contracts/interfaces/IDatumIdentityVerifier.sol` (NEW, ~20 LOC)
- `alpha-4/test/identity-verifier.test.ts` (NEW, ~120 LOC)

**Contract shape:**

```solidity
contract DatumIdentityVerifier is DatumOwnable {
    struct VerifyingKey {
        uint256[2] alpha1;
        uint256[4] beta2;
        uint256[4] gamma2;
        uint256[4] delta2;
        uint256[2] IC0;  // constant
        uint256[2] IC1;  // commitment
    }
    VerifyingKey private _vk;
    bool public vkSet;
    event VerifyingKeySet(bytes32 indexed vkHash);

    function setVerifyingKey(
        uint256[2] calldata alpha1, uint256[4] calldata beta2,
        uint256[4] calldata gamma2, uint256[4] calldata delta2,
        uint256[2] calldata IC0, uint256[2] calldata IC1
    ) external onlyOwner {
        require(!vkSet, "already set");
        _vk.alpha1 = alpha1;
        _vk.beta2 = beta2;
        _vk.gamma2 = gamma2;
        _vk.delta2 = delta2;
        _vk.IC0 = IC0;
        _vk.IC1 = IC1;
        vkSet = true;
        emit VerifyingKeySet(keccak256(abi.encode(_vk)));
    }

    /// @notice Verify Groth16 proof that prover knows secret s.t.
    ///         Poseidon(secret) == commitment.
    /// @param proof  256-byte Groth16 proof bytes (a, b, c)
    /// @param commitment public input (bytes32 → uint256 < r)
    function verifyIdentity(bytes calldata proof, bytes32 commitment)
        external view returns (bool)
    {
        if (!vkSet) return false;
        if (proof.length != 256) return false;
        uint256[1] memory pubs;
        pubs[0] = uint256(commitment) % FIELD_SIZE;
        return _verify(proof, pubs);
    }

    function _verify(bytes calldata proof, uint256[1] memory pubs)
        internal view returns (bool)
    {
        // Standard Groth16 pairing-check via 0x08 precompile.
        // Mirror of DatumZKVerifier._verify, simplified for 1 pub input.
        // ... ~120 LOC of pairing logic, copy/adapt from DatumZKVerifier ...
    }
}
```

**Interface (IDatumIdentityVerifier.sol):**

```solidity
interface IDatumIdentityVerifier {
    function verifyIdentity(bytes calldata proof, bytes32 commitment)
        external view returns (bool);
    function vkSet() external view returns (bool);
}
```

**Tests:**
- `setVerifyingKey` owner-only, lock-once
- `verifyIdentity` returns false if vk unset
- `verifyIdentity` returns false on 0-length or wrong-length proof
- Sample proof (generated via snarkjs in test fixture) verifies true
- Tampering with the commitment makes the proof fail
- Tampering with the proof bytes makes the proof fail

**Effort:** ~1 session for the contract, ~half session for tests
(test fixture needs a sample proof; can generate offline once and
hardcode in the test).

### Stage 2 — Wire into DatumStakeRootV2

**Files:**
- `alpha-4/contracts/DatumStakeRootV2.sol` (MODIFY: +~120 LOC for
  `challengeRootBalance` + `identityVerifier` ref + setter)
- `alpha-4/test/stake-root-v2-balance-fraud.test.ts` (NEW, ~250 LOC)

**Storage additions:**

```solidity
IDatumIdentityVerifier public identityVerifier;
event IdentityVerifierSet(address indexed addr);

function setIdentityVerifier(address addr) external onlyOwner {
    require(addr != address(0), "E00");
    require(address(identityVerifier) == address(0), "already set"); // lock-once
    identityVerifier = IDatumIdentityVerifier(addr);
    emit IdentityVerifierSet(addr);
}
```

**New challenge function:**

```solidity
/// @notice Balance-fraud challenge: prove the leaf for a commitment
///         encodes a balance that doesn't match the prover's actual
///         DATUM balance. Caller must prove knowledge of the secret
///         behind the commitment via the identity verifier.
///
/// @param epoch             pending root epoch
/// @param commitment        the commitment whose leaf is wrong
/// @param claimedBalance    the balance encoded in the bad leaf
/// @param leafIndex         Merkle leaf index
/// @param siblings          Merkle path
/// @param identityProof     ZK proof: prover knows secret s.t.
///                          Poseidon(secret) == commitment
function challengeRootBalance(
    uint256 epoch,
    bytes32 commitment,
    uint256 claimedBalance,
    uint256 leafIndex,
    bytes32[] calldata siblings,
    bytes calldata identityProof
) external payable nonReentrant {
    require(msg.value >= challengerBond, "E11");
    PendingRoot storage p = _pending[epoch];
    require(p.proposer != address(0), "E01");
    require(!p.slashed, "E22");
    require(block.number <= uint256(p.proposedAtBlock) + uint256(challengeWindow), "E96");
    require(address(identityVerifier) != address(0), "E00");

    // 1. Leaf must be in the proposed root
    bytes32 leaf = keccak256(abi.encodePacked(commitment, claimedBalance));
    require(_verifyMerkle(p.root, leaf, leafIndex, siblings), "E53");

    // 2. Commitment must be registered (otherwise this is a phantom-leaf
    //    case and challengePhantomLeaf is the right path)
    require(registeredCommitments[commitment], "E53");

    // 3. Caller must prove ownership of the commitment
    require(identityVerifier.verifyIdentity(identityProof, commitment), "E53");

    // 4. Caller's current DATUM balance must differ from claimed.
    //    SEE STAGE 3 — historical balance handling. For now, assume
    //    snapshotBlock is recent enough that current balance ≈ snapshot
    //    balance.
    uint256 actualBalance = IERC20(datumToken).balanceOf(msg.sender);
    require(actualBalance != claimedBalance, "E53");

    // Refund + slash
    _pendingPayout[msg.sender] += msg.value;
    _slashProposer(epoch, msg.sender);
}
```

**Tests:**
- Valid challenge (recent snapshot, real balance mismatch) → slash
- Challenge with bad Merkle path → revert E53
- Challenge with valid path but unregistered commitment → revert E53
  (caller should use challengePhantomLeaf instead)
- Challenge with valid path + commitment but no/wrong identity proof
  → revert E53
- Challenge with valid identity proof but balances actually match
  → revert E53
- Challenge after window → revert E96
- Challenge on already-slashed pending → revert E22
- Caller bond < challengerBond → revert E11

**Effort:** ~1 session for contract changes, ~1 session for tests
(generating identity proofs in tests is awkward — use a mock
verifier in unit tests, or precompute proofs).

### Stage 3 — Historical balance handling

The Stage 2 challenge currently uses `IERC20(datumToken).balanceOf(msg.sender)`
which is the **current** balance. If the snapshot block is more
than a few blocks old, balances may have moved, and false-negative
or false-positive challenges become possible.

Three resolutions (pick one):

**3a. Recency constraint (simplest, recommended for v2 launch).**
Require `snapshotBlock` ≤ `block.number - K` and ≥ `block.number - L`
for some K (e.g., 10 blocks) and L (e.g., 100 blocks). Off-chain
builder must commit roots within L blocks of the snapshot;
challengers have ~L blocks to challenge. Trade-off: tight operational
cadence; if the off-chain builder is slow, challenge window narrows.

```solidity
// In proposeRoot:
require(snapshotBlock + 100 >= block.number, "E11"); // snapshot ≤ 100 blocks old
require(snapshotBlock + 10 <= block.number, "E11"); // ≥ 10 blocks ago

// In challengeRootBalance:
// Check is implicit — challenger acts within challengeWindow, by which
// time block.number is close to snapshotBlock; balance comparison uses
// current balance as approximation.
```

**3b. OZ ERC20Snapshot on DATUM token.** Modify the DATUM token to
inherit `ERC20Snapshot`. Snapshot taken at `proposeRoot` time.
Challenger reads historical balance via `balanceOfAt(snapshotBlock)`.
Best accuracy; requires DATUM token contract change + snapshot gas
overhead on every transfer between snapshots.

**3c. EVM block-hash storage proofs.** Challenger provides a
storage proof of their DATUM balance at the snapshot block. Heavy
(~150k extra gas) but trustless and works with any unmodified
ERC20.

**Decision for first ship: 3a.** Reassess once mainnet adoption
gives a clearer picture of whether tight snapshot recency is
operationally viable.

**Effort if 3a:** ~few hours to add the constraints + tests.
**Effort if 3b/3c:** much larger — out of scope of this task.

### Stage 4 — Deploy wiring

**Files:**
- `alpha-4/scripts/deploy.ts` (MODIFY: ~30 LOC)
- `alpha-4/scripts/setup-testnet.ts` (no changes needed — bonded
  reporter bootstrap unchanged)

**Deploy.ts changes:**
- Add `identityVerifier` to REQUIRED_KEYS.
- Deploy step: `deployOrReuse("identityVerifier", "DatumIdentityVerifier", [])`.
- Place in STAGE 3 lock-once wiring section:
  ```
  StakeRootV2.setIdentityVerifier(identityVerifier)
  ```
- Also wire VK from the trusted-setup output:
  ```
  identityVerifier.setVerifyingKey(...alpha, beta, gamma, delta, IC0, IC1)
  ```
  Conditional on `circuits/identity-setVK-calldata.json` existing
  (skipped with WARNING if absent — same pattern as the existing
  `ZKVerifier.setVerifyingKey` wiring).

**Effort:** ~half session.

### Stage 5 — Migration runbook update

**File:**
- `alpha-4/narrative-analysis/migration-stakeroot-v1-to-v2.md` (MODIFY)

Add a section noting that balance-fraud challenge is now available
once the identity verifier is deployed + the VK is set. Update the
"Open follow-ups" section to reflect that exclusion-fraud is the
only remaining trust gap.

**Effort:** ~quarter session.

## Open design decisions (decide during implementation)

1. **Field-modulus reduction for the public commitment.**
   `commitment` is `bytes32` on-chain but the circuit expects a
   field element. The verifier does `uint256(commitment) % r`. This
   is fine cryptographically (the modulo is consistent on both
   sides) but produces a small chance of collision (commitments
   above `r` map to commitments < `r`). The off-chain workflow
   should always generate commitments < `r` to avoid this; document
   in the SDK.

2. **Same field-modulus for stored leaves.** The Merkle leaf
   `keccak256(commitment, balance)` doesn't care about field
   modulus — keccak operates on raw bytes. But the off-chain ZK
   tree-builder (if using Poseidon) needs the commitment in field
   form. Match the on-chain raw commitment to the off-chain field
   commitment exactly.

3. **Verifier ownership.** Same pattern as DatumZKVerifier — deployer
   sets VK once, then transfers ownership to Timelock. Document
   that the VK can never be re-set (lock-once); if a circuit bug is
   found, the recovery path is to deploy a new IdentityVerifier and
   call StakeRootV2.setIdentityVerifier — except setIdentityVerifier
   is also lock-once. Tension here. Resolution: either make
   setIdentityVerifier *plumbingLocked*-gated instead of lock-once
   (re-pointable until lock), or accept that an identity-verifier
   bug means re-deploying V2.

   **Recommendation:** plumbingLocked-gated, not pure lock-once.
   Mirrors how ClaimValidator handles its verifier ref. Lower trust
   cost (operator can swap a buggy verifier before lockPlumbing
   fires).

4. **Bond pricing.** `challengerBond` is shared across phantom-leaf
   and balance-fraud challenges. The balance-fraud challenge has
   higher proof-generation cost (ZK proof), so honest challengers
   need a stronger incentive. Consider a separate bond knob:
   `balanceChallengerBond` vs `phantomChallengerBond`. Adds 1 more
   storage slot + governance setter; trade-off vs simplicity.

   **Recommendation:** start with a single shared bond; revisit if
   real-world data shows balance-fraud is under-challenged.

5. **Reward shape.** Successful balance-fraud challenger gets the
   same `slashedToChallengerBps` cut as phantom-leaf challengers.
   But the user has a SECOND legitimate claim: their leaf was
   wrong, the proposer was attacking THEM specifically. Worth
   considering a bonus payout. Adds complexity.

   **Recommendation:** uniform reward shape for v2. Asymmetric
   rewards are easy to add later if needed; harder to take away.

## Effort estimate

| Stage | Effort | Critical path? |
|---|---|---|
| 0 — Circuit + trusted setup | ~1 session | Yes — gates everything |
| 1 — IdentityVerifier contract | ~1.5 sessions | Yes |
| 2 — StakeRootV2 wiring + challengeRootBalance | ~2 sessions | Yes |
| 3 — Historical balance handling (3a recency) | ~0.5 session | Yes (if 3a) |
| 4 — Deploy wiring | ~0.5 session | Yes |
| 5 — Migration runbook update | ~0.25 session | No |

**Total: ~5-6 sessions** for the full task with resolution 3a.
Bumps to ~10+ sessions if 3b (ERC20Snapshot) or 3c (storage proofs)
is chosen for historical balances.

## Acceptance criteria

- [ ] `identity.circom` compiles + trusted setup produces a VK.
- [ ] `DatumIdentityVerifier` deployed; sample proof verifies; VK
      is lock-once.
- [ ] `StakeRootV2.setIdentityVerifier(addr)` plumbed.
- [ ] `StakeRootV2.challengeRootBalance(...)` rejects:
  - Insufficient bond (E11)
  - Bad Merkle path (E53)
  - Unregistered commitment (E53)
  - Invalid identity proof (E53)
  - Matching-balance call (E53)
  - After-window challenge (E96)
  - Already-slashed pending (E22)
- [ ] `StakeRootV2.challengeRootBalance(...)` succeeds when all
      pre-conditions hold; proposer + approvers slashed correctly.
- [ ] Snapshot-block recency constraint enforced.
- [ ] Migration runbook updated; "balance fraud" line moved from
      "deferred" to "available."
- [ ] No regressions in the existing 958-test suite.

## Risk + rollback

**Risk:** trusted setup compromise. If the secret used in the
trusted setup is leaked, an attacker can forge identity proofs for
any commitment.

**Mitigation:** for testnet, single-party setup is acceptable since
no real funds are at risk. For mainnet, run an MPC ceremony with N
participants — any one honest participant erases the secret.

**Risk:** circuit bug producing false-positive proofs (e.g.,
proving identity for any commitment regardless of secret).

**Mitigation:** code review the circuit; run differential tests
against a reference implementation; test fixture with intentionally-
wrong proofs that must fail.

**Rollback:** if a verifier bug is discovered post-deploy,
`StakeRootV2.setIdentityVerifier(...)` (if plumbingLocked-gated per
the Stage 1 design decision) re-points to a fixed verifier. If the
bug is in StakeRootV2 itself, fall back to the v1→v2 migration
runbook's rollback paths.

## What's still deferred after this task

- **Exclusion-fraud challenge.** Requires non-inclusion proof
  primitive. Track as a separate task; resolutions documented in
  the migration runbook.
- **Trusted-setup MPC ceremony for mainnet.** Coordinate when
  mainnet timeline is set.
- **Leaf-hash function unification.** Independent of this task —
  resolve in the v1→v2 migration runbook's Phase 0.

## Next action

Stage 0 — write `identity.circom` and run the trusted setup. The
circuit is tiny (~30 lines); the bottleneck is verifying the
existing snarkjs tooling still works without surprises. Establishes
the proving infrastructure before any contract code is written.
