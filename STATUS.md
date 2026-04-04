# DATUM Project Status

**Last Updated:** 2026-04-04
**Current Phase:** Alpha-3 (canonical, deployed on Paseo)
**Testnet:** Paseo (Chain ID 420420417)
**Web App:** https://datum.javcon.io

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub (PolkaVM). Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

Alpha-3 is deployed. **All 20 contracts** are live on Paseo testnet (v4+reputation, 2026-04-04). The web app is live at **https://datum.javcon.io** (28 pages, 20-contract support). The alpha-3 browser extension is built (165/165 tests, 4-tab popup with Filters). All CRITICAL and HIGH security findings fixed. Alpha-2 archived.

---

## Components

### Smart Contracts — `alpha-3/contracts/` (canonical)

**20 contracts**, 219/219 Hardhat EVM tests.

| Contract | Group | Role | Deployed |
|----------|-------|------|----------|
| ZKVerifier | Infrastructure | Stub (real Groth16 post-alpha) | ✅ |
| PauseRegistry | Infrastructure | Global emergency pause (`whenNotPaused`) | ✅ |
| Timelock | Infrastructure | 48h admin delay for sensitive config | ✅ |
| PaymentVault | Infrastructure | Pull-payment vault (publisher/user/protocol) | ✅ |
| BudgetLedger | Campaign | Campaign escrow + daily caps | ✅ |
| TargetingRegistry | Campaign | Tag-based targeting (bytes32 hashes, AND-logic) | ✅ |
| CampaignValidator | Campaign | Creation-time validation satellite | ✅ |
| Campaigns | Campaign | Campaign creation, metadata, status, snapshots | ✅ |
| CampaignLifecycle | Campaign | complete / terminate / expire + P20 inactivity (30d) | ✅ |
| ClaimValidator | Settlement | Claim validation: chain continuity, blocklist, rate-limit, ZK | ✅ |
| Settlement | Settlement | Main entry: hash-chain + Blake2 + 3-way payment split | ✅ |
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
- 7 new contracts: TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper, Reports, SettlementRateLimiter, PublisherReputation
- Campaigns: `createCampaign` takes `requiredTags` (bytes32[]) + `requireZkProof` bool
- Publishers: `relaySigner`, `profileHash` mappings; `setRelaySigner()`, `setProfile()`
- Settlement: `setRateLimiter()`, `setPublishers()` for S12 blocklist check
- Security fixes: C-1, C-2, H-1, H-2, H-3, S4, S6, T1-T3, empty-claims OOB, impression cap, blocklist fail-safe

**Toolchain:** Solidity 0.8.24, resolc 1.0.0, Hardhat 2.22, OZ 5.0, optimizer mode `z`

---

### Browser Extension — `alpha-3/extension/` (alpha-3)

v0.4.0, 20-contract support. 165/165 Jest tests, 0 webpack errors. Manifest V3, Chrome/Chromium.

**4-tab popup:** Claims, Earnings, Settings, Filters.

