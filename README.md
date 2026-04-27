# DATUM

**Decentralized Ad Targeting Utility Marketplace**

A privacy-preserving ad exchange on Polkadot Hub (PolkaVM). Advertisers create DOT-denominated campaigns on-chain; publishers embed a lightweight SDK; users earn DOT and optional ERC-20 sidecar tokens for verified impressions — settled entirely on-chain with no intermediary, no surveillance, and no personal data leaving the browser.

---

## Roles and Revenue

### Advertisers

Deposit DOT into escrow when creating a campaign. Define a bid CPM, daily cap, targeting tags (bytes32 hashes), and optionally a specific publisher or `address(0)` for open campaigns served by any matching publisher.

- **Spend:** Escrow deducted per verified impression at the clearing CPM.
- **Reclaim:** Unspent escrow returned via `CampaignLifecycle.completeCampaign()`.
- **ERC-20 sidecar:** Pair any campaign with a token reward (`rewardToken` + `rewardPerImpression`). Seed `DatumTokenRewardVault` with tokens; settlement credits them non-critically on every impression alongside DOT.
- **Challenge bond:** A bond is locked at campaign creation and returned on clean completion, or distributes a bonus to the bond pool if publisher fraud is upheld via `DatumPublisherGovernance`.

### Publishers

Register on-chain, set their take rate (30–80%), configure targeting tags, and embed the SDK. A relay signer EOA co-signs attestations so users settle at zero gas cost.

- **Take rate:** A snapshot-locked share of every clearing payment flows to the publisher's `DatumPaymentVault` balance. The rate is frozen at campaign creation — mid-campaign changes don't affect live campaigns.
- **Stake requirement:** Publishers must maintain a DOT stake in `DatumPublisherStake` (`base + cumulativeImpressions × perImp`). Settlement rejects under-staked publishers (error code 15).
- **Withdrawal:** `PaymentVault.withdrawPublisher()` at any time; `withdrawTo(recipient)` for cold-wallet sweeps.

### Users

Browse with the DATUM Chrome extension. It detects publisher SDK embeds, classifies pages against campaign tags, runs a Vickrey second-price auction, and builds Blake2-256 hash-chain claims entirely on-device. No browsing data leaves the browser.

- **DOT earnings:** After the publisher take rate, 75% of the remainder goes to the user and 25% to the protocol. At a 40% publisher take and 0.05 DOT/1000 CPM, a user earns 0.0225 DOT per 1000 verified impressions.
- **ERC-20 sidecar:** Users earn `impressionCount × rewardPerImpression` of the campaign token per settlement, claimed via `TokenRewardVault.withdraw(token)`.
- **Zero-gas path:** Co-sign claims with the publisher relay; the relay submits on-chain and pays gas.
- **Self-submit path:** `Settlement.settleClaims()` — user pays gas directly.

### Governance Voters

Any DOT holder can review pending campaigns. Stake DOT with a conviction multiplier (0–8, nine levels; 0× to 21× weight; 0-day to 365-day lockup).

- **Slash rewards:** The losing side (nay voters on activated campaigns, aye on terminated ones) forfeits 10% of stake, redistributed to winners via `DatumGovernanceSlash`.
- **Stake return:** Winners recover 100% after lockup; losers recover 90%.

### Publisher Fraud Governance

`DatumPublisherGovernance` runs a separate conviction-vote process targeting publishers. Fraud upheld → `DatumPublisherStake` slashes the publisher → bond bonus distributed to `DatumChallengeBonds` pool.

### Protocol Treasury

25% of the advertiser-net on every settlement accumulates in `DatumPaymentVault`. Unclaimed slash pools are swept after 365 days. Admin actions route through a 48-hour `DatumTimelock`.

---

## Governance Ladder

Three-phase governance with a stable-address router:

| Phase | Contract | Mechanism |
|-------|----------|-----------|
| 0 (current) | `DatumAdminGovernance` | Team direct approval — activate campaigns, set parameters |
| 1 | `DatumCouncil` | N-of-M trusted council vote |
| 2+ | `DatumGovernanceV2` | Full conviction-weighted on-chain vote |

`DatumGovernanceRouter` holds the stable address. Phase transitions require a 48h timelocked `router.setGovernor()` call. GovernanceV2 conviction voting is live for campaign evaluation; Phase 0 activation uses AdminGovernance.

---

## Settlement Pipeline

