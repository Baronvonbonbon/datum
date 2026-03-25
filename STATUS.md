# DATUM Project Status

**Last Updated:** 2026-03-25
**Current Phase:** Alpha-2 (canonical)
**Testnet:** Paseo (Chain ID 420420417)

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub (PolkaVM). Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

The protocol is live on Paseo testnet with 9 alpha contracts. Alpha-2 (13 contracts) is fully tested but not yet deployed. The alpha-2 browser extension is built (165/165 tests, Blake2-256, P1 attestation, EIP-1193 provider bridge). A web app covers all advanced flows. The critical path to mainnet is relay Blake2 migration, deploy scripts, and alpha-2 testnet deployment.

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

Live systemd service for Diana on localhost:3400. Co-signs attestations, processes claim batches via `DatumRelay.settleClaimsFor()`.

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployment (Paseo)

| Item | Value |
|------|-------|
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Currency | PAS |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher 1 | Diana `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` (50% take, all 26 categories) |
| Campaign #1 | Bob → Diana, 10 PAS, Active |
| Vote #1 | Frank, Aye, 100 PAS |

9 alpha contracts deployed + wired + ownership transferred. 6 accounts funded. Private keys in gitignored `alpha/DEPLOY-TESTNET.md`.

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

### 1. Blake2 Claim Hash Migration

Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`. Claims will fail validation until both sides match.

- **Extension: DONE** — `@noble/hashes/blake2.js` in claimBuilder, behaviorChain, behaviorCommit. 165/165 tests.
- **Relay bot: PENDING** — must switch from keccak256 to Blake2-256 before testnet deploy.

### 2. Alpha-2 Deploy Scripts

Update `alpha/scripts/deploy.ts` for 13-contract deployment:
- Settlement `configure()` now takes 5 args (budgetLedger, paymentVault, lifecycle, relay, publishers)
- CampaignLifecycle 2-arg constructor
- `setAttestationVerifier()` for P1
- New wiring for BudgetLedger, PaymentVault, CampaignLifecycle, AttestationVerifier

### 3. Alpha-2 Testnet Deploy

Deploy 13 contracts to Paseo, run setup-testnet.ts, verify E2E.

### 4. A3.5 Open Testing

Publish addresses, document external tester flow, monitor events.

---

## Backlog

| ID | Item | Notes |
|----|------|-------|
| BL-1 | Claim submit CAPTCHA | Bot-resistance before settlement (PoW puzzle, publisher-hosted, or nonce commitment) |
| BL-2 | ZK proof integration | Replace zkProofStub with real Groth16 circuit. Needs BN128 precompile on PolkaVM. |
| 4D-P3 | UI polish | UP-2 blocklist UI, UP-4/5/7/8, GV-4 timelock decode, EA-1/2, AD-1/2 |
| — | S12 mainnet migration | Blocklist must be timelock-gated before mainnet. Governance-managed (Option C hybrid). |
| — | Relay settlement web UI | Web page for `DatumRelay.settleClaimsFor()` (currently extension-only) |
| — | Attested settlement web UI | Web page for `DatumAttestationVerifier.settleClaimsAttested()` |
| — | Relay Blake2 migration | Relay bot must switch claim hash from keccak256 to Blake2-256 |

---

## Directory Layout

```
datum/
├── alpha-2/          # Canonical contracts (13), tests, extension (165 tests), process flows
├── web/              # Web app (React + Vite, 24 pages)
├── sdk/              # Publisher SDK (datum-sdk.js)
├── docs/             # Demo page + relay template
├── relay-bot/        # Publisher relay (gitignored)
├── archive/          # PoC, alpha contracts, alpha extension, old extension, superseded docs
├── STATUS.md         # This file
└── README.md         # Project overview
```
