# alpha-core Deploy Coverage

Audit of every production contract in `contracts/` against `scripts/deploy.ts`.
Refreshed **2026-06-11** (was 2026-05-23 / "alpha-5 v5"). Addresses are no longer
listed here — they live in `deployed-addresses.json` and drift every redeploy;
this doc tracks **coverage** (is each contract deployed, deferred, or abstract),
not addresses.

**Result: no silent gaps.** Every concrete contract is either deployed by the
base `deploy.ts`, deferred to the token-plane deploy with a documented reason,
deployed by its own staged script, or is an abstract base / storage-layout
helper that isn't directly deployable.

**Live deployments:**
- **Slim spine** (`DATUM_MVP=1`) — the **19** ◆-marked contracts below; the live
  Paseo deploy (`deployedAt 2026-06-10`). Optional/governance/token/ZK modules are
  left undeployed (`address(0)` = "feature off") and activate later via their
  lock-once setters — no spine redeploy. See `narrative-analysis/mvp-slim-deploy.md`.
- **Full deploy** — all **49** `deploy.ts` contracts (the non-MVP run).

## Status by contract

◆ = in the `DATUM_MVP=1` slim spine.

| Contract | Status | |
|---|---|---|
| `DatumActivationBonds` | deploy.ts | |
| `DatumAdvertiserGovernance` | deploy.ts | CB4 fraud track |
| `DatumAdvertiserRegistry` | **staged script** | `deploy-advertiser-registry.ts` (post-deploy addition; relay advertiser-cosigner discovery) |
| `DatumAdvertiserStake` | deploy.ts | CB4 stake |
| `DatumAttestationVerifier` | deploy.ts ◆ | |
| `DatumBondedIdentityReporter` | deploy.ts | People-Chain fast-path |
| `DatumBudgetLedger` | deploy.ts ◆ | Advertiser DOT escrow |
| `DatumCampaignAllowlist` | deploy.ts | |
| `DatumCampaignCreative` | deploy.ts | Bulletin Chain creative storage |
| `DatumCampaignLifecycle` | deploy.ts ◆ | |
| `DatumCampaigns` | deploy.ts ◆ | |
| `DatumCampaignsMigrationLogic` | deploy.ts ◆ | Campaigns full-state migration delegate |
| `DatumCampaignsStorage` | **abstract** | Storage base — inherited by Campaigns |
| `DatumChallengeBonds` | deploy.ts | |
| `DatumClaimValidator` | deploy.ts ◆ | |
| `DatumClickRegistry` | deploy.ts | |
| `DatumCouncil` | deploy.ts | Phase-1 N-of-M Council |
| `DatumCouncilBlocklistCurator` | deploy.ts | |
| `DatumDualSigSettlement` | deploy.ts ◆ | EIP-712 dual-sig path |
| `DatumEmissionEngine` | deploy.ts | |
| `DatumFundMigratable` | **abstract** | Native-PAS fund-sweep base (`migrateFundsTo`) |
| `DatumGovernanceRouter` | deploy.ts ◆ | Stable proxy + governor/adminGovernor split |
| `DatumGovernanceV2` | deploy.ts | |
| `DatumIdentityVerifier` | deploy.ts | |
| `DatumInterestCommitments` | deploy.ts | |
| `DatumMintCoordinator` | deploy.ts | |
| `DatumNullifierRegistry` | deploy.ts ◆ | |
| `DatumOwnable` | **abstract** | Ownable2Step base |
| `DatumParameterGovernance` | deploy.ts | Bicameral PG (self-owned post-bootstrap) |
| `DatumPauseRegistry` | deploy.ts ◆ | |
| `DatumPaymentVault` | deploy.ts ◆ | User + publisher pull-payment |
| `DatumPeopleChainIdentity` | deploy.ts | |
| `DatumPeopleChainXcmBridge` | deploy.ts | |
| `DatumPlumbingLockable` | **abstract** | Phase-gated lock base (`whenOpenGovPhase`) |
| `DatumPowEngine` | deploy.ts ◆ | Per-user Sybil/spam gate (enforced at launch) |
| `DatumPublisherGovernance` | deploy.ts | |
| `DatumPublisherReputation` | deploy.ts | |
| `DatumPublishers` | deploy.ts ◆ | |
| `DatumPublisherStake` | deploy.ts | |
| `DatumRelay` | deploy.ts ◆ | |
| `DatumRelayGovernance` | deploy.ts | |
| `DatumRelayStake` | deploy.ts | |
| `DatumReports` | deploy.ts | |
| `DatumSettlement` | deploy.ts ◆ | Thin shell + storage + DELEGATECALL router |
| `DatumSettlementLogicA` | deploy.ts ◆ | EIP-170 split delegate (relay entries) |
| `DatumSettlementLogicB` | deploy.ts ◆ | EIP-170 split delegate (`_processBatch` + dual-sig) |
| `DatumSettlementRateLimiter` | deploy.ts | |
| `DatumSettlementStorage` | **abstract** | Shared layout — Settlement / LogicA / LogicB |
| `DatumStakeRoot` | deploy.ts | |
| `DatumStakeRootV2` | deploy.ts | |
| `DatumTagCurator` | deploy.ts | Governance-curated tag lane |
| `DatumTagRegistry` | **token-deferred** | Constructor needs `IERC20 datum_` → `deploy-token.ts` |
| `DatumTagSystem` | deploy.ts | |
| `DatumTimelock` | deploy.ts ◆ | 48h Phase-2 timelock |
| `DatumTokenRewardVault` | deploy.ts ◆ | |
| `DatumUpgradable` | **abstract** | Router-rotation base |
| `DatumZKStake` | **token-deferred** | Constructor needs `IERC20 _token` → `deploy-token.ts` |
| `DatumZKVerifier` | deploy.ts | Groth16 impression verifier |

