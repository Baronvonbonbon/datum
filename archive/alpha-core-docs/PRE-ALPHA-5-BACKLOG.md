> ⊗ **SUPERSEDED (2026-06-11) by [`ALPHA-CORE-BACKLOG.md`](../../alpha-core/ALPHA-CORE-BACKLOG.md).**
> Item-level content consolidated there with done/obsolete/open marks and Paseo-launch
> staging. Kept for detail/history; the consolidated doc is the live source of truth.

# DATUM Alpha-5 — Carryover Backlog

Compiled 2026-05-19 by walking every alpha-4-era doc that was inherited
into the alpha-5 tree. Deduped across:

- `AUDIT-HEDGES.md` (audit-prep punch list)
- `AUDIT-PASS-5-FINDINGS.md` (internal audit pass 5, 2026-05-14)
- `MAINNET-DEFERRED-ITEMS.md` (inventory of pre-mainnet work)
- `PRE-MAINNET-CHECKLIST.md` (subset; superseded by deferred-items)
- `PRE-REDEPLOY-FINDINGS.md` (2026-05-13 pre-redeploy audit)
- `PROCESS-FLOW-PRE-REDEPLOY.md` (descriptive; no actionable items)
- `SETTLEMENT-EIP170-PLANNING.md` (closed: two-Logic split shipped 2026-05-19)
- `FUTURE-WORK.md` (CB pass design backlog)

Source docs archived under `archive/alpha-4-docs/` after this backlog
landed. **Anything marked "revalidate" below is a claim from an
alpha-4 doc that may not still hold against the current alpha-5
contract tree — verify before relying on it.**

---

## Section 1 — Mainnet blockers (open)

These must run, be replaced, or be decided on before any Polkadot Hub
mainnet deploy.

### 1.1 Mock / shim replacements

- [ ] **Wrapper unwrap XCM path.** `DatumWrapper._ahAddressOf(bytes32)`
      is a devnet-only shim. Swap to production `transferToSubstrate`
      (or equivalent). Set `devnetUnwrapShimEnabled = false`. Add
      integration test that `unwrap` to a known Asset Hub AccountId
      increases the AH balance. (Source: §2, §L3 PRE-REDEPLOY)
- [ ] **AssetHubPrecompileMock** → real Asset Hub precompile.
- [ ] **PeopleChainIdentity** deployer-as-oracle-reporter → dedicated
      bridge EOA. Do NOT call `lockOracleReporter()` until the
      trustless return-leg path is proven — Diana direct path stays
      as fallback. See `narrative-analysis/people-chain-return-leg.md`.

### 1.2 deploy.ts production parameters

- [ ] Line 78: deployer/Alice EOAs → Gnosis Safes / hardware wallets.
- [ ] Line 153: lengthen Timelock windows (e.g. 50400 voting / 14400
      exec / 100800 veto).
- [ ] Line 178: `SR_V1_THRESHOLD` 1-of-1 (deployer) → 3-of-5
      reporters.
- [ ] Line 200: Council initial members → real council Gnosis Safes.
- [ ] Line 617: redirect `DatumActivationBonds` treasury away from
      deployer before `treasuryBps` is set non-zero.
- [ ] Lines 648 / 662: pass the real DATUM ERC-20 address to
      `DatumStakeRootV2` (currently `address(0)` — balance-fraud
      challenges revert E00 until wired).
- [ ] Line 652: rotate StakeRootV2 treasury from deployer.
- [ ] Line 1342: replace deployer as PeopleChainIdentity bridge EOA.
- [ ] deploy.ts must call `mintAuthority.setPauseRegistry(pauseRegistry)`
      before parachain sunset. (Contract + test landed; operational
      wiring not in deploy.ts.)

### 1.3 ZK trusted setup — MPC ceremonies

Currently single-party setups (testnet-only):

- [ ] `DatumZKVerifier` — impression circuit, run N-participant MPC.
- [ ] `DatumIdentityVerifier` — identity circuit, same.

### 1.4 House-ad campaign bootstrap

Before enabling `DatumBootstrapPool`:

- [ ] Set the house-ad campaign to AssuranceLevel ≥ 1 (publisher
      cosig required).
