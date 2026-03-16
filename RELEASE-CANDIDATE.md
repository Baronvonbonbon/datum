# DATUM Alpha — Polkadot Hub TestNet Release Summary

**Date:** 2026-03-16
**Version:** 2.1
**Status:** Deployed to Polkadot Hub TestNet (Chain ID 420420417). ECRecover verified. Test campaign active. Pending browser E2E on testnet → open testing.

---

## What This Is

DATUM is a decentralized advertising protocol built on Polkadot Hub (pallet-revive). Users earn DOT for viewing ads. Publishers monetize content. Advertisers pay per-impression with on-chain settlement. Governance is conviction-weighted with symmetric slash penalties.

The alpha release is a full-stack system: 9 Solidity contracts compiled to PolkaVM and deployed to Polkadot Hub TestNet, a Chrome MV3 browser extension (7 tabs), a publisher SDK, deploy/test scripts, and comprehensive documentation.

---

## Contract System (9 contracts, all < 49,152 B PVM)

| Contract | PVM Size | Spare | Purpose |
|----------|----------|-------|---------|
| **DatumPauseRegistry** | 4,047 B | 45,105 B | Global emergency pause circuit breaker |
| **DatumTimelock** | 18,342 B | 30,810 B | 48-hour admin timelock for contract reference changes |
| **DatumPublishers** | 22,614 B | 26,538 B | Publisher registry + configurable take rates (30-80%) + category bitmask (26 categories) |
| **DatumCampaigns** | 48,662 B | 490 B | Campaign lifecycle, budget escrow, open campaigns, manual reentrancy guard |
| **DatumGovernanceV2** | 39,693 B | 9,459 B | Conviction voting, campaign evaluation, symmetric slash, anti-grief termination protection |
| **DatumGovernanceSlash** | 30,298 B | 18,854 B | Slash pool finalization + proportional winner claims |
| **DatumSettlement** | 48,820 B | 332 B | Hash-chain claim validation, 3-way payment split (publisher/user/protocol) |
| **DatumRelay** | 46,180 B | 2,972 B | EIP-712 user signature verification + optional publisher co-signature |
| **DatumZKVerifier** | 1,409 B | 47,743 B | Stub ZK verifier (accepts any non-empty proof) |

**Architecture:** PauseRegistry → Timelock → Publishers → Campaigns → GovernanceV2/GovernanceSlash → Settlement → Relay → ZKVerifier. Campaigns + Settlement ownership transferred to Timelock post-deploy.

### Key Contract Features

- **Campaign lifecycle:** Pending → Active → Completed/Terminated/Expired, with pause/resume. Open campaigns (publisher=address(0)) allow any matching publisher.
- **Conviction governance:** Vote with conviction 0-6 (1x to 64x weight, lockup 24h to 365d). Majority + quorum model. Symmetric slash: losing side forfeits slashBps (10%) on withdrawal.
- **Anti-grief termination protection:** `terminationQuorum` (E52) requires minimum nay stake, `terminationGraceBlocks` (E53) enforces ~24h window after first nay before termination can execute. Prevents cheap 1-DOT griefing attacks on active campaigns.
- **Settlement:** Hash-chain validation with per-(user, campaign) nonce tracking. Revenue: `totalPayment = (clearingCpm × impressions) / 1000`. Split: publisher gets takeRate%, remainder split 75% user / 25% protocol.
- **Relay:** Gasless settlement via publisher relay with EIP-712 signatures. Publisher co-signature optional (degraded trust mode for open campaigns).
- **System precompile:** GovernanceV2 uses `minimumBalance()` (0x0900) to prevent dust transfers below existential deposit (E58).

### Error Codes

51 unique error codes (E00-E58, P, reason codes 1-12) covering zero addresses, access control, governance states, settlement validation, reentrancy, dust prevention, and paused state.

---

## Browser Extension (Chrome MV3)

**Build output:** popup.js 603 KB, background.js 377 KB, content.js 33 KB — 0 webpack errors.

### 7 Popup Tabs

