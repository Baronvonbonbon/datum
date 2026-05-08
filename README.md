# DATUM

**Decentralized Ad Targeting Utility Marketplace**

A privacy-preserving ad exchange on Polkadot Hub. Advertisers create DOT-denominated campaigns on-chain; publishers embed a lightweight SDK; users earn DOT and optional ERC-20 sidecar tokens for verified impressions — settled entirely on-chain with no intermediary, no surveillance, and no personal data leaving the browser.

The active line is **Alpha-4** (v0.4.0, 21 production contracts) — an **EVM-only** refactor of the alpha-3 layout. Compiled with stock solc (evmVersion `cancun`) and deployed to Paseo Hub on 2026-05-06 via pallet-revive's EVM execution path. Dropping the PVM resolc bytecode-size constraint let nine alpha-3 satellites fold into their parents (29 → 21 contracts), eliminating cross-contract staticcalls in the settlement hot path. The alpha-3 line stays in-tree as the canonical 29-contract reference, dual-targeted at PVM (resolc 1.1.0) and EVM (solc) for cost benchmarking.

---

## Roles and Revenue

### Advertisers

Deposit DOT into escrow when creating a campaign. Define a bid CPM, daily cap, targeting tags (bytes32 hashes), and optionally a specific publisher or `address(0)` for open campaigns served by any matching publisher.

- **Spend:** Escrow deducted per verified impression at the clearing CPM.
- **Reclaim:** Unspent escrow returned via `CampaignLifecycle.completeCampaign()`.
- **ERC-20 sidecar:** Pair any campaign with a token reward (`rewardToken` + `rewardPerImpression`). Seed `DatumTokenRewardVault` with tokens; settlement credits them non-critically on every impression alongside DOT.
- **Challenge bond:** A bond is locked at campaign creation and returned on clean completion, or distributes a bonus to the bond pool if publisher fraud is upheld via `DatumPublisherGovernance`.
- **Direct dual-sig settlement:** Co-sign claim batches with a publisher off-chain; anyone can submit on-chain (see *Settlement Pipeline* below).

### Publishers

Register on-chain, set their take rate (30–80%), configure targeting tags, and embed the SDK. A relay signer EOA co-signs attestations so users settle at zero gas cost.

- **Take rate:** A snapshot-locked share of every clearing payment flows to the publisher's `DatumPaymentVault` balance. Frozen at campaign creation — mid-campaign changes don't affect live campaigns.
- **Stake requirement:** Publishers maintain a DOT stake in `DatumPublisherStake` (`base + cumulativeImpressions × perImp`). Settlement rejects under-staked publishers (error code 15).
- **Withdrawal:** `PaymentVault.withdrawPublisher()` at any time; `withdrawTo(recipient)` for cold-wallet sweeps.

### Users

Browse with the DATUM Chrome extension. It detects publisher SDK embeds, classifies pages against campaign tags, runs a Vickrey second-price auction, and builds Blake2-256 hash-chain claims entirely on-device. No browsing data leaves the browser.

- **DOT earnings:** After the publisher take rate, 75% of the remainder goes to the user and 25% to the protocol. At a 40% publisher take and 0.05 DOT/1000 CPM, a user earns 0.0225 DOT per 1000 verified impressions.
- **ERC-20 sidecar:** Users earn `eventCount × rewardPerImpression` of the campaign token per settlement, claimed via `TokenRewardVault.withdraw(token)`.
- **Zero-gas path:** Co-sign claims with the publisher relay; the relay submits on-chain and pays gas.
- **Self-submit path:** `Settlement.settleClaims()` — user pays gas directly.

### Governance Voters

Any DOT holder can review pending campaigns. Stake DOT with a conviction multiplier (0–8, nine levels; 0× to 21× weight; 0-day to 365-day lockup).

- **Slash rewards:** The losing side (nay voters on activated campaigns, aye on terminated ones) forfeits 10% of stake, redistributed to winners via the slash pool inside `DatumGovernanceV2`.
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

DATUM supports **three settlement entry points**:

```
                ┌──────────────────────────────────────────────────────┐
[User Extension]│  Blake2-256 hash-chain claim                          │
                │  (campaignId, publisher, user, eventCount,           │
                │   ratePlanck, actionType, nonce, prevHash)            │
                └──────────────────────────────────────────────────────┘
                          │
       ┌──────────────────┼─────────────────────┬──────────────────────┐
       ▼                  ▼                     ▼                      ▼
[Settlement.settle  [Relay.settleClaimsFor   [AttestationVerifier.   [Settlement.settleSigned
  Claims]            (userSig + opt.          settleClaimsAttested]   Claims]
  user pays gas      publisherSig)]          publisher EIP-712       publisher + advertiser
  direct             user EIP-712 +           co-sig only             dual EIP-712 sigs;
                     optional pub co-sig                              anyone can submit
                                                                      (refute by withholding)
                          │
                          ▼
                  [DatumClaimValidator]
                    ├─ chain continuity (nonces, prevHash)
                    ├─ campaign active + publisher match
                    ├─ clearing rate ≤ bid rate
                    ├─ event count ≤ 100,000
                    ├─ S12 blocklist (Publishers staticcall)
                    ├─ BM-2 per-user event cap
                    ├─ BM-5 rate limiter (per-publisher window)
                    ├─ BM-7 advertiser allowlist
                    ├─ FP-1 publisher stake check
                    └─ FP-5 ZK nullifier (real Groth16/BN254)
                          │
                          ▼
                  [DatumBudgetLedger.deductSettlement]
                    ├─ daily cap check
                    └─ deduct from escrow
                          │
                          ▼
                  [DatumPaymentVault.credit]
                    ├─ publisher += takeRate%
                    ├─ user     += 75% of remainder
                    └─ protocol += 25% of remainder
                          │
                          ▼ (non-critical — does not block DOT settlement)
                  [DatumTokenRewardVault.creditReward]
                    └─ user token balance += eventCount × rewardPerImpression
                          │
                          ▼
                  [Publisher relay parses ClaimSettled / ClaimRejected events
                   → records (publisher, campaignId) reputation in Settlement]
```

**Hybrid dual-sig path** (`settleSignedClaims`, alpha-4): both publisher and advertiser sign EIP-712 over `ClaimBatch(user, campaignId, claimsHash, deadline)` on the DatumSettlement domain. Publisher sig accepts the publisher EOA *or* its registered `relaySigner`; advertiser sig must match `campaigns.getCampaignAdvertiser`. Either party can refute by withholding their signature. Errors: `E81` (deadline), `E82` (publisher sig), `E83` (advertiser sig).

`settleClaimsMulti(UserClaimBatch[])` batches up to 10 users × 10 campaigns per transaction.

---

## Architecture

### Smart Contracts — `alpha-4/contracts/` (EVM)

**21 deployable production contracts**, compiled to EVM bytecode with solc 0.8.24 (evmVersion `cancun`, viaIR, optimizer 200 runs). Executed on Paseo Hub via pallet-revive's EVM compatibility path — no resolc, no PolkaVM target. **532/532 alpha-4 tests passing.**

