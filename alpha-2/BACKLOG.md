# DATUM — Complete Feature Backlog

**Version:** 1.1
**Date:** 2026-03-23 (updated from 1.0 / 2026-03-20)
**Scope:** Every deferred, incomplete, planned, sacrificed, or missing feature from the alpha-2 build, collected from all project documentation, code annotations, process flow analysis, and design reviews.

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

| # | Item | Source | Status | Description |
|---|------|--------|--------|-------------|
| 1.1 | **Browser E2E on Paseo (A3.4)** | ALPHA.md, RELEASE-CANDIDATE.md | **DONE** | ~~Load extension in Chrome, create campaign with real IPFS metadata, vote to activate, browse to trigger ad display, submit claims via relay, verify on-chain settlement, withdraw earnings.~~ All key points pass. |
| 1.2 | **Relay round-trip fix** | PROCESS-FLOWS.md §10.1 | **BLOCKED** | Extension `signForRelay()` stores signed batches in `chrome.storage.local` but **never POSTs to relay bot's `/relay/submit`**. The relay bot endpoint works but has zero callers. Must fix `ClaimQueue.tsx` to POST signed batches to publisher relay URL after signing. |
| 1.3 | **Gate GA: IPFS round-trip** | RELEASE-CANDIDATE.md | **DONE** | ~~Verify IPFS metadata round-trip end-to-end on Paseo.~~ |
| 1.4 | **Gate GA: External testers** | RELEASE-CANDIDATE.md | Open | At least 3 external testers complete the full flow. |
| 1.5 | **Gate GA: Stability** | RELEASE-CANDIDATE.md | Open | No critical bugs in first 7 days of operation. |
| 1.6 | **Claim export/import test procedure** | ALPHA.md (A2.2/L6) | Open | Cross-device verification pending. |
| 1.7 | **Benchmark `settleClaimsFor()` gas** | MVP.md (1.6) | Open | Full relay vs direct comparison pending. |
| 1.8 | **Alpha-2 deploy scripts** | IMPLEMENTATION-PLAN.md | Open | Update `deploy.ts` for 12-contract deploy + wiring. Alpha scripts target 9 contracts. |
| 1.9 | **Alpha-2 testnet deploy** | CHANGELOG.md | Open | Deploy alpha-2 (12 contracts) to Paseo, run E2E validation. |
| 1.10 | **Blake2 claim hash migration (extension + relay)** | CHANGELOG.md (O1) | Open | Settlement now uses `hashBlake256()` on PolkaVM. Extension `behaviorChain.ts` and relay bot must switch from keccak256 to Blake2-256. `@noble/hashes` installed but unused. **Required before 1.9** (testnet deploy) — claims will fail hash validation otherwise. |

---

## 2. Contract Hardening

Items previously blocked by PVM size constraints. Alpha-2 restructuring freed headroom. Hardening pass applied 2026-03-22, S12 blocklist 2026-03-23. **7 of 8 items complete.**