```
[User Extension]
  Blake2-256 hash-chain claim (campaignId, publisher, user, impressions, CPM, nonce, prevHash)
      ↓
[AttestationVerifier.settleClaimsAttested(batch, publisherSig)]  ← relay path (zero gas for user)
      or
[Settlement.settleClaims(batch)]                                  ← direct path
      ↓
[DatumClaimValidator]
  ├─ chain continuity (nonces, prevHash)
  ├─ campaign active + publisher match
  ├─ clearing CPM ≤ bid CPM
  ├─ impression count ≤ 100,000
  ├─ S12 blocklist check (Publishers staticcall)
  ├─ BM-2 per-user impression cap
  ├─ BM-5 rate limiter (SettlementRateLimiter staticcall)
  ├─ BM-7 advertiser allowlist
  ├─ FP-1 publisher stake check (PublisherStake staticcall)
  └─ ZK nullifier check if requireZkProof=true (real Groth16/BN254)
      ↓
[DatumBudgetLedger.deductSettlement(campaignId, amount)]
  ├─ daily cap check
  └─ deduct from escrow
      ↓
[DatumPaymentVault.credit(publisher, user, protocol)]
  ├─ publisher += takeRate%
  ├─ user     += 75% of remainder
  └─ protocol += 25% of remainder
      ↓ (non-critical — does not block DOT settlement)
[DatumTokenRewardVault.creditReward(campaignId, token, user, amount)]
  └─ user token balance += impressions × rewardPerImpression
      ↓
[Publisher relay: parse ClaimSettled / ClaimRejected events]
[DatumPublisherReputation.recordSettlement(publisher, campaignId, settled, rejected)]
```

`settleClaimsMulti(UserClaimBatch[])` batches up to 10 users × 10 campaigns per transaction.

---

## Architecture

### Smart Contracts — 29 deployed, Solidity on PolkaVM

| Group | Contract | Role |
|-------|----------|------|
| Infrastructure | `DatumPauseRegistry` | Global emergency pause |
| Infrastructure | `DatumTimelock` | 48h admin delay for sensitive config |
| Infrastructure | `DatumZKVerifier` | Groth16/BN254 verifier; verifying key set post-deploy |
| Infrastructure | `DatumPaymentVault` | Pull-payment: publisher/user/protocol DOT balances |
| Infrastructure | `DatumTokenRewardVault` | Pull-payment: ERC-20 sidecar token rewards, per-campaign budgets |
| Infrastructure | `DatumGovernanceRouter` | Stable-address proxy for governance phase transitions |
| Campaign | `DatumBudgetLedger` | Campaign escrow + daily caps |
| Campaign | `DatumTargetingRegistry` | bytes32 tag registry (AND-logic, 32 tags/publisher, 8/campaign) |
| Campaign | `DatumCampaignValidator` | Creation-time validation: registration, tags, take rate |
| Campaign | `DatumCampaigns` | Campaign creation, metadata, status, relay signer/tag snapshots, token reward config |
| Campaign | `DatumCampaignLifecycle` | complete / terminate / expire + P20 30-day inactivity timeout |
| Settlement | `DatumClaimValidator` | Chain continuity, budget, blocklist, rate-limit, stake, ZK proof |
| Settlement | `DatumSettlement` | Main entry: hash-chain, 3-way DOT split, non-critical token credit, multi-user batching |
| Settlement | `DatumSettlementRateLimiter` | BM-5: window-based per-publisher impression cap |
| Settlement | `DatumAttestationVerifier` | P1: mandatory EIP-712 publisher co-signature |
| Publisher | `DatumPublishers` | Registration, take rates, relay signer, profile, S12 blocklist, allowlists |
| Publisher | `DatumRelay` | EIP-712 gasless relay: publisher submits batches for users |
| Publisher | `DatumPublisherReputation` | BM-8 settlement acceptance rate + BM-9 cross-campaign anomaly detection |
| Governance | `DatumAdminGovernance` | Phase 0: team direct approval (current active governor) |
| Governance | `DatumCouncil` | Phase 1: N-of-M trusted council voting |
| Governance | `DatumGovernanceV2` | Phase 2+: conviction voting (9 levels, 0–8), symmetric slash |
| Governance | `DatumGovernanceHelper` | Slash computation, dust guard, read helpers |
| Governance | `DatumGovernanceSlash` | Per-campaign slash pool finalization, winner rewards, 365d sweep |
| Fraud Prevention | `DatumPublisherStake` | FP-1+FP-4: publisher DOT bonding curve; settlement enforces (code 15) |
| Fraud Prevention | `DatumChallengeBonds` | FP-2: advertiser bonds at creation; bonus on fraud upheld |
| Fraud Prevention | `DatumPublisherGovernance` | FP-3: conviction-weighted fraud governance targeting publishers |
| Fraud Prevention | `DatumNullifierRegistry` | FP-5: per-user per-campaign ZK nullifier replay prevention |
| Fraud Prevention | `DatumParameterGovernance` | FP-15: conviction-vote DAO for protocol parameters |
| Satellite | `DatumReports` | Community reporting: `reportPage()` / `reportAd()`, reasons 1–5 |

