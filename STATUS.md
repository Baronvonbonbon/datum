# DATUM Project Status

**Last Updated:** 2026-05-28
**Current Phase:** Alpha-5 v5 — full advertiser fraud track + interest commitments + tag curator deployed on Paseo (2026-05-23T12:23Z). Twenty governable parameters across seven contracts retunable via the Timelock route (48h delay) AND the `DatumParameterGovernance` bicameral veto-window route. 10/10 governable parameters round-tripped end-to-end on Paseo via `scripts/exercise-governable-params.ts`. Pre-mainnet upgrade-machinery work tracked in `PRE-MAINNET-CHECKLIST.md` §U1-U7.
**Testnet:** Paseo Hub (Chain ID 420420417) — alpha-5 v5 (EVM, solc) live; alpha-3 PVM reference frozen in `archive/`
**Web App:** https://datum.javcon.io
**Contract count:** 53 deployable production contracts + 2 Logic delegates (LogicA + LogicB) for Settlement. Token plane (5 contracts in `contracts/token/`) deployed separately via `deploy-token.ts`.
**Tests:** 1579 passing, 0 failing, 1 pending

---

## Cypherpunk Roadmap

The system is **upgradable today, locked tomorrow**. Two-phase commitment:

1. **Alpha + beta (current):** Every contract is replaceable via governance. Deployer (Phase 0 = Admin) can `upgradeContract(name, v2)` instantly; Council (Phase 1) and OpenGov (Phase 2) gate the same flow with their respective delays. Lock-once functions revert pre-OpenGov so the system stays malleable while iterating. Token plane (MintAuthority, Wrapper, Vesting, BootstrapPool, FeeShare) is phase-conditional.

2. **Production (when OpenGov is in charge):** Governance can fire `lock*()` functions per-contract, ratifying cypherpunk commitments piecemeal. The original "code-is-law" guarantees become OpenGov-choice commitments rather than baked-in invariants.

End-state target: every lock fired, oracleReporter retired, parachain sunset finalized. See `alpha-5/narrative-analysis/upgrade-ladder-design.md`.

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub. Users earn DOT and DATUM tokens for viewing ads; publishers set their own take rates; advertisers fund campaigns from on-chain budgets; governance voters curate campaign quality with conviction-weighted staking; disputes resolve via on-chain slash. Alpha-5 is the rename + clean checkpoint of alpha-4 v0.5.0 (`bd59fa4`, 2026-05-19) — all contract sources, tests, scripts, and the narrative-analysis tree carry over byte-for-byte. The version bump declares "alpha-4 contract surface is the alpha-5 baseline."

**Build:** Solidity 0.8.24, EVM-only (`evmVersion: cancun`, viaIR, optimizer 200 runs). Single build target — pallet-revive on Polkadot Hub runs EVM bytecode directly, so no resolc/PVM step. Alpha-3 PVM and alpha-3 EVM dual-target deploys remain in `archive/` as the canonical 29-contract reference and the PVM-vs-EVM cost benchmark that motivated the satellite merge.

---

## Components

### Smart Contracts — `alpha-5/contracts/` (canonical, EVM)

**53 production contracts** + token plane (5 contracts in `contracts/token/`). Executed on Paseo Hub via pallet-revive's EVM compatibility path. **1579/1579 alpha-5 tests passing.**

#### Settlement core (4)

| Contract | Role |
|---|---|
| `DatumSettlement` | Thin shell + storage + DELEGATECALL router |
| `DatumSettlementStorage` | Shared storage base (Settlement / LogicA / LogicB) |
| `DatumSettlementLogicA` | Relay-path entries (`settleClaims`, `settleClaimsMulti`) + auth |
| `DatumSettlementLogicB` | `_processBatch` + dual-sig entry + helpers |

The two-Logic split (2026-05-19) closed the EIP-170 gap: `DatumSettlement` is a thin shell holding state via `DatumSettlementStorage` and routing via DELEGATECALL through LogicA → LogicB. DualSig submissions enter LogicB directly, bypassing LogicA. All three contracts share an identical storage layout asserted by `test/settlement-layout.test.ts` against `settlement-layout.snapshot.json`. Layout drift is a deploy-time revert via `validateSettlementLayoutMatchesSnapshot()`.

