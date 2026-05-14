# Pre-Deploy Checklist — Alpha-4 v9 (Paseo Hub)

Generated 2026-05-14 covering all work since the last Paseo deploy
(2026-05-06 v8). Six new commits, ~3,800 LOC, 909/909 tests passing.

## What's new since last Paseo deploy

| Commit | Change | Status |
|---|---|---|
| `9bb4176` | Optimistic activation + commit-reveal on contested Pending | landed |
| `010de1e` | Phase 2b: emergency mute bond on Active campaigns | landed |
| `e4676c9` | Three-lane tag policy: `DatumTagRegistry` | landed |
| `329a2e1` | Wire `DatumActivationBonds` into deploy.ts + setup-testnet.ts | landed |
| `650a9f7` | `DatumPublishers.setAllowedAdvertisers` batch | landed |
| `d7da52f` | Governance-settable caps + ergonomic batch entrypoints | landed |

## Contracts that gained behaviour (re-deploy targets)

These all changed substantively — every one needs a fresh deploy on v9:

- **`DatumActivationBonds`** — NEW (22nd contract). Wired into Campaigns,
  GovernanceV2, ClaimValidator.
- **`DatumCampaigns`** — `createCampaignWithActivation`, `addAllowedPublishers`
  batch, `setActivationBonds`, three new governance setters (max tags ×2 +
  max allowed publishers), `activateCampaign` accepts ActivationBonds caller.
- **`DatumGovernanceV2`** — `commitVote` / `revealVote` / `sweepUnrevealed`,
  `setActivationBonds`, `setCommitRevealPhases`, Pending-vote gating.
- **`DatumClaimValidator`** — `setActivationBonds`, `isMuted` check on
  validation path (reason 22).
- **`DatumPublishers`** — `setAllowedAdvertisers` batch,
  `setRelaySignerAndProfile` combined, `publisherTagMode` for three-lane.
- **`DatumChallengeBonds`** — `maxBondedPublishers` setter.
- **`DatumCouncil`** — `addMembers` / `removeMembers` batch.
- **`DatumSettlement`** — `maxBatchSize` governable (was hard-coded 10).
- **`DatumRelay`** — `maxBatchSize` governable.

## Contracts that did NOT change (can reuse v8 addresses if redeploying selectively)

- `DatumPauseRegistry`, `DatumTimelock`, `DatumZKVerifier`, `DatumBudgetLedger`,
  `DatumPaymentVault`, `DatumCampaignLifecycle`, `DatumAttestationVerifier`,
  `DatumTokenRewardVault`, `DatumPublisherStake`, `DatumPublisherGovernance`,
  `DatumParameterGovernance`, `DatumGovernanceRouter`, `DatumClickRegistry`,
  `DatumCouncilBlocklistCurator`.

Realistically: just redeploy the whole set, `deployOrReuse()` handles
sequencing safely.

## NEW: `DatumTagRegistry` is NOT wired in deploy.ts yet

`DatumTagRegistry` (contract + tests landed in `e4676c9`) is **not** in
`scripts/deploy.ts` and **not** in `REQUIRED_KEYS`. The three-lane policy
default is Curated, so the registry being absent isn't a blocker — but the
StakeGated lane (mode=1) is unreachable until it's deployed and wired.

**Decision required:** include TagRegistry in the v9 deploy or defer to v10?
The contract takes a WDATUM token reference in the constructor; if the
DATUM token isn't yet deployed, defer. Add to checklist for v10 either way.

## Bytecode sizes (Spurious Dragon = 24,576 B; Paseo does not enforce)

| Contract | Size | Notes |
|---|---|---|
| `DatumSettlement` | 37,080 B | grew from 36,872 B |
| `DatumCampaigns` | ~30,900 B | grew from 27,683 B |
| `DatumActivationBonds` | ~10 KB | new, fine |
| `DatumTagRegistry` | ~18 KB | new, fine |
| All others | < 24,576 B | fine |

Settlement/Campaigns are over Spurious Dragon. Per project memory: Paseo's
PVM EVM-compat path does **not** enforce the 24,576 B cap (alpha-3 deployed
GovernanceV2 at 57,453 B). Verify by attempting deploy — if it reverts on
size, the immediate fix is to drop revert strings on hot paths or split
into a satellite. Don't pre-emptively optimize.

## Configuration to verify before pushing the deploy button

### Default parameter values in `deploy.ts`