| Tab | Component | Features |
|-----|-----------|----------|
| **Campaigns** | CampaignList.tsx | Active/Pending/Paused campaigns, block/unblock, category filter (persisted), expandable info with IPFS metadata links, creative preview, CTA URL, auto-hide resolved |
| **Claims** | ClaimQueue.tsx | Pending claims queue, submit direct or via relay, sign for publisher co-sig, earnings estimate, attestation badges, encrypted export/import (P6) |
| **Earnings** | UserPanel.tsx | DOT balance + withdraw, engagement stats (dwell, viewable, IAB viewability), per-campaign breakdown, minimum withdrawal display |
| **Publisher** | PublisherPanel.tsx | Balance + withdraw, relay submit, take rate management with effective block display, 26 category checkboxes, SDK embed snippet with copy-to-clipboard |
| **My Ads** | AdvertiserPanel.tsx | Campaign creation (open or publisher-specific) with IPFS CID, pause/resume/complete/expire controls, auto-hide resolved |
| **Govern** | GovernancePanel.tsx | Vote with conviction 0-6 (human-readable lockup times), evaluate campaigns, expire pending (nay majority), withdraw with slash, slash finalization + reward claiming, majority+quorum bars, IPFS metadata links, error context (E47/E52/E53) |
| **Settings** | Settings.tsx | Network selector (local/Polkadot Hub TestNet/Paseo/Westend/Kusama/Polkadot Hub), RPC URL with connectivity test, 9 contract addresses with load/validate, IPFS gateway, Pinata API key, auto-submit toggle, ad preferences (max ads/hr, min CPM, silenced categories), interest profile, danger zone |

### Background Service (13 modules)

| Module | Purpose |
|--------|---------|
| **index.ts** | Message router (40+ handlers), alarm-based polling, global pause check, auction-based campaign selection, auto-flush with session-scoped encrypted key |
| **auction.ts** | Vickrey second-price auction — effectiveBid = bidCpm × interestWeight, clearingCpm from 2nd price, solo 70%, floor 30% |
| **campaignPoller.ts** | Polls on-chain campaigns (Active/Pending/Paused), fetches IPFS metadata (10KB cap, schema validation, phishing CTA check), caches metadata + URLs, cleans stale entries |
| **claimBuilder.ts** | Builds claims from impressions with per-(user, campaign) hash chains, mutex for nonce race prevention |
| **claimQueue.ts** | Queue management, batch building for settlement |
| **behaviorChain.ts** | Per-(user, campaign) append-only keccak256 engagement hash chain |
| **behaviorCommit.ts** | Single bytes32 commitment from chain state |
| **interestProfile.ts** | User interest profile with normalized category weights |
| **publisherAttestation.ts** | EIP-712 publisher co-signature via /.well-known/datum-attest (3s timeout, HTTPS enforced) |
| **timelockMonitor.ts** | Polls ChangeProposed/Executed/Cancelled events, surfaces pending admin changes |
| **userPreferences.ts** | Block/silence/rate-limit/minCPM, persisted in chrome.storage.local |
| **walletManager.ts** | Multi-account wallet (AES-256-GCM + PBKDF2 310k iterations), named accounts, switch/rename/delete, legacy migration |
| **zkProofStub.ts** | Dummy ZK proof (`0x01` + behaviorCommit) for stub verifier |

### Content Script (6 modules)

| Module | Purpose |
|--------|---------|
| **index.ts** | SDK detection, category filtering, campaign selection, handshake, ad injection (inline/overlay/default house ad) |
| **adSlot.ts** | Shadow DOM ad rendering, sanitizeCtaUrl (HTTPS only), inline for SDK publishers, overlay/default for others, image support |
| **engagement.ts** | IntersectionObserver viewport tracking, scroll depth, tab focus, IAB viewability (≥50% visible ≥1s) |
| **handshake.ts** | Challenge-response with SDK via CustomEvents, 32-byte random challenge, SHA-256 signature verification |
| **sdkDetector.ts** | Detects datum-sdk.js script tag or datum:sdk-ready event (2s timeout) |
| **taxonomy.ts** | Multi-signal page classification (URL, meta tags, content analysis) into 26 categories |

### Shared Utilities (13 modules)

| Module | Purpose |
|--------|---------|
| **types.ts** | All TypeScript types (Campaign, Claim, Governance, Preferences, Engagement, 26 categories + subcategories) |
| **contracts.ts** | Factory functions for all 9 contract instances + getTimelockContract |
| **walletManager.ts** | Multi-account wallet crypto (encryptPrivateKey/decryptPrivateKey exports) |
| **claimExport.ts** | P6 encrypted export/import (AES-256-GCM, HKDF from wallet signature, merge higher nonce) |
| **errorCodes.ts** | Human-readable error code map (E00-E58, P, reason codes) with dual-meaning context |
| **contentSafety.ts** | Schema validation, field length caps, URL scheme allowlist, content blocklist |
| **phishingList.ts** | Polkadot.js/phishing deny list (6h refresh), parent domain matching, H160 address blocklist |
| **qualityScore.ts** | Engagement quality scoring (dwell 35%, focus 25%, viewability 25%, scroll 15%) — computed in background |
| **ipfs.ts** | CIDv0 ↔ bytes32 encoding |
| **ipfsPin.ts** | Pinata API pin utility |
| **dot.ts** | DOT/planck formatting |
| **networks.ts** | Network configs (local, Polkadot Hub TestNet, Paseo, Westend, Kusama, Polkadot Hub) |
| **messages.ts** | Message type definitions for chrome.runtime.sendMessage |

