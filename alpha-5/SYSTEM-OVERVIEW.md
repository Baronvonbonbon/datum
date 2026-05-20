# DATUM Alpha-5 — System Overview

A single-document tour of the protocol: what it does, every contract
that constitutes it, the major flows between them, the trust model,
and the path from current alpha posture to the cypherpunk end state.
Authoritative for shape; defer to per-contract docs under
`narrative-analysis/` for invariant-level precision.

**Codebase shape:** 59 production contracts (54 in `contracts/` + 5 in
`contracts/token/`), Solidity 0.8.24, EVM (`evmVersion: cancun`,
viaIR, optimizer 200 runs). Single build target — pallet-revive on
Polkadot Hub runs EVM bytecode directly, so no resolc/PVM step.

**Provenance.** Alpha-5 is a rename + clean checkpoint of alpha-4 v0.5.0
(`bd59fa4`, 2026-05-19). All contract sources, tests, scripts, and the
narrative-analysis tree carry over byte-for-byte. The version bump
declares "alpha-4 contract surface is the alpha-5 baseline" — any
future divergence happens on top of this snapshot.

---

## 1. What DATUM is

A decentralized advertising exchange on Polkadot Hub. Users earn DOT
for viewing ads, publishers set their own take rates, advertisers fund
campaigns from on-chain budgets, governance voters curate campaign
quality with conviction-weighted staking, and disputes resolve via
on-chain slash rather than off-chain trust.

Three economic actors, one shared escrow:

- **Advertiser** → escrow DOT into `DatumBudgetLedger` via a campaign.
- **Publisher** → serve impressions, sign claim batches, take a
  configurable share (30–80% bps) of revenue.
- **User** → 75% of the post-take-rate remainder. Pull-paid from
  `DatumPaymentVault`.

The protocol takes 25% of the post-take-rate remainder as fee, of which
a configurable share flows to WDATUM stakers via `DatumFeeShare`. The
slash bonus split, mint-emission schedule, and per-campaign ERC-20
side-rewards layer on top of this base economics.

---

## 2. Architectural pillars

### 2.1 Settlement (the bottleneck)

Every claim becomes a payment here, or it doesn't. `DatumSettlement`
exposes three entry points that all converge on `_processBatch`:

1. **`settleClaims(ClaimBatch[])`** — relay path. msg.sender is the
   user themselves, `DatumRelay`, `DatumAttestationVerifier`, or a
   publisher's `relaySigner` hot key. Satisfies AssuranceLevel ≤ 1.
2. **`settleClaimsMulti(UserClaimBatch[])`** — batch variant; one tx,
   multiple users × campaigns.
3. **`settleSignedClaims(SignedClaimBatch[])`** — dual-sig path
   delegated to `DatumDualSigSettlement` (EIP-712 publisher +
   advertiser cosig over `(user, campaignId, claimsHash, deadline,
   expectedRelaySigner, expectedAdvertiserRelaySigner)`). Only path
   that satisfies AssuranceLevel = 2.

**EIP-170 architecture.** Settlement was over the 24,576 B runtime cap
even after the alpha-4 satellite merge. The two-Logic split (2026-05-19,
phase 8d) closed the gap: `DatumSettlement` is a thin shell holding
state via `DatumSettlementStorage` and routing via DELEGATECALL through
`DatumSettlementLogicA` (relay-path entry + auth) → `DatumSettlementLogicB`
(`_processBatch` + helpers). DualSig submissions enter LogicB directly,
bypassing LogicA. All three contracts share an identical storage
layout asserted by `test/settlement-layout.test.ts` against
`settlement-layout.snapshot.json`. Layout drift is a deploy-time
revert via `validateSettlementLayoutMatchesSnapshot()`.

**Settlement satellites** read by `_processBatch`:

- `DatumSettlementRateLimiter` — per-publisher per-window event cap
- `DatumNullifierRegistry` — ZK replay prevention
- `DatumPowEngine` — per-impression PoW + leaky-bucket difficulty
- `DatumPublisherReputation` — settlement acceptance counters,
  anomaly detection
- `DatumClaimValidator` — hash chain, nonce monotonicity, PoW, ZK,
  attestation
- `DatumMintCoordinator` → `DatumEmissionEngine` → `DatumMintAuthority`
  — DATUM emission per claim, dust gate, split bps
- `DatumZKVerifier` — Groth16 BN254 with 7 public inputs
- `DatumPublisherStake` + `DatumAdvertiserStake` — bonding curve gates
- `DatumActivationBonds` — `isMuted(campaignId)` short-circuit for
  optimistic-activation mutes

### 2.2 Campaigns

`DatumCampaigns` is the per-campaign object: budget, daily caps,
allowed publishers, tag policy, AssuranceLevel, dual-sig flag,
ZK-required flag, ERC-20 side reward, bulletin reference, and
governance status.

Carved-out per-claim policy modules (alpha-4 EIP-170 split):

- `DatumCampaignAllowlist` — multi-publisher allowlist + per-publisher
  take-rate snapshots
- `DatumCampaignCreative` — IPFS hash + Bulletin Chain reference
- `DatumTagSystem` — tag dictionary, per-publisher tag sets,
  per-campaign required tags, lane mode
- `DatumReports` — community page/ad reports

`DatumCampaignLifecycle` handles status transitions: Pending → Active
→ Terminated / Expired / Demoted. Transitions are gated by
`DatumGovernanceRouter` so the active governor (Admin / Council /
OpenGov) is the only authorizer.

### 2.3 Governance ladder

Three governance phases share a stable address via
`DatumGovernanceRouter`:

| Phase | Active Governor | Typical Delay | Purpose |
|---|---|---|---|
| 0 — Admin | Deployer EOA / 3-of-5 Safe | None (or ~1h) | Bootstrap |
| 1 — Council | `DatumCouncil` N-of-M | ~24h propose/vote/veto | Curated launch |
| 2 — OpenGov | `DatumGovernanceV2` + `DatumParameterGovernance` | Conviction-weighted, ~7-day cycles | Decentralized |

Governance objects:

- **`DatumGovernanceV2`** — open conviction voting on campaign
  Activate / Terminate / Demote. PAS-locked, conviction 0–8,
  multipliers 1×–21×, lockups 0–365d. Commit-reveal added for
  optimistic-activation contested votes.
- **`DatumParameterGovernance`** — conviction voting on protocol
  parameters (slash bps, take rate caps, etc.).
- **`DatumPublisherGovernance`** + **`DatumAdvertiserGovernance`** —
  fraud proposals against either party, with conviction lock; slash
  on uphold.
- **`DatumCouncil`** — N-of-M signed multisig with propose / vote /
  executionDelay / vetoWindow / execute. Includes grant proposals
  with `perProposalMax` + `monthlyMax` caps.
- **`DatumCouncilBlocklistCurator`** + **`DatumTagCurator`** —
  delegation shims so Council *rotation* doesn't reset blocklist /
  tag state.
- **`DatumTimelock`** — 48h delay on owner-gated admin paths.

### 2.4 Identity & assurance

Five-level claim assurance gradient (`AssuranceLevel`):

- **L0** — open; only user signature required
- **L1** — relay-mediated; sig + liveness check via `DatumRelay`
- **L2** — dual-sig; publisher + advertiser EIP-712 cosigs over the
  same envelope. Only path that satisfies L2 campaigns
- (**L3+** discussed as future; not currently expressible —
  see §10 gaps)

Identity primitives layered on top:

- **`DatumIdentityVerifier`** — ZK identity circuit (Groth16, single
  public input = commitment, secret-bound to a Poseidon preimage).
- **`DatumPeopleChainIdentity`** + **`DatumPeopleChainXcmBridge`** —
  XCM-asynchronous bridge to People Chain identity-pallet judgments.
  Operates in oracle mode (deployer-as-reporter) on Paseo; mainnet
  story requires the trustless return-leg work in
  `narrative-analysis/people-chain-return-leg.md`.
- **`DatumBondedIdentityReporter`** — alternative bonded reporter
  pattern for the same data; currently deployed but not wired
  (per deploy-runbook §11).
- **`DatumInterestCommitments`** — per-user interest-category Merkle
  commitments for ZK targeting proofs.
- **`DatumAttestationVerifier`** — mandatory publisher-cosig wrapper
  upstream of Settlement.

### 2.5 Stake roots & off-chain commitments

- **`DatumStakeRoot`** (V1) — reporter-committed Merkle roots over
  `(commitment, stake)` leaves. N-of-M threshold finalization.
- **`DatumStakeRootV2`** — fraud-proof system on top of V1: bonded
  reporters propose roots, approvers stake-vote, anyone can challenge
  phantom-leaf / balance-fraud during a challenge window. Slashing
  applies to bad-faith approvers. Shadow-mode dual-source oracle
  wiring lets V1 and V2 coexist during migration.
- **`DatumZKStake`** — DATUM stake + 30-day lockup backing the ZK
  stake gate.

### 2.6 Payments

- **`DatumBudgetLedger`** — advertiser DOT escrow.
- **`DatumPaymentVault`** — pull-payment vault for publisher / user
  / protocol DOT credits. Funnels protocol fees into
  `DatumFeeShare.fund()` via `sweepProtocolFee` / `sweepToFeeShare`.
- **`DatumTokenRewardVault`** — pull-payment vault for per-campaign
  ERC-20 / Asset Hub native asset side-rewards.
- **`PaseoSafeSender`** — DOT-transfer helper that defeats the Paseo
  eth-rpc denomination bug by stashing sub-10⁶-planck dust into
  per-recipient claimable buckets. Shared base class across all
  contracts that send DOT.

### 2.7 Token plane (DATUM ERC-20)

Five-contract sidecar implementing the DATUM token:

- **`token/DatumMintAuthority`** — sole bridge contract for DATUM
  mints. 95M cap (95% of supply). `transferIssuerTo(newAuthority)` →
  `acceptIssuerRole()` is the irrevocable parachain-sunset path.
- **`token/DatumWrapper`** — WDATUM, the EVM-side ERC-20 wrapper over
  canonical Asset Hub DAT. `wrap` / `unwrap` against
  `precompile.transferFrom` (production) — devnet shim
  `_ahAddressOf` still in the path for Paseo, gated by
  `devnetUnwrapShimEnabled` constructor flag.
- **`token/DatumBootstrapPool`** — one-time onboarding grant of
  WDATUM to new users. Settlement-gated (`msg.sender == settlement`)
  so a Sybil's only cost floor is the house-ad campaign's
  AssuranceLevel.
- **`token/DatumFeeShare`** — single-token MasterChef pattern. Stake
  WDATUM, earn DOT from protocol fee sweeps via `accDotPerShare`.
- **`token/DatumVesting`** — single-beneficiary linear vesting with
  cliff.

### 2.8 Upgradability

`DatumUpgradable` is the inheritance base for ~36 of the 57 production
contracts. Each gives the governance router authority to swap the
contract's address in a global `currentAddrOf[name]` registry. Pre-
OpenGov, `lock*()` functions revert `not-opengov`, leaving the system
malleable during alpha/beta. Post-OpenGov, governance can fire each
lock to ratify cypherpunk commitments piecemeal.

