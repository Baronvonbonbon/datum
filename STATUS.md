# DATUM Project Status

**Last Updated:** 2026-04-27
**Current Phase:** Alpha-3 v7 (fully deployed on Paseo)
**Testnet:** Paseo (Chain ID 420420417)
**Web App:** https://datum.javcon.io

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub (PolkaVM). Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

Alpha-3 v7 is feature-complete and deployed. **30 contracts authored, 29 deployed** on Paseo (2026-04-26). The web app is live at **https://datum.javcon.io** (41 pages, 29-contract support). The alpha-3 browser extension is built (222/222 tests, 4-tab popup with Filters + IAB ad format system). **All 30 internal security audit items implemented.** ZK circuit artifacts rebuilt for 2-public-input circuit. Governance ladder (Phase 0/1/2+) deployed. Alpha-2 archived.

---

## Components

### Smart Contracts — `alpha-3/contracts/` (canonical)

**30 contracts authored, 29 deployed** on Paseo v7 (2026-04-26). `DatumClickRegistry` authored but not deployed (click-fraud detection, deferred). **539/539 Hardhat EVM tests passing.**

| Contract | Group | Role | Deployed |
|----------|-------|------|----------|
| ZKVerifier | Infrastructure | Real Groth16/BN254 verifier; verifying key set on Paseo | ✅ |
| PauseRegistry | Infrastructure | Global emergency pause (`whenNotPaused`) | ✅ |
| Timelock | Infrastructure | 48h admin delay for sensitive config | ✅ |
| PaymentVault | Infrastructure | Pull-payment vault (publisher/user/protocol DOT) | ✅ |
| TokenRewardVault | Infrastructure | Pull-payment vault for ERC-20 sidecar token rewards | ✅ |
| BudgetLedger | Campaign | Campaign escrow + daily caps | ✅ |
| TargetingRegistry | Campaign | Tag-based targeting (bytes32 hashes, AND-logic) | ✅ |
| CampaignValidator | Campaign | Creation-time validation satellite | ✅ |
| Campaigns | Campaign | Campaign creation, metadata, status, snapshots, token reward config | ✅ |
| CampaignLifecycle | Campaign | complete / terminate / expire + P20 inactivity (30d) | ✅ |
| ClaimValidator | Settlement | Claim validation: chain continuity, blocklist, rate-limit, ZK, publisher stake | ✅ |
| Settlement | Settlement | Hash-chain + Blake2 + 3-way DOT split + token credit + `settleClaimsMulti` | ✅ |
| SettlementRateLimiter | Settlement | BM-5: window-based per-publisher impression cap | ✅ |
| AttestationVerifier | Settlement | P1: EIP-712 mandatory publisher co-signature | ✅ |
| Publishers | Publisher | Registration, take rates, relay signer, profile, S12 blocklist | ✅ |
| Relay | Publisher | Gasless relay: publisher submits batches for users | ✅ |
| GovernanceV2 | Governance | Conviction voting (9 levels), symmetric slash, lockups | ✅ |
| GovernanceHelper | Governance | Read-only aggregation helpers | ✅ |
| GovernanceSlash | Governance | Slash pool finalization, winner rewards, 365d sweep | ✅ |
| AdminGovernance | Governance | Phase 0: team direct approval; current active governor | ✅ |
| GovernanceRouter | Governance | Stable-address proxy; transitions Phase 0 → 1 → 2+ via Timelock | ✅ |
| Council | Governance | Phase 1: N-of-M trusted council voting | ✅ |
| Reports | Satellite | Community reporting: `reportPage()` / `reportAd()`, reasons 1-5 | ✅ |
| PublisherReputation | Satellite | BM-8 score + BM-9 anomaly detection (wired via Settlement) | ✅ |
| PublisherStake | FP | FP-1+FP-4: Publisher DOT bonding curve; Settlement enforces; reason code 15 | ✅ |
| ChallengeBonds | FP | FP-2: Advertiser bonds at campaign creation; bonus from slash pool on fraud | ✅ |
| PublisherGovernance | FP | FP-3: Conviction-weighted fraud governance targeting publishers | ✅ |
| NullifierRegistry | FP | FP-5: Per-user per-campaign per-window ZK nullifier replay prevention (E73) | ✅ |
| ParameterGovernance | FP | FP-15: Conviction-vote DAO for protocol parameters | ✅ |
| ClickRegistry | FP | FP-6: Click-fraud detection (authored, not deployed) | — |