Compiled to PolkaVM (RISC-V) via resolc v1.0.0, optimizer mode `z`. **539/539 Hardhat EVM tests passing.** All 29 deployed on Paseo v7 (2026-04-26).

### Browser Extension — `alpha-3/extension/`

Manifest V3, Chrome/Chromium. 4-tab popup: Claims, Earnings, Settings, Filters. **222/222 Jest tests passing.** 30 ABIs synced.

Key capabilities: Blake2-256 claim hashing (matches PolkaVM Settlement), Vickrey second-price auction (interest-weighted), P1 two-party attestation (challenge-response + EIP-712 co-signature), tag-based campaign filtering, IAB format-aware ad injection (7 standard sizes), Shadow DOM isolation, per-format creative image selection from IPFS metadata, AES-256-GCM multi-account embedded wallet, auto-submit, claim export, engagement tracking, phishing list, content safety pipeline.

### Web App — `web/`

React 18 + Vite 6 + TypeScript + ethers v6. **41 pages across 6 sections.** 29-contract support. 0 TS errors.

| Section | Pages |
|---------|-------|
| Explorer (8) | Overview, HowItWorks, Philosophy, Campaigns, CampaignDetail, Publishers, PublisherProfile, AdvertiserProfile |
| Advertiser (5) | Dashboard, CreateCampaign, CampaignDetail, SetMetadata, Analytics |
| Publisher (9) | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile, Stake |
| Governance (6) | Dashboard, Vote, MyVotes, Parameters, ProtocolParams, PublisherFraud |
| Admin (11) | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation, PublisherStake, PublisherGovernance, ChallengeBonds, NullifierRegistry, ParameterGovernance |
| Root (2) | Demo, Settings |

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). Declare slot format via `data-slot` attribute (7 IAB sizes: leaderboard 728×90, medium-rectangle 300×250, wide-skyscraper 160×600, half-page 300×600, mobile-banner 320×50, square 250×250, large-rectangle 336×280). Challenge-response HMAC handshake with the extension for two-party attestation.

```html
<script src="datum-sdk.js"
  data-publisher="0xYOUR_ADDRESS"
  data-relay="https://relay.example.com"
  data-slot="leaderboard"
  data-tags="topic:crypto-web3,locale:en">
</script>
<div id="datum-ad-slot"></div>
```

### Pine RPC — `pine/`

smoldot light-client bridge. Translates Ethereum JSON-RPC into Substrate `ReviveApi_*` and `chainHead_v1_*` calls for Polkadot Asset Hub — no centralized RPC proxy for read operations or tx broadcast. Fixes the Paseo null-receipt bug via session-scoped TxPool.

### Publisher Relay — `relay-bot/` (gitignored)

Reference relay: HTTP challenge/submit endpoints, EIP-712 co-signature, Blake2-256, SHA-256 PoW anti-spam (BM-3). After each batch: parses `ClaimSettled`/`ClaimRejected` events and calls `DatumPublisherReputation.recordSettlement()` per `(publisher, campaignId)` pair.

---

## Walkthrough — Alice, Bob, Carol, Dave

**Alice** is a user. **Bob** runs a tech blog (publisher). **Carol** sells hardware wallets (advertiser). **Dave** reviews campaigns (governance voter).

### Bob registers and embeds the SDK

Bob registers on `DatumPublishers`, sets his take rate to 40%, configures a relay signer, stakes DOT in `DatumPublisherStake`, and sets targeting tags (`keccak256("topic:technology")`). He embeds the SDK with a leaderboard slot:

```html
<script src="datum-sdk.js" data-publisher="0xBob..." data-slot="leaderboard" data-tags="topic:technology"></script>
<div id="datum-ad-slot"></div>
```

### Carol creates a campaign with token sidecar and creative images

