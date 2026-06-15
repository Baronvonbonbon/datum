# Migration compute-cost benchmark — live Paseo (2026-06-15)

`scripts/bump-all-paseo.ts` deploys each upgradable, loads it with real
state/funds, runs the full redeploy→freeze→migrate→fund-sweep on live
pallet-revive, and asserts nothing is lost (native PAS + ERC-20 conserved to the
wei, state carried). Re-run after the multi-claim fan-out upgrade (#30) landed
the paginated `DatumBudgetLedger` migrate.

**Result: 15/15 contracts bumped with no loss. Spent 18.58 PAS.**

Per-call weight via `eth_estimateGas` (weight units; fee ≈ weight ÷ 1e6 PAS at
the script's 1e12 gasPrice — i.e. sub-0.06 PAS per migrate):

| contract | freeze | migrate | fundSweep |
|---|--:|--:|--:|
| DatumPublisherStake | 1,294 | 19,143 | 4,433 |
| DatumAdvertiserStake | 1,297 | 18,779 | 4,438 |
| DatumChallengeBonds | 1,327 | 42,355 | 1,858 |
| DatumActivationBonds | 1,355 | 27,035 | 4,555 |
| DatumBudgetLedger | 1,317 | 28,472 | 1,838 |
| DatumZKStake | 1,293 | 23,917 | 5,339 |
| DatumTagRegistry | 1,369 | 27,100 | 5,493 |
| DatumRelayStake | 1,296 | 23,393 | 4,436 |
| DatumRelayGovernance | 1,365 | 52,407 | 4,941 |
| DatumPublisherGovernance | 1,377 | 13,509 | 4,965 |
| DatumAdvertiserGovernance | 1,370 | 12,941 | 0 |
| DatumNullifierRegistry | 1,250 | 4,746 | 0 |
| DatumPublisherReputation | 1,264 | 4,890 | 0 |
| DatumPublishers | 1,359 | 25,837 | 0 |
| DatumCampaignAllowlist | 1,301 | 32,439 | 0 |
| **mean migrate** | | **23,797** | |

## Going-forward cost (the important caveat)

These are **single-call** weights at small state. Real migration cost **scales
with state**, and on Paseo the binding limit is **per-tx proof-size from
cross-contract reads**, not ref_time:

- `DatumBudgetLedger` costs **~5 cross-contract staticcalls/campaign**
  (`budgetCampaignAt` + 3×`getBudgetFull` + `lastSettlementBlock`). The live
  upgrade probed the ceiling at **~8 campaigns/tx** (10 reverts), so a populated
  ledger migrates in **`ceil(N/8)` transactions** (the live 29-campaign escrow
  took 4). `migrationBatchSize` is governance-tunable to fit the live ceiling.
- The same pagination template (`DatumPublishers`, `DatumBudgetLedger`) applies
  to any other unbounded enumerable set before it outgrows one block.

bump-all migrates each contract against a Mock successor (version+1), so it
proves the migrate *mechanism* but cannot catch a real successor that forgot to
bump `version()` (the #30 BudgetLedger defect) — that only surfaces on a live
upgrade from the genuinely-old build.