Key features:
- **Event-driven campaign polling** — CampaignCreated events, incremental from lastBlock, O(1) Map index, no campaign count limit
- **Batch-parallel RPC** — 20 concurrent status refreshes, 5 concurrent IPFS fetches
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` matches Settlement on PolkaVM
- **P1 attestation path** — `AttestationVerifier.settleClaimsAttested()` with publisher EIP-712 co-sig
- **Filters tab** — tag-based campaign filtering: allow/block topics, silenced campaigns list
- **In-ad dismiss** — ✕ button with popover: Hide this ad / Hide [topic] ads / Not interested
- **Publisher profile section** — in Settings: relay signer and profile hash display
- **20-contract support** — all ABIs synced including Reports, RateLimiter, Reputation
- EIP-1193 provider bridge, Vickrey auction, engagement tracking, IPFS multi-gateway (5 fallbacks), Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit, claim export (P6), timelock monitor (H2)

---

### Web App — `web/`

v0.3.0, React 18 + Vite 6 + TypeScript + ethers v6. 0 TS errors.

**28 pages across 6 sections:**

| Section | Count | Pages |
|---------|-------|-------|
| Explorer | 4 | Overview, Campaigns, CampaignDetail, Publishers |
| Advertiser | 5 | Dashboard, CreateCampaign, CampaignDetail, SetMetadata, Analytics |
| Publisher | 8 | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile |
| Governance | 4 | Dashboard, Vote, MyVotes, Parameters |
| Admin | 6 | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation |
| Settings | 1 | Settings (network, RPC, 20 contract addresses, IPFS config) |

20-contract support. Deep-merge fix for contractAddresses. Null guard in contract factory. Theme toggle. Role badges.

---

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). `<script data-publisher="0x...">` + `<div id="datum-ad-slot">`. Challenge-response handshake with extension for two-party attestation.

---

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service for Diana on localhost:3400. Co-signs attestations, processes claim batches via `DatumRelay.settleClaimsFor()`. Blake2-256 claim hashing. After each batch: parses ClaimSettled/ClaimRejected events, aggregates per `(publisher, campaignId)` pair, calls `DatumPublisherReputation.recordSettlement()` (BM-8/BM-9). Reporter registration done via setup-testnet.ts step 5.7.

---

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployment (Paseo — Alpha-3 v4, 2026-04-04)

| Item | Value |
|------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Web App | `https://datum.javcon.io` |
| Currency | PAS (planck = 10^-10 PAS) |
| Deployed | 2026-04-04 (v4: security fixes + S12 settlement blocklist) |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher | Diana `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` (50% take rate, relay signer) |

### Alpha-3 Contract Addresses (19 deployed, 1 pending)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0x9c65f8919Dca88d260637C015DC47f45993D36dD` |
| Timelock | `0x0959e8Fb600D559EB0162A0aef560DB0fe87F3a4` |
| ZKVerifier | `0xCaFCA05eE6f837c2F8e597f1a1dfe13b05463bF1` |
| Publishers | `0xC0B5794A401C392116b14f6c682423130C0e689a` |
| BudgetLedger | `0x4Dd3cad6fFF40d5bFd8cCf1f9b83aE2168DF38A3` |
| PaymentVault | `0x850C12410eCf6733D5CF2C33861f23b6816c950B` |
| TargetingRegistry | `0x5E3D299bfB83B0E6dE54D6943e9c54e1bdf00676` |
| CampaignValidator | `0x77EFC1B9a04cDF92610A567202Ac7F37e769a5f8` |
| Campaigns | `0xe28B053c6A6428Bb2D095e24c0AA0735145656B3` |
| CampaignLifecycle | `0x1948A518F5F7412DAbeF0273a2755a0D510D23bC` |
| Settlement | `0xE1454CCD97b7F752617c90d29939f34C6D4d5f95` |
| ClaimValidator | `0x8Bf6C34A797C5bD919213493655C4A90E3Bb131e` |
| GovernanceV2 | `0xE318338b5c1D4d7DAD25CDd4E8B300b42129A930` |
| GovernanceHelper | `0xdDC82a51f33820Bdd92b26380eD797ed60d332Fa` |
| GovernanceSlash | `0x9152be906c27e12e20CD66574dDB067eFA306294` |
| Relay | `0x143e6A59D4eeF103F417fC45cf685fD876023e19` |
| AttestationVerifier | `0x447ECc8bbA06F02A71a073f8ae2260FCb128A337` |
| Reports | `0x0bf309ba45aE61dEF6398AAE161E72770E6027CA` |
| SettlementRateLimiter | `0x5C128CCF8795394Ad2411b76CD9d8f158d6929F8` |
| PublisherReputation | `0xbFfb416b8f0A239BF041D60A267BD7F3c0ddb79E` |