### Security Layers

| Layer | Protection |
|-------|-----------|
| **Phishing** | 3-layer defense: campaignPoller (CTA URL + advertiser address), content script (CTA re-check), background SELECT_CAMPAIGN (address filter). Polkadot.js/phishing deny list with 6h refresh. |
| **Content safety** | 10KB metadata cap, schema validation, URL scheme allowlist (HTTPS only), content blocklist (multi-word phrases for adult/gambling/drugs/weapons/tobacco/counterfeit) |
| **Ad rendering** | Shadow DOM isolation, `sanitizeCtaUrl()` — unsafe URLs render as non-clickable `<span>` |
| **Wallet** | AES-256-GCM + PBKDF2 (310k iterations), 8-char minimum password, strength indicator, session-scoped auto-submit key |
| **SDK handshake** | Challenge-response with SHA-256 signature verification, rejects spoofed responses |
| **Claim integrity** | Per-(user, campaign) mutex prevents nonce race, hash chain validation |

---

## Publisher SDK

- **datum-sdk.js** (~3 KB): Lightweight JS tag. `<script src="datum-sdk.js" data-categories="1,6,26" data-publisher="0x...">`
- Dispatches `datum:sdk-ready` event, responds to `datum:challenge` with SHA-256 signature
- Extension detects SDK, filters campaigns by category bitmask, performs handshake, injects ad inline into `<div id="datum-ad-slot">`
- **example-publisher.html**: Demo page with full SDK integration

---

## Test Suite

### Hardhat Contract Tests — 132/132 passing

| File | Tests | Coverage |
|------|-------|---------|
| campaigns.test.ts | 26 | Lifecycle (L1-L8), snapshots, publishers, categories, metadata, open campaigns, T6 publisher edges, T7 multi-campaign |
| governance.test.ts | 37 | Voting (V1-V8), withdrawal (W1-W5), evaluation (E1-E9 with anti-grief), slash (S1-S6), dynamic voting (D1-D4), T1 zero-vote, T3 edges |
| integration.test.ts | 6 | Happy path (A), termination (B), pending expiry (C), nonce gaps (D), take rate snapshot (E), publisher relay (F) |
| pause.test.ts | 10 | Global pause (P1-P8), T5 idempotency |
| settlement.test.ts | 35 | Claims (S1-S8), relay (R1-R10), ZK (Z1-Z3), open campaigns (OC1-OC4), T2 edges, T7 multi-batch |
| timelock.test.ts | 18 | Admin timelock (T1-T15), T4 edges |

### Jest Extension Tests — 140/140 passing

| File | Tests | Coverage |
|------|-------|---------|
| auction.test.ts | ~15 | Vickrey auction, effective bid, solo/floor/second-price |
| contentSafety.test.ts | ~25 | Schema validation, URL allowlist, content blocklist |
| dot.test.ts | ~10 | DOT denomination, transfer floor |
| ipfs.test.ts | ~12 | Pinata API, CID encoding |
| phishingList.test.ts | ~20 | Domain blocklist, address blocklist, cache refresh |
| qualityScore.test.ts | ~15 | Quality scoring, threshold validation |
| taxonomy.test.ts | ~12 | Category bitmask, naming, filtering |
| types.test.ts | ~12 | Type definitions, address validation |
| userPreferences.test.ts | ~15 | Preferences persistence, password validation |

### E2E Scripts

- **e2e-full-flow.ts**: 6-section integration test (campaign lifecycle, settlement, withdrawals, pause/unpause, governance slash, timelock). Validated on local devnet.
- **fund-test-accounts.ts**: Creates 24 test accounts (6 config, 11 role-specific, 2 light-funded, 5 ED edge cases).
- **benchmark-gas.ts**: Gas/weight measurement for 6 key contract functions.

---

## Deploy & Operations Scripts (12 files)