| ID | Item | Status | Notes |
|----|------|--------|-------|
| S2 | **Zero-address checks on contract reference setters** | **DONE** | All setters across all contracts now validate `addr != address(0)`. Settlement `setRelayContract()` added. |
| S3 | **Events on contract reference changes** | **DONE** (5/6 contracts) | `ContractReferenceChanged(name, oldAddr, newAddr)` emitted by Campaigns, BudgetLedger, CampaignLifecycle, GovernanceV2. Settlement events removed to make room for O1 Blake2 precompile (-2,640 B). |
| S7 | **Error code E03/E52/E53 reused** | **DONE** | GovernanceSlash deduped: E52→E59, E53→E60, E03→E61. Extension `errorCodes.ts` updated. |
| C-M3 | **Inconsistent reentrancy guard** | **DONE** | BudgetLedger: OZ `ReentrancyGuard`. GovernanceSlash: OZ `ReentrancyGuard`. Campaigns: manual `_locked` (cheaper PVM). All value-transfer paths now guarded. |
| S4 | **ZK verification accepts empty return** | Open | Stub verifier — must fix before real ZK integration. Not applicable until post-alpha. |
| S5 | **DatumPublishers dual pause** | **DONE** | Replaced OZ `Pausable` with global `pauseRegistry.paused()`. Constructor now takes `_pauseRegistry` address. Publishers +3,962 B PVM (22,377 spare). |
| M4 | **Governance sweep of abandoned funds** | **DONE** | GovernanceSlash: `sweepSlashPool()`. BudgetLedger: `sweepDust()` — permissionless sweep of terminal campaign dust to protocol owner. +3,483 B PVM (20,502 spare). |
| S12 | **On-chain publisher/advertiser blocklist** | **DONE** | Global blocklist on Publishers (E62) + per-publisher allowlist (E63). Checked in registerPublisher + createCampaign + **settlement claim validation** (reason 11). Owner-managed for alpha — **must migrate to timelock before mainnet**. Future: open blocklist to governance control. Publishers +8,966 B (13,411 spare), Campaigns +4,443 B (6,686 spare), Settlement +2,128 B (1,936 spare). 27 tests. |

---

## 3. Gas & Runtime Optimizations

Optimizations that would reduce on-chain costs. Some now have headroom after alpha-2 restructuring + hardening.

| ID | Optimization | PVM Cost | Spare (post-S12) | Feasible? | Impact |
|----|-------------|----------|-------------------|-----------|--------|
| O1 | **Blake2-256 claim hashing** via `hashBlake256()` system precompile — ~3x cheaper than keccak256 per claim. | +2,119 B to Settlement (actual) | 4,064 B | **DONE** — contract deployed. Extension + relay migration pending. | High — per-claim gas reduction |
| O2 | **`weightLeft()` batch loop early abort** — graceful partial settlement when weight runs low mid-loop, instead of full revert. | +3,598 B to Relay, +~4 KB to Settlement | Relay: 2,974 B; Settlement: 3,543 B | **No** — exceeds both | Medium — prevents wasted gas on partial batches |
| O3 | **`minimumBalance()` in PaymentVault withdrawals** — prevent dust transfers below existential deposit. Matches GovernanceV2's E58 guard. | +1,279 B to PaymentVault (actual) | 31,811 B | **DONE** | Low — edge case dust prevention |
| O4 | ~~**Storage precompile `has_key()`**~~ — cheaper existence checks for voted/registered mappings vs full SLOAD. | — | — | **Closed** — pallet-revive does not expose storage precompiles through Solidity. System precompile at 0x900 only has minimumBalance/weightLeft/hashBlake256. | — |
| O5 | **Storage precompile `get_range()`/`length()`** — partial reads of large storage values. | ~1-2 KB | Settlement: 4,064 B | **Closed** — same as O4, not available via Solidity precompile | Low — marginal gas savings |
| O6 | **Relay: replace typed interface variables with plain `address` + inline staticcall** — mirror Settlement's pattern for `campaigns` and `pauseRegistry`. | **+1,160 B worse** (tested) | Relay: 2,974 B | **Closed** — typed variables are cheaper when the interface is already imported (amortized). 46,178 → 47,338 B. | — |

**Note:** O1 contract-side complete (Settlement: 45,088 B, 4,064 spare). Extension `behaviorChain.ts` + relay bot must migrate from keccak256 → Blake2-256 before testnet deploy (see 1.10). O2 remains blocked on Settlement (4,064 B spare) and Relay (2,974 B spare). O3 done (PaymentVault: 17,341 B, 31,811 spare). O4/O5 closed — pallet-revive does not expose storage precompiles through Solidity. O6 closed — typed interface variables cheaper than inline staticcall when interface already imported.

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