Sizes after the split (all under EIP-170):
- `DatumSettlement` — 11,338 B
- `DatumSettlementLogicA` — 5,289 B
- `DatumSettlementLogicB` — 12,507 B
- `DatumCampaigns` — 20,767 B

#### Settlement satellites (8)

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

#### Campaign (5)

| Contract | Role |
|---|---|
| `DatumCampaigns` | Per-campaign object: budget, caps, AssuranceLevel, tag refs |
| `DatumCampaignAllowlist` | Multi-publisher allowlist + take-rate snapshots |
| `DatumCampaignCreative` | IPFS + Bulletin Chain creative reference + renewer escrow |
| `DatumCampaignLifecycle` | Status transitions: Active / Terminated / Expired / Demoted |
| `DatumReports` | Community page / ad reports |

#### Payments (3)

| Contract | Role |
|---|---|
| `DatumBudgetLedger` | Advertiser DOT escrow |
| `DatumPaymentVault` | Pull-payment vault (publisher / user / protocol); recovery-address support |
| `DatumTokenRewardVault` | Pull-payment vault for ERC-20 side-rewards |

#### Tag policy (3)

| Contract | Role |
|---|---|
| `DatumTagSystem` | Tag dictionary + per-publisher tag sets + per-campaign required tags |
| `DatumTagRegistry` | WDATUM-staked namespace + Schelling-jury arbitration |
| `DatumTagCurator` | Council-curated tag-approval registry |

#### Publisher (3)

| Contract | Role |
|---|---|
| `DatumPublishers` | Registry, take rate, relaySigner, blocklist curator integration |
| `DatumPublisherStake` | Bonding-curve stake gate |
| `DatumPublisherGovernance` | Conviction-vote fraud proposals against publishers |

#### Advertiser (3)

| Contract | Role |
|---|---|
| `DatumAdvertiserStake` | Bonding-curve stake gate for advertisers (CB4) |
| `DatumAdvertiserGovernance` | Fraud proposals against advertisers (G-3 mirror) |
| `DatumChallengeBonds` | Optional advertiser bonds; pay out on fraud upheld |

#### Governance (8)

| Contract | Role |
|---|---|
| `DatumGovernanceRouter` | Stable-address phase router + contract registry |
| `DatumGovernanceV2` | Open conviction voting on campaigns; commit-reveal for optimistic |
| `DatumParameterGovernance` | Conviction voting on protocol parameters |
| `DatumCouncil` | N-of-M trusted-member council (Phase 1) |
| `DatumCouncilBlocklistCurator` | Council-driven blocklist with bonded-appeal mechanism |
| `DatumTimelock` | 48-hour delay on owner-gated admin changes |
| `DatumActivationBonds` | Optimistic activation creator bonds + challenge + mute |
| `ParameterRetuneGuard` (mixin) | Per-key cooldown defense-in-depth on economic setters |

#### Relay accountability (2) — G-1 first close, 2026-05-20

| Contract | Role |
|---|---|
| `DatumRelayStake` | Flat-minimum bond + slash hook; `isAuthorized` consumed by `DatumRelay` |
| `DatumRelayGovernance` | Conviction-vote fraud proposals against relays (censorship / front-run / MEV / collusion) |

#### Identity (5)

| Contract | Role |
|---|---|
| `DatumIdentityVerifier` | ZK identity circuit (Groth16, single public input) |
| `DatumPeopleChainIdentity` | XCM bridge state machine to People Chain identity |
| `DatumPeopleChainXcmBridge` | XCM dispatcher (outbound + callback) for the bridge |
| `DatumBondedIdentityReporter` | Bonded-reporter alternative identity feed |
| `DatumInterestCommitments` | Per-user interest-category Merkle commitments for ZK targeting |

#### Stake-root system (3)

| Contract | Role |
|---|---|
| `DatumStakeRoot` | V1 reporter-committed Merkle roots |
| `DatumStakeRootV2` | Fraud-proof system on top of V1 (bonded reporters, phantom-leaf challenge) |
| `DatumZKStake` | DATUM stake + 30-day lockup for ZK gate |

#### Verifiers / attestation (3)

| Contract | Role |
|---|---|
| `DatumZKVerifier` | Groth16 BN254 verifier (7 public inputs) for impression circuit |
| `DatumAttestationVerifier` | Mandatory publisher-cosig wrapper upstream of Settlement |
| `DatumClickRegistry` | Impression → click-session tracking for CPC |

#### Infrastructure / safety (5)

