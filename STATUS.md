# DATUM Project Status

**Last Updated:** 2026-03-31
**Current Phase:** Alpha-3 (canonical, deployed on Paseo)
**Testnet:** Paseo (Chain ID 420420417)
**Web App:** https://datum.javcon.io

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub (PolkaVM). Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

Alpha-3 is deployed. 17 contracts are live on Paseo testnet (deployed 2026-03-31). The web app is live at **https://datum.javcon.io**. The alpha-3 browser extension is built (165/165 tests, 17-contract, event-driven polling, O(1) lookups). All CRITICAL and HIGH security findings fixed (2026-03-28). Alpha-2 archived.

---

## Components

### Smart Contracts — `alpha-3/contracts/` (canonical)

17 contracts, 219/219 Hardhat EVM tests.

| Contract | Role |
|----------|------|
| ZKVerifier | Stub (real Groth16 post-alpha) |
| PauseRegistry | Global emergency pause |
| PaymentVault | Pull-payment vault (publisher/user/protocol) |
| Timelock | Single-slot governance delay |
| BudgetLedger | Campaign escrow + daily caps |
| Publishers | Registration, take rates, S12 blocklist, allowlists |
| AttestationVerifier | P1 mandatory publisher co-signature |
| GovernanceSlash | Symmetric slash on losing voters |
| CampaignLifecycle | Complete/terminate/expire + P20 inactivity |
| Campaigns | Campaign creation, metadata, status |
| TargetingRegistry | Tag-based targeting (bytes32 hashes, AND-logic) |
| CampaignValidator | Cross-contract campaign creation validation |
| ClaimValidator | Claim validation logic (extracted from Settlement) |
| Relay | Optional publisher co-signed settlement |
| GovernanceV2 | Conviction voting (9 levels, 0-8) |
| GovernanceHelper | Read-only governance aggregation |
| Settlement | Claim validation + Blake2 hash chain |

**New in alpha-3 (vs alpha-2):**
- 4 satellite contracts: TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper
- GovernanceV2 constructor: 8 params (added pauseRegistry)
- Security fixes: C-1 slash drain, C-2 reentrancy, H-1 timelock, H-2 return data, H-3 GovernanceV2 pause
- 219 tests (up from 187)

**Toolchain:** Solidity 0.8.24, resolc 1.0.0, Hardhat 2.22, OZ 5.0

### Browser Extension — `alpha-3/extension/` (alpha-3)

v0.4.0 (alpha-3, 17-contract). 165/165 Jest tests, 0 webpack errors. Manifest V3, Chrome/Chromium.

3-tab popup (Claims, Earnings, Settings). Advanced flows (Campaigns, Publisher, Advertiser, Governance) in web app.

Key features:
- **Event-driven campaign polling** — CampaignCreated events, incremental from lastBlock, O(1) Map index lookups, no campaign count limit
- **Batch-parallel RPC** — 20 concurrent status refreshes, 5 concurrent IPFS fetches
- **17-contract support** — 4 new satellites (TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper)
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` matches Settlement on PolkaVM
- **P1 attestation path** — submits via `AttestationVerifier.settleClaimsAttested()` with publisher co-sig
- **EIP-1193 provider bridge** — `window.datum` compatible with `ethers.BrowserProvider`
- Vickrey auction, engagement tracking, IPFS multi-gateway, Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit (B1), claim export (P6), timelock monitor (H2)

Previous extensions archived: alpha-2 in `archive/alpha-2/extension/`, alpha in `archive/alpha-extension/`.

### Web App — `web/`

v0.2.0, React 18 + Vite 6 + TypeScript + ethers v6. 0 TS errors.

24 pages across 6 sections:
- **Explorer (4):** Overview, Campaigns, CampaignDetail, Publishers — no wallet required
- **Advertiser (4):** Dashboard, CreateCampaign, CampaignDetail, SetMetadata
- **Publisher (7):** Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup
- **Governance (4):** Dashboard, Vote, MyVotes (with finalize slash flow), Parameters
- **Admin (4):** Timelock, PauseRegistry, Blocklist, ProtocolFees (with dust sweep)
- **Settings (1):** Network, RPC, 17 contract addresses, IPFS pinning config

17-contract support. Deep-merge fix for contractAddresses (new keys preserved on localStorage load). Null guard in contract factory.

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). `<script data-publisher="0x..." data-categories="1,6,26">` + `<div id="datum-ad-slot">`. Challenge-response handshake with extension.

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service for Diana on localhost:3400. Co-signs attestations, processes claim batches via `DatumRelay.settleClaimsFor()`. Blake2-256 claim hashing.

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployment (Paseo)

| Item | Value |
|------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Web App | `https://datum.javcon.io` |
| Currency | PAS |
| Deployed | 2026-03-31 (alpha-3) |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher 1 | Diana `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` (50% take, all 26 categories) |
| Campaign #1 | Bob → Diana, 10 PAS, Active |