| Priority | ID | Item | Description | Dependency | Status |
|----------|-----|------|-------------|------------|--------|
| 1 | P7 | **Contract upgrade path** | UUPS proxy or migration pattern for PaymentVault (holds user balances). Required before Kusama mainnet. | None | Open |
| 2 | P1 | **Mandatory publisher attestation** | `DatumAttestationVerifier` wrapper contract — enforces EIP-712 publisher co-sig for direct settlement. 35,920 B PVM. Settlement `setAttestationVerifier()` + auth check (+836 B). 4 tests (H1-H4). | P21 (done) | **DONE** |
| 3 | P17 | **External wallet integration** | WalletConnect v2 for SubWallet/Talisman/Polkadot.js. Embedded wallet uses secp256k1/EIP-712; external wallets may use sr25519. | None | Open |
| 4 | P9 | **ZK proof Phase 1** | Replace stub DatumZKVerifier with real Groth16/PLONK circuit for auction clearing and behavioral proofs. In-browser WASM prover (~5-30s per batch). | BN128 pairing precompile on Polkadot Hub | Open |
| 5 | P20 | **Campaign inactivity timeout** | `expireInactiveCampaign()` on CampaignLifecycle. `lastSettlementBlock` tracking on BudgetLedger. 30-day default (432,000 blocks). Permissionless. E64 error. 5 tests (LC10-LC14). | None | **DONE** |
| 6 | ~~M4~~ | ~~**Governance sweep**~~ | ~~`sweepSlashPool()` + `sweepAbandonedBudget()` for locked funds with no claimant.~~ | — | **DONE** |
| 7 | F7 | **sr25519 signature verification** | Native Polkadot wallet signatures via system precompile. Eliminates EIP-712/secp256k1 requirement. | P17, sr25519Verify precompile stability | Open |
| 8 | P11 | **XCM fee routing** | Protocol fee routing to HydraDX for DOT→stablecoin swaps via XCM precompile. | HydraDX integration | Open |
| 9 | F9 | **H160 phishing address list population** | Populate H160 blocklist from Ethereum phishing feeds (MetaMask/EthPhishingDetect). Infrastructure ready; list is empty. | None | Open |
| 10 | P10 | **Decentralized KYB identity** | Evaluating zkMe and Polkadot PoP. Currently permissionless. | None | Open |
| 11 | F11 | **On-chain domain blocklist** | Move phishing domain deny list on-chain so settlement rejects phishing campaigns. Currently extension-only. | S12 (**done**) | Open — unblocked |
| 12 | — | **Rich media ad rendering** | Image/video creatives. Currently text-only with IPFS metadata (title, body, CTA). | None | Open |

---

## 8. Trust Model Gaps

Areas where the system currently relies on trust assumptions rather than cryptographic guarantees.

| Component | Current State | Trust Assumption | Full Solution |
|-----------|--------------|------------------|---------------|
| **Impression count** | Extension self-reports | Publisher co-sig optional (degraded trust mode) | Mandatory attestation (P1) + TEE/ZK |
| **Clearing CPM** | On-device second-price auction (P19) | Deterministic from inputs, no proof | ZK proof of auction outcome (P9) |
| **Engagement quality** | On-device behavior hash chain (P16) | Quality scoring in trusted background context | Selective disclosure; ZK behavior proofs (P9) |
| **Claim state persistence** | Browser `chrome.storage.local` | Lost if browser data cleared | Encrypted export/import (P6 done); deterministic derivation from seed + on-chain state |
| **Dust transfer prevention** | GovernanceV2 + PaymentVault check `minimumBalance()` (E58) | Settlement/Relay skip check | PaymentVault done (O3). Settlement/Relay still PVM-constrained. BudgetLedger sends budget-scale amounts — guard unnecessary. |
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
| **Contract upgrade / migration** | Non-upgradeable. PaymentVault holds user balances (extracted from Settlement in alpha-2). Lost owner key = permanently locked protocolBalance. | UUPS proxy or migration function (P7). Required before mainnet. |
| **XCM retry queue** | XCM fee routing not implemented. | Idempotency keys + bounded retries for XCM failures when P11 is built. |
| **Extension version coordination** | No on-chain version hash registry. | Hash registration must precede extension release. Staging environment. |
| **Multi-chain settlement** | Single chain (Polkadot Hub). | XCM-based cross-chain claims post-mainnet. |