- [ ] Wire `DatumBootstrapPool.setCampaigns(campaignsAddr)`.
- [ ] Confirm `bootstrapPool.minHouseAdAssuranceLevel >= 1`.

### 1.5 Audit obligations

- [ ] **External professional security audit.** Internal pass found
      4 HIGH bugs; external review by specialists is warranted
      before live funds depend on this code. Repeated as a hard
      blocker across every archive review.
- [ ] **Re-audit obligation from upgrade ladder (Stages 1–5b).** The
      retrofit added new surface to ~36 contracts: `DatumUpgradable`
      inheritance, `whenNotFrozen` on mutators, `whenOpenGovPhase`
      on lock-once. Earlier audit-pass-5 findings closed under
      "fine because immutable / lock-once" need re-verification.
      Detailed checklist in `narrative-analysis/deploy-runbook-paseo.md`
      §13 (a-f).

### 1.6 Pre-audit hedges (from `AUDIT-HEDGES.md`)

- [ ] **#6 Slither + Mythril pre-audit sweep.** Run detectors, fix
      obvious findings, document false positives in
      `slither-baseline.json`. Mythril on the DELEGATECALL chain
      specifically.
- [ ] **#7 Foundry fuzz tests on `_processBatch`.** Add `forge test`
      alongside Hardhat — codebase compiles cleanly with both.
      Target ~100 fuzz cases on payment math, gate combinations,
      batch sizes, the `_effectiveAssuranceDecision` helper.

### 1.7 Bytecode / EVM compatibility

- [ ] **Revalidate Settlement EIP-170 status** on alpha-5. Per
      `STATUS.md` the two-Logic split closed the gap on 2026-05-19,
      but the alpha-5 rename touched headers in `deploy.ts` and
      configs — re-run `npm run size:mainnet` and confirm every
      runtime stays < 24,576 B. (Source: §8 + SETTLEMENT-EIP170-PLANNING.md)

### 1.8 Operational / infrastructure (from §13 archive scan)

- [ ] **Mainnet gas-price source.** Extension and scripts assume
      Paseo's hardcoded `eth_gasPrice` (10¹² wei/gas). Polkadot Hub
      may differ; swap to dynamic `eth_gasPrice` query or per-chain
      config before switching networks.
- [ ] **Native asset precompile verification on mainnet.** USDT (asset
      1984), USDC (asset 1337) precompile addresses best-effort from
      Paseo. Run `verify-native-asset.ts` against Polkadot Hub RPC
      before launch.
- [ ] **Relay-bot production hardening.** Diana service is
      single-publisher localhost. Mainnet needs multi-publisher
      support, HTTPS, structured logging, key management (HSM),
      rate limiting, restart/recovery.
- [ ] **ZK proving-key distribution.** Decide between bundling
      `impression.zkey` + `impression.wasm` (~24 KB) in extension
      vs IPFS pinning. Same question for the identity circuit.
- [ ] **Indexer / subgraph.** Direct RPC pagination is already slow
      on Paseo at ≤100 campaigns. Subsquid or The Graph subgraph
      needed before mainnet scale.
- [ ] **Extension user-approval UX for real DOT.** Alpha auto-signs
      after install consent — acceptable for testnet PAS, NOT for
      mainnet DOT. Add per-session / per-campaign approval popup.

### 1.9 Economic calibration

- [ ] **Publisher stake bonding-curve constants.** `baseStakePlanck`,
      `planckPerImpression`, max-required cap need real-money
      calibration. Too low → no Sybil resistance; too high →
      expensive onboarding.
- [ ] **ActivationBonds + ChallengeBonds bond sizing.** Pass once
      target DOT price + adversary budget model exists.

---

## Section 2 — Operational lock-downs (post-launch)

Lock-once `lock*()` calls phase-gated on OpenGov via `whenOpenGovPhase`.
Pre-OpenGov, all revert `not-opengov`. Fire each after operational
validation in production, NOT just when technically possible.

