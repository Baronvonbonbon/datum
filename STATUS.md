# DATUM Project Status

**Last Updated:** 2026-04-17
**Current Phase:** Alpha-3 (canonical, deployed on Paseo)
**Testnet:** Paseo (Chain ID 420420417)
**Web App:** https://datum.javcon.io

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub (PolkaVM). Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

Alpha-3 is deployed. **All 21 contracts** are live on Paseo testnet (v6, 2026-04-10). The web app is live at **https://datum.javcon.io** (32 pages, 21-contract support). The alpha-3 browser extension is built (168/168 tests, 4-tab popup with Filters). All CRITICAL and HIGH security findings fixed. Pine RPC light-client bridge added. Alpha-2 archived.

---

## Components

### Smart Contracts — `alpha-3/contracts/` (canonical)

**21 contracts**, 353/353 Hardhat EVM tests passing.

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
| ClaimValidator | Settlement | Claim validation: chain continuity, blocklist, rate-limit, ZK | ✅ |
| Settlement | Settlement | Main entry: hash-chain + Blake2 + 3-way DOT split + non-critical token credit | ✅ |
| SettlementRateLimiter | Settlement | BM-5: window-based per-publisher impression cap | ✅ |
| AttestationVerifier | Settlement | P1: EIP-712 mandatory publisher co-signature | ✅ |
| Publishers | Publisher | Registration, take rates, relay signer, profile, S12 blocklist | ✅ |
| Relay | Publisher | Gasless relay: publisher submits batches for users | ✅ |
| GovernanceV2 | Governance | Conviction voting (9 levels), symmetric slash, lockups | ✅ |
| GovernanceHelper | Governance | Read-only aggregation helpers | ✅ |
| GovernanceSlash | Governance | Slash pool finalization, winner rewards, 365d sweep | ✅ |
| Reports | Satellite | Community reporting: `reportPage()` / `reportAd()`, reasons 1-5 | ✅ |
| PublisherReputation | Satellite | BM-8 score + BM-9 anomaly detection (reporter pattern) | ✅ |

**New in alpha-3 (vs alpha-2):**
- 8 new contracts: TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper, Reports, SettlementRateLimiter, PublisherReputation, TokenRewardVault
- Campaigns: `createCampaign` takes `requiredTags` (bytes32[]) + `requireZkProof` bool + optional `rewardToken`/`rewardPerImpression`
- Publishers: `relaySigner`, `profileHash` mappings; `setRelaySigner()`, `setProfile()`
- Settlement: `setRateLimiter()`, `setPublishers()` for S12 blocklist; non-critical `creditReward()` call to TokenRewardVault
- Security fixes: C-1, C-2, H-1, H-2, H-3, S4, S6, T1-T3, empty-claims OOB, impression cap, blocklist fail-safe

**Toolchain:** Solidity 0.8.24, resolc 1.0.0, Hardhat 2.22, OZ 5.0, optimizer mode `z`

---

### Browser Extension — `alpha-3/extension/` (alpha-3)

v0.2.0, 21-contract support. 168/168 Jest tests passing. Manifest V3, Chrome/Chromium.

**4-tab popup:** Claims, Earnings, Settings, Filters.

