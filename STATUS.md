# DATUM Project Status

**Last Updated:** 2026-05-08
**Current Phase:** Alpha-4 v0.4.0 — EVM-optimized refactor; webapp migrated; dual-target deploys live on Paseo
**Testnet:** Paseo (PVM, Chain ID 420420417) + Paseo EVM (dual-target)
**Web App:** https://datum.javcon.io

---

## Summary

DATUM is a decentralized ad exchange on Polkadot Hub. Users earn DOT for viewing ads, publishers set their own take rates, advertisers get verifiable impressions, and governance voters curate campaign quality with conviction-weighted staking.

**Alpha-4** is the active line. 21 production contracts (8 alpha-3 satellites merged into core contracts), webapp migrated to 21-contract addressing, deployed to Paseo PVM 2026-05-06 (resolc 1.1.0). A parallel **dual-target EVM build** of the 29-contract alpha-3 layout is also deployed to Paseo EVM (2026-05-03) for benchmarking and EVM-parachain readiness. **Alpha-3** remains in-tree as the canonical 29-contract reference and last v9 PVM deploy (2026-05-02).

Newest unreleased work (uncommitted): **hybrid dual-sig settlement** — `DatumSettlement.settleSignedClaims()` adds a permissionless path requiring publisher + advertiser EIP-712 co-sigs over the same `ClaimBatch` envelope, alongside the existing relay (`userSig + optional publisherSig`) path. Either party can refute by withholding their signature. 8 new tests (D1–D8) green; full alpha-4 suite 532/532.

---

## Components

### Smart Contracts — `alpha-4/contracts/` (canonical)

**21 production contracts** (PVM build) / **29-contract dual-target EVM build**. **532/532 alpha-4 contract tests passing.**

| Contract | Group | Role | PVM | EVM |
|----------|-------|------|-----|-----|
| ZKVerifier | Infrastructure | Real Groth16/BN254 verifier; verifying key set | ✅ | ✅ |
| PauseRegistry | Infrastructure | Global emergency pause; 2-of-3 guardian unpause | ✅ | ✅ |
| Timelock | Infrastructure | 48h admin delay for sensitive config | ✅ | ✅ |
| PaymentVault | Infrastructure | Pull-payment vault (publisher/user/protocol DOT) | ✅ | ✅ |
| TokenRewardVault | Infrastructure | Pull-payment vault for ERC-20 sidecar token rewards | ✅ | ✅ |
| BudgetLedger | Campaign | Campaign escrow + daily caps | ✅ | ✅ |
| Campaigns | Campaign | Creation, metadata, status, snapshots, token reward config | ✅ | ✅ |
| CampaignLifecycle | Campaign | complete / terminate / expire + 30d inactivity timeout | ✅ | ✅ |
| ClaimValidator | Settlement | Chain continuity, blocklist, rate-limit, ZK, publisher stake | ✅ | ✅ |
| Settlement | Settlement | Hash-chain + Blake2 + 3-way DOT split + dual-sig path; absorbs RateLimiter, NullifierRegistry, Reputation | ✅ | ✅ |
| AttestationVerifier | Settlement | EIP-712 mandatory publisher co-signature | ✅ | ✅ |
| Publishers | Publisher | Registration, take rates, relay signer, profile, S12 blocklist | ✅ | ✅ |
| Relay | Publisher | Gasless relay path with `userSig` + optional `publisherSig` | ✅ | ✅ |
| GovernanceV2 | Governance | Conviction voting (9 levels), symmetric slash; absorbs Helper + Slash | ✅ | ✅ |
| AdminGovernance | Governance | Phase 0: team direct approval (current active governor) | (merged) | ✅ |
| GovernanceRouter | Governance | Stable-address proxy; Phase 0 → 1 → 2+ via Timelock | ✅ | ✅ |
| Council | Governance | Phase 1: N-of-M trusted council voting | ✅ | ✅ |
| PublisherStake | FP | FP-1+FP-4: publisher DOT bonding curve; settlement enforces | ✅ | ✅ |
| ChallengeBonds | FP | FP-2: advertiser bonds at creation; bonus on fraud upheld | ✅ | ✅ |
| PublisherGovernance | FP | FP-3: conviction-weighted fraud governance targeting publishers | ✅ | ✅ |
| ParameterGovernance | FP | FP-15: conviction-vote DAO for protocol parameters | ✅ | ✅ |
| ClickRegistry | FP | FP-6: click-fraud detection (deployed in alpha-4 PVM) | ✅ | — |
| TargetingRegistry | Campaign | Tag-based targeting (alpha-3 satellite, EVM-only in alpha-4) | (merged) | ✅ |
| CampaignValidator | Campaign | Creation-time validation satellite (EVM-only) | (merged) | ✅ |
| GovernanceHelper | Governance | Read-helper aggregation (EVM-only) | (merged) | ✅ |
| GovernanceSlash | Governance | Slash pool finalization (EVM-only) | (merged) | ✅ |
| Reports | Satellite | Community reporting (EVM-only) | (merged) | ✅ |
| SettlementRateLimiter | Settlement | BM-5: per-publisher window cap (EVM-only) | (merged) | ✅ |
| PublisherReputation | Satellite | BM-8/9 settlement reputation (EVM-only) | (merged) | ✅ |
| NullifierRegistry | FP | FP-5: ZK nullifier replay prevention (EVM-only) | (merged) | ✅ |