Carol creates a campaign: 10 DOT escrow, 1 DOT daily cap, 0.05 DOT/1000 CPM, required tag `topic:technology`. She adds a token sidecar (`rewardToken = 0xCarolToken`, `rewardPerImpression = 1e18`) and pre-seeds the vault:

```
ERC20(carolToken).approve(tokenRewardVault, 100_000e18)
tokenRewardVault.depositCampaignBudget(campaignId, carolToken, 100_000e18)
```

She uploads creative images for each IAB slot size to IPFS and sets metadata via `DatumCampaigns.setMetadata(campaignId, bytes32CID)`. The IPFS JSON includes `creative.images[]` with per-format URLs — the on-chain CID hash makes the full creative payload verifiable for governance and fraud detection.

### Dave votes to activate

Dave votes Aye with 0.5 DOT at conviction 2 (3× weight, 3-day lockup → 1.5 DOT effective). Once weighted aye votes cross quorum, anyone calls `evaluateCampaign()` (or AdminGovernance activates directly in Phase 0).

### Alice browses Bob's site

The extension detects the SDK, reads `data-slot="leaderboard"`, classifies the page as `topic:technology`, wins the auction, performs the two-party handshake, selects the leaderboard-format creative image from IPFS metadata, and injects the ad into `datum-ad-slot` with exact IAB dimensions (728×90). Claims auto-submit to the relay — Alice pays zero gas.

### Settlement splits the payment

At 0.05 DOT/1000 impressions, 40% publisher take:

```
Bob   (40%):            0.0200 DOT / 1000 imp  → PaymentVault publisher
Alice (75% × 60%):      0.0225 DOT / 1000 imp  → PaymentVault user
Protocol (25% × 60%):   0.0075 DOT / 1000 imp  → PaymentVault protocol
Alice (token):          1000 carolTokens        → TokenRewardVault user
```

---

## Getting Started

```bash
# Prerequisites: Node 18+, Chrome

# Contracts
cd alpha-3
npm install
npx hardhat test                          # 539 pass

# Extension
cd alpha-3/extension && npm install && npm run build
# Load dist/ as unpacked extension in chrome://extensions

# Web App
cd web && npm install && npm run dev
```

### Paseo Testnet (live — v7, 2026-04-26)

| Resource | Value |
|----------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Web App | https://datum.javcon.io |

```bash
cd alpha-3
export DEPLOYER_PRIVATE_KEY="0x..."
npx hardhat run scripts/deploy.ts --network polkadotTestnet
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

Contract addresses: `alpha-3/deployed-addresses.json`. Full status: `STATUS.md`.

---

## Why PolkaVM

- **Native DOT settlement** — escrow, stakes, and payments in DOT; no bridges or wrapped tokens
- **Shared security** — contracts execute on Polkadot Hub, inheriting relay chain validator security
- **XCM interoperability** — cross-chain fee routing and governance tooling are native XCM calls
- **Asset Hub tokens** — ERC-20 sidecar rewards work with any Asset Hub token (precompile address derivation built in)

The Solidity source is portable — EVM parachain deployment requires no contract changes.

---

## Status

- [x] **29 contracts** — all deployed on Paseo v7 (2026-04-26), including governance ladder and full FP suite
- [x] **539 contract tests** + **222 extension tests** — all passing
- [x] **Governance ladder** — AdminGovernance (Phase 0) + GovernanceRouter (stable proxy) + Council (Phase 1) live
- [x] **Real Groth16 ZK verifier** — BN254 ecPairing, verifying key set, 2-public-input circuit
- [x] **Fraud prevention (FP-1–FP-5, FP-15)** — publisher stake, challenge bonds, fraud governance, ZK nullifiers, parameter DAO
- [x] **ERC-20 token reward vault** — per-campaign sidecar token rewards, pull-payment
- [x] **IAB ad format system** — 7 standard sizes, per-format creative images in IPFS metadata, format-aware ad injection
- [x] **Publisher reputation** — BM-8/BM-9, relay bot wired, anomaly detection
- [x] **Security audit (internal)** — all 30 items implemented
- [x] **Pine RPC** — smoldot light-client bridge, eliminates centralized RPC dependency
- [ ] **E2E browser validation** — full flow on Paseo with live extension + relay + web app
- [ ] **External security audit**
- [ ] **Mainnet** — Kusama → Polkadot Hub

See [STATUS.md](STATUS.md) for detailed component status and deployed addresses.

---

## License

GPL-3.0-or-later