Key features:
- **Event-driven campaign polling** — CampaignCreated events, incremental from lastBlock, O(1) Map index, no campaign count limit
- **Batch-parallel RPC** — 20 concurrent status refreshes, 5 concurrent IPFS fetches
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` matches Settlement on PolkaVM
- **P1 attestation path** — `AttestationVerifier.settleClaimsAttested()` with publisher EIP-712 co-sig
- **Filters tab** — tag-based campaign filtering: allow/block topics, silenced campaigns list
- **In-ad dismiss** — ✕ button with popover: Hide this ad / Hide [topic] ads / Not interested
- **Report overlay** — ⚑ Report button, click-to-open reason picker (only on click, not on ad load)
- **Publisher profile section** — in Settings: relay signer and profile hash display
- **Second-price Vickrey auction** — interest-weighted effective bids; solo/floor/second-price mechanisms
- **21-contract support** — all ABIs synced including Reports, RateLimiter, Reputation, TokenRewardVault
- EIP-1193 provider bridge, engagement tracking, IPFS multi-gateway (5 fallbacks), Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit, claim export (P6), timelock monitor (H2)

---

### Web App — `web/`

v0.3.0, React 18 + Vite 6 + TypeScript + ethers v6. 0 TS errors.

**32 pages across 6 sections:**

| Section | Count | Pages |
|---------|-------|-------|
| Explorer | 6 | Overview, HowItWorks, Campaigns, CampaignDetail, Publishers, PublisherProfile |
| Advertiser | 6 | Dashboard, CreateCampaign (+ ERC-20 config), AdvertiserProfile, CampaignDetail, SetMetadata, Analytics |
| Publisher | 8 | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile |
| Governance | 4 | Dashboard, Vote, MyVotes, Parameters |
| Admin | 6 | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation |
| Root | 2 | Demo (browse simulator + interest profile), Settings (network, RPC, 21 addresses, IPFS) |

21-contract support. Deep-merge fix for contractAddresses. Null guard in contract factory. Theme toggle. Role badges. Demo page with live Vickrey auction simulation and interest profile bar chart.

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

Lightweight JS tag (~3 KB). `<script data-publisher="0x...">` + `<div id="datum-ad-slot">`. Challenge-response handshake with extension for two-party attestation.

---

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service for Diana on localhost:3400. Co-signs attestations, processes claim batches via `DatumRelay.settleClaimsFor()`. Blake2-256 claim hashing. After each batch: parses ClaimSettled/ClaimRejected events, aggregates per `(publisher, campaignId)` pair, calls `DatumPublisherReputation.recordSettlement()` (BM-8/BM-9).

---

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployment (Paseo — Alpha-3 v6, 2026-04-10)

| Item | Value |
|------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Web App | `https://datum.javcon.io` |
| Currency | PAS (planck = 10^-10 PAS) |
| Deployed | 2026-04-10 (v6: all 21 contracts, full redeploy) |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher | Diana `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` (50% take rate, relay signer) |

### Alpha-3 Contract Addresses (v6 — all 21 deployed)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0x305303dF07C7F9E265B6EBD3b7940F6e7c8EafD4` |
| Timelock | `0x8b755205058F8B7162a2f362057c8a2391C948B4` |
| ZKVerifier | `0x31F2DE45F985E24BFb0BC833B77e557491187f3f` |
| Publishers | `0x2d3938B16A711B3e393224776b1D1da5ceCF6FE7` |
| BudgetLedger | `0x663F713D1AD3E3361736F6A60F623067b3A7EF6E` |
| PaymentVault | `0xD51ce700B0cF51DA3E8385681ACB1c10c2407f20` |
| TokenRewardVault | `0xC4A4247319C8E6Ff2d81B318c300bF81CB987aFE` |
| TargetingRegistry | `0x23460C40c7EFA277551cDC7Fb2972B0aaAB03fB9` |
| CampaignValidator | `0x30bCC00bc3c8E6cFFDD2798861B2C9Df03d20b20` |
| Campaigns | `0xb181415cd7C59fe182A3DeF20546b6d6089CD394` |
| CampaignLifecycle | `0xb42280d0A3A24Be8f87aAbF261e11CEfF78d2b8a` |
| Settlement | `0x9353dAb26e178cAA4103A7708b0ea63FC340F731` |
| ClaimValidator | `0x616e47592Fabc4F2A94E1A2FEFd86EE86572C0C2` |
| GovernanceV2 | `0x38c55B6855050276648E44b5A621C671ca25e14e` |
| GovernanceHelper | `0x2567027e5a308f29aa887c4bdfaE9F8dbF19ff65` |
| GovernanceSlash | `0x147972F36ab3e85a0dFa18204e9F59b21B7a6C46` |
| Relay | `0xFDF0dD9f81d1139Cb3CBc00b2CeeDE2dCdc97173` |
| AttestationVerifier | `0x73C002D6cf9dFEdb6257F7c9210e04651BFeA2af` |
| Reports | `0x070cba0Ab1b084c5E35eF79db58916947DeF96ea` |
| SettlementRateLimiter | `0xdE2d58ecd15642E2d5DaE9B0D515D3085F506C5A` |
| PublisherReputation | `0xd7a60FA27349A1fF312735E84F19ed75309cCdeA` |

Source: `alpha-3/deployed-addresses.json` (authoritative). Ownership: Campaigns, Settlement, Publishers owned by Timelock.

---

