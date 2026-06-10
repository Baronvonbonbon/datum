# Alpha-5 Deploy Coverage

Audit of every production contract in `contracts/` against `scripts/deploy.ts`.
Generated 2026-05-23, post alpha-5 v5 redeploy (deployedAt
`2026-05-23T12:23:32.462Z`).

**Result: no silent gaps.** Every concrete contract is either deployed by
the base `deploy.ts`, deferred to the token-plane deploy with documented
reason, or is an abstract base / storage-layout helper that isn't directly
deployable.

## Status by contract

| Contract | Status | Notes |
|---|---|---|
| `DatumActivationBonds` | deployed by `deploy.ts` | Tier-1.5 satellite. v5 Paseo: `0xeb3f…c59A` |
| `DatumAdvertiserGovernance` | deployed by `deploy.ts` | CB4 fraud track (v5 addition). Paseo: `0xf273…9A18` |
| `DatumAdvertiserStake` | deployed by `deploy.ts` | CB4 stake (v5 addition). Paseo: `0xda5e…70cE` |
| `DatumAttestationVerifier` | deployed by `deploy.ts` | |
| `DatumBondedIdentityReporter` | deployed by `deploy.ts` | People-Chain fast-path |
| `DatumBudgetLedger` | deployed by `deploy.ts` | Advertiser DOT escrow |
| `DatumCampaignAllowlist` | deployed by `deploy.ts` | |
| `DatumCampaignCreative` | deployed by `deploy.ts` | Bulletin Chain creative storage |
| `DatumCampaignLifecycle` | deployed by `deploy.ts` | v2 with Phase A tunable |
| `DatumCampaigns` | deployed by `deploy.ts` | v2 with Phase A tunables |
| `DatumChallengeBonds` | deployed by `deploy.ts` | |
| `DatumClaimValidator` | deployed by `deploy.ts` | |
| `DatumClickRegistry` | deployed by `deploy.ts` | |
| `DatumCouncil` | deployed by `deploy.ts` | Phase-1 N-of-M Council |
| `DatumCouncilBlocklistCurator` | deployed by `deploy.ts` | |
| `DatumDualSigSettlement` | deployed by `deploy.ts` | |
| `DatumEmissionEngine` | deployed by `deploy.ts` | Path H emission engine |
| `DatumGovernanceRouter` | deployed by `deploy.ts` | Stable proxy |
| `DatumGovernanceV2` | deployed by `deploy.ts` | v2 with Phase B tunables |
| `DatumIdentityVerifier` | deployed by `deploy.ts` | |
| `DatumInterestCommitments` | deployed by `deploy.ts` | v5 addition |
| `DatumMintCoordinator` | deployed by `deploy.ts` | v2 with Phase B tunables |
| `DatumNullifierRegistry` | deployed by `deploy.ts` | |
| `DatumOwnable` | **abstract** | Base contract — not directly deployable. Inherited by all owned contracts. |
| `DatumParameterGovernance` | deployed by `deploy.ts` | Bicameral PG (self-owned post-bootstrap) |
| `DatumPauseRegistry` | deployed by `deploy.ts` | |
| `DatumPaymentVault` | deployed by `deploy.ts` | User + publisher pull-payment |
| `DatumPeopleChainIdentity` | deployed by `deploy.ts` | |
| `DatumPeopleChainXcmBridge` | deployed by `deploy.ts` | |
| `DatumPowEngine` | deployed by `deploy.ts` | |
| `DatumPublisherGovernance` | deployed by `deploy.ts` | |
| `DatumPublisherReputation` | deployed by `deploy.ts` | |
| `DatumPublishers` | deployed by `deploy.ts` | |
| `DatumPublisherStake` | deployed by `deploy.ts` | |
| `DatumRelay` | deployed by `deploy.ts` | |
| `DatumRelayGovernance` | deployed by `deploy.ts` | |
| `DatumRelayStake` | deployed by `deploy.ts` | |
| `DatumReports` | deployed by `deploy.ts` | |
| `DatumSettlement` | deployed by `deploy.ts` | |
| `DatumSettlementLogicA` | deployed by `deploy.ts` | EIP-170 split delegate |
| `DatumSettlementLogicB` | deployed by `deploy.ts` | EIP-170 split delegate |
| `DatumSettlementRateLimiter` | deployed by `deploy.ts` | |
| `DatumSettlementStorage` | **abstract** | Storage-layout helper. Inherited by Settlement / LogicA / LogicB. |
| `DatumStakeRoot` | deployed by `deploy.ts` | |
| `DatumStakeRootV2` | deployed by `deploy.ts` | |
| `DatumTagCurator` | deployed by `deploy.ts` | v5 addition (governance-curated lane) |
| `DatumTagRegistry` | **deferred to token plane** | Constructor requires `IERC20 datum_`. Lands alongside `deploy-token.ts`. |
| `DatumTagSystem` | deployed by `deploy.ts` | |
| `DatumTimelock` | deployed by `deploy.ts` | 48h Phase-2 timelock |
| `DatumTokenRewardVault` | deployed by `deploy.ts` | |
| `DatumUpgradable` | **abstract** | Router-rotation base. Inherited by every router-registered contract. |
| `DatumZKStake` | **deferred to token plane** | Constructor requires `IERC20 _token`. Lands alongside `deploy-token.ts`. |
| `DatumZKVerifier` | deployed by `deploy.ts` | Groth16 verifier for impression circuit |

## Totals

| Category | Count |
|---|---:|
| Deployed by `deploy.ts` (production) | 47 |
| Abstract bases (not deployable) | 3 |
| Deferred to `deploy-token.ts` | 2 |
| **Total `Datum*.sol` files** | **52** |

## Deferred contracts — when they will deploy

`DatumTagRegistry` and `DatumZKStake` both take a DATUM ERC-20 token in
their constructor. The DATUM token plane (Wrapper + MintAuthority +
Vesting + BootstrapPool + FeeShare + AssetHubPrecompileMock) is deployed
by `scripts/deploy-token.ts`, which the base `deploy.ts` does not invoke.

Until the token plane lands on Paseo, these two contracts have no usable
DATUM address to bind to. Their interfaces are already covered by the
test suite (`test/parameter-governance-phase-b.test.ts` and similar);
the deploy step is the only missing piece.

When ready, the integration runs `deploy.ts` first, then
`deploy-token.ts` (which writes the WDATUM address), then a new
`deploy-token-tag-zkstake.ts` that takes the WDATUM address and
instantiates these two with it.

## Operational invariants

The `deploy.ts` PARAM_SETTERS filter (introduced 2026-05-23 during the v4
debugging) tolerates entries whose contract isn't deployed in a given
run, logging `[skip PG entry]` and continuing. That filter is what keeps
the script working even with the two token-plane-dependent entries
listed in PARAM_SETTERS. If new contracts are added to PARAM_SETTERS
without being deployed, the filter catches them — no silent gas burns,
no half-wired deploys.

## Verifying this manifest

```sh
cd alpha-5
ls contracts/Datum*.sol | sed 's|.*/Datum||;s|\.sol||' | sort -u > /tmp/all-contracts.txt
grep -oE 'deployOrReuse\("[^"]+", "Datum[^"]+"' scripts/deploy.ts \
  | sed 's/.*"Datum/Datum/;s/".*//' | sort -u | sed 's/^Datum//' > /tmp/deployed.txt
comm -23 /tmp/all-contracts.txt /tmp/deployed.txt
```

Expected output: `Ownable`, `SettlementStorage`, `TagRegistry`,
`Upgradable`, `ZKStake` — and nothing else. Any other contract appearing
in that list is a silent gap.
