# DATUM Alpha-4 — Mainnet Deferred Items

Compiled inventory of work intentionally deferred from testnet/Paseo that
must run, be replaced, or be decided on before any Polkadot Hub mainnet
deploy. Pulled from `PRE-MAINNET-CHECKLIST.md`, `FUTURE-WORK.md`,
`AUDIT-PASS-5-FINDINGS.md`, `scripts/deploy.ts`, contract source, and
project memory.

Compiled 2026-05-16. Verified against `alpha-4/contracts/` 2026-05-16
(items already addressed are marked **✅ COMPLETE** with the source
location of the fix).

---

## 1. Permission lock-downs (from PRE-MAINNET-CHECKLIST §Permission)

After vetting production parties, call:

- `DatumRelay.lockRelayerOpen()` — converts relay from open-mode (any EOA
  passing stateless sig+liveness) to a curated set. Verify
  `relay.relayerOpen() == false`.
- `DatumCouncilBlocklistCurator.lockCouncil()`
- `DatumTagCurator.lockCouncil()`
- `DatumPublishers.lockBlocklistCurator()`
- `DatumCampaigns.lockTagCurator()`
- `DatumGovernanceRouter.raisePhaseFloor()` after Phase 1 (Council) and
  again after Phase 2 (OpenGov) — prevents any future `setGovernor` from
  regressing back.

## 2. Mock / shim replacements

- **L3 Wrapper unwrap XCM path.** `DatumWrapper._ahAddressOf(bytes32)` is
  a devnet-only shim. Replace
  `precompile.transfer(canonicalAssetId, _ahAddressOf(...), amount)` with
  the production precompile's
  `transferToSubstrate(canonicalAssetId, accountId, amount)` (or equiv).
  Constructor flag `devnetUnwrapShimEnabled` must be `false`. Verify with
  an integration test that an `unwrap` to a known Asset Hub AccountId
  increases the AH balance.
- **AssetHubPrecompileMock** replaced by the real Asset Hub precompile.
- ✅ **COMPLETE — DatumFeeShare `sweep()` is wired.** The mainnet pull
  path (`DatumFeeShare.sweep()` → `PaymentVault.sweepToFeeShare()`) is
  live (`DatumFeeShare.sol:151`). The permissionless `fund()` devnet
  scaffold (line 230) is harmless to leave in — it just folds direct
  DOT into the accumulator. No action required.
- **DatumPeopleChainIdentity**: replace deployer-as-oracle-reporter with
  dedicated bridge EOA, then `lockOracleReporter()` once the XCM
  dispatcher is wired and proven on mainnet.
  - **Return-leg research (2026-05-17):**
    `narrative-analysis/people-chain-return-leg.md` — the People Chain
    runtime has no `pallet-revive` and XCM is write-only; the trustless
    return path requires either (a) a custom FRAME pallet via OpenGov
    (Track B, months-scale), (b) XCQ when it ships (Track A risk: 6-18
    months, unmaintained dependency), or (c) relay-chain state proofs
    (Track C, research-blocked).
  - **Phase D posture (current):** Diana stand-in as
    `peopleChainSovereign`. Bridge code path is identical to the
    trustless future-state; flipping is a single `setSovereign(...)`
    call. **Do NOT call `lockOracleReporter()` until the trustless
    path is proven** — Diana's direct path stays as fallback.

## 3. Token plane sunset (PRE-MAINNET-CHECKLIST §5.5)

When the DATUM parachain native issuance pallet is live:

1. Deploy the parachain pallet as the new issuer.
2. `DatumMintAuthority.stageIssuerTransfer(parachainPalletAddress)` from
   Timelock.
3. Parachain pallet calls `acceptIssuerRole()` from its own context.
4. **Irrevocable** — `issuerLocked` is permanently true after step 3.

