# DATUM Project Status

**Last Updated:** 2026-03-29
**Current Phase:** Alpha-2 (canonical) / Alpha-3 (planning, `alpha-3` branch)
**Testnet:** Paseo (Chain ID 420420417)
**Web App:** https://datum.javcon.io

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub (PolkaVM). Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

Alpha-2 is deployed. 13 contracts are live on Paseo testnet (deployed 2026-03-26). The web app is live at **https://datum.javcon.io**. The alpha-2 browser extension is built (165/165 tests, Blake2-256, P1 attestation, EIP-1193 provider bridge). All CRITICAL and HIGH security findings fixed (2026-03-28). Web app fade-in bug fixed + DATUM extension provider injection fixed for datum.javcon.io (2026-03-29). Alpha-3 backlog created (131 items, 17 sections) on `alpha-3` branch — covers targeting redesign, bot mitigation, satellite extraction, and all remaining security findings.

---

## Components

### Smart Contracts — `alpha-2/contracts/` (canonical)

13 contracts, all under 49,152 B PVM limit, 187/187 Hardhat EVM tests.

| Contract | PVM Size | Spare | Role |
|----------|----------|-------|------|
| ZKVerifier | 1,409 | — | Stub (real Groth16 post-alpha) |
| PauseRegistry | 4,047 | — | Global emergency pause |
| PaymentVault | 17,341 | 31,811 | Pull-payment vault (publisher/user/protocol) |
| Timelock | 18,342 | — | Single-slot governance delay |
| BudgetLedger | 29,809 | 19,343 | Campaign escrow + daily caps |
| Publishers | 35,741 | 13,411 | Registration, categories, S12 blocklist, allowlists |
| AttestationVerifier | 37,086 | 12,066 | P1 mandatory publisher co-signature |
| GovernanceSlash | 37,160 | 11,992 | Symmetric slash on losing voters |
| CampaignLifecycle | 40,910 | 8,242 | Complete/terminate/expire + P20 inactivity |
| Campaigns | 42,466 | 6,686 | Campaign creation, metadata, status |
| Relay | 46,872 | 2,280 | Optional publisher co-signed settlement |
| GovernanceV2 | 47,939 | 1,213 | Conviction voting (9 levels, 0-8) |
| Settlement | 48,052 | 1,100 | Claim validation + Blake2 hash chain |

**Key features over alpha:**
- P1: Mandatory publisher attestation for all campaigns (including open)
- P20: 30-day inactivity timeout (432,000 blocks) — permissionless expiry
- S12: Global blocklist + per-publisher advertiser allowlists
- O1: Blake2-256 claim hashing on PolkaVM (keccak256 fallback on EVM)
- O3: Existential deposit dust guard in PaymentVault
- Escalating conviction curve: weights [1,2,3,4,6,9,14,18,21], lockups [0,1d,3d,7d,21d,90d,180d,270d,365d]

**Security fixes applied (2026-03-28):** C-1 slash pool drain, C-2 reentrancy guard, H-1 timelock overwrite, H-2 return data validation, H-3 GovernanceV2 pause. GovernanceV2 constructor now 8 params (added pauseRegistry).

**Toolchain:** Solidity 0.8.24, resolc 1.0.0, Hardhat 2.22, OZ 5.0

### Browser Extension — `alpha-2/extension/` (alpha-2)

v0.3.0 (alpha-2, 13-contract). 165/165 Jest tests, 0 webpack errors. Manifest V3, Chrome/Chromium.

3-tab popup (Claims, Earnings, Settings). Advanced flows (Campaigns, Publisher, Advertiser, Governance) moved to web app.

Key features:
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` matches Settlement on PolkaVM
- **P1 attestation path** — submits via `AttestationVerifier.settleClaimsAttested()` with publisher co-sig per batch
- **EIP-1193 provider bridge** — `window.datum` compatible with `ethers.BrowserProvider` for web app integration
- **Relay POST** — `signForRelay()` POSTs signed batches to publisher relay endpoints
- Vickrey auction, engagement tracking, IPFS multi-gateway, Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit (B1), claim export (P6), timelock monitor (H2)

Previous alpha extension (140/140 tests, 9-contract) archived in `archive/alpha-extension/`.

### Web App — `web/`

v0.1.0, React 18 + Vite 6 + TypeScript + ethers v6. 0 TS errors, builds to 220 KB gzip.

24 pages across 6 sections:
- **Explorer (4):** Overview, Campaigns, CampaignDetail, Publishers — no wallet required
- **Advertiser (4):** Dashboard, CreateCampaign, CampaignDetail, SetMetadata
- **Publisher (7):** Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup
- **Governance (4):** Dashboard, Vote, MyVotes (with finalize slash flow), Parameters
- **Admin (4):** Timelock, PauseRegistry, Blocklist, ProtocolFees (with dust sweep)
- **Settings (1):** Network, RPC, contract addresses, Pinata API key

Shared library in `web/src/shared/` — all 13 alpha-2 ABIs, types, networks, conviction curve, error codes, IPFS utils, content safety.

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). `<script data-publisher="0x..." data-categories="1,6,26">` + `<div id="datum-ad-slot">`. Challenge-response handshake with extension.

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service for Diana on localhost:3400. Co-signs attestations, processes claim batches via `DatumRelay.settleClaimsFor()`. Blake2-256 claim hashing migrated (matches Settlement on PolkaVM).

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
| Deployed | 2026-03-26 |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher 1 | Diana `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` (50% take, all 26 categories) |
| Campaign #1 | Bob → Diana, 10 PAS, Active |
| Vote #1 | Frank, Aye, 100 PAS |

### Alpha-2 Contract Addresses (13 contracts, Paseo)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0xEE1C347bDd5A552DC7CEDFdC51903ec7C82EC52D` |
| Timelock | `0x7CE40Ff62073f64fA6061A39023342Ab6Cf7c8Cc` |
| ZKVerifier | `0x80C547a15C59e26317C85C32C730e85F8067D87D` |
| Publishers | `0x903D787B06B4b1E0036b162C3EfFd9984e73620b` |
| BudgetLedger | `0xbCB853B7306fa27866717847FAD0a11f5bd65261` |
| PaymentVault | `0x31D64e88318937CeA791A4E54Bc9abCeab51d23C` |
| Campaigns | `0xd14f889c1DafC1AD47788bfA47890353596380b9` |
| CampaignLifecycle | `0xb789c62b90d525871ECCF54E5d0D5Eae87BF62fe` |
| Settlement | `0x13bF0d24C67b7a5354c675e00D7154bcc4A5738E` |
| GovernanceV2 | `0xcb2B5b586E0726A7422eb4E5bD049382a19769A4` |
| GovernanceSlash | `0x7A3032672bd5AeA348aD203287DedA58A62401ae` |
| Relay | `0x4D8B2CE56D40a3c423A7C1b91861C6186ceb59Ef` |
| AttestationVerifier | `0x1d84219251e8750FB7121AE92b2994887dDd9E18` |