- [ ] `DatumRelay.lockRelayerOpen()` — verify `relay.relayerOpen() == false`.
- [ ] `DatumCouncilBlocklistCurator.lockCouncil()`
- [ ] `DatumTagCurator.lockCouncil()`
- [ ] `DatumPublishers.lockBlocklistCurator()`
- [ ] `DatumCampaigns.lockTagCurator()` (pending Campaigns Tier 3 conversion)
- [ ] `DatumGovernanceRouter.raisePhaseFloor()` after Phase 1, again after Phase 2
- [ ] `DatumPeopleChainIdentity.lockOracleReporter()` + `.lockXcmDispatcher()`
- [ ] `DatumPeopleChainXcmBridge.lockSovereign()` + `.lockPalletCallIndices()`
- [ ] `DatumBondedIdentityReporter.lockCache()`
- [ ] `DatumPaymentVault.lockFeeShareRecipient()`
- [ ] `DatumStakeRootV2.lockPlumbing()`
- [ ] `DatumPublishers.lockWhitelistMode()` + `.lockStakeGate()`
- [ ] `DatumTagRegistry.lockCampaigns()`
- [ ] `DatumRelay.lockPlumbing()`
- [ ] `DatumZKStake.lockSlashers()`
- [ ] `DatumPauseRegistry.lockGuardianSet()`
- [ ] `DatumClickRegistry.lockPlumbing()`
- [ ] `DatumClaimValidator.lockPlumbing()`
- [ ] `DatumCampaignLifecycle.lockPlumbing()`
- [ ] **Token plane sunset sequence** (irrevocable post step 3):
      deploy parachain pallet → `MintAuthority.stageIssuerTransfer` from
      Timelock → parachain calls `acceptIssuerRole()`.

---

## Section 3 — Design backlog (not blocking)

Items deferred for design conversation. None block the next redeploy.

### 3.-7 G-6 blocklist appeal mechanism — closed (2026-05-20)

- [x] **Bonded appeal flow** shipped on
      `DatumCouncilBlocklistCurator`. `fileBlocklistAppeal` +
      `councilResolveAppeal` + pull-payment queue + treasury sweep.
      Mirror of the G-3 publisher-fraud-claim shape. 21 new tests
      (blocklist-curator-g6.test.ts).
- [ ] Operational: set `appealBond` to a production value via
      `setAppealBond` before opening the track. 0 keeps it disabled.
      Recommend starting at 1 DOT (matches the symmetric
      PublisherGov advertiser-claim bond + AdvertiserGov
      publisher-claim bond).
- [ ] Consider mirroring this pattern to `DatumTagCurator` (G-6
      coverage for tag-approval false positives). Same shape; not
      blocking since the tag set is currently small and false-
      positive risk is lower than publisher-blocklist
      false-positives.

### 3.-6 G-8 emergency unstake / recovery for users — closed (2026-05-20)

- [x] **Time-locked recovery address** shipped on `DatumPaymentVault`.
      Pre-register cold wallet via `setRecoveryAddress(addr)`; after
      ~24h default delay (bounded `[6h, 30d]`), `emergencyWithdraw`
      pulls all vault balances to the recovery. One-shot: recovery
      clears after use. 25 new tests (payment-vault-g8.test.ts).
- [ ] Operational: calibrate `recoveryDelayBlocks` from off-chain
      compromise-detection timelines. Default 14400 (~24h) gives
      users one day to react; reduce/extend based on observed
      incident-response patterns.
- [ ] Incrementally adopt the recovery pattern on `DatumTokenRewardVault`
      (ERC-20 side-rewards). Pattern is identical; ~50 LOC additional.
      Not blocking since DOT credits in PaymentVault are the
      highest-value user asset.

### 3.-5 G-10 economic-parameter retune rate limit — first close (2026-05-20)

- [x] **`ParameterRetuneGuard` mixin** (`contracts/lib/ParameterRetuneGuard.sol`)
      + integration on `DatumRelayGovernance` (4 high-impact setters).
      16 new tests. Default cooldown 0 (testnet posture); production
      sets a non-zero value via `setRetuneCooldownBlocks`.
- [ ] Incrementally adopt the mixin on the other governance contracts:
      `DatumPublisherGovernance` (setSlashBps, setConvictionCurve,
      setBondBonusBps), `DatumAdvertiserGovernance` (setSlashBps,
      setConvictionCurve, setPublisherClaimBond), `DatumGovernanceV2`
      (setSlashBps, setConvictionCurve, setQuorum),
      `DatumMintCoordinator` (setMintRate, setDatumRewardSplit,
      setDustMintThreshold). Pattern is documented; each integration
      is ~5 LOC per setter.