| Contract | Role |
|---|---|
| `DatumPauseRegistry` | Global per-category emergency pause; 3-guardian set |
| `DatumRelay` | Publisher-cosigned batch relay path (open-mode pre-`lockRelayerOpen`) |
| `DatumUpgradable` | Inheritance base for registry + pause + migrate + lockOpenGov |
| `DatumOwnable` | Ownable2Step base (manual implementation) |
| `PaseoSafeSender` | DOT-transfer helper; defeats Paseo eth-rpc denomination bug |

#### Token plane (5, under `contracts/token/`)

| Contract | Role |
|---|---|
| `DatumMintAuthority` | Sole bridge contract for DATUM mints; 95M cap |
| `DatumWrapper` | WDATUM ERC-20 wrapper over canonical DATUM |
| `DatumBootstrapPool` | One-time onboarding grant of WDATUM to new users |
| `DatumFeeShare` | Stake WDATUM, earn DOT fee share (MasterChef pattern) |
| `DatumVesting` | Single-beneficiary linear vesting with cliff |

---

### Settlement Entry Points

`DatumSettlement` exposes three entry points that all converge on `_processBatch` in LogicB:

1. **`settleClaims(ClaimBatch[])`** — relay path. `msg.sender` is the user themselves, `DatumRelay`, `DatumAttestationVerifier`, or a publisher's `relaySigner` hot key. Satisfies AssuranceLevel ≤ 1.
2. **`settleClaimsMulti(UserClaimBatch[])`** — batch variant; one tx, multiple users × campaigns.
3. **`settleSignedClaims(SignedClaimBatch[])`** — dual-sig path delegated to `DatumDualSigSettlement` (EIP-712 publisher + advertiser cosig over `(user, campaignId, claimsHash, deadline, expectedRelaySigner, expectedAdvertiserRelaySigner)`). Only path that satisfies AssuranceLevel = 2.

AssuranceLevel gradient:
- **L0** — open; user signature only
- **L1** — relay-mediated; sig + liveness check via `DatumRelay`
- **L2** — dual-sig path required
- **L3** — ZK-only floor (users may demand via `userMinAssurance`)

---

### Browser Extension — `alpha-5/extension/`

v0.2.0, alpha-5 contract support. **212+ Jest tests passing.** Manifest V3, Chrome/Chromium. ABIs synced from alpha-5 artifacts.

**4-tab popup:** Claims, Earnings, Settings, Filters.

Key features:
- **IAB ad format system** — 7 standard sizes; SDK sizes placeholder div to exact dimensions
- **Per-format creative images** — `creative.images[]` with `{ format, url, alt? }`
- **Event-driven campaign polling** — incremental from lastBlock, O(1) Map index
- **Blake2-256 claim hashing** — matches Settlement on Polkadot Hub
- **All three settlement paths** — `publisher` / `dualsig` / `datumrelay` modes from SDK propagated via `datum:sdk-ready`
- **Filters tab** — tag-based campaign filtering, silenced campaigns
- **In-ad dismiss / Report** — popover with topic-level mute and reason picker
- **Publisher profile + FP state** in Settings (relay signer, profile hash, stake balance, challenge bond)
- **Second-price Vickrey auction** — interest-weighted bids, mechanism badge
- **Native Asset Hub token metadata** — registry fallback for ERC-20 precompile addresses
- **ZK proof generation** — impression circuit (Groth16/BN254) + identity circuit (single-input)
- **Interest commitments** — local leaf storage + on-chain Merkle root publication
- EIP-1193 provider bridge, IPFS multi-gateway, Shadow DOM injection, AES-256-GCM multi-account wallet, auto-submit, claim export, timelock monitor

---

### Web App — `web/`

React 18 + Vite 6 + TypeScript + ethers v6. **82 page TSX files.** Alpha-5 contract addressing throughout.

Sections:
- **Explorer** — Overview, HowItWorks, Philosophy, Campaigns, CampaignDetail, Publishers, PublisherProfile, AdvertiserProfile
- **Advertiser** — Dashboard, Profile, CreateCampaign, CampaignDetail, SetMetadata, Analytics
- **Publisher** — Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile, Stake
- **Governance** — Dashboard, Vote, MyVotes, Parameters, ProtocolParams, PublisherFraud, AdvertiserFraud, RelayFraud
- **Admin** — Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation, PublisherStake, PublisherGovernance, ChallengeBonds, NullifierRegistry, ParameterGovernance, AdvertiserStake, RelayStake
- **Identity** — Dashboard, PeopleChain, Zk
- **Token** — Dashboard, Wrapper, FeeShare, Bootstrap, Vesting, MintCoordinator
- **Protocol** — Dashboard, TagCurator, BrandCurator, Upgrades
- **Me** — Dashboard, History, Assurance, Branding, Dust, Identity
- **Settings / Demo**

