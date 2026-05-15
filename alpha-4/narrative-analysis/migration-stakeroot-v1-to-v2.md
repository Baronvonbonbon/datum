# Migration Runbook: DatumStakeRoot V1 → V2

Operator playbook for cutting over from the owner-managed V1 reporter
set to the permissionless bonded-reporter V2. Companion to
`proposal-stakeroot-optimistic.md` and `task-stakeroot-v2-implementation.md`.

## State of the world at start of migration

- V1 is the only StakeRoot source. `ClaimValidator.stakeRoot` points
  at V1. `stakeRoot2` is `address(0)`.
- V1 reporters are an owner-managed set with N-of-M threshold.
- An off-chain `build-stake-root.ts` script generates trees and
  submits to V1 via `commitStakeRoot`.

## Goal

- V2 is the canonical StakeRoot source. `ClaimValidator.stakeRoot2`
  points at V2.
- V1 continues to serve `isRecent` for in-flight proofs against
  historical roots through the lookback window, then quietly retires.
- No service disruption — every step is additive until V1's final
  removal.

## Phase 0: Pre-flight

- [ ] V2 is deployed (`addresses.stakeRootV2` set in
  `deployed-addresses.json`).
- [ ] `ClaimValidator.stakeRoot2()` returns V2 address.
- [ ] `ClaimValidator.stakeRoot()` still returns V1 address.
- [ ] V2 has at least one bonded reporter (deployer auto-joined in
  `setup-testnet.ts`).
- [ ] Off-chain tree builder is updated to commit to **both** V1 and
  V2 in parallel during the dual-write window. See "Off-chain
  builder changes" below.

**Decision point: leaf-hash function compatibility.** V2 currently
uses `keccak256(abi.encodePacked(commitment, balance))` for
phantom-leaf verification. The ZK circuit uses Poseidon. Two leaves
hashed differently won't fit in the same Merkle tree. Options:

1. **V2 uses Poseidon on-chain** (heavy gas; ~30k per hash step).
2. **V2 uses keccak everywhere** (requires ZK circuit to verify
   against a keccak-hashed tree — feasible but bespoke).
3. **V2 commits two roots per epoch** — one keccak-based for fraud
   proofs, one Poseidon-based for ZK proofs. Both derived from the
   same leaf set.

Recommended: option 2 for the first migration cycle. The Path A
circuit gets rebuilt against a keccak-hashed tree. This is a
non-trivial circuit change but eliminates the on-chain Poseidon
cost. Track as a sub-task.

For testnet purposes, option 3 can be used immediately by keeping the
existing Poseidon-based ZK circuit and adding a parallel keccak root
for fraud-proof verification. The V2 contract API supports this
without modification (multiple `proposeRoot(epoch, ...)` calls under
different epoch numbers).

## Phase 1: Dual-write window (V2 + V1 in parallel)

1. **Update off-chain builder to commit to both contracts.**
   `scripts/build-stake-root.ts` calls `commitStakeRoot(epoch, root)`
   on V1 AND `proposeRoot(epoch, snapshotBlock, root)` on V2 for
   every epoch. (Approve from a second bonded reporter if N-of-M
   approval is needed for V2 finalization.)

2. **Confirm V2 produces roots successfully** for one full lookback
   window (8 epochs by default = 8 days at default 1-epoch-per-day
   cadence). Spot-check via the explorer that `rootAt(epoch)` is set
   on V2 to the same value as V1's `rootAt(epoch)`.

3. **Spot-check `ClaimValidator.isRecent`.** Any root in V1's lookback
   window should be accepted; any root in V2's lookback window
   should also be accepted (via `stakeRoot2.isRecent`).

4. **Acceptance criteria for moving to Phase 2:**
   - V2 has completed ≥ 8 epochs without a successful phantom-leaf
     challenge.
   - Multiple bonded reporters exist on V2 (not just the deployer).
   - No `DeprecatedCommitAttempt` events seen yet (V1 is not yet
     marked deprecated; this is just a sanity check that the
     monitoring infrastructure is in place).

## Phase 2: Mark V1 deprecated

Run a single governance call:

```solidity
DatumStakeRoot(v1).setDeprecated(true);
```

This is a no-op for any caller other than off-chain watchers:
- `commitStakeRoot` still works — V1 reporters can keep submitting.
- Each commit emits `DeprecatedCommitAttempt(reporter, epoch)`.
- `isRecent` is unaffected.