## Test Totals

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha contracts | 132 | Passing (archived) |
| Alpha-2 contracts | 187 | Passing (archived) |
| Alpha-3 contracts | 353 / 353 | All passing |
| Extension (alpha-3) | 168 / 168 | All passing |
| **Total active** | **640 / 640** | |

---

## Critical Path to Mainnet

### ✅ 1. Blake2 Claim Hash Migration — DONE
Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`. Extension + relay both use `@noble/hashes/blake2.js`.

### ✅ 2. Alpha-3 Deploy — DONE
All 21 contracts deployed to Paseo 2026-04-10 (v6: full redeploy including TokenRewardVault).

### ✅ 3. Security Audit (CRITICAL/HIGH) — DONE
C-1, C-2, H-1, H-2, H-3 fixed 2026-03-28. S4, S6, T1-T3 fixed 2026-04-04.

### ✅ 4. Bot Mitigation (BM-5) — DONE
DatumSettlementRateLimiter deployed. Window-based per-publisher impression cap. Wired in Settlement via `setRateLimiter()`.

### ✅ 5. Bot Mitigation (BM-8/BM-9) — DONE
DatumPublisherReputation deployed. Relay bot wired. Web admin UI at `/admin/reputation`. Reporter (Diana) wired via setup-testnet.ts step 5.7.

### ✅ 6. Real ZK Verifier — DONE
Groth16/BN254 verifier live on Paseo. Trusted setup via `scripts/setup-zk.mjs`. Verifying key set post-deploy. 33-constraint impression circuit.

### ✅ 7. Pine RPC Light Client — DONE (alpha)
smoldot-based EIP-1193 provider in `pine/`. Translates eth JSON-RPC to Substrate ReviveApi calls. Eliminates centralized RPC proxy dependency for read operations and tx broadcast.

### ✅ 8. Fix Failing Tests — DONE
- Extension: `formatDOT` rewritten, `auction.test.ts` profile keys fixed, `userPreferences.test.ts` rewritten → 168/168
- Contracts: `MockZKVerifier.sol` created → 353/353

### 9. E2E Browser Validation
Full flow on Paseo: load extension with live addresses, create impression, submit via AttestationVerifier, verify settlement on-chain, confirm user + publisher earnings. Run `setup-testnet.ts` to re-seed state first.

### ✅ 10. BM-3 Relay PoW Challenge — DONE
`GET /relay/challenge` + `POST /relay/submit` with SHA-256 PoW verification already live in relay-bot.mjs. Challenge TTL + used-flag for replay prevention. No contract changes needed.

### 11. Open Testing
Publish addresses, document external tester flow, monitor events.

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
| Bot mitigation (BM-*) | 9 | BM-2, BM-3, BM-5, BM-7, BM-8, BM-9 done; BM-6 open |
| Security HIGH | 4 | ✅ All fixed |
| Security MEDIUM | 6 | 4 fixed, 2 open (AttestationVerifier open-campaign, drainFraction precision) |
| Security LOW | 5 | 2 fixed, 3 open (low risk) |
| Pre-mainnet (S12 governance blocklist) | 1 | Open — hybrid admin/governance blocklist needs contract change |
| User economics (UX + payout) | 4 | Token withdrawal UI + ERC-20 approve flow done; cross-campaign batching, auto-sweep open |
| Pine RPC | 3 | Alpha done; eth_subscribe, filter subs, production hardening open |
| Pre-mainnet gate (MG-*) | 7 | External audit, Kusama deploy — not started |

---

## Directory Layout

```
datum/
├── alpha-3/          # Canonical contracts (21), tests (306), extension (156 tests)
├── web/              # Web app (React + Vite, 32 pages, 21-contract support)
├── sdk/              # Publisher SDK (datum-sdk.js)
├── pine/             # Pine RPC: smoldot light-client eth JSON-RPC bridge
├── docs/             # Demo page + relay template
├── relay-bot/        # Publisher relay (gitignored) — BM-8/BM-9 wired
├── archive/          # PoC, alpha (9), alpha-2 (13), old extensions
├── BENCHMARKS.md     # Gas costs, settlement economics, CPM break-even analysis
├── SECURITY-AUDIT.md # 3-part audit with fix status tracker
├── BACKLOG.md        # Bugs, issues, missing features, open items
├── STATUS.md         # This file
└── README.md         # Project overview + role-based system flow
```