- [ ] Operational: calibrate `retuneCooldownBlocks` from production
      data; typical production value would be ~14400 (24h). Lock-once
      mechanism not yet added — consuming contracts can wrap
      `setRetuneCooldownBlocks` with their own `whenOpenGovPhase`
      lock when ready.

### 3.-4 G-7 L3 ZK-only userMinAssurance floor — closed (2026-05-20)

- [x] **Verified L3 setter accepts** `userMinAssurance <= 3` in
      `DatumSettlement.setUserMinAssurance`. M1-fix L3 ZK enforcement
      shipped during audit-pass-5 (LogicB._processBatch line 84+).
      8 new confirmation tests in `user-min-assurance-l3.test.ts`.
      Doc-only gap; structurally closed since alpha-4.

### 3.-3 G-4 reporter cabal fast eviction — closed (2026-05-20)

- [x] **`DatumStakeRootV2.markInactive(reporter)`** shipped.
      Permissionless eviction after `inactivityThresholdBlocks`
      (~7d default, bounded `[24h, 30d]`). Activity tracked via
      `lastActiveBlock[reporter]` on join/propose/approve. Voting
      weight drops immediately; stake locked through `reporterExitDelay`
      for slash protection. 17 new tests.
- [ ] Operational: calibrate `inactivityThresholdBlocks` from
      observed off-chain root cadence. Default 100800 (~7d) is
      conservative — could be tightened to 50400 (~3.5d) once cadence
      is empirical.

### 3.-2 G-3 publisher-side dispute initiation — closed (2026-05-20)

- [x] **Council-arbitrated publisher → advertiser fraud claim track**
      shipped via `DatumAdvertiserGovernance.filePublisherFraudClaim`
      + `councilResolvePublisherClaim`. Mirror of the existing
      `DatumPublisherGovernance.fileAdvertiserFraudClaim`. 23 new
      tests; full suite 1369 passing.
- [ ] Operational: confirm `AdvertiserGovernance.councilArbiter`
      wired to the live Council address. deploy.ts does this
      automatically when `addresses.advertiserGovernance` is set.
- [ ] Operational: set `publisherClaimBond` to calibrated production
      value. deploy.ts default is 1 DOT (matches PublisherGov's
      `advertiserClaimBond` default). Raise if false-positive grief
      becomes a pattern.

### 3.-1 G-2 guardian damage bounds — partially closed (2026-05-20)

- [x] **Per-category caps, solo/extended window split, re-engagement
      cooldown** shipped in `DatumPauseRegistry`. Tests: 27 new
      (pause-g2). Total tests 1346.
- [ ] Calibrate `categoryMaxPauseBlocks` defaults based on production
      damage observations once protocol is live. Defaults: settlement
      3d, campaign-creation 7d, governance 7d, token-mint 14d.
- [ ] Decide whether to enable `reengagementCooldownBlocks` on Paseo
      (currently 7d default at deploy) or set it to 0 for testnet
      iteration. Production posture: ~7d.
- [ ] Fire `pauseParamsLocked` post-OpenGov once parameter calibration
      is final. Lock-once.
- [ ] **3-of-3 total guardian compromise** remains unbounded. Future
      consideration: Council/OpenGov override path for unpause when
      all three guardians are captured. Not in scope for G-2 close.

### 3.0 G-1 relay accountability — partially closed (2026-05-20)

- [x] **Identity + bond + governance slash** shipped via
      `DatumRelayStake` + `DatumRelayGovernance`. See
      [`narrative-analysis/proposals/relay-accountability.md`](narrative-analysis/proposals/relay-accountability.md)
      and per-contract narratives. Tests: 77 new (relay-stake,
      relay-governance, relay-accountability-integration); 1319
      total passing.
- [ ] Operational: rotate `DatumRelayGovernance.treasury` from
      deployer to protocol treasury Safe.