## Totals

| Category | Count |
|---|---:|
| Deployed by `deploy.ts` (production) | 49 |
| — of which in the `DATUM_MVP=1` slim spine ◆ | 19 |
| Abstract bases (not deployable) | 6 |
| Deferred to `deploy-token.ts` | 2 |
| Deployed by its own staged script | 1 |
| **Total `Datum*.sol` files** | **58** |

(Token plane proper — `DatumWrapper`, `DatumMintAuthority`, `DatumVesting`,
`DatumFeeShare`, `AssetHubPrecompileMock` — lives in `contracts/token/` and is
deployed by `deploy-token.ts`; not counted above.)

## Deferred contracts — when they deploy

`DatumTagRegistry` and `DatumZKStake` both take a DATUM ERC-20 in their
constructor, so they land alongside the token plane (`deploy-token.ts` writes the
WDATUM address). Their interfaces are already covered by the test suite; only the
deploy step is pending. `DatumAdvertiserRegistry` deploys via
`deploy-advertiser-registry.ts` as a staged post-deploy addition (no state
migration — brand-new contract; lowest-risk upgrade step).

## Operational invariant

`deploy.ts`'s `PARAM_SETTERS` filter tolerates entries whose contract isn't
deployed in a given run (logs `[skip PG entry]`), which is what keeps the script
working with the token-plane-dependent entries and in `DATUM_MVP=1` slim mode
(`mvpDefer` skips non-core keys; their refs stay `address(0)`).

## Verifying this manifest

```sh
cd alpha-core
ls contracts/Datum*.sol | sed 's|.*/Datum||;s|\.sol||' | sort -u > /tmp/all.txt
grep -oE 'deployOrReuse\("[^"]+", "Datum[^"]+"' scripts/deploy.ts \
  | sed 's/.*"Datum/Datum/;s/".*//' | sort -u | sed 's/^Datum//' > /tmp/dep.txt
comm -23 /tmp/all.txt /tmp/dep.txt
```

Expected output (the 9 not-deployed-by-`deploy.ts` contracts) — anything else is a
silent gap:

```
AdvertiserRegistry      # staged script
CampaignsStorage        # abstract
FundMigratable          # abstract
Ownable                 # abstract
PlumbingLockable        # abstract
SettlementStorage       # abstract
TagRegistry             # token-deferred
Upgradable              # abstract
ZKStake                 # token-deferred
```