| Script | Purpose |
|--------|---------|
| deploy.ts | Full 9-contract deploy + wiring + ownership transfer + post-wire validation + re-run safety |
| setup-testnet.ts | Automated testnet post-deploy: fund 6 accounts, register publishers, create campaign, vote, activate, set metadata |
| setup-test-campaign.ts | Register publisher → create campaign → vote → activate → set metadata (local devnet) |
| e2e-full-flow.ts | 6-section end-to-end validation |
| fund-test-accounts.ts | 24 test accounts with role-based funding |
| benchmark-gas.ts | Gas/weight measurement for key functions |
| fund-wallet.ts | Simple DOT transfer to target address |
| check-state.ts | Query on-chain contract state |
| debug-tx.ts | Transaction debugging utility |
| debug-substrate.ts | Minimal Substrate connectivity check |
| upload-metadata.ts | IPFS metadata schema validation + on-chain CID registration |
| start-substrate.sh | Docker script for local pallet-revive devnet |
| lib/ipfs.ts | CIDv0 ↔ bytes32 encoding utility |

---

## Documentation (6 files, 382 KB)

| Document | Lines | Purpose |
|----------|-------|---------|
| **MVP.md** | 2,415 | Full specification (architecture, contracts, extension, security) |
| **ALPHA.md** | 1,269 | Implementation status, release notes, PVM size lessons, checklist |
| **SYSTEM-FLOW.md** | 764 | Detailed system flow for all 7 extension tabs |
| **TESTING.md** | 372 | Browser E2E walkthrough for manual testing |
| **README.md** | 304 | Quick start, key paths, toolchain, build sizes |
| **REVIEW.md** | 566 | Code review checklist, audit notes, security analysis |

---

## Deployment Status

### A3.3 — Polkadot Hub TestNet Deployment (COMPLETE 2026-03-16)

- [x] Connected to Polkadot Hub TestNet at block 6,467,844
- [x] Alice funded with ~500,000 PAS via faucet
- [x] **ECRecover precompile verified working** (signer == recovered)
- [x] All 9 contracts deployed via `npm run deploy:testnet`
- [x] All wiring validated (GovernanceV2→Slash, Campaigns→Governance/Settlement, Settlement→Relay/ZKVerifier)
- [x] Campaigns + Settlement ownership transferred to Timelock
- [x] Automated setup via `npm run setup:testnet`: 6 accounts funded, Diana+Eve registered as publishers, campaign #1 active
- [x] Extension hardcoded with testnet addresses, default network set to Polkadot Hub TestNet

**Contract addresses:** See README.md or `deployed-addresses.json`.

## What Remains

### A3.4 — Browser E2E on Testnet

- [x] `networks.ts` hardcoded with testnet contract addresses
- [x] Polkadot Hub TestNet set as default network
- [ ] Build extension: `cd alpha-extension && npm run build`
- [ ] Load in Chrome, test against testnet:
  - Create campaign with real IPFS metadata
  - Vote → activate
  - Browse → ad appears → claims generated
  - Submit claims → settlement on testnet
  - Withdraw
- [ ] Document load instructions

### A3.5 — Open Testing

- [ ] Publish testnet contract addresses publicly
- [ ] Document external tester instructions (faucet, extension install, registration, campaign creation)
- [ ] Monitor contract events for unexpected patterns

### Gate GA (Alpha Complete) — Remaining Checkboxes

- [x] All contracts deployed on testnet with addresses recorded
- [ ] IPFS metadata round-trip verified end-to-end
- [ ] At least 3 external testers complete full flow
- [ ] No critical bugs in first 7 days of operation

---

## What Has Been Deferred

### Contract Hardening (PVM budget constraints)

| Item | Reason | Location |
|------|--------|----------|
| **S2: Zero-address checks on contract setters** | Campaigns 490 B spare, Settlement 332 B spare — may not fit | setSettlement/Governance/Relay/ZKVerifier |
| **S3: Events on contract reference changes** | Each `emit` adds ~200-400 B PVM — Campaigns/Settlement cannot afford | setXxxContract, transferOwnership |
| **S4: ZK verification rejects empty return** | Mitigated by stub verifier — fix before mainnet | Settlement:217-224 |
| **S5: Publishers dual pause** | OZ Pausable (local) vs PauseRegistry (global) — document as intentional | DatumPublishers |
| **S7: Error code E03 reused** | Same code for 3 different conditions — debugging confusion only | GovernanceSlash, Settlement |
| **M4: Governance sweep** | Campaigns too tight (490 B spare) for sweepAbandonedBudget. Design exists (two-contract pattern via GovernanceSlash). | GovernanceSlash + Campaigns |

### Gas & Runtime Optimizations (PVM bytecode limits)