**Alpha-4 merger plan:** 8 alpha-3 satellites collapsed into core contracts to fit PVM bytecode constraints under resolc 1.1.0. The EVM dual-target build keeps satellites separate so behavior is benchmarked and audit-ready against the canonical 29-contract layout.

**Hybrid settlement (uncommitted, today):**
- `Settlement.settleSignedClaims(SignedClaimBatch[])` — permissionless dual-sig path. Both parties sign EIP-712 `ClaimBatch(user, campaignId, claimsHash, deadline)` on the **DatumSettlement** domain. Publisher sig accepts EOA *or* its registered `relaySigner`; advertiser sig must match `campaigns.getCampaignAdvertiser`. Errors: `E81` deadline, `E82` publisher sig, `E83` advertiser sig.
- `SignedClaimBatch` struct gains `userSig` (renamed from `signature`) and new `advertiserSig`. Existing relay path uses `userSig + publisherSig`.

**Toolchain:** Solidity 0.8.24, resolc 1.1.0 (PVM) / solc cancun (EVM), Hardhat 2.22, OZ 5.0, optimizer mode `z`.

---

### Browser Extension — `alpha-4/extension/`

v0.4.0, 21-contract support. **212 Jest tests passing.** Manifest V3, Chrome/Chromium. ABIs synced from alpha-4 artifacts (incl. updated `DatumRelay`/`DatumSettlement` after dual-sig refactor).

**4-tab popup:** Claims, Earnings, Settings, Filters.

Key features (carried forward from alpha-3, retargeted at alpha-4 contracts):
- **IAB ad format system** — 7 standard sizes; SDK sizes placeholder div to exact dimensions; format-priority creative image selection
- **Per-format creative images** — `creative.images[]` with `{ format, url, alt? }` entries; horizontal layout for leaderboard/mobile-banner, vertical for the rest
- **Event-driven campaign polling** — incremental from lastBlock, O(1) Map index
- **Batch-parallel RPC** — 20 concurrent status refreshes, 5 concurrent IPFS fetches
- **Blake2-256 claim hashing** — `@noble/hashes/blake2.js` matches Settlement on PolkaVM
- **P1 attestation path** — `AttestationVerifier.settleClaimsAttested()` with publisher EIP-712 co-sig
- **Filters tab** — tag-based campaign filtering, silenced campaigns
- **In-ad dismiss / Report** — popover with topic-level mute and reason picker
- **Publisher profile + FP state** in Settings (relay signer, profile hash, stake balance, challenge bond)
- **Second-price Vickrey auction** — interest-weighted bids, mechanism badge
- **Native Asset Hub token metadata** — registry fallback for ERC-20 precompile addresses
- **Hybrid sig support** — `SignedClaimBatch` interface now carries `userSig`, `publisherSig`, `advertiserSig`
- EIP-1193 provider bridge, IPFS multi-gateway, Shadow DOM injection, AES-256-GCM multi-account wallet, auto-submit, claim export, timelock monitor

---

### Web App — `web/`

v0.4.x, React 18 + Vite 6 + TypeScript + ethers v6. **41 page TSX files**, 0 TS errors. **Migrated to alpha-4 21-contract addressing.**

Core sections: Explorer, Advertiser, Publisher, Governance, Admin, Demo + Settings. Native Asset Hub token precompile support in CreateCampaign. Challenge bond display in CampaignDetail. Theme toggle, role badges, live Vickrey auction simulation.

**ABIs synced:** 21 entries in `web/src/shared/abis/` matching alpha-4. `DatumRelay.json` and `DatumSettlement.json` re-synced today after dual-sig struct change.

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