**Governance ladder:** Router at stable address. Phase 0 = AdminGovernance (team direct, active now). Phase 1 = Council (N-of-M). Phase 2+ = GovernanceV2 (conviction vote). Transitions require timelocked `router.setGovernor()`.

**New in alpha-3 v7 (vs v6):**
- 3 new governance contracts: AdminGovernance, GovernanceRouter, Council
- 5 FP contracts now deployed: PublisherStake, ChallengeBonds, PublisherGovernance, NullifierRegistry, ParameterGovernance
- Full OZ compliance pass (all 30 security audit items implemented)
- `settleClaimsMulti(UserClaimBatch[])` — batch settle up to 10 users × 10 campaigns per TX
- ZK circuit: 2 public inputs (claimHash, nullifier); IC2 confirmed in vk.json; verifying key set on Paseo

**Toolchain:** Solidity 0.8.24, resolc 1.0.0, Hardhat 2.22, OZ 5.0, optimizer mode `z`

---

### Browser Extension — `alpha-3/extension/` (alpha-3)

v0.2.0, 29-contract support. **222/222 Jest tests passing.** Manifest V3, Chrome/Chromium. **30 ABIs synced** (incl. AdminGovernance, GovernanceRouter, Council).

**4-tab popup:** Claims, Earnings, Settings, Filters.

Key features:
- **IAB ad format system** — 7 standard sizes (leaderboard 728×90, medium-rectangle 300×250, wide-skyscraper 160×600, half-page 300×600, mobile-banner 320×50, square 250×250, large-rectangle 336×280). SDK sizes placeholder div to exact IAB dimensions. Format-priority image selection: exact format match → `images[0]` → legacy `imageUrl`.
- **Per-format creative images** — `creative.images[]` with `{ format, url, alt? }` entries. Horizontal layout for leaderboard/mobile-banner; vertical layout for all others.
- **Event-driven campaign polling** — CampaignCreated events, incremental from lastBlock, O(1) Map index, no campaign count limit
- **Batch-parallel RPC** — 20 concurrent status refreshes, 5 concurrent IPFS fetches
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` matches Settlement on PolkaVM
- **P1 attestation path** — `AttestationVerifier.settleClaimsAttested()` with publisher EIP-712 co-sig
- **Filters tab** — tag-based campaign filtering: allow/block topics, silenced campaigns list
- **In-ad dismiss** — ✕ button with popover: Hide this ad / Hide [topic] ads / Not interested
- **Report overlay** — ⚑ Report button, click-to-open reason picker (only on click, not on ad load)
- **Publisher profile section** — in Settings: relay signer and profile hash display
- **FP state in Settings** — publisher stake balance + required stake, challenge bond status
- **Second-price Vickrey auction** — interest-weighted effective bids; solo/floor/second-price mechanisms with mechanism badge in ad overlay
- **Native Asset Hub token metadata** — registry fallback for ERC-20 precompile addresses (no `symbol()`/`decimals()` call for known assets)
- EIP-1193 provider bridge, engagement tracking, IPFS multi-gateway (5 fallbacks), Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit, claim export (P6), timelock monitor (H2)

---

### Web App — `web/`

v0.3.0, React 18 + Vite 6 + TypeScript + ethers v6. 0 TS errors. **29-contract support.**

**41 pages across 6 sections:**

| Section | Count | Pages |
|---------|-------|-------|
| Explorer | 8 | Overview, HowItWorks, Campaigns, CampaignDetail, Publishers, PublisherProfile, Governance, Leaderboard |
| Advertiser | 5 | Dashboard, CreateCampaign (per-format image upload + native Asset Hub token toggle), CampaignDetail (challenge bond display), SetMetadata, Analytics |
| Publisher | 9 | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile, Stake |
| Governance | 6 | Dashboard, Vote, MyVotes, Parameters, Council, GovernanceRouter |
| Admin | 11 | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation, PublisherStake, PublisherGovernance, ChallengeBonds, NullifierRegistry, ParameterGovernance |
| Root | 2 | Demo (browse simulator + interest profile + Vickrey simulation), Settings (network, RPC, 29 addresses, IPFS) |

Native Asset Hub token precompile support in CreateCampaign. Challenge bond display in CampaignDetail. Deep-merge fix for contractAddresses. Theme toggle. Role badges. Demo page with live Vickrey auction simulation and interest profile bar chart.

---

### Pine RPC — `pine/`

Local smoldot light-client bridge. Translates Ethereum JSON-RPC into Substrate `ReviveApi_*` and `chainHead_v1_*` calls for Polkadot Asset Hub without a centralized RPC proxy.

**Architecture:** `PineProvider` (EIP-1193) → per-method handlers → smoldot WASM light client → P2P proof fetching.

Key capabilities:
- Fully supported: `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_sendRawTransaction`, `eth_blockNumber`, `eth_chainId`
- Partial: `eth_getLogs` (rolling 10,000-block in-memory window), `eth_getTransactionReceipt` (session-scoped TxPool; fixes Paseo null-receipt bug), `eth_getBlockBy*` (tracked window only)
- Not supported: `eth_subscribe`, filter subscriptions, `eth_accounts`, debug/trace, EIP-1559 fee market

**Supported chains:** Paseo Asset Hub, Polkadot Asset Hub, Kusama Asset Hub, Westend Asset Hub, custom.

See `pine/CAPABILITIES.md` for the full method support matrix and per-method caveats.

---

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). `<script data-publisher="0x..." data-slot="medium-rectangle">` + `<div id="datum-ad-slot">`. Sizes placeholder div to exact IAB dimensions. Challenge-response handshake with extension for two-party attestation.

---

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service for Diana on localhost:3400. Co-signs attestations, processes claim batches via `DatumRelay.settleClaimsFor()`. Blake2-256 claim hashing. After each batch: parses ClaimSettled/ClaimRejected events, aggregates per `(publisher, campaignId)` pair, calls `DatumPublisherReputation.recordSettlement()` (BM-8/BM-9).

---

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployment (Paseo — Alpha-3 v7, 2026-04-26)

| Item | Value |
|------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Web App | `https://datum.javcon.io` |
| Currency | PAS (planck = 10⁻¹⁰ PAS) |
| Deployed | 2026-04-26T14:49:55Z (v7: all 29 contracts, full redeploy) |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher | Diana `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` (50% take rate, relay signer) |