User-facing mutators carry `whenNotFrozen` so a frozen-pending-migrate
contract refuses writes. `_migrate(oldContract)` is governance-only
and pause-gated. Current per-contract `_migrate` overrides are no-op
(state lost across upgrade); production migration requires per-contract
implementations.

### 2.9 Operational safety net

- **`DatumPauseRegistry`** — global per-category emergency pause.
  Three guardian EOAs: any one can fast-pause, two-of-three unpause.
  `lockGuardianSet()` flips this into a non-recoverable production
  posture.
- **`DatumOwnable`** — Ownable2Step base, manual implementation (OZ
  was removed alpha-3-era to avoid PVM constructor traps; preserved
  here as the canonical pattern).

---

## 3. Major flows

### 3.1 Claim → settlement (relay path, L0–L1)

```
USER WALLET            EXTENSION / SDK              ON-CHAIN
─────────              ───────────────              ────────
view ad ──►  build claim {campaignId,publisher,user,
             nonce,impressions,claimHash,PoW solution}
                       │
                       ├─ accumulate batch (per-(user,campaign,actionType))
                       │
                       ▼
             sign or forward to publisher relay
                       │
                       ▼
             DatumRelay.settleClaimsFor   ─OR─   publisher.relaySigner ──► DatumSettlement.settleClaims
                       │
                       ▼
             DatumSettlement.settleClaims (LogicA)
                       │
                       └ DELEGATECALL ──► LogicB._processBatch
                                              │
                                              ├ user gates (paused/blocklist/minAssurance)
                                              ├ assurance gradient decision (LogicB pure helper)
                                              ├ ClaimValidator.validate
                                              ├ PoW + nullifier (if ZK)
                                              ├ Publisher/Advertiser stake check
                                              ├ BudgetLedger.debit
                                              ├ PaymentVault.credit (pull)
                                              ├ TokenRewardVault.credit (pull, non-critical)
                                              ├ PublisherReputation.record
                                              ├ MintCoordinator.coordinate (DATUM emission)
                                              └ RateLimiter.consume
USER ══► PaymentVault.withdrawUser()         (pull DOT)
USER ══► TokenRewardVault.withdraw(token)    (pull side-reward)
```

### 3.2 Claim → settlement (dual-sig path, L2)

```
PUBLISHER ┈┈► sign EIP-712 ClaimBatch                  ON-CHAIN
              │
              ├─ forward to advertiser
              ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈►
ADVERTISER ┈┈ verify, sign cosig
              ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈►
              │
              ▼
         DatumDualSigSettlement.settleSignedClaims
              │
              ├ recover publisherSig vs relaySigner
              ├ recover advertiserSig vs campaign advertiser
              │
              └ DELEGATECALL ──► LogicB._processBatch
                                    (advertiserConsented = true)
```

### 3.3 Campaign create → activate

```
ADVERTISER ══► ChallengeBonds.depositBond {payable}   (FP-2 optional)
ADVERTISER ══► Campaigns.createCampaign {payable budget}
                    ├ Allowlist.setPublishers (if multi-pub)
                    ├ TagSystem.setRequiredTags
                    ├ CampaignCreative.set (if bulletin / ipfs)
                    └ ChallengeBonds bond locked
            (status = Pending)
                    │
   ┌────────────────┼────────────────┐
   │                │                │
Optimistic         Council         OpenGov
   │                │                │
ActivationBonds   propose          vote(conviction)
.openBond           ▼              .commitReveal
   │           Council.execute        │
   │                │                  │
   ▼                ▼                  ▼
challenge?     timeout → activate    GovernanceV2.evaluateCampaign
   │                                  │
   ▼                                  ▼
GovernanceV2.commitVote / revealVote
   │
   ▼
DatumCampaignLifecycle.activateCampaign (status = Active)
```

### 3.4 Upgrade flow

```
DEPLOYER (Admin phase)   /   COUNCIL (Phase 1)   /   OpenGov (Phase 2)
        │                        │                         │
        ▼                        ▼                         ▼
GovernanceRouter.upgradeContract(name, newAddrV2)
        │
        ├ pause v1 (via DatumUpgradable.pause)
        ├ v2.migrate(v1) — copy state (currently no-op)
        ├ currentAddrOf[name] := newAddrV2
        ├ versionOf[name]++
        └ event ContractUpgraded(name, v2, version)

Consumers (other contracts + web/extension):
        registry.currentAddrOf[name] is the new live address
        cached references in dependent contracts updated via setter
```

---

## 4. New in alpha-5 vs alpha-3 baseline (alpha-4 carryover)

Everything below landed in the alpha-4 line and is preserved into
alpha-5 unchanged.

### 4.1 Architectural

- **Satellite merge (29 → 21).** Nine alpha-3 satellites folded into
  parents (`TargetingRegistry`, `CampaignValidator`, `Reports` →
  Campaigns; `SettlementRateLimiter`, `NullifierRegistry`,
  `PublisherReputation` → Settlement; `GovernanceHelper`,
  `GovernanceSlash` → GovernanceV2; `AdminGovernance` →
  GovernanceRouter). EVM-only build dropped the resolc PVM bytecode-
  size pressure that motivated the alpha-3 split.
- **EIP-170 carve-outs (later, 2026-05-18).** Some satellites carved
  back out for EIP-170 compliance on mainnet: `DatumPowEngine`,
  `DatumPublisherReputation`, `DatumNullifierRegistry`,
  `DatumSettlementRateLimiter`, `DatumCampaignCreative`,
  `DatumReports`, `DatumCampaignAllowlist`, `DatumTagSystem`,
  `DatumMintCoordinator`, `DatumDualSigSettlement`. Each is
  independently upgradable, registered in `DatumGovernanceRouter`.
  `MAINNET-DEFERRED-ITEMS` notes a pre-mainnet remerge target if
  the gas cost of cross-contract reads becomes load-bearing.