| Item | Blocker |
|------|---------|
| **Blake2-256 claim hashing** — ~3x cheaper than keccak256 | +4,177 B to Settlement (332 B spare) |
| **weightLeft() batch loop early abort** — graceful partial settlement | +3.5-4 KB to Settlement/Relay |
| **minimumBalance() in Settlement** — prevent dust transfers | +2 KB to Settlement (332 B spare) |
| **Storage precompile has_key()** — cheaper existence checks | Delegate-call complexity |

### Extension UX — Phase 3 (post-alpha polish)

| Item | Description |
|------|-------------|
| **UP-2** | Address blocklist management UI (view/add/remove blocked H160 addresses) |
| **UP-4** | "Uncategorized" as silenceable category |
| **UP-5** | Auction transparency (show why ad won, clearing CPM, participant count) |
| **UP-7** | Per-campaign claim management (submit/discard per campaign) |
| **UP-8** | Per-campaign frequency cap (prevent single campaign dominating) |
| **GV-4** | Timelock ABI decoding (human-readable pending changes) |
| **EA-1** | Earnings history (daily totals, withdrawal log) |
| **EA-2** | Per-campaign earnings breakdown |
| **AD-1** | Pre-scoring quality rejection (reject before render based on site history) |
| **AD-2** | In-ad feedback/report mechanism |

### Extension UX — Deferred (beta)

| Item | Description |
|------|-------------|
| **AD-3** | Advanced content blocklist (unicode normalization, leetspeak dictionary) |
| **EA-3** | Behavior chain storage cleanup (terminal campaigns) |
| **WS-4** | Typed DELETE confirmation for wallet removal |
| **SI-3** | Contract address hex/checksum validation |
| **UP-6** | Ads-per-hour counter display |
| **PU-3** | Publisher attestation error display |
| **PU-4** | Zero-category registration warning |
| **E-M2** | Interest profile storage race (write mutex) |
| **E-M3** | Metadata fetch failure retry with exponential backoff |
| **E-M6** | Conviction tooltip (weight × lock duration explanation) |

### Feature Development (post-alpha/beta)

| Priority | Item | Description |
|----------|------|-------------|
| 1 | **P7: Contract upgrade path** | UUPS proxy or migration pattern — required before mainnet |
| 2 | **P1: Mandatory attestation** | Enforce publisher co-sig (no degraded trust) |
| 3 | **P17: External wallets** | WalletConnect v2 for SubWallet/Talisman/Polkadot.js |
| 4 | **P9: ZK proof Phase 1** | Real Groth16 circuit (requires BN128 pairing precompile) |
| 5 | **P20: Campaign inactivity timeout** | Auto-complete after N blocks with no settlements |
| 6 | **F9: Phishing H160 blocklist** | Populate from Ethereum phishing feeds |
| 7 | **sr25519 signatures** | Native Polkadot wallet sigs via system precompile |
| 8 | **XCM fee routing** | Protocol fee routing to HydraDX for DOT→stablecoin |

### Low Priority / Nice-to-Have

| Item | Description |
|------|-------------|
| **L1** | MAX_SCAN_ID increase beyond 1000 |
| **L2** | Configurable poll interval (currently 5 min) |
| **L3** | Two-step ownership transfer pattern |
| **L4** | Concurrent settlement test |
| **L6** | Claim export/import manual test procedure in README |

---

## Inventory Summary

| Component | Count | Detail |
|-----------|-------|--------|
| **Solidity contracts** | 9 main + 9 interfaces + 2 mocks | All < 49,152 B PVM |
| **Contract tests** | 132 | Hardhat EVM, ~4s runtime |
| **Extension source files** | 53 | 451 KB total source |
| **Extension tests** | 140 | Jest, ~15s runtime |
| **Deploy/operations scripts** | 12 | TypeScript + Bash |
| **SDK files** | 2 | datum-sdk.js + example page |
| **Documentation** | 6 files | 382 KB, 5,690 lines |
| **Total test cases** | 272 | 132 Hardhat + 140 Jest |

### Toolchain

- Node 18, Solidity 0.8.24, Hardhat 2.22, OpenZeppelin 5.0, resolc 0.3.0
- Webpack 5, React 18, ethers 6, TypeScript 5
- Substrate Docker: `paritypr/substrate:master` + `paritypr/eth-rpc:master` on ports 9944/8545

### Denomination

1 DOT = 10^10 planck. Polkadot Hub block time: 6s (24h = 14,400 blocks). Transfer floor on pallet-revive: `value % 10^6 >= 500_000` rejected (denomination rounding bug, not ED).