16 wiring ops + 22 validation checks completed. Campaigns + Settlement ownership transferred to Timelock. 6 accounts funded. Private keys in gitignored `alpha/DEPLOY-TESTNET.md`.

---

## Test Totals

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha contracts | 132 | Passing (archived) |
| Alpha-2 contracts | 187 | Passing |
| Extension (alpha-2) | 165 | Passing |
| **Total** | **484** | **All passing** |

---

## Critical Path to Mainnet

### ~~1. Blake2 Claim Hash Migration~~ — DONE

Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`.

- **Extension: DONE** — `@noble/hashes/blake2.js` in claimBuilder, behaviorChain, behaviorCommit. 165/165 tests.
- **Relay bot: DONE** — `@noble/hashes/blake2.js` in test-submit.mjs + blake2Hash utility in relay-bot.mjs.

### ~~2. Alpha-2 Deploy Scripts~~ — DONE

`alpha-2/scripts/deploy.ts` — 13-contract deploy in dependency order, 16 wiring operations, 22 validation checks, ownership transfer, re-run safety (B2). Writes `deployed-addresses.json` to `alpha-2/` and `alpha-2/extension/`.

`alpha-2/scripts/setup-testnet.ts` — funds 6 accounts, registers 2 publishers, creates test campaign, votes aye, sets metadata.

Usage: `npx hardhat run scripts/deploy.ts --network polkadotTestnet`

### ~~3. Alpha-2 Testnet Deploy~~ — DONE

13 contracts deployed to Paseo 2026-03-26. setup-testnet.ts run. Web app live at https://datum.javcon.io. Contract addresses in `alpha-2/deployed-addresses.json`.

### 3. E2E Browser Validation

Full flow on Paseo: load extension with live addresses, create impression, submit claim via AttestationVerifier, verify settlement on-chain, confirm user + publisher earnings.

### 4. A3.5 Open Testing

Publish addresses, document external tester flow, monitor events.

---

## Backlog

**Alpha-3 backlog** (131 items) in `alpha-3/BACKLOG.md` on the `alpha-3` branch. Key sections:

| Section | Items | Priority |
|---------|-------|----------|
| Targeting redesign (TX-*) | 7 | Alpha-3 core — replaces category bitmask with tag-based attributes |
| Bot mitigation (BM-*) | 9 | Alpha-3 core — ZK proofs, settlement caps, SDK integrity |
| Satellite extraction (SE-*) | 4 | Alpha-3 core — free PVM headroom in frozen contracts |
| Contract security (SM/SL-*) | 16 | MEDIUM + LOW from security audit |
| Extension security (XM/XL-*) | 20 | MEDIUM + LOW from security audit |
| Web app security (WS-*) | 12 | MEDIUM + LOW from security audit |
| Pre-mainnet gate (MG-*) | 7 | Timelock blocklist, external audit, Kusama |

**Alpha-2 remaining:**

| Item | Status |
|------|--------|
| E2E browser validation on Paseo | Pending — extension + relay + web app full flow |
| Open testing (3+ external testers) | Pending |
| ~~Security audit (CRITICAL/HIGH)~~ | **DONE** (2026-03-28) |
| ~~Relay Blake2 migration~~ | **DONE** |

---

## Directory Layout

```
datum/
├── alpha-2/          # Canonical contracts (13), tests, extension (165 tests), process flows
├── alpha-3/          # Alpha-3 planning (BACKLOG.md — 131 items, on alpha-3 branch)
├── web/              # Web app (React + Vite, 24 pages)
├── sdk/              # Publisher SDK (datum-sdk.js)
├── docs/             # Demo page + relay template
├── relay-bot/        # Publisher relay (gitignored)
├── archive/          # PoC, alpha contracts, alpha extension, old extension, superseded docs
├── SECURITY-AUDIT.md # 3-part audit with fix status tracker
├── STATUS.md         # This file
└── README.md         # Project overview
```
