# DATUM Alpha-5 — Narrative Contract Analysis

A walkthrough of every contract in the alpha-5 build, organised by role. Each
file is a prose description of what the contract does, why it exists, how it
fits into the broader system, and where its trust assumptions live. Read this
before the source if you want context; read the source after for precision.

For the top-level system tour (architecture, flows, gaps, upgrade paths),
read [`../SYSTEM-OVERVIEW.md`](../SYSTEM-OVERVIEW.md) first. Per-contract
docs below are written to drill in.

The protocol's elevator pitch: **user-aligned advertising on Polkadot Hub.**
Publishers serve impressions, users earn a majority share of the resulting
DOT, advertisers fund campaigns with on-chain budgets, and the protocol
notarises every claim with cryptographic proofs (publisher sigs, advertiser
co-sigs, ZK proofs of stake/interest, per-impression PoW) so that disputes
can be settled on-chain via stake slashing rather than off-chain trust.

## Reading order

1. **[DatumCampaigns](./DatumCampaigns.md)** — the campaign object: budget, pots, allowlist, AssuranceLevel, ZK-gate knobs.
2. **[DatumSettlement](./DatumSettlement.md)** — the heart. Where claims become payments.
3. **[DatumClaimValidator](./DatumClaimValidator.md)** — per-claim validity rules (hash, nonce, PoW, ZK).
4. **[DatumBudgetLedger](./DatumBudgetLedger.md)** — the escrow that holds advertiser DOT.
5. **[DatumPaymentVault](./DatumPaymentVault.md)** — pull-payment vault that holds earned DOT.
6. **[DatumCampaignLifecycle](./DatumCampaignLifecycle.md)** — complete / terminate / expire transitions.
7. **[DatumRelay](./DatumRelay.md)** — publisher-cosigned batch relay path.
8. **[DatumAttestationVerifier](./DatumAttestationVerifier.md)** — mandatory publisher-cosig wrapper.
9. **[DatumClickRegistry](./DatumClickRegistry.md)** — impression→click session tracking for CPC.

### Publisher side
10. **[DatumPublishers](./DatumPublishers.md)** — registry, take rate, relay-signer, blocklist curator integration.
11. **[DatumPublisherStake](./DatumPublisherStake.md)** — bonding-curve stake gate for publishers.
12. **[DatumPublisherGovernance](./DatumPublisherGovernance.md)** — conviction-vote fraud proposals against publishers.

### Advertiser side
13. **[DatumAdvertiserStake](./DatumAdvertiserStake.md)** — bonding-curve stake gate for advertisers (CB4).
14. **[DatumAdvertiserGovernance](./DatumAdvertiserGovernance.md)** — fraud proposals against advertisers.
15. **[DatumChallengeBonds](./DatumChallengeBonds.md)** — optional advertiser bonds that pay out on fraud upheld.

### Governance
16. **[DatumGovernanceV2](./DatumGovernanceV2.md)** — open conviction voting on campaign activation/termination/demotion (Phase 2).
17. **[DatumGovernanceRouter](./DatumGovernanceRouter.md)** — stable-address proxy spanning Admin → Council → OpenGov phases.
18. **[DatumCouncil](./DatumCouncil.md)** — N-of-M trusted-member council (Phase 1).
19. **[DatumCouncilBlocklistCurator](./DatumCouncilBlocklistCurator.md)** — council-driven blocklist for Publishers.
20. **[DatumTagCurator](./DatumTagCurator.md)** — council-driven tag-approval registry for Campaigns (Curated lane of the three-lane tag-policy model).
20a. **[DatumTagRegistry](./DatumTagRegistry.md)** — WDATUM-staked tag namespace with Schelling-jury arbitration and bounty-driven expiry (StakeGated lane of the three-lane tag-policy model).
21. **[DatumTimelock](./DatumTimelock.md)** — 48-hour delay on owner-gated admin changes.
22. **[DatumParameterGovernance](./DatumParameterGovernance.md)** — conviction voting on parameter changes.
23. **[DatumPauseRegistry](./DatumPauseRegistry.md)** — global per-category emergency pause.