---

### Pine RPC — `pine/`

Local smoldot light-client bridge. Translates Ethereum JSON-RPC into Substrate `ReviveApi_*` and `chainHead_v1_*` calls for Polkadot Asset Hub without a centralized RPC proxy.

**Architecture:** `PineProvider` (EIP-1193) → per-method handlers → smoldot WASM light client → P2P proof fetching.

Key capabilities:
- Fully supported: `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_sendRawTransaction`, `eth_blockNumber`, `eth_chainId`
- Partial: `eth_getLogs` (rolling 10,000-block window), `eth_getTransactionReceipt` (session-scoped TxPool — fixes Paseo null-receipt bug), `eth_getBlockBy*` (tracked window only)
- Not supported: `eth_subscribe`, filter subscriptions, `eth_accounts`, debug/trace, EIP-1559 fee market

**Supported chains:** Paseo Asset Hub, Polkadot Asset Hub, Kusama Asset Hub, Westend Asset Hub, custom.

See `pine/CAPABILITIES.md` for the full method support matrix.

---

### Publisher SDK — `sdk/`

`datum-sdk.js` v3.4 — lightweight JS tag. `<script data-publisher="0x..." data-slot="medium-rectangle" data-relay-mode="publisher|dualsig|datumrelay">` + `<div id="datum-ad-slot">`. Sizes placeholder div to exact IAB dimensions. Challenge-response handshake with extension for two-party attestation. Alpha-5 additions:
- Bulletin Chain creative loader (`${relay}/bulletin/<cid>`)
- Click reporter (`datum:click` → POST `${relay}/click` → `DatumClickRegistry` on-chain; no user wallet address sent)
- Relay-path hint propagated in `datum:sdk-ready`
- Publisher telemetry on `window.DATUM.metrics`
- No-extension fallback: inline DATUM house ads sized to slot

---

### WordPress Plugin — `wordpress-plugin/datum-publisher/`

PHP plugin (`datum-publisher.php`) that wraps the SDK. Provides shortcode, Gutenberg block, and sidebar widget placement. Stores publisher configuration in WP options. Inherits all SDK privacy properties (zero cookies, no third-party tracking).

---

### Publisher Relay — `relay-bot/` (gitignored, example at `relay-bot.example/`)

Live systemd service for Diana on localhost:3400. Co-signs attestations and forwards claim batches via `DatumRelay.settleClaimsFor()` using the EIP-712 `userSig` + optional `publisherSig` envelope. After each batch: parses `ClaimSettled`/`ClaimRejected` events, aggregates per `(publisher, campaignId)` pair, calls `recordSettlement` on the reputation slot. Click endpoint (`POST /click`) batches and submits to `DatumClickRegistry`. Bulletin endpoint (`GET /bulletin/<cid>`) fetches creative for the SDK.

---

### IPFS Node — `ipfs-node/`

Local Kubo IPFS daemon (1 GB cap, localhost-only API + gateway) fronted by Cloudflare Tunnel at `ipfs.datum.javcon.io`. Authenticated upload proxy (`ipfs-proxy.mjs`) on port 5050 with Bearer-token auth. Two systemd user services.

---

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployment (Paseo — Alpha-5 v5, 2026-05-23)

| Resource | Value |
|---|---|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Chain ID | 420420417 |
| Currency | PAS (planck = 10⁻¹⁰ PAS) |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher | Diana (50% take rate, relay signer) |

### Key addresses (alpha-5 v5)

