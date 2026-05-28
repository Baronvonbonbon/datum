# DATUM

**Decentralized Ad Targeting Utility Marketplace**

A privacy-preserving ad exchange on Polkadot Hub. Advertisers create DOT-denominated campaigns on-chain; publishers embed a lightweight SDK; users earn DOT and DATUM tokens for verified impressions — settled entirely on-chain with no intermediary, no surveillance, and no personal data leaving the browser.

The active line is **Alpha-5 v5** (53 production contracts + 5-contract DATUM token plane) — a clean checkpoint rename of alpha-4 v0.5.0. EVM-only (solc 0.8.24, `evmVersion: cancun`, viaIR, optimizer 200 runs) executed on Polkadot Hub via pallet-revive's EVM compatibility path. Deployed to Paseo Hub on 2026-05-23.

---

## Roles and Revenue

### Advertisers

Deposit DOT into escrow when creating a campaign. Define a bid CPM, daily cap, targeting tags (bytes32 hashes), an `AssuranceLevel` (L0–L2), optionally an ERC-20 side-reward, and optionally a publisher allowlist (or `address(0)` for open campaigns).

- **Spend:** Escrow deducted per verified impression at the clearing CPM.
- **Reclaim:** Unspent escrow returned via `DatumCampaignLifecycle.completeCampaign()`.
- **ERC-20 side-reward:** Pair any campaign with a token reward. Seed `DatumTokenRewardVault`; settlement credits it non-critically alongside DOT.
- **Stake gate:** Advertisers maintain a stake in `DatumAdvertiserStake` (bonding curve mirror of publisher stake), slashable via `DatumAdvertiserGovernance`.
- **Challenge bond:** A bond locked at campaign creation, returned on clean completion; bonus distribution to the bond pool if publisher fraud is upheld.
- **Activation bond:** Optimistic-activation pathway via `DatumActivationBonds` — creator bonds + permissionless challenge + commit-reveal vote escalation.
- **Dual-sig settlement:** Co-sign claim batches with a publisher via EIP-712; anyone can submit on-chain (see *Settlement Pipeline*).

### Publishers

Register on-chain, set their take rate (30–80%), configure targeting tags, and embed the SDK (or WordPress plugin). A relay signer EOA co-signs attestations so users settle at zero gas cost.

- **Take rate:** A snapshot-locked share of every clearing payment flows to the publisher's `DatumPaymentVault` balance. Frozen at campaign creation — mid-campaign changes don't affect live campaigns.
- **Stake requirement:** Publishers maintain a DOT stake in `DatumPublisherStake` (`base + cumulativeImpressions × perImp`). Settlement rejects under-staked publishers.
- **Withdrawal:** `PaymentVault.withdrawPublisher()`; `withdrawTo(recipient)` for cold-wallet sweeps; time-locked recovery address available.
- **Three relay modes:** publisher-direct, dual-sig, bonded `DatumRelay` — pick via SDK `data-relay-mode` attribute.

### Users

Browse with the DATUM Chrome extension. It detects publisher SDK embeds, classifies pages against campaign tags, runs a Vickrey second-price auction, and builds Blake2-256 hash-chain claims entirely on-device. No browsing data leaves the browser.

- **DOT earnings:** After the publisher take rate, 75% of the remainder goes to the user and 25% to the protocol.
- **DATUM token earnings:** Per-claim emission via `DatumMintCoordinator` → `DatumEmissionEngine` → `DatumMintAuthority`. Bootstrap grant of WDATUM on first claim via `DatumBootstrapPool`. Stake WDATUM in `DatumFeeShare` to earn DOT yield from protocol-fee sweeps.
- **ERC-20 side-reward:** Users earn `eventCount × rewardPerImpression` of the campaign token per settlement, claimed via `TokenRewardVault.withdraw(token)`.
- **Self-sovereignty:** On-chain `userPaused`, `userBlocksPublisher`, `userBlocksAdvertiser`, and `userMinAssurance` (L0–L3) controls; time-locked recovery address on the vault.
- **Privacy:** Optional ZK identity commitment (`DatumIdentityVerifier`), optional interest commitment (`DatumInterestCommitments`) — only Merkle roots / Poseidon hashes published on-chain; pre-images stay in the browser.
- **Zero-gas path:** Co-sign claims with the publisher relay; the relay submits on-chain and pays gas.