### ZK / Path A
24. **[DatumZKVerifier](./DatumZKVerifier.md)** — Groth16 verifier on BN254 with 7 public inputs.
25. **[DatumZKStake](./DatumZKStake.md)** — DATUM stake + 30-day lockup backing the ZK stake gate.
26. **[DatumStakeRoot](./DatumStakeRoot.md)** — reporter-committed Merkle roots over (commitment, stake) leaves.
27. **[DatumInterestCommitments](./DatumInterestCommitments.md)** — per-user interest-category Merkle commitments.

### Token / DATUM
28. **[token/DatumWrapper](./token-DatumWrapper.md)** — WDATUM, the EVM-side ERC-20 wrapper over canonical DATUM.
29. **[token/DatumMintAuthority](./token-DatumMintAuthority.md)** — sole bridge contract for DATUM mints.
30. **[token/DatumBootstrapPool](./token-DatumBootstrapPool.md)** — one-time onboarding grant of WDATUM to new users.
31. **[token/DatumFeeShare](./token-DatumFeeShare.md)** — stake WDATUM, earn DOT fee share.
32. **[token/DatumVesting](./token-DatumVesting.md)** — single-beneficiary linear vesting with cliff.

### Rewards & infrastructure
33. **[DatumTokenRewardVault](./DatumTokenRewardVault.md)** — per-campaign ERC-20 token rewards alongside DOT.
34. **[DatumOwnable](./DatumOwnable.md)** — Ownable2Step base shared by all owner-gated contracts.
35. **[PaseoSafeSender](./PaseoSafeSender.md)** — DOT-transfer helper that defeats the Paseo eth-rpc denomination bug.

### G-1 first close (2026-05-20)

The relay-accountability pair, mirroring the publisher and advertiser
stake/governance pairs. See
[`proposals/relay-accountability.md`](./proposals/relay-accountability.md)
for design and the future Approach A/B upgrade scaffold.

36. **[DatumRelayStake](./DatumRelayStake.md)** — flat-minimum bond + slash hook for the relay role. `isAuthorized` consumed by `DatumRelay` (pattern (b) augment).
37. **[DatumRelayGovernance](./DatumRelayGovernance.md)** — conviction-vote fraud proposals against relays. Mirrors `DatumPublisherGovernance` / `DatumAdvertiserGovernance`.

### Carried in from alpha-4 (no standalone narrative yet)

The 21 contracts below were added or split out during the alpha-4 line.
They have working tests + scripts but lack per-contract narrative-md
files. See [`../SYSTEM-OVERVIEW.md`](../SYSTEM-OVERVIEW.md) §6 for the
per-contract inventory and cross-references to the topic-level docs
in this directory.

| Contract | Topic doc(s) in this dir |
|---|---|
| `DatumSettlementStorage` | (see `DatumSettlement.md`; storage base of the two-Logic split) |
| `DatumSettlementLogicA` | (see `DatumSettlement.md`; relay-path entry contract) |
| `DatumSettlementLogicB` | (see `DatumSettlement.md`; `_processBatch` + dual-sig entry) |
| `DatumDualSigSettlement` | (see `DatumSettlement.md`; EIP-712 dual-sig path) |
| `DatumPowEngine` | `pow-timing-and-amortization.md`, `task-pow-governance-tuning.md` |
| `DatumPublisherReputation` | (anomaly detection counters; design notes folded into `DatumSettlement.md`) |
| `DatumNullifierRegistry` | (FP-5; folded into `DatumSettlement.md` ZK section) |
| `DatumSettlementRateLimiter` | (BM-5; folded into `DatumSettlement.md`) |
| `DatumMintCoordinator` | `task-datum-emission-path-h.md` |
| `DatumEmissionEngine` | `task-datum-emission-path-h.md` |
| `DatumCampaignAllowlist` | (multi-publisher campaigns; see `proposals/multi-publisher-campaigns.md`) |
| `DatumCampaignCreative` | (Bulletin Chain Phase A; folded into `DatumCampaigns.md`) |
| `DatumReports` | (community reports; folded into `DatumCampaigns.md`) |
| `DatumTagSystem` | (carved-out tag dictionary; see `DatumTagRegistry.md` + `DatumTagCurator.md` for the three-lane policy) |
| `DatumActivationBonds` | `proposal-stakeroot-optimistic.md`, `optimistic-activation-phase-2b.md` |
| `DatumStakeRootV2` | `task-stakeroot-v2-implementation.md`, `migration-stakeroot-v1-to-v2.md`, `stakeroot-shadow-mode.md`, `proposal-stakeroot-optimistic.md` |
| `DatumIdentityVerifier` | `task-zk-identity-verifier.md` |
| `DatumPeopleChainIdentity` | `bonded-reporter-identity.md`, `people-chain-return-leg.md` |
| `DatumPeopleChainXcmBridge` | `bonded-reporter-identity.md`, `people-chain-return-leg.md` |
| `DatumBondedIdentityReporter` | `bonded-reporter-identity.md` (deployed but not wired per `deploy-runbook-paseo.md` §11) |
| `DatumUpgradable` | `upgrade-ladder-design.md` |

