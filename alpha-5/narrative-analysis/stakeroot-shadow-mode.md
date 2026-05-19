# StakeRoot V1 Primary / V2 Shadow — Operating Model

DATUM's Path A oracle ships with **two stake-root contracts in
parallel** for the duration of the early-mainnet phase:

- **`DatumStakeRoot`** (V1, owner-managed N-of-M reporter set) is the
  **PRIMARY** source. ClaimValidator.stakeRoot points here. Production
  claim validation consults V1's roots.
- **`DatumStakeRootV2`** (permissionless bonded reporter set + phantom-
  leaf fraud proof) runs **in SHADOW** — produces roots in parallel but
  is **not wired into ClaimValidator** as `stakeRoot2`. V2 roots are
  not accepted for production claim validation.

This document explains why, how to operate it, and how to promote V2
to dual-source (and eventually primary) as the protocol matures.

## Why ship both contracts if only one is "live"

We deliberately built V2 (six-stage task, ~900 LOC, identity verifier,
trusted setup ceremony) and chose not to run it as the primary
oracle. The reasoning:

1. **At current scale, V1's trust model is stronger.** Buying 51% of
   bonded reporter stake in a small permissionless pool is cheaper than
   suborning 3-of-5 known operators with social/legal/reputational
   exposure. Production oracles (Chainlink/Pyth/RedStone) use V1's
   pattern for this reason.

2. **V2's complexity adds an attack surface.** Slash math, snapshot
   recency, ZK circuits, trusted setup ceremony — each is a class of
   bug V1 simply doesn't have. The bug rate of V1 is much lower
   because the code surface is smaller.

3. **Operational complexity is real cost.** V2 requires watcher
   services, off-chain ZK prover infrastructure, MPC ceremony for
   mainnet, dual-write tree builders. Same people who'd run V1
   reporters end up running V2 challenger services — the trust doesn't
   disappear, it fragments.

4. **V2 becomes correct later.** Once DATUM TVL is meaningful (say,
   10× the cost of cornering 51% of plausible bonded stake), V2's
   crypto-economic security outpaces V1's social trust. Until then,
   V1 is the operationally correct choice.

The V2 work isn't wasted — it's the runway. Shadow mode gives us:

- A production-tested oracle ready to promote when conditions warrant
- Continuous divergence checking (V1 vs V2 roots should match; any
  disagreement is a real-time signal of either V1 reporter
  compromise OR V2 implementation bug)
- A credibility story for the cypherpunk thesis
- Architectural readiness for the eventual V3 ZK-validity-proof oracle

## Topology

```
   off-chain tree builder
   ┌──────────────────────┐
   │  build-stake-root.ts │
   └──────────┬───────────┘
              │ dual-write
   ┌──────────┴────────────┐
   ▼                       ▼
DatumStakeRoot (V1)    DatumStakeRootV2
PRIMARY: ClaimValidator SHADOW: NOT wired to
.stakeRoot points here  ClaimValidator.stakeRoot2
              │
              ▼
      ClaimValidator
      validateClaim
      (only V1 roots accepted)
              │
              ▼
        Settlement
```

The off-chain tree builder is the only off-chain component that needs
to know about both. It writes the same root to V1 (`commitStakeRoot`)
and V2 (`proposeRoot` + `approveRoot` + `finalizeRoot`). A watcher
service compares `V1.rootAt(epoch)` against `V2.rootAt(epoch)` for
each finalised epoch and alerts on any divergence.

## Configuration switch

There are two layers — the deploy-time default and the runtime override.

### Deploy-time default (`deploy.ts`)

```typescript
const STAKE_ROOT_V2_SHADOW_MODE = true;
```

When `true` (default), `deploy.ts` skips the `setStakeRoot2` call so
`ClaimValidator.stakeRoot2` is left at `address(0)` after a fresh deploy.
When `false`, `deploy.ts` wires V2 as the secondary as part of normal
plumbing. This only affects fresh deploys.

### Runtime toggle (`scripts/toggle-stakeroot-mode.ts`)

For a live deployment, do not redeploy — flip the wiring on the existing
ClaimValidator owner-side:

```bash
MODE=dual    npx hardhat run scripts/toggle-stakeroot-mode.ts --network polkadotTestnet
MODE=shadow  npx hardhat run scripts/toggle-stakeroot-mode.ts --network polkadotTestnet
MODE=v2-sole npx hardhat run scripts/toggle-stakeroot-mode.ts --network polkadotTestnet
```

Each mode resolves to a concrete wiring on `DatumClaimValidator`:

| mode    | `stakeRoot`     | `stakeRoot2`    | semantics                                |
|---------|-----------------|-----------------|------------------------------------------|
| shadow  | V1              | `address(0)`    | V1 sole-source; V2 observational only    |
| dual    | V1              | V2              | EITHER oracle's recent root is accepted  |
| v2-sole | V2              | `address(0)`    | V2 sole-source; V1 also `setDeprecated`  |

The script is idempotent (no-op if already in the requested mode) and
aborts cleanly if `ClaimValidator.plumbingLocked` is true. Reversal is
symmetric — `MODE=shadow` collapses back to single-source V1 and clears
V1's deprecated flag.

### Off-chain dual-write

`scripts/build-stake-root.ts` honours `WRITE_MODE=v1-only|dual|v2-only`
(default `dual`). In `dual` it commits to V1 (`commitStakeRoot`), then
either proposes or co-signs on V2 (`proposeRoot` / `approveRoot`),
opportunistically finalising earlier pending epochs whose challenge
windows have lapsed. If the V2 pending root for an epoch disagrees with
the locally-built root, the reporter ABSTAINS and logs a divergence
warning — the watcher / fraud-proof path handles it from there.