```
ACTIVATION_MIN_BOND              = 0.1 PAS         ← creator bond floor
ACTIVATION_TIMELOCK_BLOCKS       = 14400 (~24h)    ← challenge window
ACTIVATION_WINNER_BONUS_BPS      = 5000 (50%)      ← of loser bond
ACTIVATION_TREASURY_BPS          = 0               ← keep 0 until treasury wired

GOV_COMMIT_BLOCKS                = 14400 (~24h)    ← commit phase
GOV_REVEAL_BLOCKS                = 14400 (~24h)    ← reveal phase

PUB_GOV_QUORUM                   = 100 PAS         ← unchanged from v8
PUB_GOV_SLASH_BPS                = 5000 (50%)      ← unchanged

COUNCIL_VOTING_PERIOD            = 100 blocks      ← TESTNET (10 min)
COUNCIL_EXECUTION_DELAY          = 10 blocks       ← TESTNET (1 min)
COUNCIL_VETO_WINDOW              = 200 blocks      ← TESTNET (20 min)
COUNCIL_THRESHOLD                = 1               ← TESTNET (1-of-1)
```

**Anything labelled TESTNET MUST be changed for mainnet.** For v9 on Paseo,
the testnet values are correct.

### Post-deploy parameters (set via setters in deploy.ts)

```
DatumSettlement.maxBatchSize     = 50    ← was 10 (hard-coded)
DatumRelay.maxBatchSize          = 50    ← was 10 (hard-coded)
DatumCampaigns.maxPublisherTags  = 64    ← was 32 (constant)
DatumCampaigns.maxCampaignTags   = 16    ← was 8  (constant)
DatumCampaigns.maxAllowedPublishers = 64 ← was 32 (constant)
DatumChallengeBonds.maxBondedPublishers = 64 ← lockstep
```

These are constructor defaults; no extra setter calls needed unless you
want different testnet values.

## Off-chain integration work that BLOCKS testnet use

These touch the user-facing surfaces. Without them, the deploy succeeds
but nobody can interact with the new flows from a browser.

### Web app — `web/src/`

- **ABI regen**: `web/src/shared/abis/DatumCampaigns.json` etc. still on
  v8. Re-export from `alpha-4/artifacts/contracts/<X>.sol/<X>.json` after
  `npx hardhat compile`. Missing entries:
  - `createCampaignWithActivation`
  - `addAllowedPublishers`
  - `setActivationBonds`, `setMaxPublisherTags`, `setMaxCampaignTags`,
    `setMaxAllowedPublishers`
  - All `MAX_*_CEILING` reads
  - `maxPublisherTags` / `maxCampaignTags` / `maxAllowedPublishers` reads
  - All new events: `MaxPublisherTagsSet`, `MaxCampaignTagsSet`, etc.
- **New ABI file needed**: `DatumActivationBonds.json` (whole new contract).
- **`web/src/shared/types.ts`**: add `activationBonds` to `ContractAddresses`.
- **`web/src/shared/networks.ts`** and `contracts.ts`: same.
- **CreateCampaign page**: optional toggle to use the activation flow
  (post bond, see timelock countdown) vs legacy vote flow.
- **Renamed constant reads**: any code using `MAX_PUBLISHER_TAGS()` or
  `MAX_CAMPAIGN_TAGS()` or `MAX_ALLOWED_PUBLISHERS()` as view functions
  must switch to `maxPublisherTags()` etc. (the renames removed the
  legacy view shims).

### Extension — `alpha-4/extension/`

Same ABI sync + types updates as web. Less surface area (extension is
mostly read-side); creation/governance flows live in the web app.

### SDK — `sdk/`

No changes expected unless the SDK exposes creation primitives. Verify
`createCampaign` (legacy 7-arg) still works untouched — it does, by design.

### Relay bot — `relay-bot/`

- Update `ADDRESSES` to point at the v9 contracts.
- Take advantage of `maxBatchSize = 50`: relay can now amortize fixed
  costs across larger batches. Recommended: bump the relay's internal
  batch-size config from 10 → 25-50 to claim the throughput win.

## Testnet seed flow — `setup-testnet.ts` notes

The script now auto-detects ActivationBonds and switches to the optimistic
path when wired. Pre-deploy verification:

- ☐ `addrs.activationBonds` set in `deployed-addresses.json` after deploy.
- ☐ Setup script shrinks `timelockBlocks` 14400 → 10 for the seed run
  (already coded). **Reset to 14400 after seeding** via a manual
  `setTimelockBlocks(14400)` call if you want production timelock for
  real-world testing.
- ☐ Bob/Charlie advertiser wallets need extra funding for the 0.1 PAS bond
  per campaign (50 campaigns × 0.1 PAS = 5 PAS extra per advertiser).
  Current `FUND_AMOUNTS.bob = 150 PAS` has buffer; verify after seed run.