| Contract | Address |
|---|---|
| PauseRegistry | `0xfC4B9b1c47EbF4F7A3f2a274C57F6C7Ab307FbD0` |
| Timelock | `0x33578f113FF1502f90A9A98683ce66735Cae9B6e` |
| ZKVerifier | `0x8698D81C63Bc7DAf5F578bD9Aa232d79069f9981` |
| Publishers | `0xAAED2e515574b330A16320A6Df5669274c6Abb80` |
| BudgetLedger | `0xA7FBB6ef2EFb509764E38EB5396f597346524592` |
| PaymentVault | `0xfc7e1Cd05EdB4d7203eF6cbfE07762FA4B09eD73` |
| Campaigns | `0x3a7AB32f47f789A59c0dd659fd2DB08E4662E149` |
| CampaignLifecycle | `0x99A876954Bf4294e59938f5A031e41D508e372b4` |
| Settlement | `0x19562f8808d4e382e5B4d28c787271f384f96c35` |
| SettlementLogicA | `0x2931dA48e191cA767449fe4E8C80c8B4C716A26f` |
| SettlementLogicB | `0x896a56d7d6b3538ba241733863993A7c418f732D` |
| ClaimValidator | `0xF7E64A7124050d4322d26C6AB653C0414D96D2f6` |
| GovernanceV2 | `0x7974823244F2c46b8b952F6F84B8AcA811353ecB` |
| Relay | `0xB06CB43977d9691ED220f434EEa730425BfF03ec` |
| RelayStake | `0x14fE1aB5ceeDb6dEb1ec2afEe2e7b8267d899539` |
| RelayGovernance | `0xe2D0572333A2A5B7EA288F5De941c0E685EaE3e0` |
| AttestationVerifier | `0xc8F5c55754c8D40157A4b51A09eB768f4c0af459` |
| TokenRewardVault | `0x27D55103394f2E69E8Ae867290e0F0F4FD50933f` |
| PublisherStake | `0x1A7903Af6B47E6d0a071DD7a70Ffb89Fe5A39147` |
| ChallengeBonds | `0xB50FBF1D919e3EAc2F096b78206cCB59F791F4e8` |
| PublisherGovernance | `0xd046c9a9B5E1Ad97e8f2d290F16611B0f4C45EE9` |
| AdvertiserStake | `0xda5e6D741C210eD6AE63Da2cd6d57f0Dd81d70cE` |
| AdvertiserGovernance | `0xf27324C6093e5C45309cE4F84B72BA967EFe9A18` |
| InterestCommitments | `0xc05d837C35122523022AaA14AeaF9AAbB4C20aa6` |
| TagCurator | `0x54bd74f71F24e41d065A6f233D2a28Eb5598E672` |
| ParameterGovernance | `0xE28851Fd4CFD71A16Be7AAb80e953f53bB6b3102` |
| GovernanceRouter | `0xeeeD1f19c9ff23B7b1C748c96ab7FC853ee57062` |
| Council | `0xD474805bc19aCc0BDaA3bdDAf73DA17787C6c150` |
| ClickRegistry | `0x9Eca5ce274AFAFbC8D0B7E56CbdaD3106Bf55f27` |
| PowEngine | `0x94De8B916D68d154365762925ef29C04Fa5f0378` |
| PublisherReputation | `0xdD56e1947B713d29CefAC302946a1c9B7959cF27` |
| NullifierRegistry | `0xE6a853105e170C0B72EEF8aD632941f71d07C258` |
| SettlementRateLimiter | `0xc27c028b53390f80e10FF5e14645F6ed442dcb00` |
| CampaignCreative | `0xBfA458a72d86860973697ac5291DC1C5fEFFbC81` |
| Reports | `0x5FD07CCaDba4863A50CCF17e8D5645a23812Ec60` |
| CampaignAllowlist | `0x53B3DA56aE87fc3893555ef4e2ae8DB2B0EDce3c` |
| TagSystem | `0xA3548857670E5DF54cc06ab3bBBbf0F12233a406` |
| BlocklistCurator | `0x106a8a54BcF6fAdF80f44D6EBb0b2C515E4dAaeC` |
| ActivationBonds | `0xeb3ffFD9eaAF7E7fb56BB166ce5f300143c0c59A` |
| StakeRoot | `0x4C63C5C8751cdb8dD316070c8d40C00D13911fa8` |
| StakeRootV2 | `0x55310eddE16743Bc0F7FD5aC396351FcA5cF8047` |
| IdentityVerifier | `0xC9905F505f74b65c9445B8bC3d958523AA935CC1` |
| EmissionEngine | `0xa1b78B668155b76ABc4B8Ba40d87ed58181608bC` |
| MintCoordinator | `0xAb66b639F61C10746BC4C876Fc9d6a2Df1759aF2` |
| DualSig | `0x9B4c0f81cF2a46c5C52a91D33EA022dbF7E8e04b` |
| PeopleChainIdentity | `0x858dd5fCC448A023F12810E016187D6912247FCc` |
| PeopleChainXcmBridge | `0x4118c4c6cd5F88DA032Fc17317f779218Fc71230` |
| PeopleChainBondedReporter | `0x69B897773B3FB5d7238b211AA0DBC844bb4c85DC` |