- [ ] Operational: calibrate `relayMinStake` after observing
      independent operator interest. Arm via
      `RelayStake.setRelayMinStake(floor)` when independent
      third-party operators want to participate; before then,
      Path 3 authorization is allowlist-only on `DatumRelay`.
- [x] ~~Decide pattern (a) replace vs (b) augment~~ — **decided
      2026-05-20: keep (b) augment permanently**. The three-path
      architecture (Path 1 publisher relaySigner direct, Path 2
      advertiser dual-sig direct, Path 3 DatumRelay with optional
      stake-or-allowlist) means staking is never mandatory.
      Manual `authorizedRelayers` allowlist is preserved for
      Council-curated parties; stake gate is opt-in for
      independent operators. Decision recorded in
      `proposals/relay-accountability.md §6`.
- [ ] **Approach A or B censorship fast-track.** Deferred until
      observed censorship rate justifies the gas tax. Triggers
      documented in relay-accountability.md §9.
- [ ] **MEV / front-running primitives.** Research-stage; no commit.

### 3.1 Progressive decentralization knobs

- [ ] **GOV-MIGRATION** three-phase handoff (already routed via
      `DatumGovernanceRouter`; tune phase transitions).
- [ ] **ADMISSION** `isApproved(address)` whitelist mode for
      Publishers / Campaigns Phase 1; flip false at Phase 2+.
- [ ] **CAPS** `maxCampaignBudget` (e.g. 10,000 DOT) and
      `maxDailySettlementVolume` (rolling 24h). Start
      conservative, raise as monitoring confirms safety.
- [ ] **REPUTATION-GATE** `require(reputation.score(publisher) >= minScore)`
      in Settlement. 1-line change; `minScore = 0` at launch.
- [ ] **ORACLE-CB** pause settlement when DOT price moves >X% within
      Y blocks.
- [ ] **EMERGENCY-DRAIN** 24h-timelocked guardian drain on PaymentVault
      and TokenRewardVault if compromised.

### 3.2 Long-horizon design (`FUTURE-WORK.md`)

- [ ] **CB8 — Anti-plutocracy in OpenGov.** Wait for ≥3 months of
      mainnet conviction-vote data before picking option.
- [ ] **CB9 — Cold-key recovery.** Evaluate Polkadot identity pallet
      / People Chain in Q3.
- [ ] **CB5-extension — high-tier target selector registry.** Replaces
      operator-discipline with on-chain enforcement.
- [ ] **M3-extension — BootstrapPool Sybil hardening.** PoP /
      identity attestation per claimant; per-IP cap; decay
      `bootstrapPerAddress` over time.
- [ ] **General — post-mainnet monitoring framework.** Standardized
      dashboard for `UserBlocklistRejected`, `UserPaused`,
      `UserMinAssuranceSet`, `HighTierProposed/Vetoed/Executed`,
      `BlocklistFailedClosed`, `AssuranceLookupFailed`,
      `AdvertiserSlashed`, `MemberRelaySignerSet`.

### 3.3 Upgrade ladder follow-ups

- [ ] `_migrate` implementations are no-ops. State preservation
      across upgrades requires per-contract overrides. Acceptable
      for testnet; production decisions per-contract.