Companion: ✅ **COMPLETE — CB6-extension MintAuthority pause wiring**
(`DatumMintAuthority.sol`). Added `IDatumPauseRegistry_Mint pauseRegistry`
field, lock-once `setPauseRegistry`, and a shared `_requireNotPaused`
gate on `mintForSettlement` / `mintForBootstrap` / `mintForVesting`.
Zero-address registry skips the check (testnet default). Regression
test in `test/token/mint-flow.test.ts` ("CB6-extension: CAT_TOKEN_MINT
pause wiring"). Operational task remaining: deploy.ts must call
`setPauseRegistry(pauseRegistry)` before parachain sunset.

## 4. House-ad campaign bootstrap (PRE-MAINNET-CHECKLIST §House-ad)

Before enabling `DatumBootstrapPool`:

- Set the house-ad campaign to AssuranceLevel ≥ 1 (publisher cosig
  required).
- Wire `DatumBootstrapPool.setCampaigns(campaignsAddr)`.
- Confirm `bootstrapPool.minHouseAdAssuranceLevel >= 1`.

## 5. `scripts/deploy.ts` TODOs

- **Line 78**: deployer/Alice EOAs → Gnosis Safe or hardware wallets.
- **Line 153**: lengthen Timelock windows (e.g. 50400 voting / 14400 exec
  delay / 100800 veto).
- **Line 178**: `SR_V1_THRESHOLD` 1-of-1 (deployer) → 3-of-5 reporters.
- **Line 200**: Council initial members → real council Gnosis Safes.
- **Line 617**: redirect `DatumActivationBonds` treasury away from
  deployer before `treasuryBps` is set non-zero.
- **Line 648 / 662**: pass the real DATUM ERC-20 address to
  `DatumStakeRootV2` constructor. Currently `address(0)` —
  balance-fraud challenges revert E00 until wired.
- **Line 652**: rotate StakeRootV2 treasury from deployer.
- **Line 1342**: replace deployer as PeopleChainIdentity bridge EOA,
  then `lockOracleReporter()`.
- ✅ **COMPLETE — Line 1535 (S12 blocklist gating).** Superseded by the
  curator architecture: `DatumPublishers` no longer exposes
  `blockAddress` / `unblockAddress`. Blocklist authority lives in
  `DatumCouncilBlocklistCurator` and is `onlyCouncil`
  (`DatumCouncilBlocklistCurator.sol:63`). Council itself stands in for
  Timelock at Phase 1+. The deploy.ts comment is stale; the operational
  task collapses into "set curator + Council membership + `lockCouncil()`"
  (see §1).
- ✅ **COMPLETE — ActivationBonds ownership transfer.** Added
  `transferOwnershipIfNeeded("ActivationBonds", "DatumActivationBonds",
  addresses.activationBonds)` to `scripts/deploy.ts` next to the other
  contract ownership transfers. Stale S12 inline comment in deploy.ts
  also refreshed to reference the curator architecture.

## 6. ZK trusted setup — MPC ceremonies required

Currently single-party setups (testnet-only):

- `DatumZKVerifier` — impression circuit
  (`scripts/setup-zk.mjs`).
- `DatumIdentityVerifier` — identity circuit
  (`scripts/setup-zk-identity.mjs`).

For mainnet, run an MPC ceremony with N participants for each — any one
honest participant erases the secret. Coordinate when mainnet timeline
is set. (AUDIT-PASS-5 recommendation #1;
`task-zk-identity-verifier.md` §What's still deferred.)

## 7. Audit findings still open (AUDIT-PASS-5, 2026-05-14)

- ✅ **COMPLETE — L6 (LOW).** `DatumGovernanceV2.setConvictionCurve`
  now rejects `(0, 0)` with `E11` (`DatumGovernanceV2.sol:311-322`).
  The `(A == 0 && B == 0)` sentinel for "not yet snapshotted" is now
  safe to use. Regression test in `test/governance-params.test.ts`
  ("AUDIT-PASS-5 L6: setConvictionCurve rejects (0, 0)").
- ✅ **COMPLETE — M1 (MEDIUM).** `_payoutMuteRejected`
  (`DatumActivationBonds.sol:374-402`) now refunds the muter when
  both advertiser and treasury are zero, emitting
  `MuteBondReroutedToMuter` for observability. The slash is forgone
  in this edge so the mute state can always be cleared and never
  strands. Regression test in `test/emergency-mute.test.ts` →
  "MUTE-6: M1 strand fallback".
- **External audit before mainnet.** Internal pass found 4 HIGH bugs;
  an external specialist review is warranted before live funds depend
  on this code.

## 8. EVM bytecode size (EIP-170, 24576 B)

`DatumSettlement` raw bytecode measured ~39.5 KB after the alpha-4
hardening passes (was ~31 KB after sybil hardening, already over
EIP-170). Paseo pallet-revive does not enforce, but a mainnet EVM
deploy would reject. Reduction path:

- Extract PoW math into a library, or
- Split PoW counters into a separate contract.

Required before any mainnet EVM redeploy. Tracked in
`memory/project_alpha4_people_chain_identity.md` and
`project_alpha4_audit_2026_05_pass2.md`.

## 9. FUTURE-WORK leftovers (CB pass — design conversations, not blockers)

- **CB8 — Anti-plutocracy in OpenGov.** Options: quadratic conviction
  discount above a threshold; bicameral ratification (Council as
  permanent upper house); reputation-weighted conviction;
  time-weighted whale discount. Wait for ≥3 months of mainnet
  conviction-vote data before picking.
- **CB9 — Cold-key recovery surface.** Every role currently has one
  terminal failure mode (lose key → lose role + funds). Options: social
  recovery with delay; time-locked address migration; ENS / identity-
  pallet-backed identity; per-role recovery primitives. Evaluate
  Polkadot identity pallet / People Chain in Q3.
- **CB5-extension — high-tier target registry.** Selector registry
  classifying (target, selector) pairs as high-tier with a gate
  contract refusing direct calls. Replaces the "operator discipline"
  assumption today.
- **M3-extension — BootstrapPool Sybil hardening.** L1 floor on
  house-ad assurance is the only Sybil cost. Add Proof-of-Personhood /
  identity attestation per claimant; off-chain IP/fingerprint cap with
  attestation; decay `bootstrapPerAddress` over time.
- **General — post-mainnet monitoring framework.** Standardized
  dashboard for: `UserBlocklistRejected`, `UserPaused`,
  `UserMinAssuranceSet`, `HighTierProposed`/`Vetoed`/`Executed`,
  `BlocklistFailedClosed`, `AssuranceLookupFailed`,
  `AdvertiserSlashed`, `MemberRelaySignerSet`.

## 10. Progressive-decentralization backlog (`project_saferollout_backlog.md`)

Conservative mainnet rollout features. None block deploy.

- **GOV-MIGRATION** — three-phase handoff: 3-of-5 multisig → Council →
  full OpenGov. Phase transitions require supermajority of current
  governor. (Routing already exists via `DatumGovernanceRouter`.)
- **ADMISSION** — `isApproved(address)` whitelist mode on Publishers /
  Campaigns for Phase 1; `whitelistMode` flips to false at Phase 2+.
- **CAPS** — `maxCampaignBudget` (e.g. 10,000 DOT) and
  `maxDailySettlementVolume` (rolling 24h). Both governor-adjustable;
  start conservative, raise as monitoring confirms safety.
- **REPUTATION-GATE** — `require(reputation.score(publisher) >= minScore)`
  in Settlement. 1-line change; `minScore = 0` at launch.
- **ORACLE-CB** — pause settlement when DOT price moves >X% within Y
  blocks. Pairs with the price oracle used for CPM.
- **EMERGENCY-DRAIN** — 24h-timelocked guardian drain on PaymentVault
  and TokenRewardVault if compromised. Guardian separate from governor;
  burned/transferred to DAO in Phase 3.

## 11. Smaller deferred items in contract source

- `contracts/DatumPublishers.sol:15` — blocklist management may open to
  governance pre-mainnet.
- `contracts/DatumTagRegistry.sol` — VRF-based juror selection deferred;
  tag-creator economics deferred.
- `contracts/DatumGovernanceV2.sol:631` — Active→Pending demote
  anti-grief grace period deferred.
- `contracts/DatumStakeRootV2.sol` — exclusion-fraud challenges still
  deferred (need non-inclusion proof primitive). Tracked in
  `migration-stakeroot-v1-to-v2.md` and AUDIT-PASS-5.

## 12. Other tracked-but-deferred lines

- `memory/project_zk_path_b_people_chain.md` — ZK proof binding user
  secret to People Chain identity. Deferred until Path A ships; needs
  anonymity-set size estimate first.
- `memory/project_fp_implementation_backlog.md` — T3-A / T3-C / T3-D
  deferred fraud-prevention work; 5 deployment-readiness items pending.
- `memory/project_gplv3_smoldot.md` — smoldot light-client integration
  is post-mainnet; revisit when pallet-revive support appears.
- `memory/project_optimistic_activation.md` — Phase 2b (mute bond)
  deferred.
- `narrative-analysis/predeploy-checklist-2026-05-14.md` — Phase 2b
  mute does not increment governance vote round; round-keying refactor
  recommended (see `optimistic-activation-phase-2b.md`).

---

## Quick mainnet-go/no-go checklist

Blocking (must run / replace / decide):

- [ ] Wrapper XCM path swapped, `devnetUnwrapShimEnabled = false`,
      integration test green.
- [ ] AssetHubPrecompile points at real precompile.
- [ ] PeopleChainIdentity oracle reporter is the production bridge EOA,
      then `lockOracleReporter()`.
- [ ] StakeRootV2 wired with real DATUM ERC-20 address and rotated
      treasury.
- [ ] All deployer-EOA roles rotated to Gnosis Safes / Council.
- [ ] Timelock windows lengthened to production values.
- [ ] SR V1 threshold 3-of-5 with external reporters.
- [ ] MPC ceremonies completed for ZKVerifier + IdentityVerifier.
- [ ] Settlement bytecode trimmed under EIP-170 (or confirmed
      Polkadot Hub does not enforce).
- [x] ~~S12 blocklist setters routed through Timelock~~ — superseded by
      `DatumCouncilBlocklistCurator` (Council-gated). Lock the curator
      after Council membership is final (§1).
- [x] ~~ActivationBonds ownership transferred to Timelock~~ — wired in
      deploy.ts (`transferOwnershipIfNeeded("ActivationBonds", ...)`).
- [ ] External audit completed.
- [x] ~~AUDIT-PASS-5 L6 + M1~~ both fixed. L6 mirrored on
      PublisherGovernance + AdvertiserGovernance for consistency.

Required around the parachain sunset (separately):

- [x] ~~CB6-extension MintAuthority pause wiring landed~~ — contract
      change + test landed. Operational: deploy.ts must call
      `mintAuthority.setPauseRegistry(pauseRegistryAddr)`.
- [ ] `MintAuthority.stageIssuerTransfer` → `acceptIssuerRole` sequence
      runs only after parachain readiness (irrevocable).

Lock-downs to schedule after launch once stable:

- [ ] `DatumRelay.lockRelayerOpen()`.
- [ ] Curator locks (Council/Tag/Publishers blocklist/Campaigns tag).
- [ ] `GovernanceRouter.raisePhaseFloor()` after each phase.
- [ ] BootstrapPool wired with house-ad campaign at AssuranceLevel ≥ 1.

Design decisions pending (not blocking):

- [ ] CB8 anti-plutocracy option pick (after ≥3 months mainnet data).
- [ ] CB9 cold-key recovery approach (Q3 review against People Chain
      identity pallet).
- [ ] Progressive-decentralization knobs (ADMISSION / CAPS /
      REPUTATION-GATE / ORACLE-CB / EMERGENCY-DRAIN) tuned for Phase 1.

---

## 13. Items surfaced from archived previous builds

Scanned 2026-05-16. The archive (`/archive/`) contains alpha, alpha-2,
alpha-3, and pre-redeploy alpha-4 docs. Most security findings have
been addressed in subsequent passes. Items below were spot-verified
against the current `alpha-4/contracts/` tree and are **still open**
or **still relevant** for mainnet.

### Operational / infrastructure (not in §1–§12 above)

- **Mainnet gas-price source.** Extension and scripts assume Paseo's
  hardcoded `eth_gasPrice` (10¹² wei/gas). Polkadot Hub may differ;
  swap to dynamic `eth_gasPrice` query or per-chain config before
  switching networks. (`archive/docs/BACKLOG.md`.)
- **Kusama staging deployment.** Not started. A staging environment
  between Paseo and Polkadot Hub is reasonable for late-stage
  validation. (`archive/docs/BACKLOG.md`.)
- **Native asset precompile verification on mainnet.** USDT (asset
  1984), USDC (asset 1337) precompile addresses currently best-effort
  from Paseo. Run `verify-native-asset.ts` against Polkadot Hub RPC
  before launch. (`archive/docs/REVIEW.md`.)
- **Relay-bot production hardening.** Current Diana service is
  single-publisher localhost. For mainnet: multi-publisher support,
  HTTPS endpoint, structured logging, key management (HSM or
  equivalent), rate limiting, error recovery / restart.
  (`archive/docs/REVIEW.md`.)
- **ZK proving-key distribution.** Extension needs `impression.zkey`
  (~24 KB) + `impression.wasm` locally to generate proofs. Decide
  between bundling in extension (size cost) and IPFS pinning
  (availability cost). Same question applies to the new identity
  circuit. (`archive/docs/REVIEW.md`.)
- **Indexer / subgraph.** Direct RPC pagination is already slow on
  Paseo with ≤100 campaigns. Subsquid or The Graph subgraph needed
  before the web app scales on mainnet. (`archive/docs/REVIEW.md`.)
- **Extension user-approval UX for real DOT.** Alpha auto-signs after
  install consent — acceptable for testnet PAS, **not** acceptable for
  mainnet DOT-denominated activity. Add per-session or per-campaign
  approval popup before launch. (`archive/docs/REVIEW.md`.)

### Economic calibration

- **Publisher stake bonding-curve constants.** `baseStakePlanck`,
  `planckPerImpression`, max-required cap all need real-money
  calibration before mainnet. Too low → no Sybil resistance; too high
  → expensive onboarding. (`archive/docs/REVIEW.md`.)
- **ActivationBonds + ChallengeBonds bond sizing.** Same calibration
  question — minBond / challengerBond / muteMinBond defaults
  (`predeploy-checklist-2026-05-14.md`) are seeded for testnet. Need a
  separate pass once a target DOT price + adversary budget model
  exists.

### Process gates

- **External professional security audit.** Repeated across every
  archive review (`SECURITY-AUDIT-2026-04-20`,
  `THREAT-MODEL-followup-2026-05-09`,
  `archive/docs/REVIEW.md`). Already listed in §7 — restated here
  because every archived doc calls it a non-negotiable hard blocker.
- **ZK trusted-setup MPC ceremony.** Already in §6 — restated because
  it appears in 4+ archive reviews as a hard blocker.

### Carry-over from `archive/docs/BACKLOG.md`

- **BM-6 — Viewability dispute mechanism.** Publisher challenge window
  for low-viewability claims. Needs governance design + new contract.
  Marked deferred in current `MEMORY.md` "Next Steps" item 9 as well.
  Not a launch blocker.
- **Cross-campaign claim batching.** Current `settleClaimsMulti`
  iterates per (user, campaign). True cross-campaign packing could
  reduce gas ~39% per archive benchmark. Post-launch optimization.

### Archive items already addressed in alpha-4 (informational)

These were flagged in the archived audits but have since been fixed.
Listed so future readers don't re-open them:

- R-H1 publisher unstake evasion → fixed in `DatumPublisherStake.slash()`
  (slash consumes from `pendingUnstake` first; see comment "R-H1").
- R-M1 ZK VK not lock-once → fixed in `DatumZKVerifier.setVerifyingKey`
  (`require(!vkSet, "E01")`).
- R-M2 attestation cross-publisher batching → fixed in
  `DatumAttestationVerifier` line 105–111 (same-publisher loop guard,
  "R-M2 (SM-1)").
- G-M1 owner admin shortcuts in Router → gated on `onlyAdminPhase` in
  `DatumGovernanceRouter` (`adminActivateCampaign` /
  `adminTerminateCampaign` / `adminDemoteCampaign`).
- G-M3 push-pattern DoS → converted to pull pattern with
  `pendingOwnerSweep` / `sweepSlashPool` in GovernanceV2 (comments
  reference "G-M3").
- Mid-campaign `requiresDualSig` freeze → setter locked once Active in
  `DatumCampaigns` (line 1112 — "locked once Active (advertiser can't
  freeze user earnings)").
- AttestationVerifier open-campaign publisher impersonation → mitigated
  by R-M2 same-publisher guard + downstream `DatumClaimValidator`
  defense-in-depth check.
- S12 governance-override unblock path → superseded by
  `DatumCouncilBlocklistCurator` (pluggable curator + lock-once
  pointer). Curator lock listed in §1.

### Archive items merged into existing §s (cross-references)

- "Multisig ownership transfer" (REVIEW.md) → §5 deploy.ts items
  (EOA→Safe rotation) + §1 curator locks + Timelock routing.
- "Publisher stake bonding-curve calibration" — partially captured
  here under Economic calibration; also overlaps the FUTURE-WORK
  `M3-extension` bootstrap Sybil item.
- "Governance multisig + Timelock guardian distribution" — covered by
  §5 (Gnosis Safe rotation) + §9 progressive-decentralization items.

---

## 14. Verification pass (2026-05-16)

Each remaining open item was checked against the current contract
source. Summary of state changes since the doc was first written:

**Marked complete in this pass:**
- ✅ §2 FeeShare `sweep()` path (`DatumFeeShare.sol:151`).
- ✅ §5 line 1535 S12 blocklist gating (architecture moved to
  `DatumCouncilBlocklistCurator`).

**Landed as code changes 2026-05-16:**
- ✅ §3 CB6-extension MintAuthority pause wiring. New
  `IDatumPauseRegistry_Mint pauseRegistry` lock-once setter on
  `DatumMintAuthority`, shared `_requireNotPaused` on all three mint
  paths. Test: `test/token/mint-flow.test.ts` →
  "CB6-extension: CAT_TOKEN_MINT pause wiring".
- ✅ §5 ActivationBonds + StakeRoot V1 + StakeRootV2 ownership
  transfers added to deploy.ts.
- ✅ §7 L6 fix — `setConvictionCurve(0, 0)` rejected with E11 in
  DatumGovernanceV2, DatumPublisherGovernance, DatumAdvertiserGovernance
  (the latter two for consistency even though they don't carry the
  per-proposal snapshot). Test:
  `test/governance-params.test.ts` → "AUDIT-PASS-5 L6".
- ✅ §7 M1 fix — `_payoutMuteRejected` refunds muter when both
  advertiser and treasury are unset, emits `MuteBondReroutedToMuter`.
  Test: `test/emergency-mute.test.ts` → "MUTE-6".
- Test suite: 1090 passing (was 1086 before this work; +4 from the
  two passes).

**Re-verified as still open:**
- §1 lockRelayerOpen, curator locks, phaseFloor ratchet — operational
  post-deploy actions.
- §2 Wrapper devnet shim — `devnetUnwrapShimEnabled` flag still in
  constructor (`DatumWrapper.sol:62`); production XCM path
  `xcm-required` revert at line 157 confirms shim is the only path
  for now.
- §2 PeopleChainIdentity oracle reporter — `lockOracleReporter` still
  unset; deployer is still the reporter.
- §3 MintAuthority pause wiring — `DatumMintAuthority.sol` has no
  reference to `pauseRegistry`. Still unwired.
- §5 ActivationBonds ownership not in `transferOwnershipIfNeeded`
  block (`deploy.ts:1533-1538`). Still open.
- §5 StakeRootV2 datumToken still `ethers.ZeroAddress` in deploy.ts.
- §7 L6 — `setConvictionCurve` still allows `(0, 0)` without guard
  (`DatumGovernanceV2.sol:311-321`).
- §7 M1 — partial mitigation in place, double-zero strand still real.
- §8 Settlement bytecode measured 39,469 B (artifacts/) — over EIP-170
  by ~15 KB.
- §11 DatumPublishers comment line 15 still reads "Future: blocklist
  management may be opened to governance control before mainnet"
  (Curator path exists; "governance vs Council" decision still pending).
- §11 TagRegistry VRF comment line 49 still reads "deferred".
- §11 GovernanceV2 demote anti-grief grace — line 631 comment still
  reads "anti-grief grace deferred".
- §11 StakeRootV2 exclusion-fraud — line 22 comment still reads
  "deferred to a future cycle".
- §12 Phase 2b mute round-keying — no `roundId` / `voteRound` field
  found in ActivationBonds or GovernanceV2. Still open.

**No code-level change applicable (purely operational):** all of §1,
most of §5 (EOA→Safe rotation, Timelock windows, SR_V1 threshold,
Council members, treasury rotations), §6 MPC ceremonies, §10
progressive-decentralization knobs, §13 operational items.