Off-chain monitoring should flag every `DeprecatedCommitAttempt`
event; in steady-state the V1 reporter set should retire from
submitting, leaving the V2 set as the sole source. If a stale relay
keeps submitting to V1, the event makes it visible.

**Wait period: minimum 30 days** before Phase 3. This is the grace
window for stale relays and downstream consumers.

## Phase 3: Remove V1 from ClaimValidator

```solidity
DatumClaimValidator.setStakeRoot(stakeRootV2);
```

This points the **primary** `stakeRoot` reference to V2 as well.
After this call, both `stakeRoot` and `stakeRoot2` point at V2;
recency checks always succeed against V2. V1 becomes irrelevant to
claim validation.

Alternative if `setStakeRoot` is locked (V1 in `stakeRoot` slot is
post-`plumbingLocked`): just clear `stakeRoot2` so V1 in the
primary slot continues to serve, then deprecate V1 entirely once
the lookback window has passed. Less clean — prefer to do Phase 3
before `lockPlumbing()` fires.

## Phase 4: Decommission V1 reporters

After Phase 3 has been live for ≥ LOOKBACK_EPOCHS (~8 days), no
proofs reference V1 roots. V1 reporters can be removed:

```solidity
for each reporter in V1.reporters:
    DatumStakeRoot(v1).removeReporter(reporter);
```

V1's `rootAt` mapping remains as historical record. The contract is
not destructed — onchain history is preserved.

## Phase 5: Off-chain builder cutover

Stop submitting to V1. `build-stake-root.ts` only calls V2's
`proposeRoot`. The dual-write window is over.

## Rollback at any phase

- **Phase 1 → 0**: stop V2 submissions. ClaimValidator still uses
  V1 as primary. No state cleanup needed.
- **Phase 2 → 1**: call `v1.setDeprecated(false)`. V1 returns to
  full operation; deprecation events stop.
- **Phase 3 → 2**: call `validator.setStakeRoot(v1)` to revert the
  primary back to V1. Requires `plumbingLocked == false`.
- **Phase 4 → 3**: re-add V1 reporters via `addReporter`. Owner-only.
- **Phase 5 → 4**: resume V1 submissions in the off-chain builder.

## Operator commands (testnet)

```bash
# Phase 0 verification
npx hardhat run scripts/check-wiring.ts --network polkadotTestnet

# Phase 2: mark v1 deprecated (one-shot owner call)
# Use a hardhat console snippet:
const v1 = await ethers.getContractAt("DatumStakeRoot", addresses.stakeRoot);
await v1.setDeprecated(true);

# Phase 3: swap validator primary
const validator = await ethers.getContractAt("DatumClaimValidator", addresses.claimValidator);
await validator.setStakeRoot(addresses.stakeRootV2);
```

For mainnet, every Phase 2+3+4 call goes through Timelock → Router →
target.

## Off-chain builder changes (sub-task)

The existing `scripts/build-stake-root.ts` needs:
1. New `submitTo` config: `"v1" | "v2" | "both"`.
2. V2 path: call `proposeRoot(epoch, snapshotBlock, root)` from the
   bonded reporter wallet (must have ≥ `proposerBond` to pay the
   bond + gas).
3. V2 approval coordination: if multiple bonded reporters operate
   the builder, second/third callers use `approveRoot(epoch)`
   instead of `proposeRoot`.
4. Hash function selection: if running dual-write with both V1
   (Poseidon tree) and V2 (keccak tree), build two trees from the
   same leaf set and submit each.

This change is its own ~150-LOC sub-task; not implemented here.

## Open follow-ups not addressed by this migration

- **Balance-fraud + exclusion-fraud challenges** for V2 are still
  deferred (need ZK identity verifier). Phantom-leaf challenge is
  the only fraud-proof path that works today. This means a malicious
  proposer can still commit a root with WRONG balances for real
  registered commitments, and that fraud is undetectable by
  permissionless watchers — affected users must come forward. Plan
  the identity-verifier follow-up before mainnet.

- **Leaf-hash function unification** (Poseidon vs keccak) — see
  Phase 0 decision point. Required for production ZK Path A
  integration.

- **Off-chain builder V2 update** — independent sub-task; ~150 LOC
  in `build-stake-root.ts`.

## Acceptance for full migration

- [ ] V2 is the primary StakeRoot referenced by ClaimValidator.
- [ ] V1 is deprecated (`deprecated == true`).
- [ ] No V1 reporters remain.
- [ ] Off-chain builder only commits to V2.
- [ ] At least one full V2 epoch has been validated end-to-end
      through ClaimValidator on a live test transaction.