### Governance Voters

Any DOT holder can review pending campaigns. Stake DOT with a conviction multiplier (0–8, nine levels; 1× to 21× weight; 0-day to 365-day lockup). Three governance phases share a stable address via `DatumGovernanceRouter`.

- **Slash rewards:** The losing side forfeits 10% of stake, redistributed to winners.
- **Commit-reveal:** Contested optimistic-activation votes use commit-reveal to prevent last-minute swing.
- **Parameter governance:** `DatumParameterGovernance` runs conviction voting on 20 governable parameters across 7 contracts with `ParameterRetuneGuard` cooldowns.

### Fraud Tracks

Symmetric publisher / advertiser dispute primitives:

- `DatumPublisherGovernance` — conviction-vote fraud proposals targeting publishers. Slash → `DatumPublisherStake` → bond bonus to `DatumChallengeBonds`.
- `DatumAdvertiserGovernance` — conviction-vote + Council-arbitrated proposals targeting advertisers. Includes `filePublisherFraudClaim` (G-3 mirror) so publishers can initiate disputes.
- `DatumRelayGovernance` — conviction-vote fraud proposals against bonded relays (censorship / front-run / MEV / collusion); slash → `DatumRelayStake`.

### Reporters

`DatumStakeRoot` (V1) and `DatumStakeRootV2` (fraud-proof) commit off-chain Merkle roots over `(commitment, stake)` leaves. V2 bonded reporters are slashable on phantom-leaf or balance-fraud challenges. `markInactive` permits permissionless eviction of silent reporters.

### Protocol Treasury

25% of the advertiser-net on every settlement accumulates in `DatumPaymentVault`. Protocol-fee sweeps fund `DatumFeeShare` to reward WDATUM stakers. Admin actions route through a 48-hour `DatumTimelock`.

---

## Governance Ladder

Three-phase governance with a stable-address router:

| Phase | Active Governor | Mechanism | Delay |
|-------|----------------|-----------|-------|
| 0 (current) | Deployer EOA / Safe | Direct approval | None (or ~1h) |
| 1 | `DatumCouncil` | N-of-M trusted council vote | ~24h propose/vote/veto |
| 2+ | `DatumGovernanceV2` + `DatumParameterGovernance` | Conviction-weighted voting | ~7-day cycles |

`DatumGovernanceRouter` holds the stable address. Phase transitions require `router.setGovernor()` from the current governor and are gated by phase-floor monotonicity. Bicameral veto window (CB5): Council retains a veto window after OpenGov promotion.

The router also acts as a contract registry: `currentAddrOf[name]` + `addressHistory[name]` + `versionOf[name]`. ~36 contracts inherit `DatumUpgradable` and are swappable via `router.upgradeContract(name, v2)`. Lock-once `lock*()` functions revert pre-OpenGov; post-OpenGov they ratify cypherpunk commitments piecemeal.

---

## Settlement Pipeline

DATUM exposes **three settlement entry points** that all converge on `_processBatch` inside `DatumSettlementLogicB`:

```
                ┌──────────────────────────────────────────────────────┐
[User Extension]│  Blake2-256 hash-chain claim                          │
                │  (campaignId, publisher, user, eventCount,           │
                │   ratePlanck, actionType, nonce, prevHash,           │
                │   PoW solution, optional ZK proof + nullifier)        │
                └──────────────────────────────────────────────────────┘
                          │
       ┌──────────────────┼─────────────────────┬──────────────────────┐
       ▼                  ▼                     ▼                      ▼
[Settlement         [Relay.settleClaimsFor  [AttestationVerifier.  [DatumDualSigSettlement
  .settleClaims]      (userSig + opt.          settleClaimsAttested]  .settleSignedClaims]
  user / EOA / pub    publisherSig)           publisher EIP-712      publisher + advertiser
  relaySigner        userSig EIP-712 +        co-sig only            EIP-712 dual cosig over
                     optional pub co-sig;     (L1)                   ClaimBatch(user,
                     bonded relays via                              campaignId, claimsHash,
                     RelayStake/Gov           ↓                     deadline, expectedRelaySigner,
                                                                    expectedAdvertiserRelaySigner)
                                                                    (L2 — only path)
                          │
                          ▼
                  [DatumSettlementLogicA — relay-path auth]
                          │
                          ▼ (DELEGATECALL, shared storage)
                  [DatumSettlementLogicB._processBatch]
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   [User gates]     [Assurance gate]    [ClaimValidator]
   userPaused        AssuranceLevel       chain continuity
   userBlocks*       per-campaign +       nonce / PoW / ZK
   userMinAssurance  user floor (L0–L3)   attestation
                                          ↓
                          [Satellite checks]
                            ├─ DatumPowEngine (leaky-bucket PoW)
                            ├─ DatumNullifierRegistry (ZK replay)
                            ├─ DatumSettlementRateLimiter
                            ├─ DatumPublisherStake / AdvertiserStake
                            └─ DatumActivationBonds.isMuted
                          │
                          ▼
                  [DatumBudgetLedger.debit] → DOT escrow
                          │
                          ▼
                  [DatumPaymentVault.credit]
                    ├─ publisher += takeRate%
                    ├─ user     += 75% of remainder
                    └─ protocol += 25% of remainder  → DatumFeeShare sweep
                          │
                          ▼ (non-critical)
                  [DatumTokenRewardVault.credit] — ERC-20 side-reward
                          │
                          ▼
                  [DatumMintCoordinator → DatumEmissionEngine →
                   DatumMintAuthority]  — DATUM token emission
                          │
                          ▼
                  [DatumPublisherReputation.record] — accept/reject counters
                          │
                          ▼
                  [Relay parses ClaimSettled / ClaimRejected events]
```

**AssuranceLevel gradient:**
- **L0** — open; user signature only
- **L1** — relay-mediated; sig + liveness check via `DatumRelay`
- **L2** — dual-sig path required (publisher + advertiser cosig)
- **L3** — ZK-only floor (users may demand via `userMinAssurance`)

Either side in the dual-sig path can refute by withholding their signature.

`settleClaimsMulti(UserClaimBatch[])` batches multiple users × campaigns per transaction.

---

## Architecture

### Smart Contracts — `alpha-5/contracts/`

**53 production contracts** + 5-contract token plane (`contracts/token/`). Compiled to EVM bytecode with solc 0.8.24 (evmVersion `cancun`, viaIR, optimizer 200 runs). Executed on Paseo Hub via pallet-revive. **1579/1579 tests passing.**

Highlights:

| Group | Contracts |
|-------|-----------|
| **Settlement core** | `DatumSettlement`, `DatumSettlementStorage`, `DatumSettlementLogicA`, `DatumSettlementLogicB` |
| **Settlement satellites** | `DatumDualSigSettlement`, `DatumClaimValidator`, `DatumPowEngine`, `DatumNullifierRegistry`, `DatumSettlementRateLimiter`, `DatumPublisherReputation`, `DatumMintCoordinator`, `DatumEmissionEngine` |
| **Campaign** | `DatumCampaigns`, `DatumCampaignAllowlist`, `DatumCampaignCreative`, `DatumCampaignLifecycle`, `DatumReports` |
| **Payments** | `DatumBudgetLedger`, `DatumPaymentVault` (with recovery address), `DatumTokenRewardVault` |
| **Tag policy** | `DatumTagSystem`, `DatumTagRegistry`, `DatumTagCurator` |
| **Publisher** | `DatumPublishers`, `DatumPublisherStake`, `DatumPublisherGovernance` |
| **Advertiser** | `DatumAdvertiserStake`, `DatumAdvertiserGovernance`, `DatumChallengeBonds` |
| **Governance** | `DatumGovernanceRouter`, `DatumGovernanceV2`, `DatumParameterGovernance`, `DatumCouncil`, `DatumCouncilBlocklistCurator`, `DatumTimelock`, `DatumActivationBonds` |
| **Relay accountability** | `DatumRelay`, `DatumRelayStake`, `DatumRelayGovernance` |
| **Identity** | `DatumIdentityVerifier`, `DatumPeopleChainIdentity`, `DatumPeopleChainXcmBridge`, `DatumBondedIdentityReporter`, `DatumInterestCommitments` |
| **Stake-roots** | `DatumStakeRoot`, `DatumStakeRootV2`, `DatumZKStake` |
| **Verifiers / attestation** | `DatumZKVerifier`, `DatumAttestationVerifier`, `DatumClickRegistry` |
| **Infrastructure** | `DatumPauseRegistry`, `DatumUpgradable`, `DatumOwnable`, `PaseoSafeSender` |
| **Token plane** | `DatumMintAuthority` (95M cap), `DatumWrapper` (WDATUM), `DatumBootstrapPool`, `DatumFeeShare`, `DatumVesting` |