## Conventions across the codebase

- **Error codes (`E00`–`E94`).** Compact require-strings to fit PolkaVM and EVM bytecode budgets. The `error-codes.md` (in /docs, when present) and inline comments are the source of truth.
- **Lock-once setters.** Most structural references (claim validator, payment vault, etc.) are settable exactly once. The pattern is `require(addr == address(0))` on the first write, then frozen. This is the codebase's primary defense against owner-key compromise.
- **Cypherpunk plumbing locks.** Some contracts add a `plumbingLocked` flag that, once flipped, makes every owner setter revert forever — the "no admin" terminal state.
- **`PaseoSafeSender._safeSend`.** Replaces raw `.call{value:}`. Handles the Paseo eth-rpc denomination bug by stashing sub-10⁶-planck dust into per-recipient claimable buckets.
- **CEI in settlement.** Chain state and nullifiers update before external calls. ReentrancyGuard on every external mutator.
- **Pull payments.** Earnings (publisher, user, protocol, vesting, fee-share rewards) are pulled by the recipient via `withdraw()` paths. The contracts never push DOT to user EOAs that could revert and DoS the flow.

## Trust model at a glance

- **Owner = Timelock = (eventually) Governance.** All `onlyOwner` paths in the protocol's mainline ladder traverse a 48h Timelock and then a Council or OpenGov contract. The deploying EOA's role is bootstrap-only.
- **Guardians.** Three-of-three pause registry guardians can fast-pause (any one) but unpause needs two-of-three. Owner-only `setGuardians` is lockable via `lockGuardianSet`.
- **Reporters.** StakeRoot and (in the past) reputation feeds rely on a small reporter set running off-chain. N-of-M threshold on stake root finalisation.
- **Mint authority.** DATUM mint flows through one address, capped at 95M (95% of supply). Settlement, bootstrap pool, and vesting all interact with this single bridge.
- **Curators.** Blocklist and tag-approval policies live in swappable curator contracts. The owner can hot-swap until `lockCouncil()` / `lockBlocklistCurator()` is called, after which the council (or whoever is wired in) is the sole authority.

For audit-pass history, see the archived alpha-4 docs at
[`../../archive/alpha-4-docs/`](../../archive/alpha-4-docs/) — passes 1–4
landed before 2026-05-13 (`PRE-REDEPLOY-FINDINGS.md`), pass 5 ran 2026-05-14
(`AUDIT-PASS-5-FINDINGS.md`), pre-audit hedges ran 2026-05-19
(`AUDIT-HEDGES.md`). The carryover backlog
([`../PRE-ALPHA-5-BACKLOG.md`](../PRE-ALPHA-5-BACKLOG.md)) §4 enumerates
the items worth revalidating against the current alpha-5 tree.

## Subdirectories

- **[`process-flows/`](./process-flows/)** — per-role action sequences (User,
  Publisher, Advertiser, Relay, Reporter, Guardian, Council Member,
  OpenGov Voter, Deployer / Timelock) plus the cross-role checks-and-balances
  matrix and the gaps analysis.
- **[`proposals/`](./proposals/)** — design proposals (implemented and
  pending). Current contents:
  - `multi-publisher-campaigns.md` — multi-publisher campaign support
    with per-publisher bonds (implemented 2026-05-14).
- **[`comparative-analysis.md`](./comparative-analysis.md)** — DATUM vs
  traditional and crypto ad-tech systems.
- **[`gaps-in-checks-and-balances.md`](./gaps-in-checks-and-balances.md)** —
  structural gaps the role matrix doesn't fully address.