Lightweight JS tag (~3 KB). `<script data-publisher="0x..." data-slot="medium-rectangle">` + `<div id="datum-ad-slot">`. Sizes placeholder div to exact IAB dimensions. Challenge-response handshake with extension for two-party attestation.

---

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service for Diana on localhost:3400. Co-signs attestations and forwards claim batches via `DatumRelay.settleClaimsFor()` using the EIP-712 `userSig` + optional `publisherSig` envelope. After each batch: parses `ClaimSettled`/`ClaimRejected` events, aggregates per `(publisher, campaignId)` pair, calls `recordSettlement` on the Settlement reputation slot. Accepts legacy `signature` payloads transparently for backward compatibility.

---

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Testnet Deployments

### Alpha-4 PVM (Paseo) — 2026-05-06

| Contract | Address |
|----------|---------|
| PauseRegistry | `0x03458E616a9C9460f0A63023b63B18a84C51EC82` |
| Timelock | `0x0125909A25537422014eCE8b422A0c802f47b411` |
| ZKVerifier | `0xd3C086583581DaFd2226365A4B1E1bEb13b4f3a2` |
| Publishers | `0x4D6d100F139bF13081abb8037472cd67A89519B2` |
| BudgetLedger | `0xfF1DaA7CB3187EBb4D249567114e208fF4390B18` |
| PaymentVault | `0x4fdE02a4c0aFfef31DC36D741F6a596A2aA87Fb6` |
| Campaigns | `0x364038B8d3E8fBEFA81D3D1249C4b62d5765880b` |
| CampaignLifecycle | `0x4BE26c6078497C31f7310524F0e6f09d8A51C8b6` |
| Settlement | `0x16F1fB8e96840cb2E50Db3D165683807761f568C` |
| ClaimValidator | `0x90EfB06Ad1f4c59a07863F2ddDe8e6cad411Ac84` |
| GovernanceV2 | `0xE195CCC5dA11567b3501379985B5dfa4f0EC40b4` |
| Relay | `0x82705970AF14754F61dAb6374a7ae9DC0a2706E1` |
| AttestationVerifier | `0x765c2e7D64680Ee0987368c8489E89474cF18b0E` |
| TokenRewardVault | `0x2B141116d0c26e8DcBfE08841214147c2F10506d` |
| PublisherStake | `0xe5188a35c2dd926F1cCE35ee6f32a81A1aBa3108` |
| ChallengeBonds | `0x16c9a2Fc8D32D4106db60B38bD1D631E1A654f4D` |
| PublisherGovernance | `0x184254A2e51e3A92f840aCfDE292E926FFAf9DC1` |
| ParameterGovernance | `0x7ee17C46B68808FE22CF4B7deBD86EeB14BdFdC4` |
| GovernanceRouter | `0x99388a88b74Fc51c17A5B6Eb37F6Cc55BF4dD091` |
| Council | `0x90fe17488e1c17C1226F1c384a2Ef826dBFaa241` |
| ClickRegistry | `0x2fe26529a4F3594Bcbccd36e200721e80349A5f4` |

Source: `alpha-4/deployed-addresses.json` (authoritative).

### Alpha-4 EVM dual-target (Paseo EVM) — 2026-05-03

29-contract benchmark deploy mirroring the alpha-3 layout. Source: `alpha-4/deployed-addresses-evm.json`.

### Alpha-3 PVM (Paseo) — 2026-05-02 (v9, resolc 1.1.0)

29-contract reference deploy. Source: `alpha-3/deployed-addresses.json`. Used as the canonical comparison target for alpha-4 functional parity.

### Common parameters

| Item | Value |
|------|-------|
| RPC (PVM) | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select Paseo) |
| Chain ID | 420420417 |
| Currency | PAS (planck = 10⁻¹⁰ PAS) |
| Deployer | Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher | Diana (50% take rate, relay signer) |

---

## Test Totals

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha contracts (archived) | 132 | Passing |
| Alpha-2 contracts (archived) | 187 | Passing |
| Alpha-3 contracts | 546 / 546 | All passing |
| Alpha-4 contracts | 532 / 532 | All passing (incl. 8 new D1–D8 dual-sig) |
| Alpha-4 extension | 212 | Passing |

---

## Critical Path to Mainnet

### ✅ 1. Blake2 Claim Hash — DONE
Settlement on PolkaVM uses Blake2-256 via `ISystem(0x900).hashBlake256()`. Extension + relay use `@noble/hashes/blake2.js`.

