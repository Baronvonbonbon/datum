# DATUM Alpha-3 Backlog

> Consolidated from alpha-2 BACKLOG.md, IMPLEMENTATION-PLAN.md, SECURITY-AUDIT.md, and bot mitigation planning.
> Created 2026-03-29 on `alpha-3` branch.

## Table of Contents

1. [Alpha-3 Targeting Redesign (TX-*)](#1-alpha-3-targeting-redesign-tx)
2. [Bot Mitigation & Anti-Fraud (BM-*)](#2-bot-mitigation--anti-fraud-bm)
3. [Contract Security — Medium (SM-*)](#3-contract-security--medium-sm)
4. [Contract Security — Low (SL-*)](#4-contract-security--low-sl)
5. [Extension Security — Critical/High (XH-*)](#5-extension-security--criticalhigh-xh)
6. [Extension Security — Medium (XM-*)](#6-extension-security--medium-xm)
7. [Extension Security — Low (XL-*)](#7-extension-security--low-xl)
8. [Web App Security (WS-*)](#8-web-app-security-ws)
9. [Contract Satellite Extraction (SE-*)](#9-contract-satellite-extraction-se)
10. [Contract Hardening & Gas (CH-*)](#10-contract-hardening--gas-ch)
11. [Extension UX — Phase 3 Polish (UP-*)](#11-extension-ux--phase-3-polish-up)
12. [Extension UX — Beta Features (UB-*)](#12-extension-ux--beta-features-ub)
13. [Feature Development — Post-Alpha (FD-*)](#13-feature-development--post-alpha-fd)
14. [Architectural & Long-Term (AL-*)](#14-architectural--long-term-al)
15. [Pre-Mainnet Gate (MG-*)](#15-pre-mainnet-gate-mg)
16. [Deployment & Validation (DV-*)](#16-deployment--validation-dv)
17. [Low Priority / Nice-to-Have (LP-*)](#17-low-priority--nice-to-have-lp)

---

## Summary

| Section | Items | Priority |
|---------|-------|----------|
| 1. Targeting Redesign | 7 | **Alpha-3 core** |
| 2. Bot Mitigation | 9 | **Alpha-3 core** |
| 3. Contract Security (Medium) | 7 | High |
| 4. Contract Security (Low) | 9 | Medium |
| 5. Extension Security (Critical/High) | 4 | **Blocking** |
| 6. Extension Security (Medium) | 14 | High |
| 7. Extension Security (Low) | 6 | Medium |
| 8. Web App Security | 12 | Medium-High |
| 9. Satellite Extraction | 4 | **Alpha-3 core** |
| 10. Contract Hardening | 2 | Medium |
| 11. Extension UX Phase 3 | 3 | Medium |
| 12. Extension UX Beta | 16 | Low-Medium |
| 13. Feature Development | 7 | Post-alpha |
| 14. Architectural | 13 | Long-term |
| 15. Pre-Mainnet Gate | 7 | **Gate** |
| 16. Deployment & Validation | 5 | **Blocking** |
| 17. Low Priority | 6 | Low |
| **Total** | **131** | |

---

## 1. Alpha-3 Targeting Redesign (TX-*)

**Problem:** The current `uint256 categoryBitmask` on `DatumPublishers` supports only 26 top-level categories via bit flags. This is too coarse for real advertising — no support for localization, geography, demographics, interests, or any key-value attributes.

**Design Goal:** Replace the fixed bitmask with a flexible, extensible targeting system that supports arbitrary attribute dimensions (topic, locale, city, hobbies, age bracket, platform, etc.) while remaining gas-efficient on PolkaVM.

### Architecture: Tag-Based Attribute Registry

**On-chain (new satellite contract: `DatumTargetingRegistry`):**
- Stores `bytes32` tag hashes (not strings — gas efficient)
- Publisher declares supported tags: `setTags(bytes32[] tagHashes)`
- Campaign specifies required tags at creation: `requiredTags` field
- Matching: publisher must have ALL required tags (AND logic)
- Tag hashes are `keccak256(abi.encodePacked(dimension, ":", value))` — e.g., `keccak256("locale:en-US")`, `keccak256("city:new-york")`, `keccak256("topic:defi")`
- Max 32 tags per publisher, max 8 required tags per campaign (gas bounded)
- Tag registry is append-only per publisher (can clear and re-set, not delete individual)

**Off-chain (extension + SDK + IPFS metadata):**
- Human-readable tag definitions in IPFS metadata: `{ tags: ["locale:en-US", "topic:defi", "city:new-york"] }`
- Extension resolves tag hashes to display names via local dictionary + IPFS lookup
- SDK declares tags via `data-tags="locale:en-US,topic:defi"` attribute
- Auction filters by tag intersection (replaces category bitmask matching)

**Migration path from alpha-2:**
- `categoryBitmask` replaced by tag hashes (e.g., category 26 "Crypto & Web3" → `keccak256("topic:crypto-web3")`)
- Backward-compatible: old `categoryId` on Campaign struct → mapped to `requiredTags[0]` at creation
- `DatumPublishers.setCategories(bitmask)` replaced by `DatumTargetingRegistry.setTags(bytes32[])`

### Items

| ID | Item | Description | Effort | Deps |
|----|------|-------------|--------|------|
| TX-1 | `DatumTargetingRegistry` contract | New satellite contract. `setTags(bytes32[])`, `getTags(publisher)`, `hasAllTags(publisher, bytes32[])`. Max 32 tags/publisher, storage via mapping. | 1 week | — |
| TX-2 | Campaign `requiredTags` field | Add `bytes32[] requiredTags` to campaign creation (max 8). Stored in new mapping `campaignTags[id]` (not in struct — PVM size). | 1 week | TX-1 |
| TX-3 | Tag matching in auction | Extension auction.ts: filter campaigns where publisher has all required tags. Replace `categoryBitmask` overlap check. | 3 days | TX-1, TX-2 |
| TX-4 | SDK tag declaration | Update `datum-sdk.js` to use `data-tags` attribute. Deprecate `data-categories`. | 2 days | TX-3 |
| TX-5 | Standard tag dictionary | Define initial tag dimensions: `topic:*` (replaces categories), `locale:*` (BCP 47), `geo:*` (ISO 3166-2 region codes), `city:*` (slug), `platform:*` (desktop/mobile/tablet), `interest:*` (open-ended hobbies). Publish as IPFS-pinned JSON. | 3 days | TX-1 |
| TX-6 | Publisher tag management UI | Replace category checkboxes in extension PublisherPanel with tag picker. Autocomplete from standard dictionary + custom tags. | 1 week | TX-5 |
| TX-7 | Campaign tag picker UI | Advertiser selects required tags at campaign creation (web app + extension). Show estimated publisher reach per tag combination. | 1 week | TX-5 |

**Tag dimension examples:**

| Dimension | Example values | Use case |
|-----------|---------------|----------|
| `topic:*` | `topic:defi`, `topic:gaming`, `topic:fashion` | Content category (replaces bitmask) |
| `locale:*` | `locale:en-US`, `locale:ja`, `locale:de-DE` | Language/region targeting |
| `geo:*` | `geo:US-CA`, `geo:GB`, `geo:JP-13` | ISO 3166 country/region |
| `city:*` | `city:new-york`, `city:tokyo`, `city:london` | City-level targeting |
| `platform:*` | `platform:desktop`, `platform:mobile` | Device type |
| `interest:*` | `interest:cycling`, `interest:photography`, `interest:cooking` | User hobbies/interests |
| `audience:*` | `audience:developer`, `audience:student`, `audience:professional` | Demographic segment |

**PVM size estimate:** `DatumTargetingRegistry` as pure satellite: ~20-25 KB. Well within 49,152 limit. Campaigns struct unchanged (tags stored in separate mapping). Publishers contract: remove `categoryBitmask` setter (~2 KB savings), add `targetingRegistry` address (~200 B).

---

## 2. Bot Mitigation & Anti-Fraud (BM-*)

### 2.1 Current Defenses (All DONE in alpha-2)

1. Publisher co-signature (EIP-712) — publisher attests every claim batch
2. P1 AttestationVerifier — mandatory publisher co-sig for all settlements
3. Engagement quality scoring — dwell/focus/viewability/scroll metrics
4. Behavior hash chain — append-only per-(user, campaign) commitment
5. Per-campaign daily cap (BudgetLedger) — bounds daily spend
6. Content safety validation — schema + URL + blocklist
7. IAB viewability standard — 50% visible for ≥1s
8. S12 global blocklist — deny list on Publishers contract
9. S12 per-publisher allowlist — targeted campaigns filter advertisers
10. Phishing list integration — CTA URL + address filtering
11. SDK handshake — challenge-response integrity check

### 2.2 Bot Mitigation Backlog

| Priority | ID | Item | Effort | Deps | Status |
|----------|-----|------|--------|------|--------|
| 1 | BM-7 | Publisher SDK integrity verification | 1 week | — | **Open** |
| 2 | BM-2 | Per-user per-campaign settlement cap | 1-2 weeks | Satellite contract | **Open** |
| 3 | BM-1 | ZK engagement proof (Groth16) | 3-4 weeks | BN128 precompile | **Open** |
| 4 | BM-3 | Sybil resistance: claim CAPTCHA | 1w (A), 3-4w (B) | — | **Open** |
| 5 | BM-4 | Publisher-side fraud detection | 2-3 weeks | Relay API | **Open** |
| 6 | BM-5 | On-chain settlement rate limiter | 1-2 weeks | Satellite contract | **Open** |
| 7 | BM-6 | Viewability dispute mechanism | 4-6 weeks | Governance | **Open** |
| 8 | BM-8 | Reputation scoring | 3-4 weeks | BM-2, BM-5 | **Open** |
| 9 | BM-9 | Cross-campaign anomaly detection | 2-3 weeks | BM-8 | **Open** |

### 2.3 Implementation Plans

#### BM-7: Publisher SDK Version Registry (Phase A — Week 1)

**Contract:** Add `sdkVersionHash` mapping to `DatumPublishers` (~3 KB PVM, 13,411 spare).
- `registerSdkVersion(bytes32 hash)` — publisher registers hash of their SDK bundle
- `getSdkVersion(address publisher) → bytes32` — query registered hash

**Extension:** `sdkDetector.ts` fetches SDK script content, hashes it, compares against on-chain registered hash.
- Match → full trust, normal auction weight
- Mismatch → degraded trust, lower auction priority, warn user
- No hash registered → legacy mode (current behavior)

**SDK:** `datum-sdk.js` includes version in `datum:sdk-ready` event. Publisher registers hash after deploy.

#### BM-2: Per-User Settlement Cap (Phase A — Weeks 2-3)

**Contract:** New `DatumSettlementGuard` satellite contract (~15-20 KB PVM).
- `mapping(uint256 campaignId => mapping(address user => uint256 totalSettled))` — cumulative per-user spend
- `checkAndRecord(uint256 campaignId, address user, uint256 amount) → bool` — called by Settlement/AttestationVerifier
- Cap = `campaign.bidCpmPlanck * MAX_IMPRESSIONS_PER_USER` (configurable, default 100,000 impressions)
- Exceeding cap → claim rejected with reason code 13

**Integration:** AttestationVerifier calls `guard.checkAndRecord()` before forwarding to Settlement. Guard has 12,066 B spare in AttestationVerifier's call chain.

#### BM-1: ZK Engagement Proof with Campaign Toggle (Phase B — Weeks 4-7)

**Campaign ZK toggle:** `requireZkProof` bool per campaign.
- Set at creation: `createCampaign(..., requireZkProof)`
- Stored in `campaignZkRequired[campaignId]` mapping on Campaigns (separate from struct)
- `getCampaignZkRequired(campaignId) → bool` view function
- Two-tier market: ZK campaigns can offer higher CPMs for verified human engagement

**Groth16 circuit (circom/snarkjs):**
- Public inputs: `behaviorCommitment` (bytes32), `qualityThreshold` (uint256), `campaignId` (uint256)
- Private inputs: raw engagement events (dwell, focus, viewability, scroll arrays)
- Constraints: ~50K (dwell sum > threshold, viewability count ≥ N, hash chain verification)
- Prover: in-browser WASM via snarkjs (~2-3s on modern hardware)
- Verifier: on-chain Groth16 via BN128 precompiles (ecAdd 0x06, ecMul 0x07, ecPairing 0x08)

**Contract:** Replace `DatumZKVerifier` stub with real Groth16 verifier.
- `verify(uint256[8] proof, uint256[3] publicInputs) → bool`
- Called by Settlement when `campaignZkRequired[campaignId] == true`
- Non-ZK campaigns skip verification entirely (no gas overhead)

**Hash strategy:** Poseidon for in-circuit hashing (~250 constraints/hash). Blake2-256 stays for on-chain claim hash chain. Bridge: circuit proves knowledge of Poseidon preimage that maps to on-chain Blake2 commitment.

### 2.4 Recommended Implementation Order

| Phase | Items | Timeline | Gate |
|-------|-------|----------|------|
| A | BM-7 (SDK registry), BM-2 (settlement cap) | Weeks 1-3 | Alpha-3 testnet |
| B | BM-1 (ZK proof + campaign toggle) | Weeks 4-7 | Circuit audit |
| C | BM-3 (CAPTCHA), BM-4 (publisher fraud detection), BM-5 (rate limiter) | Weeks 8-11 | — |
| D | BM-6, BM-8, BM-9 (disputes, reputation, anomaly) | Weeks 12+ | Governance design |

---

## 3. Contract Security — Medium (SM-*)

*From SECURITY-AUDIT.md. All MEDIUM severity, open.*

| ID | Audit ID | Title | Contract | Description | Recommendation |
|----|----------|-------|----------|-------------|----------------|
| SM-1 | M-1 | Relay co-sig validation for open campaigns | DatumRelay | Open campaigns verify against `claims[0].publisher` — re-ordering claims array breaks validation | Verify against ALL claims or require sorted order |
| SM-2 | M-2 | BudgetLedger daily cap timestamp manipulation | DatumBudgetLedger | `block.timestamp / 86400` day boundary — validators can shift by ±1 block | Accepted for alpha. Use block numbers for mainnet |
| SM-3 | M-3 | Settlement unbounded batch processing | DatumSettlement | No cap on batch count per call. Could hit gas limit | Add `require(batches.length <= 10)` |
| SM-4 | M-4 | EIP-712 signature malleability | Relay, AttestationVerifier | No `s`-value canonicalization check | Add `require(uint256(s) <= 0x7FFFFFFF...)` |
| SM-5 | M-5 | GovernanceSlash weight snapshot timing | DatumGovernanceSlash | `winningWeight` at finalization, not resolution. Early withdrawals reduce denominator | Snapshot at resolution time |
| SM-6 | M-6 | PauseRegistry single-EOA owner | DatumPauseRegistry | No two-person rule or multisig | Pre-mainnet: deploy behind 2-of-3 multisig |
| SM-7 | M-7 | setCampaignStatus no transition validation | DatumCampaigns | Lifecycle can set any status without checking valid transitions | Add status transition matrix |

---

## 4. Contract Security — Low (SL-*)

| ID | Audit ID | Title | Contract | Note |
|----|----------|-------|----------|------|
| SL-1 | L-1 | sweepDust sends to owner | BudgetLedger | Owner can change between dust accumulation and sweep |
| SL-2 | L-2 | receive() accepts arbitrary deposits | GovernanceV2 | Mixes with voter stakes |
| SL-3 | L-3 | No events on Settlement.configure() | Settlement | Unlike other admin setters |
| SL-4 | L-4 | setSlashContract once-only | GovernanceV2 | Prevents correction if wrong address |
| SL-5 | L-5 | Relay deadline front-run | Relay | Validator can delay inclusion past deadline |
| SL-6 | L-6 | No max batch size in Relay | Relay | Large arrays could hit gas limit |
| SL-7 | L-7 | categoryId unbounded (0-255) | Campaigns | System uses 1-26 only. Alpha-3: replaced by tags (TX-2) |
| SL-8 | L-8 | PaymentVault E58 blocks small withdrawals | PaymentVault | Known design tradeoff — dust permanently locked |
| SL-9 | L-9 | slashAction unrestricted parameter | GovernanceV2 | Only action==0 implemented; others silently ignored |

---

## 5. Extension Security — Critical/High (XH-*)

**These block open testing.**

| ID | Audit ID | Title | File | Status | Note |
|----|----------|-------|------|--------|------|
| XH-1 | 1.1 | No user approval for signing via provider | background/index.ts | **Code-fixed (origin check)** | Full popup approval flow still needed for mainnet |
| XH-2 | 1.2 | Unrestricted RPC proxy | background/index.ts | **Code-fixed (allowlist)** | SAFE_RPC_METHODS allowlist implemented |
| XH-3 | 1.3 | Private key in plaintext via message | Settings.tsx, background | **Code-fixed (password-only)** | Background decrypts with user password |
| XH-4 | 2.1 | Provider bridge accessible to all pages | content/provider.ts | **Code-fixed (conditional inject)** | SDK detection + MutationObserver gating |

**Remaining work:** XH-1 needs a full popup approval dialog (domain, message preview, approve/reject buttons) before mainnet. Current fix uses `isExtensionOrigin()` check which blocks external pages but doesn't show user what's being signed.

---

## 6. Extension Security — Medium (XM-*)

| ID | Audit ID | Title | File | Description |
|----|----------|-------|------|-------------|
| XM-1 | 1.4 | Generated key displayed without timeout | popup/App.tsx | Add 60s auto-clear for `generatedKey` |
| XM-2 | 1.5 | Unlocked wallet accessible to all imports | walletManager.ts | Architectural. WalletConnect for production |
| XM-3 | 2.2 | Relay URL override by any page | background/index.ts | Validate relay ownership or domain match |
| XM-4 | 3.1 | SDK detection trusts DOM | sdkDetector.ts | Verify publisher identity on-chain or DNS TXT |
| XM-5 | 5.1 | Non-atomic mutex (TOCTOU) | claimQueue.ts | Use in-memory lock in service worker |
| XM-6 | 5.2 | Chain state sync trusts popup | background/index.ts | Background verify on-chain state directly |
| XM-7 | 6.1 | IPFS content not hash-verified | background/index.ts | SHA-256 verify response against CID |
| XM-8 | 7.1 | Phishing list fail-open | phishingList.ts | Bundle baseline list at build time |
| XM-9 | 8.1 | Shadow DOM open mode | adSlot.ts | Switch to `mode: "closed"` |
| XM-10 | 10.1 | Handshake uses SHA-256 not crypto sig | handshake.ts | Use HMAC or asymmetric signature |
| XM-11 | 11.1 | Pinata API key plaintext | Settings.tsx | Encrypt with PBKDF2+AES-GCM or session storage |
| XM-12 | 12.1 | `<all_urls>` manifest permission | manifest.json | Document necessity or switch to `activeTab` |
| XM-13 | 14.1 | Import overwrites during RPC outage | claimExport.ts | Add warning when on-chain state unverifiable |
| XM-14 | 13.1 | No SW restart notification | background/index.ts | Notify user that auto-submit de-authorized on restart |

---

## 7. Extension Security — Low (XL-*)

| ID | Audit ID | Title | File |
|----|----------|-------|------|
| XL-1 | 3.2 | Content script reads chrome.storage.local | content/index.ts |
| XL-2 | 6.2 | Arbitrary HTTPS image URLs enable tracking | adSlot.ts |
| XL-3 | 8.3 | Inline onerror on img tag | adSlot.ts |
| XL-4 | 12.3 | `tabs` permission may be unnecessary | manifest.json |
| XL-5 | 13.2 | Encrypted auto-submit key persists after SW restart | background/index.ts |
| XL-6 | 14.2 | Import doesn't validate claim hash chain | claimExport.ts |

---

## 8. Web App Security (WS-*)

| ID | Audit ID | Severity | Title | File |
|----|----------|----------|-------|------|
| WS-1 | F-01 | **HIGH** | Private key in memory no cleanup | WalletConnect.tsx | **Code-fixed** |
| WS-2 | F-02 | MEDIUM | IPFS API key plaintext in localStorage | SettingsContext.tsx |
| WS-3 | F-03 | MEDIUM | Address in window.open() URL | AddressDisplay.tsx |
| WS-4 | F-04 | MEDIUM | Explorer URL injection via on-chain data | CampaignDetail.tsx |
| WS-5 | F-05 | MEDIUM | Unbounded event log fetching | Overview, CampaignDetail, Publishers, Dashboard, MyVotes, Blocklist |
| WS-6 | F-06 | MEDIUM | Sequential campaign ID scanning | advertiser/Dashboard.tsx |
| WS-7 | F-07 | MEDIUM | Custom IPFS endpoint SSRF | ipfsPin.ts |
| WS-8 | F-08 | LOW | IPFS gateway URL not validated | ipfs.ts, IPFSPreview.tsx |
| WS-9 | F-09 | LOW | Contract address inputs not validated | Settings.tsx |
| WS-10 | F-10 | LOW | Error messages expose RPC details | errorCodes.ts |
| WS-11 | F-11 | LOW | RPC URL allows HTTP | SettingsContext.tsx |
| WS-12 | F-14 | LOW | Missing rel="noopener noreferrer" | Layout.tsx |

---

## 9. Contract Satellite Extraction (SE-*)

**Problem:** The 4 largest alpha-2 contracts are near the 49,152 B PVM limit, leaving no room for future features or security fixes:

| Contract | PVM Size | Spare | Status |
|----------|----------|-------|--------|
| Settlement | 48,052 B | **1,100 B** | Frozen |
| GovernanceV2 | 47,939 B | **1,213 B** | Frozen |
| Relay | 46,872 B | 2,280 B | Near frozen |
| Campaigns | 42,466 B | 6,686 B | Tight |

**Goal:** Extract logic into satellite contracts to reclaim headroom for alpha-3 features (targeting tags, ZK toggle, settlement caps, security fixes).

| ID | Item | Source Contract | Extracted Logic | Est. Savings | New Satellite Size | Priority |
|----|------|----------------|-----------------|--------------|-------------------|----------|
| SE-1 | `DatumClaimValidator` | Settlement | `_validateClaim()` — 11 checks (zero impressions, campaign lookup, bid validation, publisher match, blocklist, clearing CPM, nonce chain, hash chain, Blake2/keccak256 hash). Eliminates campaigns + publishers staticcalls from Settlement. | **~2.5 KB** → Settlement at ~3,600 spare | ~18-22 KB | **HIGH** |
| SE-2 | `DatumGovernanceHelper` | GovernanceV2 | Slash computation + dust check from `withdraw()`. Slash percentage calc, minimumBalance precompile call, loser-side penalty logic. | **~1.5 KB** → GovernanceV2 at ~2,700 spare | ~12-15 KB | MEDIUM |
| SE-3 | `DatumCampaignValidator` | Campaigns | S12 blocklist + allowlist checks from `createCampaign()` — 4 publishers cross-contract calls (isBlocked×2, allowlistEnabled, isAllowedAdvertiser). | **~1.5 KB** → Campaigns at ~8,200 spare | ~15-18 KB | MEDIUM (aligns with MG-1 timelock migration) |
| SE-4 | Relay publisher co-sig | Relay | Publisher attestation verification (40 LOC) from `settleClaimsFor()`. Determines expectedPub, verifies co-sig ecrecover. | **~2 KB** → Relay at ~4,300 spare | ~12-15 KB | LOW (Relay is already thin wrapper) |

### Extraction Architecture

**SE-1: DatumClaimValidator (HIGH priority)**
```
Settlement.settleClaims() → validator.validateClaim(claim, user) → bool + reasonCode
```
- Validator holds refs: campaigns, publishers, pauseRegistry
- Settlement calls `validator.validateClaim()` via staticcall (read-only validation)
- Blake2/keccak256 hash logic moves to validator (eliminates Settlement's ISystem import if sole user)
- Settlement keeps `_processBatch()` and `_settleSingleClaim()` (value transfer logic stays in Settlement)
- **Unblocks:** SM-3 (batch cap), SM-7 (status transitions), future claim validation rules

**SE-2: DatumGovernanceHelper (MEDIUM priority)**
```
GovernanceV2.withdraw() → helper.computeSlash(vote, campaign) → slashAmount
```
- Helper holds ref: campaigns (for status lookup)
- GovernanceV2 calls helper for slash math, keeps value transfer + reentrancy guard
- minimumBalance precompile call could move to helper (saves ~2.1 KB if sole precompile user)
- **Unblocks:** Additional governance features, conviction curve changes

**SE-3: DatumCampaignValidator (MEDIUM priority — aligns with MG-1)**
```
Campaigns.createCampaign() → validator.validateCreation(advertiser, publisher) → bool
```
- Validator holds refs: publishers (blocklist + allowlist)
- Decouples campaign creation from publisher contract checks
- **Key enabler for MG-1:** Timelock-gated blocklist migration. Validator becomes governance-controlled instead of onlyOwner
- **Unblocks:** TX-2 (required tags check at creation), future creation rules

**SE-4: Relay publisher co-sig (LOW priority — defer)**
- Relay is already a thin signature wrapper. Extraction adds interface overhead for marginal savings.
- Better to leave integrated unless Relay needs significant new features.

### Combined Impact

| Contract | Current Spare | After SE-1 | After SE-1+SE-2 | After SE-1+SE-2+SE-3 |
|----------|---------------|-----------|-----------------|---------------------|
| Settlement | 1,100 B | **~3,600 B** | ~3,600 B | ~3,600 B |
| GovernanceV2 | 1,213 B | 1,213 B | **~2,700 B** | ~2,700 B |
| Campaigns | 6,686 B | 6,686 B | 6,686 B | **~8,200 B** |
| New contracts | — | +1 (~20 KB) | +2 (~34 KB) | +3 (~50 KB) |
| Total contracts | 13 | 14 | 15 | 16 |

**Note:** Each new satellite must be < 49,152 B PVM. All estimated sizes are well within limits. Deploy script and cross-contract wiring must be updated for each extraction.

---

## 10. Contract Hardening & Gas (CH-*)

| ID | Origin | Item | Status | Note |
|----|--------|------|--------|------|
| CH-1 | S4 | ZK verification accepts empty return | **Open** | Stub verifier. Not applicable until real ZK (BM-1) |
| CH-2 | O2 | `weightLeft()` batch loop early abort | **Open (PVM blocked)** | Exceeds Settlement (1,100 spare) and Relay (2,974 spare). Alpha-3: possible if contract restructured |

---

## 11. Extension UX — Phase 3 Polish (UP-*)

| ID | Item | Description |
|----|------|-------------|
| UP-2 | Address blocklist management UI | `phishingList.ts` has API but no panel. Users can't manually block addresses |
| UP-4 | Silenced "Uncategorized" ads | `categoryId=0` bypasses silencing. Alpha-3: replaced by tag-based filtering (TX-3) |
| UP-8 | Per-campaign frequency cap | `maxAdsPerHour` is global. Single high-bid campaign dominates all slots |

---

## 12. Extension UX — Beta Features (UB-*)

| ID | Origin | Item | Description |
|----|--------|------|-------------|
| UB-1 | AD-3 | Advanced content blocklist | Unicode normalization, leetspeak detection for obfuscation bypass |
| UB-2 | EA-3 | Behavior chain storage cleanup | Clean up `behaviorChain:*` keys for terminal campaigns or cap per user |
| UB-3 | WS-4 | Typed DELETE confirmation | Require typing "DELETE" for wallet removal |
| UB-4 | UP-6 | Ads-per-hour counter display | Show "X/12 ads shown this hour" in UI |
| UB-5 | E-M2 | Interest profile storage race | Non-atomic `get→mutate→set` — multi-tab race condition |
| UB-6 | E-M3 | Metadata fetch failure retry UI | Failure count tracking + notification for 3+ consecutive failures |
| UB-7 | E-M6 | Conviction tooltip | Explain conviction weight × lockup relationship |
| UB-8 | X7 | Phishing list fetch resilience | Retry with exponential backoff, stale-cache warning |
| UB-9 | — | Vote stacking (`increaseStake()`) | Contract-level change: allow adding to existing vote |
| UB-10 | — | Conviction preview | Show weighted vote power + lockup estimate before submit |
| UB-11 | — | Campaign detail modal | Click campaign in governance list for full details |
| UB-12 | — | Vote history dashboard | Track votes across campaigns with lockup status |
| UB-13 | — | Batch relay management | Publisher per-user breakdown of signed batches |
| UB-14 | — | Auto-relay | Publisher background auto-submits signed batches |
| UB-15 | — | Governance notifications | Alert when voted campaign activated/terminated |
| UB-16 | — | Multi-address relay | Publisher collects batches from multiple user extensions |

---

## 13. Feature Development — Post-Alpha (FD-*)

| ID | Origin | Item | Effort | Deps |
|----|--------|------|--------|------|
| FD-1 | P7 | Contract upgrade path (UUPS proxy) | 2-3 weeks | Pre-mainnet gate |
| FD-2 | P17 | External wallet integration (WalletConnect v2) | 2 weeks | — |
| FD-3 | P9 | ZK proof Phase 1 — real Groth16 | 3-4 weeks | = BM-1 |
| FD-4 | F7 | sr25519 signature verification | 1-2 weeks | System precompile |
| FD-5 | P11 | XCM fee routing (HydraDX) | 2-3 weeks | XCM precompile |
| FD-6 | F9 | H160 phishing address list population | 1 week | Ethereum phishing feeds |
| FD-7 | — | Rich media ad rendering (image/video) | 2-3 weeks | IPFS metadata v2 |

---

## 14. Architectural & Long-Term (AL-*)

| ID | Item | Current State | Path Forward |
|----|------|---------------|--------------|
| AL-1 | ZK proof of auction outcome | Stub verifier | Real Groth16 (= BM-1/FD-3) |
| AL-2 | Viewability dispute mechanism | No dispute path | 7-day challenge window, governance arbiter (= BM-6) |
| AL-3 | Publisher SDK integrity | No version registry | On-chain hash registry (= BM-7) |
| AL-4 | Taxonomy governance | Hardcoded categories | Conviction referendum for tag additions. Alpha-3: tag-based (TX-*) replaces bitmask |
| AL-5 | Revenue split governability | 75/25 hardcoded | Governance parameter with timelock |
| AL-6 | Minimum CPM floor governance | Owner-settable | Governance parameter |
| AL-7 | KYB cost responsibility | No enforcement | One-time onboarding deposit |
| AL-8 | GDPR right to erasure | No plan | Hash-of-hash on-chain, PII off-chain |
| AL-9 | Price discovery mechanism | On-device only | Off-chain batch auction per epoch; ZK proof |
| AL-10 | XCM retry queue | Not implemented | Idempotency keys + bounded retries |
| AL-11 | Extension version coordination | No registry | Hash registration before release |
| AL-12 | Multi-chain settlement | Single chain | XCM-based cross-chain (post-mainnet) |
| AL-13 | Decentralized KYB identity (P10) | Permissionless | zkMe or Polkadot PoP evaluation |

---

## 15. Pre-Mainnet Gate (MG-*)

*All must be completed before Kusama/Polkadot Hub mainnet deployment.*

| ID | Item | Description | Status |
|----|------|-------------|--------|
| MG-1 | Timelock-gated blocklist | `blockAddress()`/`unblockAddress()` through 48h timelock | **Open** |
| MG-2 | Governance blocklist override | Community unblock via conviction vote (Option C hybrid) | **Open** |
| MG-3 | Contract upgrade path | UUPS proxy or migration for PaymentVault (= FD-1) | **Open** |
| MG-4 | External security audit | All 13+ contracts reviewed by external auditor | **Open** |
| MG-5 | Two-step ownership transfer | `transferOwnership()` → `acceptOwnership()` pattern (L3) | **Open** |
| MG-6 | Phase 4A — Kusama deployment | Kusama-specific params, 2-of-3 multisig, third-party advertiser | **Open** |
| MG-7 | Phase 4B — Polkadot Hub mainnet | Production deploy, Web Store extension, monitoring | **Open** |

---

## 16. Deployment & Validation (DV-*)

*Alpha-2/3 testnet deployment and E2E validation.*

| ID | Item | Description | Status |
|----|------|-------------|--------|
| DV-1 | Alpha-2 Paseo deploy | Deploy 13 contracts to Paseo, run `setup-testnet.ts` | **Open** |
| DV-2 | E2E browser validation | Load extension with live addresses, full flow on Paseo | **Open** |
| DV-3 | External tester gate | ≥3 external testers complete full flow | **Open** |
| DV-4 | Stability gate | No critical bugs in first 7 days | **Open** |
| DV-5 | Gas benchmark | `settleClaimsFor()` relay vs direct comparison | **Open** |

---

## 17. Low Priority / Nice-to-Have (LP-*)

| ID | Origin | Item | Description |
|----|--------|------|-------------|
| LP-1 | L1 | MAX_SCAN_ID increase | Campaign poller hardcoded to IDs 1-1000 |
| LP-2 | L2 | Configurable poll interval | 5-min interval should be user-configurable |
| LP-3 | L4 | Concurrent settlement test | Multiple users settling same block |
| LP-4 | L6 | Claim export/import test procedure | Cross-device verification README |
| LP-5 | L7 | Per-campaign publisher whitelist | Requires `DatumCampaignValidator` satellite |
| LP-6 | I-5 | Campaign struct packing | Pack `snapshotTakeRateBps`, `status`, `categoryId` into one slot |

---

## Implementation Priority (Alpha-3 Phases)

### Phase 1: Security Fixes + Deploy (Weeks 1-2)
- DV-1: Deploy alpha-2 to Paseo
- SM-3: Settlement batch size cap
- SM-4: EIP-712 signature malleability fix
- XH-1: Full signing approval popup (extends existing origin check)
- WS-5: Bounded event log fetching (all web app pages)

### Phase 2: Satellite Extraction (Weeks 2-4)
- **SE-1: `DatumClaimValidator`** — extract from Settlement (HIGH, +2.5 KB headroom)
- **SE-2: `DatumGovernanceHelper`** — extract from GovernanceV2 (MEDIUM, +1.5 KB headroom)
- **SE-3: `DatumCampaignValidator`** — extract from Campaigns (MEDIUM, +1.5 KB headroom, enables MG-1)
- Update deploy script, cross-contract wiring, tests for 14-16 contracts

### Phase 3: Targeting Redesign (Weeks 4-6)
- TX-1: `DatumTargetingRegistry` contract (uses Campaigns headroom from SE-3)
- TX-2: Campaign `requiredTags` field
- TX-3: Tag matching in auction
- TX-4: SDK tag declaration
- TX-5: Standard tag dictionary
- TX-6: Publisher tag management UI
- TX-7: Campaign tag picker UI

### Phase 4: Bot Mitigation A (Weeks 6-8)
- BM-7: SDK version registry on Publishers
- BM-2: Per-user settlement cap (`DatumSettlementGuard`, uses Settlement headroom from SE-1)

### Phase 5: ZK Integration (Weeks 9-12)
- BM-1: Groth16 circuit + verifier + campaign toggle
- CH-1: Real ZK verifier replaces stub

### Phase 6: Hardening + Beta UX (Weeks 12+)
- SM-1, SM-5, SM-7: Remaining contract security mediums
- XM-*: Extension security mediums
- UB-*: Beta UX features
- BM-3 through BM-9: Remaining bot mitigation

### Pre-Mainnet
- MG-1 through MG-7: All mainnet gate items
- FD-1: UUPS proxy
- MG-4: External security audit