**EIP-170 two-Logic split** (2026-05-19): Settlement was 9.8 KB over the 24,576 B cap. Closed via `DatumSettlement` (thin shell) + `DatumSettlementStorage` (layout) + `DatumSettlementLogicA` (relay path) + `DatumSettlementLogicB` (`_processBatch`). All three contracts share an identical storage layout asserted by `test/settlement-layout.test.ts` against `settlement-layout.snapshot.json`.

See `alpha-5/SYSTEM-OVERVIEW.md` for the single-document tour and `alpha-5/narrative-analysis/` for per-contract narratives.

### Browser Extension — `alpha-5/extension/`

v0.2.0, alpha-5 contract support. Manifest V3, Chrome/Chromium. 4-tab popup: Claims, Earnings, Settings, Filters. **212+ Jest tests.** ABIs synced.

Key capabilities: Blake2-256 claim hashing, Vickrey second-price auction (interest-weighted), per-format creative image selection from IPFS metadata, all three settlement paths (`publisher` / `dualsig` / `datumrelay`) propagated from SDK, tag-based filtering, IAB format-aware ad injection (7 standard sizes), Shadow DOM isolation, AES-256-GCM multi-account wallet, auto-submit, claim export, ZK proof generation (impression + identity circuits), interest-commitment leaf management.

### Web App — `web/`

React 18 + Vite 6 + TypeScript + ethers v6. **82 page TSX files.** Alpha-5 contract addressing throughout.

| Section | Pages |
|---------|-------|
| Explorer | Overview, HowItWorks, Philosophy, Campaigns, CampaignDetail, Publishers, PublisherProfile, AdvertiserProfile |
| Advertiser | Dashboard, Profile, CreateCampaign, CampaignDetail, SetMetadata, Analytics |
| Publisher | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile, Stake |
| Governance | Dashboard, Vote, MyVotes, Parameters, ProtocolParams, PublisherFraud, AdvertiserFraud, RelayFraud |
| Admin | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation, *Stake, *Governance, ChallengeBonds, NullifierRegistry, ParameterGovernance |
| Identity | Dashboard, PeopleChain, Zk |
| Token | Dashboard, Wrapper, FeeShare, Bootstrap, Vesting, MintCoordinator |
| Protocol | Dashboard, TagCurator, BrandCurator, Upgrades |
| Me | Dashboard, History, Assurance, Branding, Dust, Identity |
| Root | Demo, Settings |

### Publisher SDK — `sdk/`

`datum-sdk.js` v3.4 (~3 KB). Declare slot format via `data-slot` (7 IAB sizes). Challenge-response HMAC handshake with the extension. Alpha-5 additions:

- Bulletin Chain creative loader (`${relay}/bulletin/<cid>`)
- Click reporter (`datum:click` → POST `${relay}/click` → `DatumClickRegistry`; **no user wallet address sent**)
- `data-relay-mode` propagation (`publisher` | `dualsig` | `datumrelay`)
- Publisher telemetry on `window.DATUM.metrics`
- No-extension fallback: inline DATUM house ads sized to the slot

```html
<script src="datum-sdk.js"
  data-publisher="0xYOUR_ADDRESS"
  data-relay="https://relay.example.com"
  data-relay-mode="publisher"
  data-slot="leaderboard"
  data-tags="topic:crypto-web3,locale:en">
</script>
<div data-datum-slot="leaderboard"></div>
```

### WordPress Plugin — `wordpress-plugin/datum-publisher/`

PHP plugin wrapping the SDK. Shortcode, Gutenberg block, and sidebar widget placement. Stores publisher configuration in WP options. Inherits all SDK privacy properties (zero cookies, no third-party tracking).

### Pine RPC — `pine/`

smoldot light-client bridge. Translates Ethereum JSON-RPC into Substrate `ReviveApi_*` and `chainHead_v1_*` calls for Polkadot Asset Hub — no centralized RPC proxy for read operations or tx broadcast. Fixes the Paseo null-receipt bug via session-scoped TxPool. See `pine/CAPABILITIES.md` for the method support matrix.