---

## 10. Phase 4 — Kusama & Mainnet

Deployment milestones not yet started.

### Pre-Mainnet Gate (required before Phase 4B)

These items are mandatory before mainnet. See also `S12-BLOCKLIST-ANALYSIS.md` and `project_s12_mainnet_migration.md`.

| Item | Description | Status |
|------|-------------|--------|
| **Timelock-gated blocklist** | `blockAddress()`/`unblockAddress()` must go through 48h timelock for transparency. Currently direct `onlyOwner`. | Open |
| **Governance blocklist override** | Community can propose unblock via conviction vote (Option C hybrid). Admin retains emergency-block. | Open — future goal |
| **Settlement blocklist check** | `isBlocked(claim.publisher)` in `_validateClaim()`. Reason code 11. `configure()` expanded to 5-arg (added `_publishers`). +2,128 B (1,936 spare). | **DONE** |
| **Contract upgrade path (P7)** | UUPS proxy or migration pattern for PaymentVault. Lost owner key = permanently locked protocolBalance. | Open |
| **Full security audit** | External audit of all 12 contracts before mainnet launch. | Open |
| **Two-step ownership transfer (L3)** | `transferOwnership()` → `acceptOwnership()` pattern. Prevents irrecoverable ownership loss. | Open |

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
- All pre-mainnet gate items resolved

---

## 11. Accepted Known Limitations

Documented and accepted for alpha. Not bugs — deliberate tradeoffs.

| Limitation | Detail | Impact | Status |
|------------|--------|--------|--------|
| **Daily cap timestamp manipulation** | `block.timestamp / 86400` — validators can shift +-15s | Negligible (<0.02% error) | Accepted |
| ~~**Unclaimed slash rewards — no expiry**~~ | ~~`claimSlashReward()` has no deadline; unclaimed pools permanently locked~~ | — | **RESOLVED** — `sweepSlashPool()` added (M4, 365-day deadline) |
| **Denomination rounding** | pallet-revive eth-rpc rejects `value % 10^6 >= 500_000` | Runtime quirk — all code adjusted | Accepted |
| **Single pending timelock proposal** | `propose()` overwrites previous pending; must cancel before re-proposing | Admin UX limitation — intentional simplicity | Accepted |
| ~~**Blake2-256 deferred**~~ | ~~Claims use keccak256 (~3x more expensive on Substrate)~~ | — | **RESOLVED** — O1 Blake2 precompile added to Settlement. Extension + relay migration pending (1.10). |
| **No on-chain publisher domain registry** | Relay URL via SDK `data-relay` attribute, not chain state | URL changes require page update | Accepted |
| **Manual reentrancy guard in Campaigns** | `_locked` bool instead of OZ `nonReentrant` | Functionally equivalent — **verified optimal**: OZ costs +707 B here because Campaigns has no other OZ imports to amortize. Manual is correct choice. | Accepted |
| **No claim expiry on direct settlement** | Stale claims can be submitted indefinitely via `settleClaims()` | Low — nonce chain prevents replay. Relay has `deadline` field. | Accepted |
| ~~**E03/E52/E53 dual meaning**~~ | ~~Same error codes used in different contexts~~ | — | **RESOLVED** — GovernanceSlash deduped to E59/E60/E61 (S7) |
| **Shadow DOM mode "open"** | `attachShadow({ mode: "open" })` — page JS can access shadow DOM | Upgrade to "closed" post-alpha | Accepted |
| **Blocklist not timelock-gated** | `blockAddress()`/`unblockAddress()` use direct `onlyOwner` for alpha | Must migrate before mainnet | Accepted for alpha |
| ~~**No Settlement blocklist check**~~ | ~~Blocked publisher's existing campaigns can still settle claims~~ | — | **RESOLVED** — `_validateClaim()` now checks `isBlocked(claim.publisher)` (reason code 11). Settlement: 47,216 B (1,936 spare). |
| **No GovernanceV2 vote blocklist check** | Blocked addresses can still vote | Low — no fund theft via voting; slash penalizes bad actors | Accepted — PVM blocked (1,213 B spare) |
| **No publisher deregistration** | Publishers cannot unregister or deactivate themselves | Low — can enable empty allowlist or set max take rate | Accepted |
| **Open campaign take rate fixed at 50%** | `DEFAULT_TAKE_RATE_BPS = 5000` not configurable | Static default, not market-driven | Accepted |
| **Revenue split hardcoded** | 75/25 user/protocol split in Settlement | Not governance-controlled | Accepted for alpha |
| **Relay round-trip incomplete** | Extension stores signed batches locally, never POSTs to relay bot | **Broken flow** — see §1.2 | Must fix |

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

