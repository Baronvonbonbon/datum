# DATUM — Complete Feature Backlog

**Version:** 1.0
**Date:** 2026-03-20
**Scope:** Every deferred, incomplete, planned, sacrificed, or missing feature from the alpha build, collected from all project documentation, code annotations, and design reviews.

---

## Table of Contents

1. [Immediate — A3.4 / A3.5 / Gate GA](#1-immediate--a34--a35--gate-ga)
2. [Contract Hardening — PVM Size Blocked](#2-contract-hardening--pvm-size-blocked)
3. [Gas & Runtime Optimizations — PVM Size Blocked](#3-gas--runtime-optimizations--pvm-size-blocked)
4. [Extension UX — Phase 3 Polish](#4-extension-ux--phase-3-polish)
5. [Extension UX — Deferred to Beta](#5-extension-ux--deferred-to-beta)
6. [Extension UX — Governance Improvements](#6-extension-ux--governance-improvements)
7. [Feature Development — Post-Alpha / Beta](#7-feature-development--post-alpha--beta)
8. [Trust Model Gaps](#8-trust-model-gaps)
9. [Architectural / Long-Term](#9-architectural--long-term)
10. [Phase 4 — Kusama & Mainnet](#10-phase-4--kusama--mainnet)
11. [Accepted Known Limitations](#11-accepted-known-limitations)
12. [Code-Level Stubs & Annotations](#12-code-level-stubs--annotations)
13. [Low Priority / Nice-to-Have](#13-low-priority--nice-to-have)

---

## 1. Immediate — A3.4 / A3.5 / Gate GA

Items required to close out the alpha testing phase.

| # | Item | Source | Description |
|---|------|--------|-------------|
| 1.1 | **Browser E2E on Paseo (A3.4)** | ALPHA.md, RELEASE-CANDIDATE.md | Load extension in Chrome, create campaign with real IPFS metadata, vote to activate, browse to trigger ad display, submit claims via relay, verify on-chain settlement, withdraw earnings. |
| 1.2 | **Open testing (A3.5)** | ALPHA.md, RELEASE-CANDIDATE.md | Publish testnet addresses publicly, write external tester instructions (faucet, install, registration, campaign creation, earning, governance), monitor contract events for unexpected patterns. |
| 1.3 | **Gate GA: IPFS round-trip** | RELEASE-CANDIDATE.md | Verify IPFS metadata round-trip end-to-end on Paseo (pin → fetch → render in ad slot). |
| 1.4 | **Gate GA: External testers** | RELEASE-CANDIDATE.md | At least 3 external testers complete the full flow. |
| 1.5 | **Gate GA: Stability** | RELEASE-CANDIDATE.md | No critical bugs in first 7 days of operation. |
| 1.6 | **Claim export/import test procedure** | ALPHA.md (A2.2/L6) | Add manual test procedure to README for P6 encrypted export/import round-trip. |
| 1.7 | **Benchmark `settleClaimsFor()` gas** | MVP.md (1.6) | Update benchmark script to measure relay settlement gas cost vs direct `settleClaims()`. |

---

## 2. Contract Hardening — PVM Size Blocked

Hardening items deferred because DatumCampaigns (490 B spare) and DatumSettlement (332 B spare) cannot absorb additional PVM bytecode.

| ID | Item | Contracts Affected | Spare Available | Risk |
|----|------|--------------------|-----------------|------|
| S2 | **Zero-address checks on contract reference setters** — `setSettlementContract()`, `setGovernanceContract()`, `setRelayContract()`, `setZKVerifier()` accept `address(0)`. Misconfigured timelock proposal could brick contracts. Exception: `setZKVerifier(address(0))` is valid (disables ZK). | Campaigns, Settlement | 490 B, 332 B | Medium — admin misconfiguration vector |
| S3 | **Events on contract reference changes** — no events emitted for `setSettlementContract()`, `setGovernanceContract()`, etc. Off-chain monitoring cannot detect wiring changes. Each `emit` adds ~200-400 B PVM. | Campaigns, Settlement, Timelock | 490 B, 332 B | Low — monitoring gap |
| S4 | **ZK verification accepts empty return** — `ok2=true` but `ret.length < 32` silently passes. Malicious or broken verifier returning empty bytes bypasses ZK checks. | Settlement | 332 B | Low (stub verifier) — **must fix before real ZK** |
| S5 | **DatumPublishers dual pause** — uses OZ `Pausable` (local) rather than `pauseRegistry.paused()` (global). Two independent pause states. | Publishers | 26,538 B (plenty) | Low — inconsistency, not vulnerability |
| S7 | **Error code E03 reused** — same code for 3 different conditions across GovernanceSlash and Settlement. | GovernanceSlash, Settlement | — | Low — debugging confusion |
| C-M3 | **Inconsistent reentrancy guard** — Campaigns uses manual `_locked` bool; Settlement uses OZ `nonReentrant`. | Campaigns | 490 B | Low — functionally equivalent |
| M4 | **Governance sweep of abandoned funds** — unclaimed slash rewards (GovernanceSlash) have no expiry; completed/terminated campaigns with rounding dust have no reclaim path. Two-contract sweep pattern designed but Campaigns too tight. | GovernanceSlash (18,854 B spare), Campaigns (490 B spare) | Mixed | Medium — funds permanently locked |
| S12 | **On-chain publisher/advertiser blocklist** — extension-only filtering is bypassable by direct contract calls. | Publishers (26 KB spare) | Plenty | Low for alpha — medium for mainnet |

**Unblocking strategy:** Wait for resolc optimizer improvements, or extract functionality into new satellite contracts (e.g., `DatumSweeper`).

---

## 3. Gas & Runtime Optimizations — PVM Size Blocked

Optimizations that would reduce on-chain costs but exceed PVM bytecode limits.

| ID | Optimization | PVM Cost | Spare | Impact |
|----|-------------|----------|-------|--------|
| O1 | **Blake2-256 claim hashing** via `hashBlake256()` system precompile — ~3x cheaper than keccak256 per claim. `@noble/hashes` installed in extension but unused. `ISystem.sol` interface ready. Requires claim struct migration. | +4,177 B to Settlement | 332 B | High — per-claim gas reduction |
| O2 | **`weightLeft()` batch loop early abort** — graceful partial settlement when weight runs low mid-loop, instead of full revert. | +3,598 B to Relay, +~4 KB to Settlement | Relay: 2,972 B; Settlement: 332 B | Medium — prevents wasted gas on partial batches |
| O3 | **`minimumBalance()` in Settlement `_send()`** — prevent dust transfers below existential deposit. Already in GovernanceV2. | +~2 KB to Settlement | 332 B | Low — edge case dust prevention |
| O4 | **Storage precompile `has_key()`** — cheaper existence checks for voted/registered mappings vs full SLOAD. | ~1-2 KB each | GovernanceV2: 9,323 B; Publishers: 26,538 B | Low — marginal gas savings |
| O5 | **Storage precompile `get_range()`/`length()`** — partial reads of large storage values. | ~1-2 KB | Settlement | Low — marginal gas savings |

---

## 4. Extension UX — Phase 3 Polish

Post-alpha UX improvements identified during Part 4D audit. All have working infrastructure — they need UI implementation.

| ID | Item | Location | Description |
|----|------|----------|-------------|
| UP-2 | **Address blocklist management UI** | Settings.tsx | `phishingList.ts` has `addBlockedAddress`/`removeBlockedAddress` API but no panel exposes it. Users can't manually block a specific advertiser or publisher address. |
| UP-4 | **Silenced "Uncategorized" category** | background/index.ts | Campaigns with `categoryId=0` bypass all category silencing. No way to block uncategorized ads. |
| UP-5 | **Auction transparency display** | CampaignList.tsx | Users can't see which campaigns competed, why one won, clearing CPM, or interest weight contribution. |
| UP-7 | **Per-campaign claim management** | ClaimQueue.tsx | Only "Submit All" or "Clear All" — can't submit or discard claims for a single campaign. |
| UP-8 | **Per-campaign frequency cap** | content/index.ts, background/index.ts | `maxAdsPerHour` is global. A single high-bid campaign can dominate all ad slots. |
| GV-4 | **Timelock ABI decoding** | GovernancePanel.tsx | Timelock `ChangeProposed` events show raw hex calldata. Need ABI-decode for human-readable descriptions. |
| EA-1 | **Earnings history** | UserPanel.tsx | Only shows current withdrawable balance. No record of past withdrawals or earning rate. |
| EA-2 | **Per-campaign earnings breakdown** | UserPanel.tsx | Aggregate engagement only. No "Campaign #3 earned you X DOT" view. |
| AD-1 | **Pre-scoring quality rejection** | background/index.ts, content/index.ts | Ad shown → quality scored below threshold → claim removed, but user already saw ad. Pre-score based on site history before rendering. |
| AD-2 | **In-ad feedback/report mechanism** | adSlot.ts, background/index.ts | No way to report an ad as inappropriate, misleading, or irrelevant from within the rendered ad. |

---

## 5. Extension UX — Deferred to Beta

Lower-priority UX items and edge cases.

| ID | Item | Location | Description |
|----|------|----------|-------------|
| AD-3 | **Advanced content blocklist** | contentSafety.ts | Naive substring match doesn't catch obfuscation ("0nline cas1no"). Need unicode normalization, leetspeak dictionary. |
| EA-3 | **Behavior chain storage cleanup** | background/index.ts | `behaviorChain:address:campaign` keys grow indefinitely in `chrome.storage.local`. Need cleanup for terminal campaigns or cap per user. |
| WS-4 | **Typed DELETE confirmation for wallet removal** | App.tsx | Single confirmation dialog for wallet removal. Should require typing "DELETE" to prevent accidental key loss. |
| SI-3 | **Contract address hex/checksum validation** | Settings.tsx | Accepts any string as contract address. No `0x` prefix + 40 hex char validation. |
| UP-6 | **Ads-per-hour counter display** | UserPanel.tsx or Settings.tsx | `maxAdsPerHour` enforced but no "X/12 ads shown this hour" display. |
| PU-3 | **Publisher attestation error display** | ClaimQueue.tsx | Attestation endpoint unreachable shows "Unattested" with no error reason. |
| PU-4 | **Zero-category registration warning** | PublisherPanel.tsx | Can register with no categories selected. SDK won't match any campaigns. No warning. |
| E-M2 | **Interest profile storage race** | background/interestProfile.ts | `getProfile()` → mutate → `set()` is not atomic. Multiple tabs updating simultaneously can lose writes. |
| E-M3 | **Metadata fetch failure retry UI** | campaignPoller.ts, background/index.ts | Multi-gateway fallback implemented (4 gateways). Missing: failure count tracking + UI notification for 3+ consecutive failures. |
| E-M6 | **Conviction tooltip** | GovernancePanel.tsx | Conviction labels show "1x, 2x, 4x..." but don't explain conviction multiplies both vote weight AND lock duration. |
| X7 | **Phishing list fetch resilience** | phishingList.ts | No retry with exponential backoff. No stale-cache warning if deny list is >24h old. |

---

## 6. Extension UX — Governance Improvements

Governance-related UX enhancements identified during MVP review.

| Item | Description |
|------|-------------|
| **Vote stacking** | Contract enforces one vote per address per campaign. No `increaseStake(campaignId)` function. |
| **Conviction preview** | Show weighted vote power preview (stake x 2^conviction) and estimated lockup before submitting. |
| **Campaign detail modal** | Click campaign in governance list to see full details (advertiser, publisher, budget, metadata). |
| **Vote history** | Track user's votes across campaigns with lockup status dashboard. |
| **Batch relay management** | Publisher sees per-user breakdown of signed batches; can submit selectively. |
| **Auto-relay** | Publisher background auto-submits signed batches when they appear in storage. |
| **Governance notifications** | Alert when a campaign the user voted on gets activated/terminated. |
| **Multi-address relay** | Publisher collects signed batches from multiple user extensions. |

---

## 7. Feature Development — Post-Alpha / Beta

Major features planned for post-alpha development.

| Priority | ID | Item | Description | Dependency |
|----------|-----|------|-------------|------------|
| 1 | P7 | **Contract upgrade path** | UUPS proxy or migration pattern for Settlement (holds user balances). Required before Kusama mainnet. | None |
| 2 | P1 | **Mandatory publisher attestation** | Enforce publisher co-sig — no degraded trust mode. Currently optional. | P21 (done) |
| 3 | P17 | **External wallet integration** | WalletConnect v2 for SubWallet/Talisman/Polkadot.js. Embedded wallet uses secp256k1/EIP-712; external wallets may use sr25519. | None |
| 4 | P9 | **ZK proof Phase 1** | Replace stub DatumZKVerifier with real Groth16/PLONK circuit for auction clearing and behavioral proofs. In-browser WASM prover (~5-30s per batch). | BN128 pairing precompile on Polkadot Hub |
| 5 | P20 | **Campaign inactivity timeout** | Auto-complete after N blocks with no settlements. Prevents dust-budget lock when advertiser loses key. | None |
| 6 | M4 | **Governance sweep** | `sweepSlashPool()` + `sweepAbandonedBudget()` for locked funds with no claimant. | Campaigns PVM headroom |
| 7 | F7 | **sr25519 signature verification** | Native Polkadot wallet signatures via system precompile. Eliminates EIP-712/secp256k1 requirement. | P17, sr25519Verify precompile stability |
| 8 | P11 | **XCM fee routing** | Protocol fee routing to HydraDX for DOT→stablecoin swaps via XCM precompile. | HydraDX integration |
| 9 | F9 | **H160 phishing address list population** | Populate H160 blocklist from Ethereum phishing feeds (MetaMask/EthPhishingDetect). Infrastructure ready; list is empty. | None |
| 10 | P10 | **Decentralized KYB identity** | Evaluating zkMe and Polkadot PoP. Currently permissionless. | None |
| 11 | F11 | **On-chain domain blocklist** | Move phishing domain deny list on-chain so settlement rejects phishing campaigns. Currently extension-only. | S12 |
| 12 | — | **Rich media ad rendering** | Image/video creatives. Currently text-only with IPFS metadata (title, body, CTA). | None |

---

## 8. Trust Model Gaps

Areas where the system currently relies on trust assumptions rather than cryptographic guarantees.

| Component | Current State | Trust Assumption | Full Solution |
|-----------|--------------|------------------|---------------|
| **Impression count** | Extension self-reports | Publisher co-sig optional (degraded trust mode) | Mandatory attestation (P1) + TEE/ZK |
| **Clearing CPM** | On-device second-price auction (P19) | Deterministic from inputs, no proof | ZK proof of auction outcome (P9) |
| **Engagement quality** | On-device behavior hash chain (P16) | Quality scoring in trusted background context | Selective disclosure; ZK behavior proofs (P9) |
| **Claim state persistence** | Browser `chrome.storage.local` | Lost if browser data cleared | Encrypted export/import (P6 done); deterministic derivation from seed + on-chain state |
| **Dust transfer prevention** | GovernanceV2 checks `minimumBalance()` | Settlement/Relay skip check (PVM size) | Extend to Settlement/Relay when resolc improves |
| **Open campaign take rate** | Fixed 50% snapshot (`DEFAULT_TAKE_RATE_BPS`) | Static default, not market-driven | Dynamic per-publisher rates (PVM constraint) |
| **Publisher domain resolution** | `data-relay` SDK attribute → local storage | URL changes require page update | On-chain publisher domain registry |
| **Direct submission attestation** | No co-sig enforcement for direct `settleClaims()` | Users can submit without publisher | `DatumAttestationVerifier` wrapper contract post-MVP |

---

## 9. Architectural / Long-Term

Structural gaps identified in design review. These require significant design work before implementation.

| Gap | Current State | Path Forward |
|-----|--------------|--------------|
| **ZK proof of auction outcome** | Stub verifier (any non-empty proof passes). No circuit exists. | Real Groth16 circuit; in-browser WASM prover (~5-30s per batch). Must prototype before starting. |
| **Viewability dispute mechanism** | No dispute path. Engagement is self-reported. | 7-day challenge window, advertiser bonds 10% of payment, sampling audit via oracle or ZK. |
| **Publisher SDK integrity** | No SDK version hash registry on-chain. Extension cannot reject claims from unregistered SDK versions. | SDK version hash registry on-chain. |
| **Taxonomy governance** | 26-category taxonomy hardcoded. | Conviction referendum for changes; 7-day delay; retroactive effect on active campaigns undefined. |
| **Revenue split governability** | 75/25 user/protocol split is a hardcoded constant. | Governance parameter with timelock protection. |
| **Minimum CPM floor** | `minimumCpmFloor` owner-settable (not governance-controlled). | Governance parameter. |
| **KYB cost responsibility** | No KYB enforcement. | One-time onboarding deposit in `createCampaign()`. |
| **GDPR right to erasure** | No plan. Hashes on-chain are permanent. | Hash-of-hash on-chain, PII off-chain; erasure = delete off-chain source only. Legal analysis required. |
| **Price discovery mechanism** | `clearingCpmPlanck` bounded by bidCpm ceiling; auction on-device only. | Off-chain batch auction per epoch; ZK proof of clearing rate. |
| **Contract upgrade / migration** | Non-upgradeable. Settlement holds user balances. Lost owner key = permanently locked protocolBalance. | UUPS proxy or migration function (P7). Required before mainnet. |
| **XCM retry queue** | XCM fee routing not implemented. | Idempotency keys + bounded retries for XCM failures when P11 is built. |
| **Extension version coordination** | No on-chain version hash registry. | Hash registration must precede extension release. Staging environment. |
| **Multi-chain settlement** | Single chain (Polkadot Hub). | XCM-based cross-chain claims post-mainnet. |

---

## 10. Phase 4 — Kusama & Mainnet

Deployment milestones not yet started.

### Phase 4A — Kusama Deployment

- Kusama-specific production parameters (block counts: `PENDING_TIMEOUT = 100800`, `TAKE_RATE_DELAY = 14400`, `BASE_LOCKUP = 14400`, `MAX_LOCKUP = 5256000`)
- 2-of-3 multisig ownership transfer for all contracts
- Deploy to Kusama Hub, run E2E smoke test
- Onboard at least one third-party advertiser (not deployer)
- `deployments/kusama.json` contract registry

### Phase 4B — Polkadot Hub Mainnet

- Deploy to Polkadot Hub mainnet
- Extension published to Chrome Web Store
- Production monitoring and alerting
- Full security audit before mainnet launch

---

## 11. Accepted Known Limitations

Documented and accepted for alpha. Not bugs — deliberate tradeoffs.

| Limitation | Detail | Impact |
|------------|--------|--------|
| **Daily cap timestamp manipulation** | `block.timestamp / 86400` — validators can shift +-15s | Negligible (<0.02% error) |
| **Unclaimed slash rewards — no expiry** | `claimSlashReward()` has no deadline; unclaimed pools permanently locked | Low — only non-claiming governance participants |
| **Denomination rounding** | pallet-revive eth-rpc rejects `value % 10^6 >= 500_000` | Runtime quirk — all code adjusted |
| **Single pending timelock proposal** | `propose()` overwrites previous pending; must cancel before re-proposing | Admin UX limitation — intentional simplicity |
| **Blake2-256 deferred** | Claims use keccak256 (~3x more expensive on Substrate) | Higher per-claim gas cost |
| **No on-chain publisher domain registry** | Relay URL via SDK `data-relay` attribute, not chain state | URL changes require page update |
| **Manual reentrancy guard in Campaigns** | `_locked` bool instead of OZ `nonReentrant` | Functionally equivalent — PVM size constraint |
| **No claim expiry** | Stale claims can be submitted indefinitely | Low — nonce chain prevents replay |
| **E03/E52/E53 dual meaning** | Same error codes used in different contexts | Debugging confusion — extension `humanizeError()` provides context |
| **Shadow DOM mode "open"** | `attachShadow({ mode: "open" })` — page JS can access shadow DOM | Upgrade to "closed" post-alpha |

---

## 12. Code-Level Stubs & Annotations

Explicit TODO/stub markers in source code.

| File | Annotation |
|------|------------|
| `DatumZKVerifier.sol` | Stub — accepts any non-empty proof. Replace with real Groth16/PLONK verifier. |
| `alpha-extension/src/background/zkProofStub.ts` | ZK proof stub — real circuit replaces this in P9 post-alpha. |
| `alpha-extension/src/content/adSlot.ts:106` | `attachShadow({ mode: "open" })` — upgrade to "closed" post-alpha. |
| `alpha-extension/src/shared/walletManager.ts:8` | Post-MVP: WalletConnect or iframe bridge for external wallet support. |
| `alpha-extension/src/background/publisherAttestation.ts:25` | Post-MVP: publishers register their domain on-chain. |

---

## 13. Low Priority / Nice-to-Have

| ID | Item | Description |
|----|------|-------------|
| L1 | **`MAX_SCAN_ID` increase** | `campaignPoller.ts` hardcoded to scan IDs 1-1000. May need increase for mainnet. |
| L2 | **Configurable poll interval** | 5-minute campaign poll interval should be user-configurable in Settings. |
| L3 | **Two-step ownership transfer** | `transferOwnership()` → `acceptOwnership()` pattern instead of immediate single-step. |
| L4 | **Concurrent settlement test** | No test for multiple users settling in the same block. |
| L6 | **Claim export/import test procedure** | README procedure for P6 encrypted round-trip. |

---

## Summary

| Category | Count | Timeline |
|----------|-------|----------|
| Immediate (A3.4 / A3.5 / Gate GA) | 7 | Now |
| Contract hardening (PVM blocked) | 8 | Before mainnet |
| Gas & runtime optimizations (PVM blocked) | 5 | Post-alpha |
| Extension UX Phase 3 (polish) | 10 | Post-alpha |
| Extension UX deferred to beta | 11 | Beta |
| Extension UX governance improvements | 8 | Beta |
| Feature development (post-alpha/beta) | 12 | Beta / post-beta |
| Trust model gaps | 8 | Long-term |
| Architectural / long-term | 13 | Mainnet+ |
| Phase 4 (Kusama/mainnet) milestones | 6 | Post-testnet |
| Accepted known limitations | 10 | Documented |
| Code-level stubs | 5 | Various |
| Low priority / nice-to-have | 5 | Someday |
| **Total** | **108** | |