### Alpha-3 Contract Addresses (v7 — 29 deployed)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0x2BC4B296c82e2491358F059a238c2e5f26528f24` |
| Timelock | `0x6d9E59f4d7c3cE2EE3946a085200Af517959b818` |
| ZKVerifier | `0x5Ea16537f5c20CbDD30959dD22589666bE296271` |
| Publishers | `0xE12F7Ad3f6EF1F27daD08a7551F5DEFBDc506CA8` |
| BudgetLedger | `0x3FdfA73472C4D2e534d5eF50c568f19AA4c84922` |
| PaymentVault | `0x838E93416a38A5d05904B67E4C9BFd34bB3ee524` |
| TokenRewardVault | `0xbfB6Ed005ea0B5085eE9cC0CB2fE81AA34D53767` |
| TargetingRegistry | `0x5241DA2af587CA8d0bfF2736290E5498Dabc4176` |
| CampaignValidator | `0x44976385794271Fc12FD8EA6A470Aa4FE59B6339` |
| Campaigns | `0xe81b841d8aa13352bE4a7E593D5916bD205323F2` |
| CampaignLifecycle | `0x8835BEe830b036d582cf9f79E20B9899A090679A` |
| Settlement | `0xF861ae3FA15F7c3CA4e5D71BFB5C4f75eB8C2fF9` |
| ClaimValidator | `0xD06100d5A9a5757D444F9603653E6c697a06762D` |
| SettlementRateLimiter | `0x10E372864e0fEB9e2F831332f779333B51De3f2C` |
| AttestationVerifier | `0xEEDC77133a578add7F2c22bc643a3f051656aB89` |
| Relay | `0xf473C6570Dd3a4b854F0e2103986d41e08920299` |
| GovernanceV2 | `0x54B1F60F396c64D68819530641E255E5e5Ae0aED` |
| GovernanceHelper | `0x9b488594a7bcba3BD966354Ba7b49636C3B7348F` |
| GovernanceSlash | `0xdB799cFe78f54c04cc099e6F481a16e85faE0D33` |
| AdminGovernance | `0xa3f1f698f33DAbD76992d9dFC6a5495ED33478BE` |
| GovernanceRouter | `0x0dD31875b7675A6F4Bc0128bf34c545f0ADFE503` |
| Council | `0x5B3e80476634689259499FeC35C2b1D68289d40D` |
| Reports | `0x7cAb1D53a64A88443d7be4C97dd6718709772942` |
| PublisherReputation | `0x8aD9BD12130728404d161c7ade67fAf24dE1AA17` |
| PublisherStake | `0xBB699c50FdF4387829449134f19DE48e3acFf906` |
| ChallengeBonds | `0x2158dAbcD2eB8a21b698f88cAef0fC890019dC5E` |
| PublisherGovernance | `0xb1B60f7E2851808b2C7FC0Ab83d73f23Bb09cC07` |
| NullifierRegistry | `0x3a3B08a275C95fb3EcDBC011a81351b7Ff16c270` |
| ParameterGovernance | `0x87246ab36dB2d29DFf356d37a7661eC3a28E58cD` |