Authoritative source: `alpha-5/deployed-addresses.json`. Previous v4 addresses archived at `alpha-5/deployed-addresses.v4-pre-advertiser-track.json`. Earlier archived snapshots in `deployed-addresses.v{1,2,3}-*.json`.

---

## Test Totals

| Component | Tests | Status |
|---|---|---|
| Alpha contracts (archived) | 132 | Passing |
| Alpha-2 contracts (archived) | 187 | Passing |
| Alpha-3 contracts (archived) | 546 / 546 | All passing |
| Alpha-4 contracts (archived) | 1228 / 1228 | All passing |
| **Alpha-5 contracts** | **1579 / 1579** | **All passing (1 pending)** |
| Alpha-5 extension | 212+ | Passing |

---

## Recent Major Milestones

### ✅ Alpha-5 v5 deployment (2026-05-23)
Full advertiser fraud track + interest commitments + tag curator deployed on Paseo. Adds `DatumAdvertiserStake`, `DatumAdvertiserGovernance` (closes G-3 publisher-side dispute initiation), `DatumInterestCommitments` (ZK Path-A user-interest roots), `DatumTagCurator` (governance-curated tag lane). 20 governable parameters across 7 contracts.

### ✅ Settlement EIP-170 two-Logic split (2026-05-19)
After 10 carve-outs Settlement was still 9.8 KB over the 24,576 B mainnet cap. Closed via Storage/LogicA/LogicB split. Storage layout asserted by `test/settlement-layout.test.ts`.

### ✅ Upgrade ladder (Stages 1–6, 2026-05-18, commit `bd59fa4`)
~36 contracts inherit `DatumUpgradable`; ~28 user-facing mutators get `whenNotFrozen`; every lock-once function gates on `whenOpenGovPhase`. Web app reads addresses from the on-chain registry.

### ✅ G-1 through G-10 gaps closure (2026-05-20)
- G-1 Relay accountability — `DatumRelayStake` + `DatumRelayGovernance` (partial close)
- G-2 Guardian cabal — solo-fast-pause window, per-category caps, re-engagement cooldown (partial close)
- G-3 Publisher-side dispute initiation — `DatumAdvertiserGovernance.filePublisherFraudClaim`
- G-4 Reporter cabal fast eviction — `DatumStakeRootV2.markInactive`
- G-6 Bonded blocklist appeal — `DatumCouncilBlocklistCurator.fileBlocklistAppeal`
- G-7 L3 ZK-only assurance floor — `userMinAssurance` accepts level ≤ 3
- G-8 Time-locked recovery address — `DatumPaymentVault.setRecoveryAddress`
- G-10 ParameterRetuneGuard mixin

### ✅ People Chain identity bridge Phase B + Bonded Reporter (earlier this cycle)
`80d5ca6` Phase B, `1d52b8c` reporter, `1847e46` Tier 5 token plane.

### ✅ Hybrid dual-sig settlement
`DatumDualSigSettlement.settleSignedClaims` with EIP-712 publisher + advertiser cosigs over `ClaimBatch(user, campaignId, claimsHash, deadline, expectedRelaySigner, expectedAdvertiserRelaySigner)`. A1 + M6 anti-staleness: relay-key rotations on either side invalidate in-flight cosigs.

### ✅ Token plane (DATUM ERC-20)
Five-contract sidecar: `DatumMintAuthority` (95M cap), `DatumWrapper` (WDATUM), `DatumBootstrapPool` (onboarding grants), `DatumFeeShare` (DOT yield via MasterChef pattern), `DatumVesting`. Deployed via `deploy-token.ts`.

---

## Critical Path to Mainnet

