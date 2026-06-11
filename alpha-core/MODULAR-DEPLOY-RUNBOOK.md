# DATUM alpha-core — Modular Feature-Deploy Runbook

How to deploy a feature module **on top of the existing core spine** — and how the
UI auto-shows it once it's live. This is the operational companion to
`scripts/feature-modules.mjs` (the manifest) and `web/src/lib/features.ts` (the UI
gate). For the core spine spin-up itself, see `CORE-DEPLOY-DRESS-REHEARSAL.md`.

## The model

The core MVP slim spine is deployed with every optional reference set to
`address(0)`. Each deferred feature has an **`onlyOwner whenPlumbingUnlocked`**
wire setter on a spine contract (verified: `DatumSettlement.setRateLimiter/
setPublisherStake/…`, `DatumClaimValidator.setZKVerifier/…`,
`DatumCampaigns.setTagSystem/…`, `DatumRelay.setRelayStake`,
`DatumGovernanceRouter.setCouncil`). Because the deployer is the Phase-0 owner and
plumbing is unlocked pre-OpenGov, **layering a feature = deploy its contract(s) →
call the wire setter(s) → verify**. No spine redeploy. The feature registry then
shows the feature in the UI automatically.

**Three layers move together for a feature:**
1. **Contracts** — deploy + wire (this runbook).
2. **UI gate** — `web/src/lib/features.ts` + extension mirror already map the
   feature → required address keys + phase; once the keys are in
   `deployed-addresses.json`, the nav/routes appear (and stay hidden if the phase
   is wrong). Nothing to do per-feature unless adding a brand-new feature.
3. **Manifest** — `scripts/feature-modules.mjs` documents contracts + wire setters
   + requiredPhase + UI paths per group. Update when adding a new feature.

## Two deploy mechanisms

### A. Bulk — `deploy.ts` (reuses the spine, adds everything)
`deploy.ts` is `deployOrReuse`-based and idempotent. Run against the **current**
`deployed-addresses.json` (the live spine) and it reuses the 19 spine contracts
and deploys + wires every deferred module:
```sh
WIRE_ZK_PREDICATE=1 npx hardhat run scripts/deploy.ts --network polkadotTestnet
```
- `WIRE_ZK_PREDICATE=1` is **required** — deploy.ts skips ZK-predicate wiring by
  default but its final validation expects it (the 2026-06-11 inconsistency).
- Re-run safe: a wiring-validation failure does NOT write the final
  `deployed-addresses.json`, but per-contract addresses persist incrementally, so
  fixing + re-running reuses them.
- StakeRootV2 stays in **shadow mode** unless `STAKE_ROOT_V2_SHADOW_MODE=false`.
- Council→router (`setCouncil`) is **not** wired here — it's a Phase 0→1 step.

### B. Single feature (the modular pattern)
For adding ONE module later, mirror `deploy-advertiser-registry.ts` /
`deploy-token-paseo.ts` (hybrid: hardhat factory for bytecode/ABI + raw
`JsonRpcProvider` + nonce-poll, because Paseo's `getTransactionReceipt` returns
null for confirmed txs — standard `ethers.waitForDeployment()/.wait()` HANG).
Per the manifest entry:
```
1. deploy the module's `contracts[]` (deployOrReuse → write deployed-addresses.json)
2. for each wire {target, setter, argKey}: send target.setter(addresses[argKey])
   (onlyOwner, idempotent — read the getter first / skip if already set)
3. reverseWire similarly (module → spine back-refs)
4. propagate deployed-addresses.json → extension/ + web/public/
5. verify (below)
```
The **token plane** is the worked example: `deploy-token-paseo.ts` (5 contracts +
wiring + address merge). Use it as the template for a new single-feature script.

## Per-group reference (`scripts/feature-modules.mjs`)

| Group | Contracts | Key wire setters | UI gates on |
|---|---|---|---|
| adExchangeCore | clickRegistry, publisherReputation, settlementRateLimiter, zkVerifier, tagSystem, tagCurator, campaignCreative, campaignAllowlist, reports | settlement.setRateLimiter/setClickRegistry; claimValidator.setZKVerifier/setCampaignAllowlist; campaigns.setTagSystem; tagSystem.setTagCurator | /identity/zk, /publisher/categories, /publisher/allowlist, /protocol/tag-curator |
| fraudPrevention | publisherStake, advertiserStake, challengeBonds, activationBonds | settlement.setPublisher/AdvertiserStake; campaigns.setChallenge/ActivationBonds; lifecycle.setChallengeBonds | /publisher/stake, /protocol/{publisher-stake,challenge-bonds}, /governance/activation-bonds |
| governanceLadder | governanceV2, council, parameterGovernance, publisher/advertiserGovernance, blocklistCurator | router.setCouncil (Phase 0→1); campaigns/governanceV2.setParameterGovernance; publishers.setBlocklistCurator | /governance/* (Council gated phase≥1) |
| relayAccountability | relayStake, relayGovernance | relay.setRelayStake | — |
| identityStakeRoot | identityVerifier, stakeRoot, stakeRootV2 | claimValidator.setStakeRoot; stakeRootV2.setIdentityVerifier | /protocol/sybil-defense |
| peopleChain | peopleChainIdentity, peopleChainXcmBridge, peopleChainBondedReporter | (oracle = deployer on testnet; no lockOracleReporter) | /identity/people-chain, /me/identity |
| tokenPlane | wrapper, mintAuthority, vesting, feeShare (+ tagRegistry, zkStake) | settlement↔mintCoordinator↔mintAuthority; paymentVault↔feeShare | /token/* |

## Verify a module

- `Settlement.validateConfiguration()` still returns `(true, "")`.
- The wire setter's getter reads back the new address (e.g.
  `claimValidator.zkVerifier()`, `campaigns.tagSystem()`,
  `mintAuthority.wrapper()`).
- UI: with the key set, the feature's nav/route appears; with it unset, it's
  omitted. Phase-gated features (Council) stay hidden below their phase.
- Optional per-feature on-chain smoke (extend `smoke-settle.mjs`): e.g. a
  tag-gated campaign validates only a tagged publisher; a token-reward campaign
  credits the vault (needs the vault funded first).

## Gotchas (from the 2026-06-11 rollout)

- **Paseo receipt bug:** always raw-provider + nonce-poll; never
  `waitForDeployment()/.wait()`.
- **`WIRE_ZK_PREDICATE=1`** for any full `deploy.ts` run.
- **Plumbing locks** are `whenOpenGovPhase` (Phase 2) — wire setters work at
  Phase 0/1; once locked at OpenGov a feature must be added by router rotation
  instead.
- **ABI drift:** after deploying a new contract type, run
  `web/scripts/sync-abis.mjs` + extension `copy-abis.js` and commit, or the CI
  ABI-drift gate fails.
- **Address propagation:** after any deploy, copy `deployed-addresses.json` →
  `web/public/` (the runtime-fetched copy) — deploy.ts auto-syncs only the
  extension copy.