### ✅ 2. Alpha-4 Refactor + Deploy — DONE
21-contract PVM build deployed 2026-05-06. 8 satellites merged into core. 29-contract dual-target EVM build deployed 2026-05-03 for parity benchmarking.

### ✅ 3. Webapp Migration to Alpha-4 — DONE
41 pages, 0 TS errors, 21-contract addressing. ABIs synced.

### ✅ 4. Internal Security Audit (30 items) — DONE
SECURITY-AUDIT-2026-04-20.md fully implemented in alpha-3; carried forward to alpha-4. External audit pending.

### ✅ 5. Real ZK Verifier — DONE
Groth16/BN254 verifier live on Paseo. 2-public-input circuit (claimHash, nullifier).

### ✅ 6. Pine RPC Light Client — DONE (alpha)
smoldot-based EIP-1193 provider; eliminates centralized RPC proxy dependency.

### ✅ 7. Fraud Prevention Suite — DONE
PublisherStake, ChallengeBonds, PublisherGovernance, NullifierRegistry, ParameterGovernance live in both alpha-3 and alpha-4.

### ✅ 8. Governance Ladder — DONE
AdminGovernance (Phase 0, active), GovernanceRouter (stable proxy), Council (Phase 1) live.

### ✅ 9. IAB Ad Format System — DONE
7 IAB sizes, format-priority creative selection, per-format upload, exact-dimension SDK sizing.

### ✅ 10. Hybrid Dual-Sig Settlement — DONE (uncommitted, 2026-05-08)
`Settlement.settleSignedClaims` permissionless path with publisher + advertiser EIP-712 co-sigs. 8 new tests (D1–D8). Extension/web/relay-bot all updated to the new struct layout.

### 11. E2E Browser Validation
Full flow on Paseo against alpha-4 PVM addresses: load extension, create impression, settle on-chain, confirm earnings.

### 12. Open Testing
Publish addresses, document external tester flow, monitor events.

### 13. External Security Audit
Professional audit before Kusama/Polkadot Hub deployment.

---

## Economics Reference

See `alpha-4/ECONOMICS.md` for full break-even analysis by role (publisher, user, advertiser, voter). Constants are unchanged from alpha-3.

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

| Category | Items | Status |
|----------|-------|--------|
| Targeting redesign (TX-*) | 7 | ✅ Core done (TX-1–TX-4, TX-7) |
| Bot mitigation (BM-*) | 9 | ✅ BM-2, BM-3, BM-5, BM-7, BM-8, BM-9 done; BM-6 deferred |
| Fraud prevention (FP-*) | 5 deployed | ✅ FP-1–FP-5, FP-15 deployed; FP-6 ClickRegistry deployed in alpha-4; FP-8 partial; others deferred |
| Internal security audit | 30 | ✅ All implemented |
| Governance ladder | 3 | ✅ AdminGovernance + Router + Council deployed |
| IAB ad format system | 1 | ✅ Done |
| Hybrid dual-sig settlement | 1 | ✅ Done (uncommitted) |
| Pre-mainnet (S12 governance blocklist) | 1 | Open — hybrid admin/governance blocklist contract change |
| User economics (UX + payout) | 4 | ✅ Token withdrawal, ERC-20 approve flow, auto-sweep done; cross-campaign batching open |
| Native Asset Hub token sidecar | 1 | ✅ Done |
| Pine RPC | 3 | Alpha done; subscriptions + production hardening open |
| Pre-mainnet gate (MG-*) | 7 | External audit, Kusama deploy — not started |

---

## Directory Layout

```
datum/
├── alpha-4/         # Active line — 21 contracts (PVM) + 29-contract EVM dual-target build
│   ├── contracts/   # 21 deployable + 5 mocks
│   ├── test/        # 532 tests
│   ├── extension/   # 212 tests, 21-contract ABIs
│   └── ECONOMICS.md
├── alpha-3/         # 29-contract canonical reference; v9 PVM deploy 2026-05-02
├── web/             # React + Vite, 41 pages, alpha-4 21-contract addressing
├── sdk/             # Publisher SDK (datum-sdk.js, ~3 KB)
├── pine/            # Pine RPC: smoldot light-client eth JSON-RPC bridge
├── docs/            # Demo page + relay template
├── relay-bot/       # Publisher relay (gitignored) — userSig/publisherSig EIP-712
├── archive/         # PoC, alpha (9), alpha-2 (13), old extensions
├── BENCHMARKS.md
├── SECURITY-AUDIT-2026-04-20.md
├── BACKLOG.md
├── STATUS.md        # This file
└── README.md
```