- **Settlement two-Logic split (2026-05-19, phase 8d).** Storage in
  `DatumSettlementStorage`, logic split across LogicA (relay paths)
  and LogicB (`_processBatch` + helpers + dual-sig entry). Closed the
  EIP-170 gap.
- **Upgrade ladder (Stages 1–6, 2026-05-18).** ~36 contracts inherit
  `DatumUpgradable`; ~28 user-facing mutators get `whenNotFrozen`;
  every lock-once function gates on `whenOpenGovPhase`. Web app reads
  addresses from the on-chain registry. See
  `narrative-analysis/upgrade-ladder-design.md`.

### 4.2 Settlement-side

- **Hybrid dual-sig settlement.** `settleSignedClaims` (now in
  `DatumDualSigSettlement`) with EIP-712 publisher + advertiser
  cosigs over `ClaimBatch(user, campaignId, claimsHash, deadline,
  expectedRelaySigner, expectedAdvertiserRelaySigner)` on the
  `DatumSettlement` domain. A1 + M6 anti-staleness: relay-key
  rotations on either side invalidate in-flight cosigs.
- **AssuranceLevel gate.** Per-campaign `AssuranceLevel` 0–2 with
  per-user `userMinAssurance` floor. Gradient decision pulled into
  pure helper `_effectiveAssuranceDecision` on
  `DatumSettlementStorage` (audit-hedge #5) with exhaustive
  table-driven test.
- **Fail-closed Campaigns getters.** `getCampaignAssuranceLevelSafe`
  (and siblings) added to Campaigns; Settlement reads them in place
  of bare try/catch (audit-hedge #4 / PRE-REDEPLOY H2 fix). A
  malicious Campaigns upgrade can no longer downgrade L2 → L0 via
  controlled revert.
- **`lockLogic()` lock-once.** `_logicLocked` bool at the END of
  `DatumSettlementStorage` (append-only, layout-invariant safe).
  `setLogic` reverts when locked (audit-hedge #3). Pre-OpenGov
  the lock itself reverts.
- **layout snapshot enforcement.** `settlement-layout.snapshot.json`
  committed; `validateSettlementLayoutMatchesSnapshot()` runs at the
  top of `scripts/deploy.ts` (audit-hedge #1).
- **`msg.sender` preservation tests.** Three settlement entries (EOA,
  Relay, DualSig) tested for `msg.sender` propagation through
  LogicA → LogicB (audit-hedge #2).
- **CB1 user blocklist + self-pause.** `userBlocksPublisher /
  userBlocksAdvertiser / userPaused` mappings with explicit set/clear
  + auto-reject reason codes 22-25.

### 3.3 Campaign-side

- **Three-lane tag policy.** `DatumTagRegistry` (WDATUM-staked
  namespace with Schelling-jury arbitration) + `DatumTagCurator`
  (Council-curated lane) + legacy local approved-tag map. Campaign
  picks the lane per required tag.
- **CB4 advertiser stake.** `DatumAdvertiserStake` mirrors
  `DatumPublisherStake` bonding curve, slashed by
  `DatumAdvertiserGovernance`.
- **Bulletin Chain creative storage Phase A.** `DatumCampaignCreative`
  holds creative reference (IPFS + optional Bulletin); escrow +
  renewer-trust-gradient (open-renewal / approved-renewer-set /
  advertiser-only).
- **Stranded-bond fix.** `createCampaign` refunds the ChallengeBonds
  deposit inline if any post-bond step reverts.
- **maxBondedPublishers caps.** Governance-settable; `addAllowedPublishers`
  batch entrypoint reviewed clean in audit pass 5.

### 4.4 Optimistic activation

- **`DatumActivationBonds`** — opens a creator bond on every Pending
  campaign; anyone can challenge before timelock; challenge escalates
  to commit-reveal vote in GovernanceV2. Audit pass 5 H1 fix:
  punishment bps snapshotted at openBond; H2: self-mute guard fails
  closed on advertiser-getter revert; M1: muter refund when
  advertiser and treasury both zero.
- **Phase 2a commit-reveal vote.** GovernanceV2 commitVote / revealVote
  / sweepUnrevealed / CommitRevealWindow for contested optimistic
  activations. H4 fix: Expired-status pool routing.
- **Phase 2b mute.** Self-mute window with bond and time cap; mute
  state cleared on `settleMute` or resolution.

### 4.5 Identity & cross-chain

- **`DatumIdentityVerifier`** — separate ZK identity circuit (single
  public input, single-party trusted setup pending MPC). Trusted
  setup script `scripts/setup-zk-identity.mjs`.
- **`DatumPeopleChainIdentity` + `DatumPeopleChainXcmBridge`** —
  XCM-asynchronous bridge to People Chain `pallet-identity` judgments.
  Oracle reporter (Diana / deployer EOA) is the current Paseo posture;
  return-leg trustless path requires off-chain research (FRAME pallet
  via OpenGov / XCQ / state proofs — see
  `narrative-analysis/people-chain-return-leg.md`).
- **`DatumBondedIdentityReporter`** — alternative bonded-reporter
  identity feed pattern, deployed but not wired.

### 4.6 Token plane

- **`DatumMintCoordinator`** orchestrates per-claim emission:
  MintAuthority + EmissionEngine + dust-gate + split-bps. Decoupled
  from Settlement.
- **`DatumEmissionEngine`** — emission schedule + per-claim mint
  computation.
- **`DatumFeeShare.sweep()`** — keeper-callable, folds orphaned
  protocol-fee DOT into the accumulator when `totalStaked == 0`.
  Mainnet pull path `DatumFeeShare.sweep()` → `PaymentVault.sweepToFeeShare()`
  wired.
- **CB6-extension MintAuthority pause wiring.** `IDatumPauseRegistry_Mint
  pauseRegistry` lock-once setter + `_requireNotPaused` gate on
  `mintForSettlement / mintForBootstrap / mintForVesting`.

### 4.7 Stake / fraud-proof

- **`DatumStakeRootV2`** — bonded-reporter fraud-proof on top of V1
  StakeRoot. Phantom-leaf challenge, balance-fraud challenge, slash
  pool, optimistic finalization. H3 fix: `_slashProposer` no longer
  underflows `totalReporterStake` when an approver has exit-proposed.

### 4.8 Governance

- **`DatumGovernanceRouter` registry extension.** `currentAddrOf[name]`
  + `addressHistory[name]` + `versionOf[name]` + `upgradeContract(name,
  newAddr)`. Phase-floor monotonicity via `raisePhaseFloor()`.
- **Commit-reveal voting** on contested optimistic activations
  (Phase 2a) coexists with legacy open-tally `vote()` on
  non-optimistic paths.
- **Granular pause categories.** `DatumPauseRegistry` per-category
  pauses (campaigns / settlement / mint / etc).
- **Council rate-limit + bicameral veto window.** CB2 + CB5 hardening.

### 4.9 Audit-prep work

- **Audit hedges** (`AUDIT-HEDGES.md`, archived) — items #1 layout
  snapshot, #2 msg.sender tests, #3 lockLogic, #4 safe Campaigns
  views, #5 gradient pure helper, #8 architecture doc, #9 SAFETY
  annotations all shipped (commits `25f4f96`, `c5f69df`). Items
  #6 (Slither/Mythril), #7 (Foundry fuzz) still open.
- **Audit pass 5** — 4 HIGH (H1/H2/H3/H4) + 2 MEDIUM (M4 fixed,
  M1 fixed in MAINNET-DEFERRED) closed. L6, M1 mainnet-deferred
  items both closed too. Bug class summary archived in
  `archive/alpha-4-docs/AUDIT-PASS-5-FINDINGS.md`.

---

## 5. Trust model

| Role | Authority | Limits | Recovery |
|---|---|---|---|
| Deployer EOA | Phase 0 governor; deploy-time owner of every contract | Lock-once setters; phase-gated locks | None — must rotate to Safe before Phase 1 |
| Council N-of-M | Phase 1 governor; blocklist + tag curator authority | `executionDelay` + `vetoWindow`; guardian can veto | Add/remove members via Council vote |
| OpenGov | Phase 2 governor | Conviction lockups; commit-reveal for contested | Council retains veto via bicameral window (CB5) |
| Guardians (3) | Fast-pause any category | 2-of-3 unpause; `lockGuardianSet` makes set immutable | Owner-only `setGuardians` until locked |
| Reporters (StakeRoot) | Off-chain Merkle-root submission | N-of-M threshold; bonded V2 reporters slashable on fraud | `proposeReporterExit` + replacement |
| Mint authority | DATUM issuance | 95M cap; pause gate (CB6-ext); irrevocable post-`acceptIssuerRole` | None post-step-3 |
| Curators | Blocklist + tag policy | `onlyCouncil` (the contract); rotates with Council | Swap pre-lock; frozen post `lockCouncil()` |
| Relay | Submit relay-path batches | Stateless sig + liveness check; open-mode pre-`lockRelayerOpen()` | Curator-style swap pre-lock |
| Publisher / Advertiser | Sign batches via relaySigner / advertiser EOA | Stake gate + slash via *Governance contracts | Stake recovers via `requestUnstake` |
| User | View ads, withdraw earnings | `userPaused / userBlocks* / userMinAssurance` self-sovereignty | Cold-key loss = funds loss (CB9 open) |

### 5.1 Cypherpunk gradient (alpha → production)

- **Alpha (now).** Everything upgradable. Locks revert pre-OpenGov.
  Deployer is owner of every contract. Optimized for iteration.
- **Beta.** Council is governor (Phase 1). Lock-once functions still
  blocked. Curator wiring stable; membership rotation possible.
- **Production.** OpenGov is governor (Phase 2). Council retains a
  bicameral veto window (CB5). Governance can fire each `lock*()`
  per contract — Relay → curators → phase floor → token plane sunset
  → identity reporter — ratifying cypherpunk commitments piecemeal.
  Original "code is law" guarantees become OpenGov-ratified commitments.

---

## 6. Per-contract inventory

By role.

### 6.1 Settlement core (4)

| Contract | Role |
|---|---|
| `DatumSettlement` | Thin shell + storage + DELEGATECALL router |
| `DatumSettlementStorage` | Shared storage base (Settlement / LogicA / LogicB) |
| `DatumSettlementLogicA` | Relay-path entries (`settleClaims`, `settleClaimsMulti`) + auth |
| `DatumSettlementLogicB` | `_processBatch` + dual-sig entry + helpers |

### 6.2 Settlement satellites (8)

| Contract | Role |
|---|---|
| `DatumDualSigSettlement` | EIP-712 dual-sig path (publisher + advertiser cosig) |
| `DatumClaimValidator` | Per-claim hash chain, nonce, PoW, ZK, attestation |
| `DatumPowEngine` | PoW difficulty + leaky-bucket per-publisher |
| `DatumNullifierRegistry` | ZK replay prevention per-(user, campaign, window) |
| `DatumSettlementRateLimiter` | Per-publisher per-window event cap |
| `DatumPublisherReputation` | Settlement acceptance counters + anomaly detection |
| `DatumMintCoordinator` | Per-claim DATUM emission orchestration |
| `DatumEmissionEngine` | DATUM emission schedule + per-claim mint computation |

### 6.3 Campaign core (5)

| Contract | Role |
|---|---|
| `DatumCampaigns` | Per-campaign object: budget, caps, AssuranceLevel, tag refs |
| `DatumCampaignAllowlist` | Multi-publisher allowlist + take-rate snapshots |
| `DatumCampaignCreative` | IPFS + Bulletin Chain creative reference + renewer escrow |
| `DatumCampaignLifecycle` | Status transitions: Active / Terminated / Expired / Demoted |
| `DatumReports` | Community page / ad reports |

### 6.4 Payments (3)

| Contract | Role |
|---|---|
| `DatumBudgetLedger` | Advertiser DOT escrow |
| `DatumPaymentVault` | Pull-payment vault (publisher / user / protocol) |
| `DatumTokenRewardVault` | Pull-payment vault for ERC-20 side-rewards |

### 6.5 Tag policy (3)

| Contract | Role |
|---|---|
| `DatumTagSystem` | Tag dictionary + per-publisher tag sets + per-campaign required tags |
| `DatumTagRegistry` | WDATUM-staked namespace + Schelling-jury arbitration |
| `DatumTagCurator` | Council-curated tag-approval registry |

### 6.6 Publisher (3)

| Contract | Role |
|---|---|
| `DatumPublishers` | Registry, take rate, relaySigner, blocklist curator integration |
| `DatumPublisherStake` | Bonding-curve stake gate |
| `DatumPublisherGovernance` | Conviction-vote fraud proposals against publishers |

### 6.7 Advertiser (3)

| Contract | Role |
|---|---|
| `DatumAdvertiserStake` | Bonding-curve stake gate for advertisers (CB4) |
| `DatumAdvertiserGovernance` | Fraud proposals against advertisers |
| `DatumChallengeBonds` | Optional advertiser bonds; pay out on fraud upheld |

### 6.8 Governance (8)

| Contract | Role |
|---|---|
| `DatumGovernanceRouter` | Stable-address phase router + contract registry |
| `DatumGovernanceV2` | Open conviction voting on campaigns; commit-reveal for optimistic |
| `DatumParameterGovernance` | Conviction voting on protocol parameters |
| `DatumCouncil` | N-of-M trusted-member council (Phase 1) |
| `DatumCouncilBlocklistCurator` | Council-driven blocklist for Publishers |
| `DatumTagCurator` | (see Tag policy) |
| `DatumTimelock` | 48-hour delay on owner-gated admin changes |
| `DatumActivationBonds` | Optimistic activation creator bonds + challenge + mute |

### 6.8a Relay accountability (2) — G-1 first close (2026-05-20)

| Contract | Role |
|---|---|
| `DatumRelayStake` | Flat-minimum bond + slash hook; `isAuthorized` consumed by `DatumRelay` |
| `DatumRelayGovernance` | Conviction-vote fraud proposals against relays (4 reason codes) |

### 6.9 Identity (5)

| Contract | Role |
|---|---|
| `DatumIdentityVerifier` | ZK identity circuit (Groth16, single-input) |
| `DatumPeopleChainIdentity` | XCM bridge state machine to People Chain identity |
| `DatumPeopleChainXcmBridge` | XCM dispatcher (outbound + callback) for the bridge |
| `DatumBondedIdentityReporter` | Bonded-reporter alternative identity feed |
| `DatumInterestCommitments` | Per-user interest-category Merkle commitments |

### 6.10 Stake-root system (3)

| Contract | Role |
|---|---|
| `DatumStakeRoot` | V1 reporter-committed Merkle roots |
| `DatumStakeRootV2` | Fraud-proof system on top of V1 |
| `DatumZKStake` | DATUM stake + 30-day lockup for ZK gate |

### 6.11 Verifiers / attestation (3)

| Contract | Role |
|---|---|
| `DatumZKVerifier` | Groth16 BN254 verifier (7 public inputs) for impression circuit |
| `DatumAttestationVerifier` | Mandatory publisher-cosig wrapper upstream of Settlement |
| `DatumClickRegistry` | Impression → click-session tracking for CPC |

### 6.12 Infrastructure / safety (4)

| Contract | Role |
|---|---|
| `DatumPauseRegistry` | Global per-category emergency pause; 3-guardian set |
| `DatumRelay` | Publisher-cosigned batch relay path (open-mode pre-`lockRelayerOpen`) |
| `DatumUpgradable` | Inheritance base for registry + pause + migrate + lockOpenGov |
| `DatumOwnable` | Ownable2Step base (manual implementation) |
| `PaseoSafeSender` | DOT-transfer helper; defeats Paseo eth-rpc denomination bug |

### 6.13 Token plane (5, under `contracts/token/`)

| Contract | Role |
|---|---|
| `DatumMintAuthority` | Sole bridge contract for DATUM mints; 95M cap |
| `DatumWrapper` | WDATUM ERC-20 wrapper over canonical DATUM |
| `DatumBootstrapPool` | One-time onboarding grant of WDATUM to new users |
| `DatumFeeShare` | Stake WDATUM, earn DOT fee share (MasterChef pattern) |
| `DatumVesting` | Single-beneficiary linear vesting with cliff |

---

## 7. Gaps & assumptions

Concrete issues that exist in the current code with no clean fix in
the current architecture. Documented in detail in
`narrative-analysis/gaps-in-checks-and-balances.md`.

### 7.1 High-severity gaps (G-1 to G-4)

- **G-1 — Relay has zero on-chain accountability.** **Partially
  closed 2026-05-20** via `DatumRelayStake` + `DatumRelayGovernance`
  (relay-accountability proposal §4-5). Relays now have a slashable
  on-chain bond, adjudicated by conviction vote on four reason codes
  (censorship / front-run / MEV / collusion). Pattern (b) augment on
  `DatumRelay` — staked relays pass authorization alongside manually-
  allowlisted ones. Refund-floor cap MAX_PUNISHMENT_BPS = 8000
  preserves ≥ 20% on any single slash. **Still open:** governance-
  vote resolution is slow (one vote cycle ~7d); censorship-fast-track
  (Approach A: Settlement-side mark, or Approach B: on-chain
  commitment) deferred until observed censorship rate justifies the
  per-batch gas tax. MEV / front-running primitives also still open
  (need different mechanism class — VSS or encrypted mempool).
- **G-2 — Two-of-three guardian cabal damage window.** **Partially
  closed 2026-05-20** via three mechanisms in `DatumPauseRegistry`:
  (1) solo fast-pause window shortened to ~24h default
  (`soloMaxPauseBlocks`); extension past that requires 2-of-3
  proposal (action 5); (2) per-category extended caps differ by
  damage profile (settlement 3d, campaign-creation 7d, governance
  7d, token-mint 14d) via `categoryMaxPauseBlocks[cat]`;
  (3) per-(guardian, category) cooldown after engagement
  (`reengagementCooldownBlocks` ~7d default) closes the "extend
  indefinitely by re-engaging at expiry" attack. Consensus unpause
  (action 2 or 4) clears both cooldown and extension. Owner-pause
  bypasses cooldown (bootstrap-emergency role). **Still open:**
  3-of-3 total compromise is unbounded; per-cycle damage to a
  single category is still real (just bounded now). Lock-once
  posture via `lockPauseParams` post-OpenGov.
- **G-3 — No publisher-side dispute initiation.** **Closed
  2026-05-20** via `DatumAdvertiserGovernance.filePublisherFraudClaim`
  + `councilResolvePublisherClaim`. Mirror of the existing
  `DatumPublisherGovernance.fileAdvertiserFraudClaim` Council-
  arbitrated track. Publishers (or any non-self filer with the
  bond) file an evidence-backed claim against an advertiser; Council
  resolves on-chain after off-chain review. Upheld → advertiser stake
  slashed via `advertiserStake.slash`, bond refunded to filer.
  Dismissed → bond forwarded to advertiser as anti-grief
  compensation. Lock-once `councilArbiter`. The protocol's two trust
  planes (publisher / advertiser) now have symmetric Council-
  arbitrated dispute primitives in addition to the pre-existing
  symmetric conviction-vote tracks.
- **G-4 — Reporter cabal has no fast eviction.** StakeRoot V1
  reporters can stonewall finalization. V2 challenge window partially
  closes this; total replacement is still slow.

### 7.2 Medium-severity gaps (G-5 to G-10)

- **G-5** Users can't collectively act (no user-DAO surface).
- **G-6** No appeal for false-positive curator entries.
- **G-7** Asymmetric AssuranceLevel direction silently rejects
  (per-user `userMinAssurance` only goes up to 2; can't express
  "ZK only" floor — PRE-REDEPLOY M1).
- **G-8** No emergency unstake for users.
- **G-9** Slash funds compensate governance, not the actual victims.
- **G-10** No rate limit on economic-parameter retunes.

### 7.3 Acknowledged-unfixable

- **F-1 Attention isn't provable.** PoW + nullifier + ZK are
  necessary-but-insufficient. Some Sybil resistance is intrinsic to
  the off-chain layer.
- **F-2 Reporter trust is residual.** Honest-majority assumption
  underneath StakeRoot. Bond-and-slash narrows but doesn't eliminate.
- **F-3 Off-chain key custody.** No protocol-level recovery; users
  hold private keys.
- **F-4 ZK trusted setup.** Single-party on testnet; mainnet
  requires MPC.

### 7.4 Operational assumptions

- **Paseo eth-rpc quirks.** Denomination rounding bug + getTransactionReceipt
  returning null; both defeated by `PaseoSafeSender` + nonce polling
  in deploy scripts.
- **EVM compatibility on Polkadot Hub.** Pallet-revive runs EVM
  bytecode directly; EIP-170 enforcement is real on mainnet (Paseo
  doesn't enforce, but mainnet will).
- **Cancun evmVersion.** Required for some opcodes; pallet-revive
  EVM support must include them.
- **Diana relay daemon.** Single-publisher localhost service for
  Paseo; production needs hardening (multi-publisher, HTTPS, key
  management).

---

## 8. Upgrade paths

### 8.1 Per-contract upgrade (governance-driven)

```
governance ──► router.upgradeContract(name, v2Addr)
                  │
                  ├ v1.pause()                   (DatumUpgradable.pause)
                  ├ v2.migrate(v1)               (per-contract override)
                  ├ currentAddrOf[name] := v2Addr
                  └ event ContractUpgraded
```

Production migration of state requires per-contract `_migrate`
overrides. Current overrides are no-op (testnet acceptable;
production decisions per-contract). Storage layout snapshots
(`forge inspect storage-layout` or `hardhat-storage-layout`) should
capture pre/post for every upgrade — Settlement already does this
via `settlement-layout.snapshot.json`.

### 8.2 Phase transitions

- **Phase 0 → 1** (Admin → Council): `router.setGovernor(Phase.Council,
  council)` from current admin; Council accepts via two-step in router.
  Then `router.raisePhaseFloor()` to lock against regression.
- **Phase 1 → 2** (Council → OpenGov): same shape;
  `router.setGovernor(Phase.OpenGov, governanceV2)`. After this,
  `whenOpenGovPhase`-gated locks become firable.

### 8.3 Cypherpunk lock sequence (post-Phase 2)

Each `lock*()` is a one-way ratchet. Order is operational
preference; each can fire independently.

1. `Relay.lockRelayerOpen()` — converts open-mode relay → curated
   set.
2. Curator locks: `CouncilBlocklistCurator.lockCouncil()`,
   `TagCurator.lockCouncil()`, `Publishers.lockBlocklistCurator()`,
   `Campaigns.lockTagCurator()`.
3. Phase floor: `GovernanceRouter.raisePhaseFloor()` (idempotent;
   fires after each phase promotion).
4. Identity bridge: `PeopleChainIdentity.lockOracleReporter()`,
   `.lockXcmDispatcher()`, `PeopleChainXcmBridge.lockSovereign()`,
   `.lockPalletCallIndices()`, `BondedIdentityReporter.lockCache()`.
5. Plumbing locks: `PaymentVault.lockFeeShareRecipient()`,
   `StakeRootV2.lockPlumbing()`, `Publishers.lockWhitelistMode()`,
   `Publishers.lockStakeGate()`, `TagRegistry.lockCampaigns()`,
   `Relay.lockPlumbing()`, `ZKStake.lockSlashers()`,
   `PauseRegistry.lockGuardianSet()`, `ClickRegistry.lockPlumbing()`,
   `ClaimValidator.lockPlumbing()`, `CampaignLifecycle.lockPlumbing()`.
6. Token plane sunset (irrevocable post step 3 of the sequence):
   parachain pallet deployment → `MintAuthority.stageIssuerTransfer`
   from Timelock → parachain `acceptIssuerRole()`.

Each `lock*()` reverts pre-OpenGov via `whenOpenGovPhase`. Firing
order is operational; some (e.g. `lockOracleReporter`) should wait
on infrastructure proofs (e.g. trustless return-leg).

### 8.4 Pre-mainnet remerge plan

Some EIP-170 carve-outs are gas costs that pay for size compliance.
Once a contract has audit confidence + the cypherpunk lock is fired
on every dependent path, the carve-out can be re-merged into its
parent to recover per-claim gas. Candidates from
`memory/project_eip170_remerge_plan.md`:

- `DatumPowEngine` → Settlement (re-internalize PoW + leaky-bucket).
- `DatumPublisherReputation` → Settlement.
- `DatumNullifierRegistry` → Settlement.
- `DatumSettlementRateLimiter` → Settlement.

The remerge is a per-claim gas optimization, not an audit-confidence
win. Track in `PRE-ALPHA-5-BACKLOG.md` §1 once mainnet is real.

---

## 9. Mainnet blockers (rollup)

The carryover backlog (`PRE-ALPHA-5-BACKLOG.md`) details every item.
The five categories that block mainnet today:

1. **Shim replacements.** Wrapper XCM path,
   `devnetUnwrapShimEnabled = false`; AssetHubPrecompile → real
   precompile; PeopleChainIdentity → production bridge EOA.
2. **deploy.ts production parameters.** EOA → Safe rotation;
   Timelock window lengthening; SR_V1 3-of-5 threshold; real DATUM
   ERC-20 to StakeRootV2; treasury rotations.
3. **MPC ceremonies.** Multi-party trusted setup for
   `DatumZKVerifier` (impression circuit) and `DatumIdentityVerifier`
   (identity circuit). Single-party setups are testnet-only.
4. **External audit.** Internal pass found 4 HIGH bugs; external
   specialists are non-negotiable before live funds. Plus
   re-audit obligation from the upgrade-ladder retrofit (Stages 1–5b
   touched ~36 contracts).
5. **EIP-170 revalidation on alpha-5.** Two-Logic split closed the
   Settlement gap in alpha-4; run `npm run size:mainnet` post-rename
   to confirm.

---

## 10. Pending design decisions

Items where the right answer needs production data, ecosystem
maturity, or design-conversation surface — not engineering effort
alone.

- **CB8 anti-plutocracy in OpenGov.** Quadratic discount /
  bicameral / reputation-weighted / time-decay. Wait for ≥3 months
  of mainnet conviction-vote data.
- **CB9 cold-key recovery.** Social recovery / time-locked migration
  / identity-pallet-backed. Evaluate Polkadot identity pallet in Q3.
- **CB5-extension high-tier target registry.** On-chain selector
  registry classifying target+selector pairs as high-tier.
- **L3+ AssuranceLevel.** Currently capped at L2. ZK-only floor
  expressible by widening enum + ZK consult on dual-sig path
  (PRE-REDEPLOY M1).
- **People Chain trustless return leg.** Custom FRAME pallet via
  OpenGov / XCQ / state proofs — research-blocked.

---

## 11. Reading order from here

- **Per-contract narrative.** Start with
  `narrative-analysis/README.md` (refresh pending), then the
  reading-order list it provides (Campaigns → Settlement → ...).
- **Deploy / operate.** `narrative-analysis/deploy-runbook-paseo.md`
  for the canonical sequence on Paseo. Includes Diana daemon setup,
  XCM smoke tests, troubleshooting.
- **Upgrade.** `narrative-analysis/upgrade-ladder-design.md` for
  registry mechanics; deploy-runbook §12 for the procedure.
- **Adversary model.** `narrative-analysis/gaps-in-checks-and-balances.md`
  for what the role matrix doesn't cover.
- **Backlog.** `PRE-ALPHA-5-BACKLOG.md` (this directory) for
  carryover punch-list.
- **Comparative.** `narrative-analysis/comparative-analysis.md` for
  DATUM vs traditional + crypto-native ad tech.
- **Archive.** `archive/alpha-4-docs/` for the source docs this
  overview synthesizes from.