### IPFS Node — `ipfs-node/`

Local Kubo IPFS daemon (1 GB cap, localhost-only API + gateway) fronted by Cloudflare Tunnel at `ipfs.datum.javcon.io`. Authenticated upload proxy with Bearer-token auth on port 5050.

### Publisher Relay — `relay-bot/` (gitignored; reference at `relay-bot.example/`)

HTTP challenge/submit endpoints, EIP-712 co-signature, Blake2-256, SHA-256 PoW anti-spam. Forwards via `DatumRelay.settleClaimsFor` using the `userSig + publisherSig` envelope. After each batch: parses `ClaimSettled` / `ClaimRejected` events and records reputation. Click endpoint (`POST /click`) batches to `DatumClickRegistry`. Bulletin endpoint (`GET /bulletin/<cid>`) serves creative.

---

## Walkthrough — Alice, Bob, Carol, Dave

**Alice** is a user. **Bob** runs a tech blog (publisher). **Carol** sells hardware wallets (advertiser). **Dave** reviews campaigns (governance voter).

### Bob registers and embeds the SDK

Bob registers on `DatumPublishers`, sets his take rate to 40%, configures a relay signer, stakes DOT in `DatumPublisherStake`, and sets targeting tags (`keccak256("topic:technology")`). He embeds the SDK with a leaderboard slot and `data-relay-mode="publisher"`.

### Carol creates a campaign with token side-reward and creative images

Carol stakes DOT in `DatumAdvertiserStake`, then creates a campaign: 10 DOT escrow, 1 DOT daily cap, 0.05 DOT/1000 CPM, required tag `topic:technology`, AssuranceLevel L1, optional ERC-20 side-reward, optional `ChallengeBonds` deposit. She uploads creative images for each IAB slot size to IPFS (or Bulletin Chain via `DatumCampaignCreative`) and sets metadata via `DatumCampaigns.setMetadata`.

### Activation: optimistic, Council, or OpenGov

- **Optimistic:** Carol opens an `DatumActivationBonds` bond; anyone may challenge during the timeout; uncontested → auto-activate.
- **Council (Phase 1):** Council proposes + executes after `executionDelay`.
- **OpenGov (Phase 2):** Dave and others vote conviction-weighted via `DatumGovernanceV2.commitVote / revealVote`; `evaluateCampaign` activates on quorum.

### Alice browses Bob's site

The extension detects the SDK, reads the slot format, classifies the page as `topic:technology`, wins the Vickrey auction, performs the two-party handshake, selects the leaderboard-format creative from IPFS or Bulletin Chain, and injects the ad at exact IAB dimensions. Claims auto-submit to Bob's relay — Alice pays zero gas. Each claim carries Blake2-256 hash chaining + PoW; ZK campaigns add a Groth16 proof + Poseidon nullifier.

### Settlement splits the payment

At 0.05 DOT/1000 impressions, 40% publisher take, AssuranceLevel L1:

```
Bob       (40%):           0.0200 DOT / 1000 imp  → PaymentVault publisher
Alice     (75% × 60%):     0.0225 DOT / 1000 imp  → PaymentVault user
Protocol  (25% × 60%):     0.0075 DOT / 1000 imp  → PaymentVault protocol → FeeShare
Alice     (DATUM):         (emission via MintCoordinator → MintAuthority)
Alice     (side-reward):   N tokens / 1000 imp    → TokenRewardVault
```

First-time Alice also receives a bootstrap WDATUM grant from `DatumBootstrapPool`.

### Direct deal: Carol and Bob settle dual-sig

When Bob and Carol have an out-of-band agreement (or the campaign is L2), both co-sign a `ClaimBatch` envelope (EIP-712, DatumSettlement domain). Anyone — Bob, Carol, or a third party — submits via `DatumDualSigSettlement.settleSignedClaims`. Either party can refute by withholding their signature.

---

## Getting Started

```bash
# Prerequisites: Node 18+, Chrome

# Contracts (alpha-5)
cd alpha-5
npm install
npx hardhat test                          # 1579 pass

# Extension
cd alpha-5/extension && npm install && npm run build
# Load dist/ as unpacked extension in chrome://extensions

# Web App
cd web && npm install && npm run dev
```

### Paseo Testnet (live — alpha-5 v5, 2026-05-23)