- [ ] **Storage layout snapshot** for every Upgradable contract
      pre/post upgrade-ladder. Capture as audit reference. (Note:
      Settlement's already done via `settlement-layout.snapshot.json`
      from AUDIT-HEDGES #1.)

### 3.4 TOKENOMICS write-up

- [ ] Document token-plane upgradability mechanics, migration approach
      (currently `_migrate` is no-op), and the phase-conditional
      lock-once functions (`MintAuthority.acceptIssuerRole`,
      `Wrapper.lockMintAuthority` if added). Not blocking for Paseo;
      required before Polkadot Hub mainnet.

### 3.5 Smaller in-source deferrals

- [ ] `DatumPublishers.sol` — decide blocklist governance vs
      Council-curator split (comment line 15 still pending).
- [ ] `DatumTagRegistry.sol` — VRF-based juror selection; tag-creator
      economics.
- [ ] `DatumGovernanceV2.sol` — Active→Pending demote anti-grief
      grace period.
- [ ] `DatumStakeRootV2.sol` — exclusion-fraud challenges (needs
      non-inclusion proof primitive).

### 3.6 Cross-cycle research carryover

- [ ] `memory/project_zk_path_b_people_chain.md` — ZK proof binding
      user secret to People Chain identity. Needs anonymity-set
      size estimate first.
- [ ] `memory/project_fp_implementation_backlog.md` — T3-A / T3-C /
      T3-D fraud-prevention work; 5 deployment-readiness items.
- [ ] `memory/project_optimistic_activation.md` — Phase 2b mute bond.
- [ ] **Round-keying refactor** — Phase 2b mute does not increment
      governance vote round (see
      `narrative-analysis/optimistic-activation-phase-2b.md`).
- [ ] `memory/project_gplv3_smoldot.md` — smoldot light-client; post-
      mainnet, revisit when pallet-revive support appears.
- [ ] **Kusama staging deployment.** Reasonable layer between Paseo
      and Polkadot Hub for late-stage validation.
- [ ] **BM-6 viewability dispute mechanism.** Publisher challenge
      window for low-viewability claims. Needs governance design +
      new contract. Post-launch.
- [ ] **Cross-campaign claim batching.** `settleClaimsMulti` iterates
      per (user, campaign); true cross-campaign packing could reduce
      gas ~39% per archive benchmark. Post-launch optimization.

---

## Section 4 — Revalidate against alpha-5 (claims from alpha-4 docs)

Items marked complete during alpha-4 that touched live contract or
script surface. The alpha-5 rename did not change Solidity sources,
but each of these is worth confirming against the current tree
before relying on it.

### 4.1 Audit-pass-5 fixes (claimed complete)

- [ ] **L6** — `setConvictionCurve(0, 0)` rejection.
      Confirm `DatumGovernanceV2.sol:311-322`, mirror present on
      `DatumPublisherGovernance` + `DatumAdvertiserGovernance`. Test
      `test/governance-params.test.ts` "AUDIT-PASS-5 L6".
- [ ] **M1** — `_payoutMuteRejected` muter refund + `MuteBondReroutedToMuter`
      event. Confirm `DatumActivationBonds.sol:374-402`. Test
      `test/emergency-mute.test.ts` "MUTE-6".
- [ ] **H1** — ActivationBonds punishment bps snapshotted at openBond.
- [ ] **H2** — ActivationBonds mute() fail-closed on advertiser-getter
      revert.
- [ ] **H3** — StakeRootV2 `_slashProposer` no longer underflows
      `totalReporterStake` for exit-proposed reporters.
- [ ] **H4** — GovernanceV2.evaluateCampaign Expired + zero-nay
      Terminated branches route to `pendingOwnerSweep`.
- [ ] **M4** — TagRegistry `_disputeJurorLock[disputeId][juror]`
      mapping tracks per-dispute lock; resolveDispute releases actual
      amount.

### 4.2 Audit hedges (claimed shipped via commits `25f4f96`, `c5f69df`)

- [ ] **#1 Settlement layout snapshot** committed
      (`settlement-layout.snapshot.json`) + deploy-time validator
      called from `scripts/deploy.ts`.
- [ ] **#2 `msg.sender` preservation tests** for the three settlement
      entry paths (EOA, Relay, DualSig) through LogicA → LogicB.
- [ ] **#3 `lockLogic()` lock-once on Settlement.** Confirm `bool
      internal _logicLocked` at the END of `DatumSettlementStorage`
      and revert-if-locked inside `setLogic`.
- [ ] **#4 Non-reverting safe view variants on Campaigns.** Confirm
      `getCampaignAssuranceLevelSafe` (and any sibling safe getters)
      exist; confirm Settlement reads them instead of bare try/catch.
- [ ] **#5 `_effectiveAssuranceDecision` pure helper** extracted on
      `DatumSettlementStorage` + exhaustive table-driven test.
- [ ] **#8 `docs/SETTLEMENT-ARCHITECTURE.md`** present and accurate
      for the carve-out architecture.
- [ ] **#9 `// SAFETY:` annotations** on every try/catch in
      `_processBatch`.

### 4.3 Pre-redeploy findings (claimed addressed by subsequent passes)

For each, confirm the alpha-5 contract still has the fix. Cross-
reference with audit-pass-5 + audit-hedges.

- [ ] **H1 (Wrapper.wrap atomic deposit).** Should now pull canonical
      via `precompile.transferFrom(msg.sender, address(this), amount)`
      inside `wrap`. Confirm in `token/DatumWrapper.sol`.
- [ ] **H2 (AssuranceLevel gate fails open).** Should fail CLOSED on
      revert; subsumed by audit-hedge #4 above.
- [ ] **H3 (MintAuthority.transferIssuerTo no timelock).** Should
      have two-step accept via `pendingIssuer`; confirm
      `acceptIssuerRole` callable only by pending successor; confirm
      no path skips the staging step. (Lock-once after step 3 is
      §3 of MAINNET-DEFERRED.)
- [ ] **M1 (userMinAssurance not enforced on dual-sig path).** Decide:
      widen enum to L3 (ZK) so users can express ZK-only floor,
      consult ZK status even on dual-sig batches. Confirm whether
      current code enforces the floor on the dual-sig branch in
      `_processBatch`.
- [ ] **M2 (Settlement blocklist fails open at L≥1).** Confirm
      fail-open is now conditional on AssuranceLevel — at level ≥ 1,
      revert from `publishers.isBlocked()` should treat as block.
- [ ] **M4 (Governance ladder phase-forward lock).** Should reject
      `setGovernor` regressions via `raisePhaseFloor`. Confirm in
      `DatumGovernanceRouter`.
- [ ] **M5 (Tag-approval gate decentralization).** Tag policy moved
      to `DatumTagCurator` (per MEMORY). Confirm
      `DatumCampaigns.setTagCurator` is wired; `approveTag` /
      `removeApprovedTag` are governance-routed; `lockTagCurator`
      exists.

### 4.4 MAINNET-DEFERRED items claimed complete

- [ ] **FeeShare `sweep()` path** (`DatumFeeShare.sol:151`).
      `PaymentVault.sweepToFeeShare` → `FeeShare.fund` payable.
      Confirm permissionless `fund()` is still harmless.
- [ ] **CB6-extension MintAuthority pause wiring.** Contract +
      `setPauseRegistry` lock-once setter + `_requireNotPaused`
      gate on `mintForSettlement` / `mintForBootstrap` /
      `mintForVesting`. Test `test/token/mint-flow.test.ts`
      "CB6-extension".
- [ ] **S12 blocklist gating** superseded by `DatumCouncilBlocklistCurator`
      (`onlyCouncil`); `DatumPublishers` no longer exposes
      `blockAddress` / `unblockAddress`. Confirm.
- [ ] **ActivationBonds + StakeRoot V1 + StakeRootV2 ownership
      transfers** added to deploy.ts. Confirm `transferOwnershipIfNeeded`
      calls exist for each.
- [ ] **Test count.** alpha-4 claimed 1228 passing post-Stage 6,
      1224 post-Stage 5b. Run `npm test` after `npm install`,
      confirm alpha-5 still passes — this is the primary smoke test
      for the rename.

---

## Quick mainnet go/no-go (active checklist)

Lifted from `MAINNET-DEFERRED-ITEMS.md` §"Quick mainnet-go/no-go" so
it's visible from this doc. Items above are the detail; this list is
the rollup.

- [ ] Wrapper XCM path swapped, devnet shim disabled, integration
      test green.
- [ ] AssetHubPrecompile points at real precompile.
- [ ] PeopleChainIdentity oracle reporter is the production bridge EOA.
- [ ] StakeRootV2 wired with real DATUM ERC-20 address + treasury
      rotated.
- [ ] All deployer-EOA roles rotated to Gnosis Safes / Council.
- [ ] Timelock windows lengthened to production values.
- [ ] SR V1 threshold 3-of-5 with external reporters.
- [ ] MPC ceremonies completed for ZKVerifier + IdentityVerifier.
- [ ] Settlement bytecode confirmed under EIP-170 on alpha-5 (was
      closed in alpha-4 via two-Logic split).
- [ ] External audit completed.
- [ ] Token plane sunset sequence run AFTER parachain readiness
      (irrevocable).
