# DATUM Alpha-2 Extension — Implementation Plan

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Rebuild browser extension for 13-contract alpha-2 architecture
**Prerequisite:** Web app (24 pages, complete), alpha extension (archived, 140/140 tests)

---

## Table of Contents

1. [Delta from Alpha Extension](#1-delta-from-alpha-extension)
2. [Architecture](#2-architecture)
3. [Shared Library Extraction](#3-shared-library-extraction)
4. [Blake2 Hash Migration](#4-blake2-hash-migration)
5. [Extension Popup (3 Tabs)](#5-extension-popup-3-tabs)
6. [Background Service Worker](#6-background-service-worker)
7. [Content Scripts](#7-content-scripts)
8. [Web App Provider Bridge](#8-web-app-provider-bridge)
9. [Settlement Path Changes (P1 Attestation)](#9-settlement-path-changes-p1-attestation)
10. [Relay Integration Fix](#10-relay-integration-fix)
11. [Contract Migration (9 → 13)](#11-contract-migration-9--13)
12. [File Inventory](#12-file-inventory)
13. [Test Plan](#13-test-plan)
14. [Implementation Phases](#14-implementation-phases)
15. [Risk Register](#15-risk-register)

---

## 1. Delta from Alpha Extension

The alpha-2 extension is NOT a patch on the alpha extension. It is a **clean rebuild** that carries forward all background/content logic but restructures the popup and shared layers for the new 13-contract architecture.

### What changes

| Area | Alpha (archived) | Alpha-2 |
|------|-------------------|---------|
| **Popup tabs** | 7 (Campaigns, Claims, Earnings, Publisher, My Ads, Govern, Settings) | 3 (Earnings, Claims, Settings) |
| **Contracts** | 9 (no BudgetLedger, PaymentVault, Lifecycle, AttestationVerifier) | 13 |
| **Claim hash** | keccak256 | Blake2-256 on PolkaVM, keccak256 fallback on EVM |
| **Settlement path** | `Settlement.settleClaims()` direct | `AttestationVerifier.settleClaimsAttested()` (P1 mandatory) |
| **Relay submit** | Sign only, no POST | Sign + POST to publisher relay `/relay/submit` |
| **Shared code** | `src/shared/` inline | `@datum/shared` workspace consumed by extension + web app |
| **Publisher/Advertiser/Governance UI** | In extension popup | Removed — use web app |
| **Web app wallet bridge** | None | `window.datum` provider via content script |
| **Conviction levels** | 0-6 (7 levels) | 0-8 (9 levels) |
| **Earnings source** | `Settlement` (balance was in Settlement) | `PaymentVault.userBalance()` / `PaymentVault.withdrawUser()` |
| **Budget reads** | `Campaigns.getCampaign()` (budget in Campaign struct) | `BudgetLedger.getRemainingBudget()` (extracted) |
| **Campaign settlement data** | `getCampaignForSettlement()` → 5 fields | `getCampaignForSettlement()` → 4 fields `[status, publisher, bidCpmPlanck, snapshotTakeRateBps]` |
| **Blocklist** | None | S12 — `publishers.isBlocked()` check in campaignPoller, phishingList |
| **Inactivity expiry (P20)** | None | Awareness in campaignPoller (mark stale campaigns) |

### What stays unchanged

All background and content script logic carries forward as-is (with targeted modifications noted below):

- `campaignPoller.ts` — campaign scanning + IPFS metadata (update contract calls)
- `engagement.ts` — IntersectionObserver viewport tracking
- `behaviorChain.ts` — hash chain building (**Blake2 migration**)
- `behaviorCommit.ts` — behavior commitment computation (**Blake2 migration**)
- `auction.ts` — Vickrey second-price selection
- `adSlot.ts` — Shadow DOM ad rendering
- `content/index.ts` — content script injection + SDK detection
- `sdkDetector.ts` — publisher SDK detection
- `handshake.ts` — challenge-response with SDK
- `walletManager.ts` — multi-account AES-256-GCM wallet
- `claimExport.ts` — encrypted claim backup/restore
- `timelockMonitor.ts` — pending change detection
- `phishingList.ts` — CTA URL + address filtering
- `contentSafety.ts` — metadata validation + sanitization
- `qualityScore.ts` — engagement quality scoring
- `interestProfile.ts` — exponential decay interest weighting
- `userPreferences.ts` — blocked campaigns, silenced categories, rate limits
- `zkProofStub.ts` — dummy proof (real Groth16 is BL-2, post-alpha)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    @datum/shared                         │
│  types.ts, networks.ts, contracts.ts, abis/ (×13),      │
│  errorCodes.ts, dot.ts, ipfs.ts, contentSafety.ts,      │
│  conviction.ts, qualityScore.ts, categories              │
└────────────┬───────────────────────────┬────────────────┘
             │                           │
    ┌────────▼──────────┐      ┌─────────▼──────────────┐
    │  Browser Extension │      │     Web Application     │
    │  (MV3, 3 tabs)    │      │   (React SPA, 24 pages) │
    │                    │      │   [already built]       │
    │  Popup:            │      │                          │
    │   - Earnings       │      │  Connects via:           │
    │   - Claims         │      │  window.datum (ext) OR   │
    │   - Settings       │      │  window.ethereum (MM)    │
    │                    │      │                          │
    │  Background:       │      │                          │
    │   all SW logic     │      │                          │
    │                    │      │                          │
    │  Content:          │      │                          │
    │   - adSlot         │      │                          │
    │   - SDK handshake  │      │                          │
    │   - provider.ts ◀──┼──────┤  window.datum bridge     │
    └───────────────────┘      └──────────────────────────┘
             │                           │
             └───────────┬───────────────┘
                         │
              ┌──────────▼──────────┐
              │  Polkadot Hub /     │
              │  Paseo (13 contracts)│
              └─────────────────────┘
```

### Directory Structure

```
alpha-2/
├── extension/
│   ├── manifest.json
│   ├── package.json
│   ├── tsconfig.json
│   ├── webpack.config.ts
│   ├── jest.config.ts
│   ├── icons/
│   ├── src/
│   │   ├── background/
│   │   │   ├── index.ts              # Service worker (message hub)
│   │   │   ├── campaignPoller.ts     # On-chain campaign scanning
│   │   │   ├── claimBuilder.ts       # Hash chain claim construction
│   │   │   ├── claimQueue.ts         # Pending claim queue
│   │   │   ├── auction.ts            # Vickrey second-price auction
│   │   │   ├── interestProfile.ts    # User interest weighting
│   │   │   ├── userPreferences.ts    # Ad preferences + rate limits
│   │   │   ├── publisherAttestation.ts  # Publisher co-sig fetch
│   │   │   ├── timelockMonitor.ts    # Pending admin change monitor
│   │   │   └── zkProofStub.ts        # Dummy ZK proof
│   │   ├── content/
│   │   │   ├── index.ts              # Content script entry
│   │   │   ├── adSlot.ts             # Shadow DOM ad injection
│   │   │   ├── engagement.ts         # Viewport tracking
│   │   │   ├── handshake.ts          # SDK challenge-response
│   │   │   ├── sdkDetector.ts        # Publisher SDK detection
│   │   │   ├── taxonomy.ts           # Page classification
│   │   │   └── provider.ts           # NEW: window.datum bridge
│   │   ├── popup/
│   │   │   ├── index.html
│   │   │   ├── index.tsx
│   │   │   ├── App.tsx               # 3-tab shell + wallet
│   │   │   ├── EarningsPanel.tsx     # NEW: user earnings + withdraw
│   │   │   ├── ClaimQueue.tsx        # Simplified claims tab
│   │   │   └── Settings.tsx          # Simplified settings
│   │   ├── offscreen/
│   │   │   ├── offscreen.html
│   │   │   └── offscreen.ts
│   │   └── shared/ → imports from @datum/shared
│   └── test/
│       ├── auction.test.ts
│       ├── qualityScore.test.ts
│       ├── taxonomy.test.ts
│       ├── contentSafety.test.ts
│       ├── phishingList.test.ts
│       ├── ipfs.test.ts
│       ├── dot.test.ts
│       ├── userPreferences.test.ts
│       ├── types.test.ts
│       ├── blake2.test.ts           # NEW: Blake2 hash chain tests
│       ├── claimBuilder.test.ts     # NEW: claim building tests
│       ├── provider.test.ts         # NEW: window.datum bridge tests
│       └── chromeMock.ts
├── shared/                          # @datum/shared workspace
│   ├── package.json
│   ├── tsconfig.json
│   ├── types.ts
│   ├── networks.ts
│   ├── contracts.ts                 # 13 contract factories
│   ├── abis/                        # 13 ABIs (from web/src/shared/abis/)
│   ├── errorCodes.ts
│   ├── dot.ts
│   ├── ipfs.ts
│   ├── ipfsPin.ts
│   ├── contentSafety.ts
│   ├── conviction.ts
│   ├── qualityScore.ts
│   ├── categories.ts                # Extracted from types.ts
│   └── blockTime.ts                 # NEW: block↔time helpers
└── contracts/                       # Existing alpha-2 contracts
```

---

## 3. Shared Library Extraction

The alpha extension's `src/shared/` and the web app's `src/shared/` contain overlapping but diverged code. The alpha-2 extension must use the **same** shared library as the web app.

### Strategy: npm workspace

```
alpha-2/
├── package.json          # workspace root
├── shared/               # @datum/shared workspace
│   └── package.json      # name: "@datum/shared"
├── extension/            # @datum/extension workspace
│   └── package.json      # depends on @datum/shared
└── contracts/            # existing (unchanged)
```

The web app (`web/`) continues to have its own `src/shared/` for now. Once the shared library stabilizes, the web app can consume `@datum/shared` too. For now, the web app's shared code is the **reference implementation** — the workspace package starts as a copy of `web/src/shared/`.

### Files to extract into `@datum/shared`

Source: `web/src/shared/` (already correct for 13-contract alpha-2)

| File | Notes |
|------|-------|
| `types.ts` | ContractAddresses (13 contracts), Campaign types, CampaignMetadata, CampaignStatus, CATEGORY_NAMES, category hierarchy |
| `networks.ts` | NETWORK_CONFIGS (local, Paseo, westend, kusama, polkadotHub), DEFAULT_SETTINGS, CURRENCY_SYMBOL |
| `contracts.ts` | 13 factory functions (campaigns, publishers, governanceV2, governanceSlash, settlement, relay, pauseRegistry, timelock, zkVerifier, budgetLedger, paymentVault, lifecycle, attestationVerifier) |
| `abis/*.json` | All 13 contract ABIs |
| `errorCodes.ts` | ERROR_MESSAGES map (E00-E64, P, reason codes), humanizeError() |
| `dot.ts` | parseDOT, formatDOT, DOT_DECIMALS |
| `ipfs.ts` | cidToBytes32, bytes32ToCid, metadataUrl |
| `ipfsPin.ts` | pinToIPFS, testPinataKey |
| `contentSafety.ts` | validateAndSanitize, CONTENT_BLOCKLIST, URL_SCHEME_ALLOWLIST, MAX_METADATA_BYTES |
| `conviction.ts` | CONVICTION_WEIGHTS (9 levels), CONVICTION_LOCKUPS, convictionWeight, convictionLabel, formatBlockDelta |
| `qualityScore.ts` | computeQualityScore, meetsQualityThreshold (from alpha extension) |

### New shared utilities

| File | Purpose |
|------|---------|
| `categories.ts` | Extract CATEGORY_NAMES, getCategoryParent, buildCategoryHierarchy, categoriesToBitmask, bitmaskToCategories from types.ts |
| `blockTime.ts` | BLOCK_TIME_SECONDS=6, blocksToMs, msToBlocks, formatBlockDelta (consolidate from conviction.ts + inline code) |

### Extension-only files (NOT shared)

These stay in `extension/src/` because they use Chrome APIs or are extension-specific:

| File | Reason |
|------|--------|
| `walletManager.ts` | chrome.storage.local, PBKDF2/AES-256-GCM |
| `claimExport.ts` | chrome.storage.local, signer-derived key |
| `phishingList.ts` | chrome.storage.local cache, chrome.alarms |
| `messages.ts` | Chrome message type definitions |
| `behaviorChain.ts` | chrome.storage.local chain state |
| `behaviorCommit.ts` | chrome.storage.local |

---

## 4. Blake2 Hash Migration

**This is the #1 blocker for alpha-2 testnet deployment.**

### Problem

Alpha extension uses `keccak256` for claim hashes. Alpha-2 Settlement on PolkaVM uses `ISystem(0x900).hashBlake256()` with keccak256 fallback only on Hardhat EVM. Claims submitted from the extension will fail hash validation on-chain.

### Changes Required

#### 4.1 `behaviorChain.ts` — behavior hash chain

**Alpha (keccak256):**
```typescript
import { solidityPackedKeccak256 } from "ethers";
newHash = solidityPackedKeccak256(types, values);
```

**Alpha-2 (Blake2-256):**
```typescript
import { blake2b } from "@noble/hashes/blake2b";
import { solidityPacked } from "ethers";

function blake2Hash(types: string[], values: any[]): string {
  const packed = solidityPacked(types, values);
  const bytes = hexToBytes(packed);
  const hash = blake2b(bytes, { dkLen: 32 });
  return "0x" + bytesToHex(hash);
}
```

The `@noble/hashes` package is already a dependency in the alpha extension (v2.0.1). The `blake2b` import with `dkLen: 32` produces the same 32-byte digest as `ISystem.hashBlake256()`.

#### 4.2 `claimBuilder.ts` — claim hash computation

Same migration: replace `solidityPackedKeccak256` with `blake2Hash` for:
```
hash(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousClaimHash)
```

**Argument order must match Settlement._validateClaim():** `(campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousClaimHash)` — publisher before user.

#### 4.3 `behaviorCommit.ts` — behavior commitment

Same migration for the final commitment hash.

#### 4.4 Dual-mode support

For local development against Hardhat EVM (which still uses keccak256), support a setting:

```typescript
// In @datum/shared or extension settings
type HashMode = "blake2" | "keccak256";

// Settlement contract uses Blake2 on PolkaVM, keccak256 on EVM
// Default to blake2 for testnet/mainnet, keccak256 for local
function getHashMode(network: string): HashMode {
  return network === "local" ? "keccak256" : "blake2";
}
```

#### 4.5 Chain state migration

Existing chain states (from alpha extension) use keccak256 hashes. On upgrade:
- Clear all `chainState:*` keys (force re-sync from chain)
- Clear `claimQueue` (pending claims are invalid with wrong hash)
- Show one-time migration notice to user

### Test coverage

New test file: `test/blake2.test.ts`
- Verify Blake2-256 output matches `ISystem.hashBlake256()` for known inputs
- Verify claim hash matches Settlement's validation logic
- Verify behavior chain continuity after Blake2 migration
- Test dual-mode (keccak256 for local, Blake2 for testnet)
- Test packed encoding matches Solidity's `abi.encodePacked` for all claim field types

---

## 5. Extension Popup (3 Tabs)

### 5.1 App.tsx — Shell (rewritten)

**Tabs:** `[ Earnings | Claims | Settings ]`

**Header (same as alpha, simplified):**
- DATUM logo
- Active account name + truncated address (click to copy)
- Account switcher dropdown (MA-2)
- Lock button
- Chain heartbeat: connected/disconnected, block number, native balance
- Timelock pending change warning banner (H2)

**Wallet state machine (unchanged):**
```
loading → no-wallet → setup (import/generate)
loading → locked → password entry → unlocked
unlocked → [Earnings | Claims | Settings]
```

**Removed from alpha App.tsx:**
- Campaigns tab (→ web `/explorer/campaigns`)
- Publisher tab (→ web `/publisher`)
- My Ads tab (→ web `/advertiser`)
- Govern tab (→ web `/governance`)

**Size reduction:** ~892 lines → ~350 lines.

### 5.2 EarningsPanel.tsx (new, replaces UserPanel)

**Displays:**
- User balance from `PaymentVault.userBalance(address)` (was Settlement in alpha)
- Pending claims value estimate (from claim queue state)
- "Withdraw" button → `PaymentVault.withdrawUser()` with signer
- Link to web app for publisher earnings, governance stakes, etc.

**Removed (moved to web):**
- Publisher balance display
- Protocol balance display
- Campaign list
- Governance stake information

**Size:** ~150 lines.

### 5.3 ClaimQueue.tsx (simplified)

**Displays:**
- Pending claim count (per campaign, total)
- Estimated pending value
- Last flush timestamp
- Auto-submit status indicator

**Actions:**
- "Submit All" → build `AttestedBatch[]` + call `AttestationVerifier.settleClaimsAttested()` (P1 path, see §9)
- "Sign for Relay" → EIP-712 sign + POST to relay endpoint (see §10)
- "Export Claims" / "Import Claims" (P6, unchanged)
- "Sync Chain State" / "Clear Queue" (danger zone, collapsible)

**Removed (moved to web):**
- Detailed campaign-by-campaign claim breakdown
- Settlement history

**Size:** ~300 lines (from ~720).

### 5.4 Settings.tsx (simplified)

**Keeps:**
- Network selector (local, Paseo, westend, kusama, polkadotHub)
- RPC URL (auto-populated, editable)
- Test Connection button (SI-1)
- Contract addresses (collapsible, "Load Deployed" button for all 13)
- Auto-submit toggle + interval + authorize/revoke (B1)
- IPFS gateway URL
- Ad preferences (max ads/hour, min bid CPM, silenced categories, blocked campaigns)
- Interest profile (collapsible, reset button)
- Danger zone (clear queue, reset chain state)

**Removes:**
- Publisher address override (→ web `/publisher`)
- Pinata API key (→ web `/settings`, only advertisers pin metadata)
- Publisher relay URL (auto-detected from SDK or attestation endpoint)

**Size:** ~400 lines (from ~764).

---

## 6. Background Service Worker

### 6.1 `background/index.ts` — Message Handler Updates

**Contract changes:**
- Earnings read: `Settlement.earnings(address)` → `PaymentVault.userBalance(address)`
- Settlement submit: `Settlement.settleClaims(batches)` → `AttestationVerifier.settleClaimsAttested(attestedBatches)` (see §9)
- Campaign data: `getCampaignForSettlement()` returns 4 fields (not 5)
- Budget reads: `Campaigns.getCampaign().remainingBudget` → `BudgetLedger.getRemainingBudget(campaignId)`

**New message types:**
- `SUBMIT_ATTESTED_CLAIMS` — builds AttestedBatch[], fetches publisher co-sigs, submits via AttestationVerifier
- `POST_RELAY_BATCH` — POST signed batch to publisher relay endpoint (fix §10)

**Removed message types:**
- Governance actions (EVALUATE, FINALIZE_SLASH, CLAIM_SLASH) — moved to web app
- Publisher actions (REGISTER, SET_CATEGORIES, SET_TAKE_RATE) — moved to web app

**Auto-submit (`autoFlushDirect()`) changes:**
- Path: `AttestationVerifier.settleClaimsAttested()` instead of `Settlement.settleClaims()`
- Must fetch publisher co-signature before submission (from relay/attestation endpoint)
- Fallback: if publisher attestation unavailable, queue for manual submission

### 6.2 `campaignPoller.ts` — Contract Call Updates

**Alpha → Alpha-2 changes:**

| Alpha call | Alpha-2 call |
|------------|-------------|
| `getCampaignForSettlement(id)` → 5 fields | Same function name, but 4 fields: `[status, publisher, bidCpmPlanck, snapshotTakeRateBps]` |
| `getCampaign(id).remainingBudget` | `budgetLedger.getRemainingBudget(id)` |
| No blocklist check | `publishers.isBlocked(advertiser)` + `publishers.isBlocked(publisher)` → filter blocked |
| No inactivity tracking | Read `budgetLedger.lastSettlementBlock(id)` → mark stale (> 432,000 blocks inactive) |
| `CampaignCreated` events for categoryId | Same (unchanged) |
| `CampaignMetadataSet` events for metadataHash | Same (unchanged) |

**New: Enriched campaign data**
```typescript
interface SerializedCampaign {
  // existing
  id, advertiser, publisher, bidCpmPlanck,
  snapshotTakeRateBps, status, categoryId,
  pendingExpiryBlock, terminationBlock, metadataHash?,
  // new alpha-2 fields
  remainingBudget,        // from BudgetLedger
  dailyCap,               // from BudgetLedger
  lastSettlementBlock,    // from BudgetLedger (P20)
  isStale,                // computed: block.number > lastSettlement + 432,000
  advertisererBlocked,    // from Publishers.isBlocked()
  publisherBlocked,       // from Publishers.isBlocked()
}
```

### 6.3 `claimBuilder.ts` — Blake2 + Hash Order

- Replace `solidityPackedKeccak256` with `blake2Hash` (see §4.2)
- Verify argument order: `(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousHash)`
- `@noble/hashes/blake2b` import

### 6.4 `publisherAttestation.ts` — P1 Mandatory Path

Alpha extension treated publisher attestation as optional (degraded trust). Alpha-2 makes it **mandatory** for all settlement via AttestationVerifier.

**Changes:**
- Return value is no longer optional — attestation is required
- On failure: queue claim for retry (don't submit without attestation)
- Open campaigns: attestation still required, verified against `claims[0].publisher`
- Endpoint unchanged: `POST /.well-known/datum-attest`

### 6.5 `timelockMonitor.ts` — Event Name Changes

Verify event names match alpha-2 Timelock contract:
- `ChangeProposed(target, data, effectiveTime)` (unchanged)
- `ChangeExecuted(target, data)` (unchanged)
- `ChangeCancelled(target)` (unchanged)

No changes needed.

---

## 7. Content Scripts

### 7.1 `content/index.ts` — Minor Updates

**Campaign filtering changes:**
- Add S12 blocklist awareness: skip campaigns where `advertisererBlocked` or `publisherBlocked` is true (from enriched campaign data)
- `getCampaignForSettlement` returns 4 fields — update any destructuring

**Everything else unchanged:** SDK detection, handshake, ad injection, engagement tracking, page classification.

### 7.2 `adSlot.ts` — No Changes

Shadow DOM rendering, IPFS metadata display, creative rendering, close button — all unchanged.

### 7.3 `engagement.ts` — No Changes

IntersectionObserver, dwell tracking, IAB viewability, quality scoring — all unchanged.

### 7.4 `handshake.ts`, `sdkDetector.ts`, `taxonomy.ts` — No Changes

---

## 8. Web App Provider Bridge

**New file: `content/provider.ts`**

Injects `window.datum` object into all web pages, enabling the web app to connect using the extension's encrypted wallet.

### 8.1 Provider API

```typescript
// Injected into page context via content script
window.datum = {
  isDatum: true,
  version: "0.2.0",

  // Connection
  isConnected(): Promise<boolean>,
  connect(): Promise<string>,       // returns address, triggers popup approval
  disconnect(): Promise<void>,
  getAddress(): Promise<string>,

  // Signing
  signTransaction(tx: TransactionRequest): Promise<string>,
  signTypedData(domain, types, value): Promise<string>,  // for EIP-712

  // Events
  on(event: "connect" | "disconnect" | "accountsChanged", callback): void,
  removeListener(event, callback): void,
};
```

### 8.2 Implementation

**Content script (`provider.ts`):**
1. Inject `<script>` into page that defines `window.datum` as a proxy
2. Proxy relays calls to content script via `CustomEvent`
3. Content script relays to background via `chrome.runtime.sendMessage`
4. Background processes request using unlocked wallet
5. Response chain: background → content script → page script

**Security:**
- Every `signTransaction` / `signTypedData` call triggers a popup confirmation
- Popup shows: origin URL, transaction details, estimated gas
- User must click "Approve" before signing proceeds
- Origin allowlist in settings (auto-approve for trusted origins)

**New message types:**
```typescript
// Content → Background
PROVIDER_CONNECT = "PROVIDER_CONNECT"
PROVIDER_GET_ADDRESS = "PROVIDER_GET_ADDRESS"
PROVIDER_SIGN_TX = "PROVIDER_SIGN_TX"
PROVIDER_SIGN_TYPED_DATA = "PROVIDER_SIGN_TYPED_DATA"
PROVIDER_DISCONNECT = "PROVIDER_DISCONNECT"

// Background → Popup (approval)
PROVIDER_APPROVAL_REQUEST = "PROVIDER_APPROVAL_REQUEST"
PROVIDER_APPROVAL_RESPONSE = "PROVIDER_APPROVAL_RESPONSE"
```

### 8.3 Web App Integration

The web app's `walletProvider.ts` already checks for `window.datum`:
```typescript
export function isDatumExtensionAvailable(): boolean {
  return typeof (window as any).datum !== "undefined";
}
```

No web app changes needed — the extension just needs to provide the `window.datum` object.

---

## 9. Settlement Path Changes (P1 Attestation)

### Alpha path (direct)
```
User → Settlement.settleClaims(ClaimBatch[])
```

### Alpha-2 path (mandatory attestation)
```
User → fetch publisher co-sig → AttestationVerifier.settleClaimsAttested(AttestedBatch[])
     → AttestationVerifier verifies EIP-712 sig
     → AttestationVerifier → Settlement.settleClaims(ClaimBatch[])
```

### Extension flow

**Direct submit ("Submit All" in Claims tab):**
1. Build `ClaimBatch[]` from queue (existing logic)
2. For each batch, fetch publisher co-signature:
   - `publisherAttestation.ts` → `POST /.well-known/datum-attest` with batch info
   - Returns `{ signature: bytes }` (EIP-712 typed data signature)
   - If publisher has no relay/attestation endpoint: **cannot submit** (P1 is mandatory)
3. Construct `AttestedBatch[]`:
   ```typescript
   interface AttestedBatch {
     user: string;
     campaignId: bigint;
     claims: Claim[];
     publisherSig: string;  // from step 2
   }
   ```
4. Call `attestationVerifier.settleClaimsAttested(attestedBatches)` with user's signer
5. Parse `ClaimSettled` / `ClaimRejected` events from receipt
6. Remove settled claims from queue

**Auto-submit flow:**
1. Same as above, but using session-encrypted key
2. If publisher attestation fetch fails → skip batch, retry next alarm cycle
3. Log failure reason in auto-flush result

**Open campaigns:**
- Publisher address resolved from `claims[0].publisher` (the publisher who served the ad)
- AttestationVerifier verifies against this address
- Publisher must still have an attestation endpoint

### EIP-712 domain for attestation

The AttestationVerifier uses EIP-712 structured data:
```typescript
const domain = {
  name: "DatumAttestationVerifier",
  version: "1",
  chainId: chainId,
  verifyingContract: attestationVerifierAddress,
};

const types = {
  AttestedBatch: [
    { name: "user", type: "address" },
    { name: "campaignId", type: "uint256" },
    { name: "firstNonce", type: "uint256" },
    { name: "lastNonce", type: "uint256" },
    { name: "claimCount", type: "uint256" },
  ],
};
```

The publisher relay signs this structure. The extension must include the matching domain when requesting attestation.

---

## 10. Relay Integration Fix

### Problem (from UI plan §10.1)

Alpha extension's "Sign for Relay" button creates an EIP-712 signature but **never POSTs** the signed batch to the publisher's relay endpoint. The user signs, and nothing happens.

### Fix

After user signs the relay batch:

1. Determine relay endpoint URL:
   - From SDK detection: `sdkInfo.relay` (if publisher's SDK tag declares `data-relay="..."`)
   - From attestation endpoint: same domain + `/relay/submit`
   - From cached `publisherDomain:{address}` in storage
   - Fallback: prompt user for relay URL
2. POST signed batch:
   ```typescript
   const response = await fetch(relayUrl + "/relay/submit", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({
       batches: signedBatches,       // SignedClaimBatch[]
       publisherSig: attestation,    // publisher's co-sig
     }),
   });
   ```
3. Handle response:
   - `200 OK` + `{ accepted: true, batchId: string }` → show success, store batchId
   - `400/403/500` → show error, keep claims in queue
4. Show submission status in Claims tab:
   - "Signed and submitted to relay" (success)
   - "Signed but relay unavailable — claims retained" (failure)

### Relay batch format

```typescript
interface SignedClaimBatch {
  user: string;
  campaignId: bigint;
  claims: Claim[];
  deadline: bigint;           // block deadline for relay submission
  signature: string;          // user's EIP-712 signature
  publisherSig: string;      // publisher's co-signature (P1)
}
```

The relay bot receives this, calls `DatumRelay.settleClaimsFor(signedBatches)` on-chain.

---

## 11. Contract Migration (9 → 13)

### ContractAddresses type update

```typescript
// Alpha (9 contracts)
interface ContractAddresses {
  campaigns, publishers, governanceV2, governanceSlash,
  settlement, relay, pauseRegistry, timelock, zkVerifier
}

// Alpha-2 (13 contracts)
interface ContractAddresses {
  campaigns, publishers, governanceV2, governanceSlash,
  settlement, relay, pauseRegistry, timelock, zkVerifier,
  // New:
  budgetLedger, paymentVault, lifecycle, attestationVerifier
}
```

Already done in web app's `types.ts`. The shared library carries this forward.

### ABI updates

All 13 ABIs already exist in `web/src/shared/abis/`. Copy to `@datum/shared`:
- DatumCampaigns.json (alpha-2 version — budget fields removed, S12 checks added)
- DatumPublishers.json (alpha-2 — S12 blocklist + allowlist)
- DatumGovernanceV2.json (alpha-2 — 9 conviction levels, anti-grief)
- DatumGovernanceSlash.json (alpha-2 — sweepSlashPool)
- DatumSettlement.json (alpha-2 — Blake2, 5-arg configure)
- DatumRelay.json (alpha-2 — publisherSig in SignedClaimBatch)
- DatumPauseRegistry.json (unchanged)
- DatumTimelock.json (unchanged)
- DatumZKVerifier.json (unchanged)
- **NEW:** DatumBudgetLedger.json
- **NEW:** DatumPaymentVault.json
- **NEW:** DatumCampaignLifecycle.json
- **NEW:** DatumAttestationVerifier.json

### Contract factory updates

13 factory functions (already in `web/src/shared/contracts.ts`):
```typescript
getCampaignsContract(addresses, signerOrProvider)
getPublishersContract(addresses, signerOrProvider)
getGovernanceV2Contract(addresses, signerOrProvider)
getGovernanceSlashContract(addresses, signerOrProvider)
getSettlementContract(addresses, signerOrProvider)
getRelayContract(addresses, signerOrProvider)
getPauseRegistryContract(addresses, signerOrProvider)
getTimelockContract(addresses, signerOrProvider)
getZKVerifierContract(addresses, signerOrProvider)
getBudgetLedgerContract(addresses, signerOrProvider)    // NEW
getPaymentVaultContract(addresses, signerOrProvider)    // NEW
getLifecycleContract(addresses, signerOrProvider)       // NEW
getAttestationVerifierContract(addresses, signerOrProvider) // NEW
```

### Networks config

Paseo testnet addresses for alpha-2 will be populated after deployment. For now, the 4 new satellite addresses are empty strings.

### Settings migration

On extension update from alpha to alpha-2:
1. Detect missing contract address fields (`budgetLedger`, `paymentVault`, `lifecycle`, `attestationVerifier`)
2. Add with empty strings
3. Prompt user to update contract addresses (or "Load Deployed" from bundled file)
4. Clear chain state (hash algorithm changed)

---

## 12. File Inventory

### New files to create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `extension/src/popup/EarningsPanel.tsx` | User earnings + withdraw via PaymentVault | ~150 |
| `extension/src/content/provider.ts` | `window.datum` bridge for web app | ~250 |
| `shared/categories.ts` | Category names, bitmask helpers | ~80 |
| `shared/blockTime.ts` | Block↔time conversion helpers | ~30 |
| `extension/test/blake2.test.ts` | Blake2 hash chain validation | ~80 |
| `extension/test/claimBuilder.test.ts` | Claim building with Blake2 | ~100 |
| `extension/test/provider.test.ts` | window.datum bridge tests | ~60 |

### Files to modify (carry forward + update)

| File | Key Changes |
|------|------------|
| `background/index.ts` | Message types (add SUBMIT_ATTESTED, POST_RELAY; remove governance/publisher), contract calls (PaymentVault, BudgetLedger, AttestationVerifier), auto-submit path |
| `background/campaignPoller.ts` | 4-field settlement data, BudgetLedger reads, S12 blocklist filter, P20 stale marking |
| `background/claimBuilder.ts` | Blake2 hash, argument order verification |
| `background/publisherAttestation.ts` | Non-optional return (P1 mandatory), retry logic |
| `popup/App.tsx` | 3 tabs instead of 7, simplified shell |
| `popup/ClaimQueue.tsx` | AttestedBatch submit path, relay POST, simplified display |
| `popup/Settings.tsx` | 13 contract addresses, remove publisher/Pinata sections |
| `content/index.ts` | S12 blocklist awareness in campaign filtering |
| `shared/messages.ts` | New message types (SUBMIT_ATTESTED, POST_RELAY, PROVIDER_*), removed types |
| `behaviorChain.ts` | Blake2 hash |
| `behaviorCommit.ts` | Blake2 hash |

### Files carried forward unchanged

| File | Reason |
|------|--------|
| `auction.ts` | Vickrey logic unchanged |
| `interestProfile.ts` | Interest weighting unchanged |
| `userPreferences.ts` | Preferences unchanged |
| `timelockMonitor.ts` | Event names unchanged |
| `zkProofStub.ts` | Stub unchanged (BL-2 is post-alpha) |
| `adSlot.ts` | Shadow DOM rendering unchanged |
| `engagement.ts` | Viewport tracking unchanged |
| `handshake.ts` | SDK handshake unchanged |
| `sdkDetector.ts` | SDK detection unchanged |
| `taxonomy.ts` | Page classification unchanged |
| `walletManager.ts` | Multi-account wallet unchanged |
| `claimExport.ts` | Encrypted export/import unchanged |
| `phishingList.ts` | Phishing defense unchanged |
| `offscreen.ts` | Offscreen document unchanged |

### Files removed (moved to web app)

| File | Web App Replacement |
|------|-------------------|
| `popup/AdvertiserPanel.tsx` (~599 lines) | `/advertiser/*` (4 pages, already built) |
| `popup/PublisherPanel.tsx` (~508 lines) | `/publisher/*` (7 pages, already built) |
| `popup/GovernancePanel.tsx` (~1015 lines) | `/governance/*` (4 pages, already built) |
| `popup/CampaignList.tsx` (~394 lines) | `/explorer/campaigns` (already built) |
| `popup/UserPanel.tsx` (~246 lines) | Replaced by EarningsPanel.tsx (~150 lines) |

**Net popup reduction:** ~2,762 lines removed, ~150 lines added = **~2,612 lines saved**.

---

## 13. Test Plan

### Existing tests to carry forward (update as needed)

| Test | Changes |
|------|---------|
| `auction.test.ts` | Unchanged |
| `qualityScore.test.ts` | Unchanged |
| `taxonomy.test.ts` | Unchanged |
| `contentSafety.test.ts` | Unchanged |
| `phishingList.test.ts` | Unchanged |
| `ipfs.test.ts` | Unchanged |
| `dot.test.ts` | Unchanged |
| `userPreferences.test.ts` | Unchanged |
| `types.test.ts` | Update for 13-contract ContractAddresses |

### New tests

| Test | Coverage |
|------|----------|
| `blake2.test.ts` | Blake2-256 hash output, Solidity-compatible packed encoding, dual-mode (blake2/keccak256), claim hash field order |
| `claimBuilder.test.ts` | Claim building with Blake2, chain continuity, nonce sequencing, publisher-before-user order |
| `provider.test.ts` | `window.datum` injection, message relay, approval flow mocking |
| `attestation.test.ts` | AttestedBatch construction, EIP-712 domain/types, publisher sig verification |
| `relay.test.ts` | Relay POST flow, error handling, signed batch format |

### Target: ≥150 tests

| Source | Count |
|--------|-------|
| Carried forward (9 suites) | ~140 |
| New tests (5 suites) | ~50 |
| **Total** | **~190** |

### Integration testing

After extension builds and unit tests pass, the critical integration path is:

1. **Local devnet (Hardhat):** Extension builds → popup loads → wallet unlock → campaign poller finds campaigns → ad injection works → claims build with keccak256 (local mode) → submit via Settlement (no attestation on local) → earnings appear in PaymentVault
2. **Paseo testnet:** Same flow but Blake2 hashes → attestation via Diana's relay → submit via AttestationVerifier → earnings in PaymentVault → withdraw
3. **Web app bridge:** Extension installed → web app detects `window.datum` → connect → sign transaction → confirmation popup → transaction sent

---

## 14. Implementation Phases

### Phase 1: Shared Library + Blake2 (foundation)

**Goal:** `@datum/shared` workspace + Blake2 hash functions + tests.

**Tasks:**
1. Create `alpha-2/shared/` workspace with package.json
2. Copy web app's `src/shared/` files as base (already correct for 13 contracts)
3. Add `qualityScore.ts` from alpha extension (not in web app)
4. Extract `categories.ts` from types.ts
5. Add `blockTime.ts`
6. Implement `blake2Hash()` utility using `@noble/hashes/blake2b`
7. Write `blake2.test.ts` — verify against known Settlement hash outputs
8. Verify shared library builds standalone (tsc)

**Verification:** `blake2.test.ts` passes, all extracted code compiles.

### Phase 2: Extension Scaffold + Background Updates

**Goal:** Extension project compiles with 13-contract support.

**Tasks:**
1. Create `alpha-2/extension/` with manifest.json, webpack.config, tsconfig
2. Copy background files from alpha extension
3. Update `background/index.ts`:
   - Import contracts from `@datum/shared`
   - Update message types (add SUBMIT_ATTESTED, POST_RELAY; remove governance/publisher actions)
   - Update auto-submit to use AttestationVerifier path
4. Update `campaignPoller.ts`:
   - 4-field settlement data
   - BudgetLedger reads
   - S12 blocklist filtering
   - P20 stale marking
5. Update `claimBuilder.ts`:
   - Blake2 hash
   - Verify field order
6. Update `behaviorChain.ts` + `behaviorCommit.ts` — Blake2
7. Update `publisherAttestation.ts` — mandatory (non-optional) return
8. Update `messages.ts` with new message types
9. Copy content scripts (unchanged except S12 awareness in index.ts)
10. Verify webpack builds (0 errors)

**Verification:** `npm run build` succeeds, 0 webpack errors.

### Phase 3: Popup Rebuild (3 tabs)

**Goal:** Functional extension popup with 3 tabs.

**Tasks:**
1. Rewrite `App.tsx` — 3 tabs, wallet state machine, chain heartbeat
2. Create `EarningsPanel.tsx` — PaymentVault balance + withdraw
3. Simplify `ClaimQueue.tsx`:
   - Remove detailed breakdown
   - Add AttestedBatch submit path
   - Add relay POST flow (§10)
4. Simplify `Settings.tsx`:
   - 13 contract addresses
   - Remove publisher/Pinata sections
5. All popup tests pass

**Verification:** Extension loads in Chrome, tabs render, wallet unlock works.

### Phase 4: Provider Bridge + Relay Fix

**Goal:** Web app can connect via extension wallet; relay submission works.

**Tasks:**
1. Create `content/provider.ts` — `window.datum` injection
2. Implement approval popup flow (sign request → popup → approve/deny)
3. Fix relay submission — POST signed batch after signing
4. Write `provider.test.ts`
5. Test web app connection via `window.datum`

**Verification:** Web app detects extension, connects, signs transaction, extension shows approval popup.

### Phase 5: Testing + Polish

**Goal:** ≥150 tests, 0 errors, extension ready for alpha-2 testnet.

**Tasks:**
1. Run all carried-forward tests, fix any failures from contract migration
2. Write remaining new tests (attestation, relay)
3. Manual testing on local devnet (Hardhat)
4. Settings migration logic (alpha → alpha-2 upgrade)
5. Chain state migration notice (Blake2 hash change)
6. Update manifest version to 0.2.0
7. Final webpack build — verify bundle size

**Verification:** ≥150 tests pass, `npm run build` 0 errors, extension loads clean in Chrome.

### Phase 6: Testnet Integration (after alpha-2 deploy)

**Goal:** Extension works end-to-end on Paseo testnet.

**Tasks:**
1. Update deployed-addresses.json with alpha-2 Paseo addresses
2. Test full flow: browse → ad injection → claim build (Blake2) → attestation → submit → earnings → withdraw
3. Test relay path: sign → POST → relay submits on-chain
4. Test web app bridge on testnet
5. Fix any denomination rounding issues (10^6 planck multiples)

**Verification:** End-to-end claim settlement on Paseo testnet.

---

## 15. Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Blake2 output mismatch** | Claims rejected on-chain (hash validation fails) | Test against Settlement's known hash outputs; test with Hardhat + substrate both |
| **@noble/hashes in service worker** | Import fails or WASM not available | Already used in alpha extension (v2.0.1); blake2b is pure JS, no WASM |
| **Publisher attestation unavailable** | Cannot submit claims (P1 mandatory) | Queue claims for retry; show clear error; auto-submit skips unattestation batches |
| **window.datum origin spoofing** | Malicious page tricks extension into signing | Approval popup shows origin URL; user must explicitly approve; nonce-based replay protection |
| **Extension store review delays** | Chrome Web Store review rejects MV3 extension | Follow MV3 best practices; minimize permissions; document `<all_urls>` justification (ad injection requires it) |
| **Denomination rounding on submit** | Transaction rejected by eth-rpc | Enforce `value % 10^6 < 500_000` on all value transfers; round down claim amounts |
| **Large bundle size** | Slow extension load | Tree-shake @datum/shared imports; webpack SplitChunks for background/popup |
| **Chain state migration** | Users lose pending claims on upgrade | Clear warning; export claims first (P6); claims are low-value at alpha stage |

---

## Appendix A: Backlog Items (Post-Alpha-2 Extension)

These are **not** in scope for the alpha-2 extension build, but are tracked for future work.

### BL-1: Claim Submit CAPTCHA

Bot-resistance layer before settlement. Options: PoW puzzle, publisher-hosted CAPTCHA, nonce commitment. Requires relay endpoint changes + attestation schema extension. UI: modal in extension or inline on web claims page.

**Extension surface:** Small CAPTCHA modal before `settleClaimsAttested()` call.

### BL-2: ZK Proof Integration (Groth16)

Replace `zkProofStub.ts` with real circuit. Requires BN128 precompile on PolkaVM, trusted setup, snarkjs/circom WASM in service worker. Extension: proof generation indicator in Claims tab.

**Extension surface:** Progress bar during proof generation in Claims tab.

### Future: Closed Shadow DOM

Upgrade `adSlot.ts` from `open` to `closed` Shadow DOM. Prevents publisher page scripts from accessing ad content. Low risk, low effort, but changes testability.

### Future: External Wallet (WalletConnect v2)

Replace embedded wallet with WalletConnect v2 for SubWallet, Talisman, Nova. Removes need for private key storage in extension. Major UX change.

---

## Appendix B: Estimated Size

| Component | Alpha (lines) | Alpha-2 (est.) |
|-----------|---------------|-----------------|
| Popup (App + panels) | ~4,500 | ~950 |
| Background (SW + modules) | ~2,800 | ~2,900 (+Blake2, +attestation) |
| Content (scripts) | ~1,500 | ~1,750 (+provider.ts) |
| Shared (extension-only) | ~1,200 | ~800 (moved to @datum/shared) |
| @datum/shared | — | ~2,000 |
| Tests | ~1,200 | ~1,800 |
| **Total** | ~11,200 | ~10,200 |

Net reduction despite new features — shared extraction + popup simplification.