| Group | Contract | Role |
|-------|----------|------|
| Infrastructure | `DatumPauseRegistry` | Global emergency pause; 2-of-3 guardian unpause |
| Infrastructure | `DatumTimelock` | 48h admin delay for sensitive config |
| Infrastructure | `DatumZKVerifier` | Groth16/BN254 verifier; verifying key set post-deploy |
| Infrastructure | `DatumPaymentVault` | Pull-payment: publisher/user/protocol DOT balances |
| Infrastructure | `DatumTokenRewardVault` | Pull-payment: ERC-20 sidecar token rewards |
| Infrastructure | `DatumGovernanceRouter` | Stable-address proxy for governance phase transitions |
| Campaign | `DatumBudgetLedger` | Campaign escrow + daily caps |
| Campaign | `DatumCampaigns` | Creation, metadata, status, snapshots, token reward config |
| Campaign | `DatumCampaignLifecycle` | complete / terminate / expire + 30d inactivity timeout |
| Settlement | `DatumClaimValidator` | Chain continuity, budget, blocklist, rate-limit, stake, ZK |
| Settlement | `DatumSettlement` | Three settlement entry points (direct / dual-sig); 3-way DOT split; non-critical token credit; rate-limit + nullifier + reputation merged in |
| Settlement | `DatumAttestationVerifier` | Mandatory EIP-712 publisher co-signature path |
| Publisher | `DatumPublishers` | Registration, take rates, relay signer, profile, S12 blocklist |
| Publisher | `DatumRelay` | Gasless relay path: `userSig + optional publisherSig` |
| Governance | `DatumCouncil` | Phase 1: N-of-M trusted council voting |
| Governance | `DatumGovernanceV2` | Phase 2+: conviction voting (9 levels, 0–8); slash + helper merged in |
| Fraud Prevention | `DatumPublisherStake` | FP-1+FP-4: publisher DOT bonding curve; settlement enforces (code 15) |
| Fraud Prevention | `DatumChallengeBonds` | FP-2: advertiser bonds at creation; bonus on fraud upheld |
| Fraud Prevention | `DatumPublisherGovernance` | FP-3: conviction-weighted fraud governance targeting publishers |
| Fraud Prevention | `DatumParameterGovernance` | FP-15: conviction-vote DAO for protocol parameters |
| Fraud Prevention | `DatumClickRegistry` | FP-6: click-fraud detection (impression → click session tracking) |

Nine alpha-3 satellites are folded into their parents in alpha-4: TargetingRegistry / CampaignValidator / Reports → `DatumCampaigns`; SettlementRateLimiter / NullifierRegistry / PublisherReputation → `DatumSettlement`; GovernanceHelper / GovernanceSlash → `DatumGovernanceV2`; AdminGovernance → `DatumGovernanceRouter`. The standalone alpha-3 contracts remain available in `alpha-3/contracts/` (dual-target PVM via resolc 1.1.0 + EVM via solc) as the canonical 29-contract reference and the source of the PVM-vs-EVM cost benchmark that motivated the merge.

### Browser Extension — `alpha-4/extension/`

Manifest V3, Chrome/Chromium. 4-tab popup: Claims, Earnings, Settings, Filters. **212 Jest tests passing.** ABIs synced for 21-contract alpha-4 layout.

Key capabilities: Blake2-256 claim hashing, Vickrey second-price auction (interest-weighted), P1 two-party attestation, dual-sig-aware `SignedClaimBatch` payload (`userSig` + `publisherSig` + `advertiserSig`), tag-based campaign filtering, IAB format-aware ad injection (7 standard sizes), Shadow DOM isolation, per-format creative image selection from IPFS metadata, AES-256-GCM multi-account embedded wallet, auto-submit, claim export, engagement tracking, phishing list, content safety pipeline.

### Web App — `web/`

React 18 + Vite 6 + TypeScript + ethers v6. **41 pages.** Migrated to alpha-4 21-contract addressing. 0 TS errors.

| Section | Pages |
|---------|-------|
| Explorer | Overview, HowItWorks, Philosophy, Campaigns, CampaignDetail, Publishers, PublisherProfile, AdvertiserProfile |
| Advertiser | Dashboard, CreateCampaign, CampaignDetail, SetMetadata, Analytics |
| Publisher | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile, Stake |
| Governance | Dashboard, Vote, MyVotes, Parameters, ProtocolParams, PublisherFraud |
| Admin | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation, PublisherStake, PublisherGovernance, ChallengeBonds, NullifierRegistry, ParameterGovernance |
| Root | Demo, Settings |

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). Declare slot format via `data-slot` (7 IAB sizes: leaderboard 728×90, medium-rectangle 300×250, wide-skyscraper 160×600, half-page 300×600, mobile-banner 320×50, square 250×250, large-rectangle 336×280). Challenge-response HMAC handshake with the extension for two-party attestation.

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

Reference relay: HTTP challenge/submit endpoints, EIP-712 co-signature, Blake2-256, SHA-256 PoW anti-spam (BM-3). Uses the `userSig + publisherSig` envelope when forwarding to `DatumRelay.settleClaimsFor()`. After each batch: parses `ClaimSettled` / `ClaimRejected` events and records per `(publisher, campaignId)` reputation in Settlement. Accepts legacy `signature` field names transparently.

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