Ownership: Campaigns + Settlement + Publishers owned by Timelock. Other contracts owned by deployer EOA.

---

## Test Totals

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha contracts | 132 | Passing (archived) |
| Alpha-2 contracts | 187 | Passing (archived) |
| Alpha-3 contracts | 219 | Passing |
| Extension (alpha-3) | 165 | Passing |
| **Total active** | **384** | **All passing** |

---

## Critical Path to Mainnet

### ✅ 1. Blake2 Claim Hash Migration — DONE
Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`. Extension + relay both use `@noble/hashes/blake2.js`.

### ✅ 2. Alpha-3 Deploy — DONE
19/20 contracts deployed to Paseo 2026-04-04. 4 new satellites (v3) + security fixes + BM-5 rate limiter + Reports + S12 settlement blocklist (v4).

### ✅ 3. Security Audit (CRITICAL/HIGH) — DONE
C-1, C-2, H-1, H-2, H-3 fixed 2026-03-28. S4, S6, T1-T3 fixed 2026-04-04.

### ✅ 4. Bot Mitigation (BM-5) — DONE
DatumSettlementRateLimiter deployed. Window-based per-publisher impression cap. Wired in Settlement via `setRateLimiter()`. ClaimValidator reason code 14 for rate-limit violations.

### ✅ 5. Bot Mitigation (BM-8/BM-9) — IMPLEMENTED, DEPLOY PENDING
DatumPublisherReputation deployed at `0xbFfb416b8f0A239BF041D60A267BD7F3c0ddb79E`. Relay bot wired. Web admin UI at `/admin/reputation`. Run setup-testnet.ts step 5.7 to add Diana as approved reporter.

### 6. E2E Browser Validation
Full flow on Paseo: load extension with live addresses, create impression, submit claim via AttestationVerifier, verify settlement on-chain, confirm user + publisher earnings. Run setup-testnet.ts to re-seed state first.

### 7. BM-3 Relay PoW Challenge
Server-side PoW: `GET /relay/challenge` returns nonce + expiry; `POST /relay/submit` verifies PoW. No contract changes needed.

### 8. Open Testing
Publish addresses, document external tester flow, monitor events.

---

## Backlog Summary

**Full backlog** in `BACKLOG.md` (bugs/issues) and `alpha-3/BACKLOG.md` (127+ items).

| Category | Items | Status |
|----------|-------|--------|
| Targeting redesign (TX-*) | 7 | ✅ Core done (TX-1 through TX-4, TX-7) |
| Bot mitigation (BM-*) | 9 | BM-2, BM-5, BM-7, BM-8, BM-9 done; BM-3, BM-6 open |
| Security HIGH | 4 | ✅ All fixed |
| Security MEDIUM | 6 | 4 fixed, 2 open (AttestationVerifier open-campaign, drainFraction precision) |
| Security LOW | 5 | 2 fixed, 3 open (low risk) |
| Pre-mainnet (S12 governance blocklist) | 1 | Open — hybrid admin/governance blocklist needs contract change |
| Extension UX (B-*) | 6 | ✅ B1-B6 done (filters tab, in-ad dismiss, publisher profile) |
| Pre-mainnet gate (MG-*) | 7 | External audit, Kusama deploy — not started |

---

## Directory Layout

```
datum/
├── alpha-3/          # Canonical contracts (20), tests (219), extension (165 tests)
├── web/              # Web app (React + Vite, 28 pages, 20-contract support)
├── sdk/              # Publisher SDK (datum-sdk.js)
├── docs/             # Demo page + relay template
├── relay-bot/        # Publisher relay (gitignored) — BM-8/BM-9 wired
├── archive/          # PoC, alpha (9), alpha-2 (13), old extensions
├── SECURITY-AUDIT.md # 3-part audit with fix status tracker
├── BACKLOG.md        # Bugs, issues, missing features
├── STATUS.md         # This file
└── README.md         # Project overview + role-based system flow analysis
```