| Category | Total | Done | Open | Timeline |
|----------|-------|------|------|----------|
| Immediate (deploy, relay fix, testing, Blake2 migration) | 10 | 2 | 8 | Now |
| Contract hardening | 8 | 7 | 1 (S4 ZK stub) | Before mainnet |
| Gas & runtime optimizations | 6 | 2 (O1, O3) + 3 closed (O4, O5, O6) | 1 (O2 PVM-blocked) | Post-alpha |
| Extension UX Phase 3 (polish) | 10 | 0 | 10 | Post-alpha |
| Extension UX deferred to beta | 11 | 0 | 11 | Beta |
| Extension UX governance improvements | 8 | 0 | 8 | Beta |
| Feature development (post-alpha/beta) | 12 | 3 (M4, P1, P20) | 9 | Beta / post-beta |
| Trust model gaps | 8 | 0 | 8 | Long-term |
| Architectural / long-term | 13 | 0 | 13 | Mainnet+ |
| Pre-mainnet gate | 6 | 1 | 5 | Before mainnet |
| Phase 4 (Kusama/mainnet) milestones | 6 | 0 | 6 | Post-testnet |
| Accepted known limitations | 17 | 4 resolved | 13 accepted | Documented |
| Code-level stubs | 5 | 0 | 5 | Various |
| Low priority / nice-to-have | 5 | 0 | 5 | Someday |
| **Total** | **125** | **21** | **104** | |

### Contract Status: FROZEN FOR ALPHA (2026-03-24)

All 13 contracts are complete. 185/185 tests. No further contract changes for alpha deployment.

**Done:** Phases 1-4 restructuring, S2/S3/S5/S7/C-M3/M4 hardening, S12 blocklist (all 3 layers), O1 Blake2-256, O3 dust guard, P1 mandatory attestation (new DatumAttestationVerifier), P20 campaign inactivity timeout.

**Closed:** O2 (PVM-blocked), O4/O5 (not available), O6 (counterproductive), GovernanceV2 vote blocklist (no room), GovernanceV2 reentrancy guard (no room).

**PVM-frozen (no additions possible):** Settlement (1,100 spare), GovernanceV2 (1,213 spare), Relay (2,974 spare).

**Pre-mainnet contract changes (post-alpha):** Timelock-gated blocklist, two-step ownership (L3), UUPS proxy (P7), security audit.

**Post-alpha feature contracts:** P9 (real ZK), F7 (sr25519), F11 (on-chain domain blocklist — skipped for now, would blow Settlement budget).

### Critical Path (blocking mainnet)

1. **1.10** — Blake2 claim hash migration (extension + relay) — **blocks testnet deploy**
2. **1.2** — Fix relay round-trip (extension → relay bot POST)
3. **1.8** — Alpha-2 deploy scripts (13-contract, 5-arg `configure()` + `setAttestationVerifier()`, 2-arg Lifecycle constructor)
4. **1.9** — Alpha-2 testnet deploy
5. **P7** — Contract upgrade path (UUPS proxy)
6. **Timelock-gated blocklist** — S12 pre-mainnet requirement
7. **L3** — Two-step ownership transfer
8. **Security audit** — External review of all 12 contracts