She uploads creative images for each IAB slot size to IPFS and sets metadata via `DatumCampaigns.setMetadata(campaignId, bytes32CID)`. The IPFS JSON includes `creative.images[]` with per-format URLs — the on-chain CID hash makes the full creative payload verifiable.

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

### Direct deal: Carol and Bob settle off-protocol

When Bob and Carol have an out-of-band agreement and want to settle without involving Alice's wallet flow, both co-sign a `ClaimBatch` envelope (EIP-712, DatumSettlement domain). Anyone — Bob, Carol, or a third party — submits via `Settlement.settleSignedClaims`. Either party can refute by withholding their signature.

---

## Getting Started

```bash
# Prerequisites: Node 18+, Chrome

# Contracts (alpha-4)
cd alpha-4
npm install
npx hardhat test                          # 532 pass

# Extension
cd alpha-4/extension && npm install && npm run build
# Load dist/ as unpacked extension in chrome://extensions

# Web App
cd web && npm install && npm run dev
```

### Paseo Testnet (live — alpha-4 EVM, 2026-05-06)

| Resource | Value |
|----------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Web App | https://datum.javcon.io |

```bash
cd alpha-4
export DEPLOYER_PRIVATE_KEY="0x..."
npx hardhat run scripts/deploy.ts --network polkadotTestnet
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

Contract addresses: `alpha-4/deployed-addresses.json`. Full status, dual-target EVM addresses, and alpha-3 reference: `STATUS.md`.

---

## Why Polkadot Hub

- **Native DOT settlement** — escrow, stakes, and payments in DOT; no bridges or wrapped tokens
- **Shared security** — contracts execute on Polkadot Hub, inheriting relay chain validator security
- **XCM interoperability** — cross-chain fee routing and governance tooling are native XCM calls
- **Asset Hub tokens** — ERC-20 sidecar rewards work with any Asset Hub token (precompile address derivation built in)
- **Two execution paths in one runtime** — pallet-revive runs both PolkaVM bytecode (resolc) and EVM bytecode (solc). Alpha-4 picks the EVM path because dropping resolc's bytecode-size constraint lets us merge satellites and shrink settlement gas. Alpha-3 keeps both compile targets so we can benchmark the trade-off honestly.

The Solidity source is fully portable to standard EVM parachains.

---

## Status

- [x] **Alpha-4 EVM — 21 contracts deployed on Paseo Hub** (2026-05-06, solc/cancun via pallet-revive EVM)
- [x] **Alpha-3 dual-target benchmark deploys** — PVM (resolc 1.1.0) 2026-05-02, EVM (solc) 2026-05-03
- [x] **Webapp migrated to alpha-4** — 41 pages, 0 TS errors, 21-contract addressing
- [x] **Hybrid dual-sig settlement** — `settleSignedClaims` permissionless path; D1–D8 tests; extension/web/relay updated
- [x] **532 alpha-4 contract tests** + **212 extension tests** — all passing
- [x] **Governance ladder** — AdminGovernance (Phase 0) + GovernanceRouter (stable proxy) + Council (Phase 1) live
- [x] **Real Groth16 ZK verifier** — BN254, verifying key set, 2-public-input circuit
- [x] **Fraud prevention (FP-1–FP-5, FP-15)** — publisher stake, challenge bonds, fraud governance, ZK nullifiers, parameter DAO; FP-6 ClickRegistry standalone in alpha-4
- [x] **ERC-20 token reward vault** — per-campaign sidecar token rewards, pull-payment
- [x] **IAB ad format system** — 7 standard sizes, per-format creative images, format-aware ad injection
- [x] **Internal security audit (30 items)** — all implemented
- [x] **Pine RPC** — smoldot light-client bridge, eliminates centralized RPC dependency
- [ ] **E2E browser validation** — full flow on Paseo against alpha-4 EVM addresses
- [ ] **External security audit**
- [ ] **Mainnet** — Kusama → Polkadot Hub

See [STATUS.md](STATUS.md) for detailed component status, test totals, and deployed addresses across alpha-4 (EVM), alpha-3 PVM, and alpha-3 EVM dual-target.

---

## License

GPL-3.0-or-later