| Resource | Value |
|----------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Chain ID | 420420417 |
| Web App | https://datum.javcon.io |

```bash
cd alpha-5
export DEPLOYER_PRIVATE_KEY="0x..."
npx hardhat run scripts/deploy.ts --network polkadotTestnet
npx hardhat run scripts/deploy-token.ts --network polkadotTestnet      # token plane
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

Contract addresses: `alpha-5/deployed-addresses.json`. Full status, prior snapshots, and archived alpha-3/alpha-4 references: [STATUS.md](STATUS.md).

---

## Why Polkadot Hub

- **Native DOT settlement** — escrow, stakes, and payments in DOT; no bridges or wrapped tokens
- **Shared security** — contracts execute on Polkadot Hub, inheriting relay-chain validator security
- **XCM interoperability** — cross-chain identity (People Chain) and fee routing are native XCM calls
- **Asset Hub tokens** — ERC-20 side-rewards work with any Asset Hub token (precompile address derivation built in)
- **EVM compatibility** — pallet-revive runs EVM bytecode directly; alpha-5 picks the EVM path because dropping resolc's bytecode-size constraint enabled merging satellites and shrinking settlement gas. Alpha-3 (archived) keeps both compile targets for the PVM-vs-EVM benchmark.

The Solidity source is fully portable to standard EVM parachains.

---

## Status

- [x] **Alpha-5 v5 deployment on Paseo Hub** (2026-05-23) — 53 production contracts + 5-contract token plane
- [x] **1579 alpha-5 contract tests** + 212+ extension tests — all passing
- [x] **Settlement EIP-170 two-Logic split** — `DatumSettlement` thin shell + LogicA + LogicB with shared storage
- [x] **Upgrade ladder Stages 1–6** — ~36 contracts inherit `DatumUpgradable`; `whenNotFrozen` + `whenOpenGovPhase` gates
- [x] **Governance ladder** — Admin (Phase 0) + Council (Phase 1) + OpenGov (Phase 2) via `DatumGovernanceRouter`
- [x] **Hybrid dual-sig settlement** — `DatumDualSigSettlement.settleSignedClaims` (L2)
- [x] **AssuranceLevel L0–L3 gradient** + `userMinAssurance` floor + user blocklist/pause/recovery
- [x] **Three relay modes** — publisher-direct, dual-sig, bonded (`DatumRelayStake` + `DatumRelayGovernance`)
- [x] **Symmetric fraud tracks** — publisher / advertiser / relay governance + Council-arbitrated claim filing
- [x] **Real Groth16 ZK verifiers** — impression circuit (BN254, 7 public inputs) + identity circuit (single input)
- [x] **People Chain identity XCM bridge** (Phase B oracle posture) + Bonded Identity Reporter
- [x] **Interest commitments + tag curator** — opt-in ZK targeting; Council-curated tag lane
- [x] **DATUM token plane** — MintAuthority, WDATUM, BootstrapPool, FeeShare, Vesting
- [x] **G-1/G-3/G-4/G-6/G-7/G-8/G-10 gap closures** — relay accountability, advertiser fraud track, reporter eviction, bonded appeal, ZK-only floor, recovery address, retune-guard
- [x] **IAB ad format system** — 7 sizes, per-format creative images, format-aware injection
- [x] **Pine RPC smoldot light client**
- [x] **Self-hosted IPFS node + upload proxy**
- [x] **WordPress plugin**
- [ ] **MPC ceremonies** for impression + identity ZK circuits
- [ ] **External security audit** (re-audit obligation after upgrade-ladder retrofit)
- [ ] **Production shim replacements** — Wrapper XCM path, AssetHubPrecompile, PeopleChain bridge EOA
- [ ] **E2E browser validation** on Paseo against alpha-5 v5 addresses
- [ ] **Mainnet** — Kusama → Polkadot Hub

See [STATUS.md](STATUS.md) for detailed component status, test totals, and deployed addresses.

---

## Privacy

DATUM is designed local-first: browsing data, ZK secrets, and wallet keys never leave your device. Only the data you explicitly authorize (claim batches → relay; commitments → on-chain) is transmitted. See [PRIVACY-POLICY.md](PRIVACY-POLICY.md) v2.0 for the full data-flow disclosure across all surfaces.

---

## License

GPL-3.0-or-later