### ✅ Done
- Alpha-5 v5 deployment with full advertiser fraud track + interest commitments
- Settlement EIP-170 compliance via two-Logic split
- Upgrade ladder Stages 1–6 (~36 contracts upgradable)
- G-1 / G-3 / G-4 / G-6 / G-7 / G-8 / G-10 gap closures
- Real Groth16 ZK verifier (impression circuit)
- ZK identity verifier (single-input circuit)
- People Chain identity XCM bridge (Phase B oracle posture)
- Bonded Identity Reporter
- Interest commitments + Tag curator
- Hybrid dual-sig settlement
- Token plane (mint authority / wrapper / bootstrap / fee share / vesting)
- AssuranceLevel L0–L3 + `userMinAssurance` floor
- User self-sovereignty controls (`userPaused`, `userBlocksPublisher`, `userBlocksAdvertiser`)
- Time-locked recovery address
- Internal security audit pass 5 (4 HIGH + 2 MEDIUM closed)
- IAB ad format system + per-format creative images
- Pine RPC smoldot light client
- IPFS node + upload proxy
- WordPress plugin

### Open
- **MPC ceremonies** for impression circuit + identity circuit (single-party setups are testnet-only)
- **Production deploy parameters** — EOA → Safe rotation; Timelock window lengthening; SR_V1 3-of-5 threshold; real DATUM ERC-20 to StakeRootV2; treasury rotations
- **Shim replacements** — Wrapper XCM path (`devnetUnwrapShimEnabled = false`); AssetHubPrecompile → real precompile; PeopleChainIdentity production bridge EOA
- **E2E browser validation** — full flow on Paseo against alpha-5 v5 addresses
- **External security audit** — internal pass found 4 HIGH bugs; external specialists non-negotiable. Re-audit obligation from upgrade-ladder retrofit (~36 contracts touched).
- **EIP-170 revalidation** — confirm post-rename via `npm run size:mainnet`
- **Kusama / Polkadot Hub deployment planning**

---

## Economics Reference

See `alpha-5/ECONOMICS.md` for full break-even analysis by role.

**At recommended 0.500 PAS/1000 CPM ($2.50 @ $5/DOT), 50% publisher take rate:**

| Party | Per 1000 impressions | After gas |
|---|---:|---:|
| Publisher | 0.250 PAS ($1.25) | ~$1.14 |
| User | 0.1875 PAS ($0.94) | ~$0.93 |
| Protocol | 0.0625 PAS ($0.31) | $0.31 |
| Relay gas overhead | — | −$0.11 |

User withdrawal break-even: **9 impressions** at 0.500 PAS/1000 CPM. Relay profitable at 7-claim × 100-imp batches.

---

## Directory Layout

```
datum/
├── alpha-5/                         # Active line — EVM-only, 53 prod contracts + 5 token plane
│   ├── contracts/                   # Production + token plane + mocks
│   │   └── token/                   # DATUM token plane (5)
│   ├── test/                        # 1579 tests
│   ├── extension/                   # 212+ tests, alpha-5 ABIs
│   ├── scripts/                     # deploy.ts, deploy-token.ts, setup-testnet.ts, exercise-governable-params.ts, ...
│   ├── narrative-analysis/          # Per-contract narratives + upgrade-ladder design + deploy runbook
│   ├── deployed-addresses.json      # Alpha-5 v5 (2026-05-23)
│   ├── deployed-addresses.v{1..4}-*.json  # Archived prior snapshots
│   ├── SYSTEM-OVERVIEW.md           # Single-document tour
│   ├── ECONOMICS.md
│   ├── SECURITY-AUDIT-2026-05-20.md
│   └── PRE-ALPHA-5-BACKLOG.md
├── web/                             # React + Vite, 82 page TSX files, alpha-5 addressing
├── sdk/                             # Publisher SDK (datum-sdk.js v3.4, ~3 KB)
├── wordpress-plugin/datum-publisher/  # WP plugin wrapping the SDK
├── pine/                            # Pine RPC: smoldot light-client eth JSON-RPC bridge
├── ipfs-node/                       # Local Kubo daemon + auth upload proxy (gitignored runtime)
├── docs/                            # Demo page + relay template
├── relay-bot/                       # Publisher relay (gitignored) — userSig/publisherSig EIP-712
├── relay-bot.example/               # Public reference template
├── archive/                         # PoC, alpha, alpha-2, alpha-3, alpha-4, old extensions, scripts, docs
├── PRIVACY-POLICY.md
├── PRE-MAINNET-CHECKLIST.md
├── PROCESS-FLOW-AUDIT.md
├── STATUS.md                        # This file
├── TOKENOMICS.md
└── README.md
```