- ☐ Frank's 10,500 PAS allocation is **unused** on the optimistic path —
  consider reducing if PAS supply is tight on the faucet.

## Test invariants to spot-check post-deploy

- ☐ `DatumCampaigns.maxPublisherTags()` returns 64
- ☐ `DatumCampaigns.maxCampaignTags()` returns 16
- ☐ `DatumCampaigns.maxAllowedPublishers()` returns 64
- ☐ `DatumChallengeBonds.maxBondedPublishers()` returns 64
- ☐ `DatumSettlement.maxBatchSize()` returns 50
- ☐ `DatumRelay.maxBatchSize()` returns 50
- ☐ `DatumActivationBonds.minBond()` returns 0.1 PAS
- ☐ `DatumActivationBonds.timelockBlocks()` returns 14400 (or 10 if still
  in testnet-seed mode)
- ☐ `DatumActivationBonds.muteMinBond()` returns 1 PAS (10× minBond default)
- ☐ `DatumCampaigns.activationBonds()` matches deployed address (lock-once)
- ☐ `DatumGovernanceV2.activationBonds()` matches (lock-once)
- ☐ `DatumClaimValidator.activationBonds()` matches (subject to plumbingLocked)

## Smoke tests after deploy (deferred from setup-testnet)

End-to-end flow walkthrough on Paseo:

1. ☐ Create a campaign via `createCampaignWithActivation` (web UI)
2. ☐ Wait timelock; call `activate(cid)` (anyone) → campaign goes Active
3. ☐ Settle a claim batch with 25+ claims (verify new batch cap works)
4. ☐ Challenge an in-flight Pending campaign via
   `ActivationBonds.challenge(cid)` payable
5. ☐ Commit + reveal a vote via `commitVote` / `revealVote`
6. ☐ `sweepUnrevealed` after revealDeadline (verify forfeit math)
7. ☐ `evaluateCampaign` after grace
8. ☐ Mute an Active campaign via `ActivationBonds.mute(cid)`
9. ☐ Verify `ClaimValidator.validateClaim` rejects with reason 22 while muted
10. ☐ `settleMute` after Terminated → muter refund; or after timeout → bond
    to advertiser

## Known limitations / things explicitly deferred

- **`DatumTagRegistry` not in deploy.ts** — see decision required above.
- **Phase 2b mute does not increment governance vote round** — if a
  campaign is muted and the demote vote produces stale weights from a
  prior vote cycle, the resolution is correct (status read), but the
  weights are misleading. Mitigated by the open-tally Active demote
  path being separate from commit-reveal Pending. See
  `optimistic-activation-phase-2b.md` for the round-keying refactor
  recommendation.
- **Two ABI-level renames are breaking for stale callers**: the
  view-function shims `MAX_ALLOWED_PUBLISHERS()` and `MAX_BONDED_PUBLISHERS()`
  (etc.) were removed in favour of governable storage variables
  `maxAllowedPublishers` / `maxBondedPublishers`. Web/extension/SDK
  must be regenerated.
- **No mainnet `transferOwnership` plan in this deploy** — testnet keeps
  deployer as owner of activationBonds. Mainnet wants ownership routed
  through Timelock/Router same as other contracts.

## Smoke test for the deploy.ts itself before pushing to Paseo

```bash
# 1. Compile
cd alpha-4
npx hardhat compile

# 2. Full test suite must pass
npx hardhat test
# expect: 909 passing, 0 failing

# 3. Deploy to local hardhat network (mock substrate)
npx hardhat run scripts/deploy.ts --network hardhat

# 4. If that works, run on Paseo
npx hardhat run scripts/deploy.ts --network polkadotTestnet
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

## Rollback plan

`deploy.ts` writes `deployed-addresses.json` incrementally. If anything
fails mid-deploy, the script is re-run safe (`deployOrReuse` skips
already-deployed contracts). To force a fresh deploy of just one
contract, delete its entry from `deployed-addresses.json` and re-run.

The v8 deployment remains canonical until v9 is confirmed working. The
web app `networks.ts` should keep v8 addresses for the `polkadotTestnet`
key until v9 smoke tests pass, then swap.

## Sign-off

- ☐ Compiler clean, no warnings other than Spurious Dragon (expected).
- ☐ Full test suite green (909/909).
- ☐ TagRegistry-in-v9 decision made.
- ☐ Web/extension ABI sync scheduled.
- ☐ Mainnet-vs-testnet param differences acknowledged.
- ☐ Backup of `deployed-addresses.json` before deploy.