Source: `alpha-3/deployed-addresses.json` (authoritative). Ownership: Campaigns, Settlement, Publishers owned by Timelock via GovernanceRouter.

---

## Test Totals

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha contracts | 132 | Passing (archived) |
| Alpha-2 contracts | 187 | Passing (archived) |
| Alpha-3 contracts | 539 / 539 | All passing |
| Extension (alpha-3) | 222 / 222 | All passing |
| **Total active** | **761 / 761** | |

---

## Critical Path to Mainnet

### ✅ 1. Blake2 Claim Hash Migration — DONE
Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`. Extension + relay both use `@noble/hashes/blake2.js`.

### ✅ 2. Alpha-3 v7 Deploy — DONE
All 29 contracts deployed to Paseo 2026-04-26 (v7: full redeploy including governance ladder + OZ compliance pass).

### ✅ 3. Security Audit (Internal — All 30 Items) — DONE
C-1, C-2, H-1, H-2, H-3 fixed 2026-03-28. S4, S6, T1-T3 fixed 2026-04-04. Full 30-item internal audit (SECURITY-AUDIT-2026-04-20.md) implemented 2026-04-20. External audit pending.

### ✅ 4. Bot Mitigation (BM-5) — DONE
DatumSettlementRateLimiter deployed. Window-based per-publisher impression cap. Wired in Settlement via `setRateLimiter()`.

### ✅ 5. Bot Mitigation (BM-8/BM-9) — DONE
DatumPublisherReputation deployed. Relay bot wired. Web admin UI at `/admin/reputation`. Reporter (Diana) wired via setup-testnet.ts step 5.7.

### ✅ 6. Real ZK Verifier — DONE
Groth16/BN254 verifier live on Paseo. Trusted setup via `scripts/setup-zk.mjs`. Verifying key set post-deploy. Circuit: 2 public inputs (claimHash, nullifier). Artifacts rebuilt 2026-04-20; IC2 confirmed in vk.json + setVK-calldata.json.

### ✅ 7. Pine RPC Light Client — DONE (alpha)
smoldot-based EIP-1193 provider in `pine/`. Translates eth JSON-RPC to Substrate ReviveApi calls. Eliminates centralized RPC proxy dependency for read operations and tx broadcast.

### ✅ 8. Fraud Prevention Suite (FP-1–FP-5, FP-15) — DONE
PublisherStake (bonding curve, settlement enforcement), ChallengeBonds (advertiser bonds, fraud bonus), PublisherGovernance (conviction-weighted, publisher-targeting), NullifierRegistry (ZK replay prevention), ParameterGovernance (DAO parameter control) — all deployed v7.

### ✅ 9. Governance Ladder — DONE
AdminGovernance (Phase 0, active), GovernanceRouter (stable proxy), Council (Phase 1) deployed v7. Phase transitions require timelocked `router.setGovernor()`.

### ✅ 10. IAB Ad Format System — DONE
7 standard IAB sizes, format-priority creative image selection, per-format image upload in CreateCampaign, horizontal/vertical layout in ad overlay. SDK sizes placeholder div to exact IAB dimensions.

### ✅ 11. BM-3 Relay PoW Challenge — DONE
`GET /relay/challenge` + `POST /relay/submit` with SHA-256 PoW verification live in relay-bot.mjs. Challenge TTL + used-flag for replay prevention.

### 12. E2E Browser Validation
Full flow on Paseo: load extension with live addresses, create impression, submit via AttestationVerifier, verify settlement on-chain, confirm user + publisher earnings. Run `setup-testnet.ts` to re-seed state first.

### 13. Open Testing
Publish addresses, document external tester flow, monitor events.

### 14. External Security Audit
Professional audit before Kusama/Polkadot Hub deployment.

---

## Economics Reference

See `BENCHMARKS.md` for full gas cost table, settlement economics, and CPM break-even analysis.

**At recommended 0.500 PAS/1000 CPM ($2.50 @ $5/DOT), 50% publisher take rate:**

| Party | Per 1000 impressions | After gas |
|---|---:|---:|
| Publisher | 0.250 PAS ($1.25) | ~$1.14 |
| User | 0.1875 PAS ($0.94) | ~$0.93 |
| Protocol | 0.0625 PAS ($0.31) | $0.31 |
| Relay gas overhead | — | −$0.11 |

User withdrawal break-even: **9 impressions** at 0.500 PAS/1000 CPM. Relay profitable at 7-claim × 100-imp batches.

---

## Backlog Summary

**Full backlog** in `BACKLOG.md`.

| Category | Items | Status |
|----------|-------|--------|
| Targeting redesign (TX-*) | 7 | ✅ Core done (TX-1 through TX-4, TX-7) |
| Bot mitigation (BM-*) | 9 | ✅ BM-2, BM-3, BM-5, BM-7, BM-8, BM-9 done; BM-6 deferred (viewability dispute) |
| Fraud prevention (FP-*) | 5 | ✅ FP-1–FP-5, FP-15 deployed; FP-6 authored (ClickRegistry, not deployed); FP-8 partial; others deferred |
| Internal security audit | 30 | ✅ All 30 items implemented (SECURITY-AUDIT-2026-04-20.md) |
| Governance ladder | 3 | ✅ AdminGovernance + GovernanceRouter + Council deployed v7 |
| IAB ad format system | 1 | ✅ Done — 7 sizes, format-priority selection, per-format upload, SDK sizing |
| Pre-mainnet (S12 governance blocklist) | 1 | Open — hybrid admin/governance blocklist needs contract change |
| User economics (UX + payout) | 4 | ✅ Token withdrawal, ERC-20 approve flow, auto-sweep done; cross-campaign batching open |
| Native Asset Hub token sidecar | 1 | ✅ Done — ERC-20 precompile registry, CreateCampaign toggle, extension metadata fallback |
| Pine RPC | 3 | Alpha done; eth_subscribe, filter subs, production hardening open |
| Pre-mainnet gate (MG-*) | 7 | External audit, Kusama deploy — not started |

---

## Directory Layout

```
datum/
├── alpha-3/          # Canonical contracts (30 authored / 29 deployed), tests (539), extension (222 tests, 30 ABIs)
├── web/              # Web app (React + Vite, 41 pages, 29-contract support)
├── sdk/              # Publisher SDK (datum-sdk.js, ~3 KB)
├── pine/             # Pine RPC: smoldot light-client eth JSON-RPC bridge
├── docs/             # Demo page + relay template
├── relay-bot/        # Publisher relay (gitignored) — BM-8/BM-9 wired
├── archive/          # PoC, alpha (9), alpha-2 (13), old extensions
├── BENCHMARKS.md     # Gas costs, settlement economics, CPM break-even analysis
├── SECURITY-AUDIT-2026-04-20.md  # Internal audit — all 30 items implemented
├── SECURITY-AUDIT.md # 3-part audit with fix status tracker
├── BACKLOG.md        # Bugs, issues, missing features, open items
├── STATUS.md         # This file
└── README.md         # Project overview + role-based system flow
```