### Alpha-3 Contract Addresses (17 contracts, Paseo)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0xA6c70e86441b181c0FC2D4b3A8fC98edf34044b8` |
| Timelock | `0x987201735114fa0f7433A71CFdeFF79f82EB1fE2` |
| ZKVerifier | `0xf65c841F2CEd53802Cbd5E041e65D28d8f5eB4D8` |
| Publishers | `0xB280e7b3D2D9edaF8160AF6d31483d15b0C8c863` |
| BudgetLedger | `0xc683899c9292981b035Cfc900aBc951A47Ed00c8` |
| PaymentVault | `0xF6E62B417125822b33B73757B91096ed6ebb4A2a` |
| TargetingRegistry | `0x668aA4d72FF17205DE3C998da857eBaD94835219` |
| CampaignValidator | `0xCebC8e1E81205b368B4BF5Fc53dAeA0e0b09c08E` |
| Campaigns | `0xd246ede4e6BE1669fecA9731387508a1Eb5A13A3` |
| CampaignLifecycle | `0x6514C058D2De1cd00A21B63e447770780C83dbB5` |
| Settlement | `0xaFF8010109249c3C8f2B5D762002b794Dd14E1d1` |
| ClaimValidator | `0xf1fbe1dfbD78a8E5317001721749382EdB50294a` |
| GovernanceV2 | `0x2F5a0FCEf51a2bD84D71f916E8886Ee35e5139Ff` |
| GovernanceHelper | `0x96c974e7733dc6f570Ae96800d6cc3604A2EA3B9` |
| GovernanceSlash | `0xb1c63CF0f3F27E569757a627FCCc5fe07A7D6BbD` |
| Relay | `0xDa293CbF712f9FF20FF9D7a42d8E989E25E6dd09` |
| AttestationVerifier | `0xA06CAf0A21B8324f611d7Bc629abA16e9d301Fa0` |

17 wiring ops + validation checks completed. Campaigns + Settlement ownership transferred to Timelock.

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

### ~~1. Blake2 Claim Hash Migration~~ — DONE

Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`.
Extension + relay both use `@noble/hashes/blake2.js`.

### ~~2. Alpha-2 Deploy~~ — DONE (archived)

13 contracts deployed to Paseo 2026-03-26. Archived to `archive/alpha-2/`.

### ~~3. Alpha-3 Deploy~~ — DONE

17 contracts deployed to Paseo 2026-03-31. 4 new satellites + security fixes. `deployed-addresses.json` in `alpha-3/`.

### ~~4. Security Audit (CRITICAL/HIGH)~~ — DONE

C-1, C-2, H-1, H-2, H-3 all fixed (2026-03-28).

### 5. E2E Browser Validation

Full flow on Paseo: load extension with live addresses, create impression, submit claim via AttestationVerifier, verify settlement on-chain, confirm user + publisher earnings.

### 6. Open Testing

Publish addresses, document external tester flow, monitor events.

---

## Backlog

**Alpha-3 backlog** (127+ items) in `alpha-3/BACKLOG.md`. Key sections:

| Section | Items | Priority |
|---------|-------|----------|
| Targeting redesign (TX-*) | 7 | Alpha-3 core — tag-based attributes |
| Bot mitigation (BM-*) | 9 | Alpha-3 core — ZK proofs, settlement caps, SDK integrity |
| Contract security (SM/SL-*) | 16 | MEDIUM + LOW from security audit |
| Extension security (XM/XL-*) | 20 | MEDIUM + LOW from security audit |
| Web app security (WS-*) | 12 | MEDIUM + LOW from security audit |
| Pre-mainnet gate (MG-*) | 7 | Timelock blocklist, external audit, Kusama |

---

## Directory Layout

```
datum/
├── alpha-3/          # Canonical contracts (17), tests (219), extension (165 tests)
├── web/              # Web app (React + Vite, 24 pages, 17-contract support)
├── sdk/              # Publisher SDK (datum-sdk.js)
├── docs/             # Demo page + relay template
├── relay-bot/        # Publisher relay (gitignored)
├── archive/          # PoC, alpha (9), alpha-2 (13), old extensions
├── SECURITY-AUDIT.md # 3-part audit with fix status tracker
├── STATUS.md         # This file
└── README.md         # Project overview
```