### Divergence watcher

`scripts/watch-stakeroot-divergence.ts` compares `v1.rootAt(e)` against
`v2.rootAt(e)` over the lookback window. One-shot exit codes: `0` agree,
`1` diverged, `2` config/RPC error. Pass `--watch` to poll every
`POLL_SECONDS` (default 60).

## Reporter sets

### V1 (testnet bootstrap)
- Deployer is the sole reporter (added by `deploy.ts`).
- Threshold = 1 — one signature finalises a root.

### V1 (mainnet target before launch)
- 5 reporters: deployer + 4 external parties (Council members,
  independent operators, ecosystem partners).
- Threshold = 3 (3-of-5 majority).
- Reporters are KNOWN identities; collusion has out-of-band
  consequences (legal, reputational).

### V2 (testnet bootstrap)
- Deployer auto-joins as the first bonded reporter
  (in `setup-testnet.ts`, posts `reporterMinStake`).
- More reporters join voluntarily via `joinReporters`.

### V2 (mainnet)
- Permissionless from day 1. No owner-managed set.
- Approval threshold: 51% of total bonded stake (governable).

## Off-chain tree builder dual-write

Shipped in `scripts/build-stake-root.ts` — see the **Off-chain dual-write**
subsection of the Configuration switch above.

## Divergence monitoring (background)

A watcher service queries `v1.rootAt(e)` and `v2.rootAt(e)` for each
recently-finalised epoch. Any mismatch is one of three events:

1. **V2 reporter set committed a different root** — investigate which
   side is wrong; V1 majority is canonical for now.
2. **V1 reporters committed a different root** — investigate the V1
   set; V2 majority becomes the canonical witness.
3. **Bug in dual-write infrastructure** — most likely a different
   leaf-hash function or block-snapshot drift.

In shadow mode, divergence does NOT affect claim validation (V1 is
authoritative). It only triggers off-chain investigation.

A simple watcher script:

```bash
# (To be added to scripts/ as watch-stakeroot-divergence.ts)
# Polls every epoch boundary, compares rootAt on both contracts,
# pushes alerts on mismatch.
```

## Promotion to V2 dual-source

The decision criteria for flipping `STAKE_ROOT_V2_SHADOW_MODE = false`:

- [ ] V2 has been running in shadow for ≥ 30 days with zero
      divergence (or any divergence has been root-caused and fixed).
- [ ] V2 has multiple bonded reporters (not just the deployer) —
      ideally ≥ 5 with diverse stake.
- [ ] TVL or value-at-risk justifies the cypherpunk property
      (heuristic: when buying 51% of bonded reporter stake costs
      meaningfully more than the value of fraud).
- [ ] Mainnet MPC ceremony for `DatumIdentityVerifier` is complete
      (single-party setup is acceptable for testnet but not for
      mainnet production validation).
- [ ] Exclusion-fraud challenge is implemented (or accepted as a
      bounded risk).
- [ ] V2 off-chain build-stake-root.ts dual-write is stable.

When promoted:
- ClaimValidator accepts roots from EITHER V1 or V2.
- The reporter sets continue to dual-write for at least
  another 30 days (truly dual-source).
- If V1 reporters retire later (per the migration runbook),
  ClaimValidator.setStakeRoot(v2) makes V2 the sole source.

## Promotion to V2 sole-source (long-term)

After V2 has been the dual-source primary for some period:

1. V1.setDeprecated(true) — emits warning on continued commits
2. ClaimValidator.setStakeRoot(v2) — V2 in the primary slot
3. ClaimValidator.setStakeRoot2(address(0)) — clears the secondary
4. V1 reporters retire; v1 contract becomes a historical record.

Then DATUM has a fully permissionless oracle. The V1→V2 migration
runbook documents the operator steps.

## Risks of shadow mode

1. **Operational overhead.** Reporters now do twice the work. Cost
   is acceptable on a small reporter set; would not scale to
   hundreds of operators. Acceptable trade-off for the visibility +
   readiness benefits.

2. **Half-broken state if dual-write fails.** A bug in build-stake-
   root.ts could write to V1 but not V2 (or vice versa). Watcher
   service catches this. Mitigation: build-stake-root.ts should
   commit to BOTH in a single transaction batch where possible, or
   detect partial writes and retry.

3. **V2 reporter set is sparse during shadow.** If only the
   deployer is bonded, V2's "permissionless" property is theoretical.
   Encourage external parties to join V2 even during shadow — their
   stake earns no fees but they're prepared for promotion.

4. **Promotion flag is a single point of switching.** A buggy
   promotion (setting flag false but not updating dependent
   infrastructure) could cause sudden behaviour shifts.
   Mitigation: promote on a testnet first, walk through every
   downstream interaction.

## What this doesn't fix

- The fundamental "is the oracle correct?" question. Both V1 and V2
  are still off-chain-computed trees committed on-chain. Trustless
  validity proofs (V3) are the only way to eliminate this — and
  they're still expensive.

- Exclusion-fraud detection. Neither V1 nor V2 catches this
  permissionlessly. The affected user must come forward off-chain.

## TL;DR

V1 is the production oracle. V2 is the readiness deployment. Both
are deployed; off-chain tree builders write to both. ClaimValidator
trusts V1 only. Divergence between V1 and V2 roots is a monitoring
signal, not a validation outcome.

Flip `STAKE_ROOT_V2_SHADOW_MODE = false` in `deploy.ts` to promote
V2 to dual-source. Promote when the cypherpunk benefit exceeds the
operational complexity cost — heuristic: meaningful TVL + multiple
bonded reporters + mainnet MPC complete.
