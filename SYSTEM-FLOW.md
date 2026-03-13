# DATUM System Flow

Detailed process flows for every participant role and subsystem. For a narrative walkthrough, see the Alice/Bob/Carol/Dave example in [README.md](README.md).

---

## Table of Contents

1. [Publisher Flow](#1-publisher-flow)
2. [Advertiser Flow](#2-advertiser-flow)
3. [Governance Reviewer Flow](#3-governance-reviewer-flow)
4. [User (Viewer) Flow](#4-user-viewer-flow)
5. [Page Classification](#5-page-classification)
6. [Auction Mechanism](#6-auction-mechanism)
7. [Engagement Tracking](#7-engagement-tracking)
8. [Claim Building (Hash Chain)](#8-claim-building-hash-chain)
9. [Settlement](#9-settlement)
10. [Revenue Split](#10-revenue-split)
11. [Relay (Gasless) Settlement](#11-relay-gasless-settlement)
12. [Auto-Submit](#12-auto-submit)
13. [Content Safety](#13-content-safety)
14. [Governance Voting Mechanics](#14-governance-voting-mechanics)
15. [Slash and Rewards](#15-slash-and-rewards)
16. [Campaign Lifecycle State Machine](#16-campaign-lifecycle-state-machine)
17. [Timelock and Pause](#17-timelock-and-pause)
18. [Claim Portability (Export/Import)](#18-claim-portability-exportimport)
19. [Publisher SDK Protocol](#19-publisher-sdk-protocol)
20. [Wallet and Key Management](#20-wallet-and-key-management)

---

## 1. Publisher Flow

**Contract:** DatumPublishers | **Extension tab:** Publisher | **SDK:** `sdk/datum-sdk.js`

### Registration

1. Publisher calls `registerPublisher(takeRateBps)` on DatumPublishers.
   - `takeRateBps` must be between 3000 (30%) and 8000 (80%).
   - Publisher address is recorded as `registered = true`.
2. The take rate is snapshotted into each campaign at creation time — changing it later only affects new campaigns.

### Category Setup

1. Publisher opens the Publisher tab and selects ad categories from the 26-category taxonomy (checkboxes).
2. On save, the extension calls `publishers.setCategories(bitmask)` — a `uint256` bitmask where bits 1-26 correspond to top-level categories.
3. Categories determine which open campaigns can be served on this publisher's site (campaign category must overlap with publisher categories).
4. Categories are also declared in the SDK tag's `data-categories` attribute for client-side filtering.

### SDK Integration

Publishers embed the DATUM SDK on their site to enable two-party impression attestation and inline ad placement:

```html
<script src="datum-sdk.js" data-categories="5,24" data-publisher="0xPublisher..."></script>
<div id="datum-ad-slot"></div>
```

**SDK protocol:**

1. On page load, the SDK dispatches `datum:sdk-ready` CustomEvent with `{ publisher, categories, version }`.
2. The DATUM extension content script listens for this event (2s timeout) or detects the SDK `<script>` tag.
3. When a campaign matches, the extension dispatches `datum:challenge` with a random 32-byte challenge + 8-byte nonce: `{ challenge, nonce }`.
4. The SDK computes `SHA-256(publisher + ":" + challenge + ":" + nonce)` and responds via `datum:response`.
5. The extension stores the attestation for inclusion with the claim — creating two-party proof that the publisher's page was actually rendering the ad.

**Ad injection modes:**

| Mode | Condition | Behavior |
|------|-----------|----------|
| **Inline (SDK)** | SDK detected + `<div id="datum-ad-slot">` exists | Ad renders inside the publisher's div via Shadow DOM |
| **Overlay** | No SDK or no ad slot div | Ad renders fixed at bottom-right of viewport |
| **Default house ad** | No campaigns match | Polkadot philosophy link, inline or overlay depending on SDK presence |

### Take Rate Updates

1. Publisher calls `updateTakeRate(newBps)` — sets a pending rate with an effective block.
2. After the delay period passes, publisher calls `applyTakeRateUpdate()` — updates the live rate.
3. Pending changes are visible in the Publisher tab UI.

### Take Rate for Open Campaigns

Open campaigns (publisher = `address(0)`) snapshot a default take rate of 50% (DEFAULT_TAKE_RATE_BPS) at creation time. The snapshot is used for settlement regardless of the serving publisher's actual registered rate. This is an alpha trade-off for PVM bytecode size constraints — dynamic publisher-specific rates for open campaigns are a post-alpha enhancement.

### Relay Settlement

1. Users sign claim batches via EIP-712 and send the signed data to the publisher.
2. Publisher opens the Publisher tab, sees pending signed batches with deadline countdown.
3. Publisher clicks "Submit Signed Claims" — calls `DatumRelay.settleClaimsFor(batches)`.
4. Relay verifies user's EIP-712 signature. For publisher-specific campaigns, also verifies optional publisher co-signature. For open campaigns (`cPublisher == address(0)`), co-signature verification is skipped — attestation is handled off-chain by the SDK handshake.
5. Publisher pays gas; user pays nothing.

### Withdrawal

1. After claims settle, publisher balance accumulates in `DatumSettlement.publisherBalance[address]`.
2. Publisher clicks "Withdraw" in the Publisher tab — calls `settlement.withdrawPublisher()`.
3. Full balance transferred via `.call{value}` (pull-payment pattern).

---

## 2. Advertiser Flow

**Contract:** DatumCampaigns | **Extension tab:** My Ads

### Campaign Creation

1. Advertiser fills the creation form:
   - **Budget** (DOT) — total escrow deposited into the contract
   - **Daily cap** (DOT) — maximum spend per 24-hour period
   - **Bid CPM** (DOT per 1000 impressions) — maximum willingness to pay
   - **Category** — one of 26 top-level categories (+ subcategories)
   - **Open Campaign toggle** — when enabled, `publisher = address(0)` and any publisher whose categories overlap can serve the ad. Take rate is snapshotted at 50% (DEFAULT_TAKE_RATE_BPS).
   - **Publisher** (if not open) — address of a registered publisher. Take rate snapshotted from the publisher's registered rate.
2. Advertiser fills the creative form:
   - **Title** (max 128 chars)
   - **Description** (max 256 chars)
   - **Ad body text** (max 512 chars) — shown in the ad slot
   - **CTA button label** (max 64 chars) — e.g. "Learn More"
   - **CTA URL** (max 2048 chars) — HTTPS only, validated before pinning
3. "Pin to IPFS" runs `validateAndSanitize()` locally:
   - Schema shape check (all required fields, correct types)
   - Field length caps enforced
   - URL scheme allowlist (only `https://` passes)
   - Content blocklist (multi-word phrases for adult, gambling, drugs, weapons, tobacco, counterfeit)
   - If rejected: error message shown, nothing pinned
4. On success: metadata pinned to Pinata IPFS, CID auto-fills.
5. "Create Campaign" sends `createCampaign(publisher, dailyCap, bidCpm, categoryId)` with `msg.value = budget`.
6. If CID provided: second transaction calls `setMetadata(campaignId, cidBytes32)`.
7. Campaign starts as **Pending** — awaiting governance activation.

### Campaign Management

| Action | Who | Contract call |
|--------|-----|---------------|
| Pause (Active -> Paused) | Advertiser | `togglePause(id, true)` |
| Resume (Paused -> Active) | Advertiser | `togglePause(id, false)` |
| Complete (Active/Paused -> Completed) | Advertiser or Settlement | `completeCampaign(id)` — refunds remaining budget |
| Expire (Pending -> Expired) | Anyone, after timeout | `expirePendingCampaign(id)` — refunds full budget |

### Budget Protection

- **Daily cap:** DatumCampaigns enforces `dailySpent + amount <= dailyCapPlanck` per day (`block.timestamp / 86400`) inside `deductBudget()`, which Settlement calls.
- **Auto-complete:** When `remainingBudget` hits 0 during settlement, campaign auto-transitions to Completed.
- **Pending timeout:** If governance doesn't activate within `pendingTimeoutBlocks`, anyone can expire the campaign and the full budget returns to the advertiser.

---

## 3. Governance Reviewer Flow

**Contracts:** DatumGovernanceV2, DatumGovernanceSlash | **Extension tab:** Govern

### Voting

1. Reviewer opens the Govern tab, sees campaigns organized by status: Pending, Active, Resolved.
2. To vote, reviewer enters:
   - **Campaign ID**
   - **Stake amount** (DOT) — locked for the duration
   - **Conviction** (0-6) — multiplies vote weight and lockup duration

   | Conviction | Weight multiplier | Lockup |
   |------------|------------------|--------|
   | 0 | 1x | ~24 hours (14,400 blocks) |
   | 1 | 2x | ~2 days |
   | 2 | 4x | ~4 days |
   | 3 | 8x | ~8 days |
   | 4 | 16x | ~16 days |
   | 5 | 32x | ~32 days |
   | 6 | 64x | ~64 days |

3. Clicks "Vote Aye" or "Vote Nay" — sends `vote(campaignId, aye, conviction)` with staked DOT as `msg.value`.
4. One vote per address per campaign. Vote is locked until `block.number >= lockedUntilBlock`.

### Evaluating Campaigns

Anyone (not just voters) can call `evaluateCampaign(campaignId)`:

| Current status | Condition | Result |
|---------------|-----------|--------|
| Pending | `total >= quorum` AND `aye > 50%` | Campaign **activated** |
| Active or Paused | `nay >= 50%` | Campaign **terminated** (90% refund, 10% slash) |
| Completed | Not yet resolved | Mark **resolved** (enables withdraw with slash) |
| Terminated | Not yet resolved | Mark **resolved** |

The Govern tab shows progress bars for aye/nay percentages and quorum threshold.

### Withdrawing Stake

1. Wait for lockup to expire (the UI shows remaining time in the "Your Vote" card).
2. Click "Withdraw DOT Stake".
3. If the campaign is **resolved** and you voted on the **losing side**: 10% of your stake is slashed.
   - Voted Aye on a Terminated campaign = loser.
   - Voted Nay on a Completed campaign = loser.
4. Remaining stake (90% or 100%) is returned.

### Claiming Slash Rewards

1. After a campaign resolves, a winner calls "Finalize Slash" on the Govern tab — this tallies the total slash pool.
2. Winners call "Claim Slash Reward" — their share is proportional to their vote weight among all winners.
3. Rewards come from the losing-side slash pool collected in GovernanceSlash.

---

## 4. User (Viewer) Flow

**Extension:** content script + background | **Extension tab:** Campaigns, Claims, Earnings

### Browsing and Impression Recording

1. User installs extension and sets up a wallet (multi-account, password-encrypted per account).
2. User browses the web normally. On each page load, the content script:
   - Classifies the page (see [Section 5](#5-page-classification))
   - Detects Publisher SDK + fetches active campaigns in parallel (see [Section 19](#19-publisher-sdk-protocol))
   - Filters campaigns by SDK category overlap (if SDK present) or page classification
   - Runs an auction on matching campaigns (see [Section 6](#6-auction-mechanism))
   - Performs SDK handshake for two-party attestation (if SDK present, after auction)
   - Injects an ad: inline into publisher's `<div>` (SDK), overlay (no SDK), or default house ad (no campaigns)
   - Tracks engagement signals (see [Section 7](#7-engagement-tracking))
   - Builds a hash-chain claim if engagement quality passes (see [Section 8](#8-claim-building-hash-chain))
3. All processing happens on-device. The only data leaving the browser is the cryptographic claim submitted to the blockchain.

### Deduplication

- **Per-page:** each `(campaignId, URL)` pair shown at most once per page load.
- **Per-site:** each `(campaignId, hostname)` pair shown at most once per 5 minutes.
- **Rate limit:** user preferences allow setting max ads per hour (default 12).
- **Category silencing:** users can mute entire categories in Settings.
- **Campaign blocking:** users can block individual campaigns from the Campaigns tab.

### Submitting Claims

Three options:
1. **Manual submit** — Claims tab, "Submit All (you pay gas)" button.
2. **Sign for relay** — Claims tab, "Sign for Publisher (zero gas)". User signs EIP-712; publisher submits and pays gas.
3. **Auto-submit** — Settings toggle. Extension submits every N minutes using a session-encrypted key (see [Section 12](#12-auto-submit)).

### Withdrawing Earnings

1. Earnings tab shows balance in DOT with per-campaign breakdown.
2. "Withdraw" button calls `settlement.withdrawUser()`.
3. Engagement stats displayed: total dwell time, viewable time, IAB viewability rate.

---

## 5. Page Classification

**File:** `content/taxonomy.ts`

The extension classifies every page against 26 top-level categories (with 89 subcategories) using four independent signals:

| Signal | Confidence score | Method |
|--------|-----------------|--------|
| Domain match | 0.9 | Exact or suffix match against known domain lists |
| Title keywords | 0.6 + 0.1 per extra hit (cap 0.8) | Keyword presence in `document.title` |
| Meta description keywords | 0.4 + 0.1 per extra hit (cap 0.6) | `<meta name="description">` content |
| Meta keywords tag | 0.5 (flat) | `<meta name="keywords">` content |

- Minimum confidence threshold: **0.3** (below this, no category assigned).
- The highest-confidence category is used for campaign matching and auction weighting.
- 26 categories include: Arts & Entertainment, Computers & Electronics, Finance, Crypto & Web3, Health, News, Sports, Travel, etc.
- Category IDs map to on-chain `uint8 categoryId` (0 = uncategorized, 1-26 top-level, 101+ subcategories).

---

## 6. Auction Mechanism

**File:** `background/auction.ts` | **Type:** Vickrey second-price

### Per-impression auction (runs on every page load)

1. **Candidate pool:** Active campaigns matching the page category (categoryId match or uncategorized campaigns as wildcard).
2. **Interest weighting:** Each campaign's effective bid = `bidCpmPlanck * interestWeight`, where `interestWeight` comes from the user's local interest profile (built from browsing history categories). Floor weight: 0.1 (no campaign is excluded entirely).
3. **Sorting:** Candidates ranked by effective bid, highest first.
4. **Clearing price:**

   | Scenario | Clearing CPM | Mechanism label |
   |----------|-------------|-----------------|
   | 1 candidate (solo) | `bidCpm * 70%` | `"solo"` |
   | 2+ candidates, 2nd price >= 30% floor | 2nd highest effective bid / winner's interest weight | `"second-price"` |
   | 2+ candidates, 2nd price < 30% floor | `bidCpm * 30%` | `"floor"` |

5. **Result:** winner campaign + clearing CPM + mechanism label passed to content script.

### Why second-price?

- Advertisers bid their true value (dominant strategy in Vickrey auctions).
- Winners pay just above the next-best competitor's bid, not their own maximum.
- Solo campaigns still get a discount (30% off) since there's no competitive pressure.
- Interest weighting means users who genuinely care about a category make those campaigns win more often — better targeting without surveillance.

---

## 7. Engagement Tracking

**File:** `content/engagement.ts`

### Signals captured (all on-device)

| Signal | Method | Weight in quality score |
|--------|--------|----------------------|
| Dwell time | IntersectionObserver (50% threshold) | 35% (linear to 5s, capped) |
| Tab focus time | `visibilitychange` event | 25% (linear to 3s, capped) |
| IAB viewability | 50% visible for 1+ second continuous | 25% (binary: 0 or 0.25) |
| Scroll depth | `scroll` event, max % tracked | 15% (linear to 100%) |

### Quality gating

- **Minimum dwell:** 1 second (below = rejected)
- **Minimum tab focus:** 0.5 seconds (below = rejected)
- **Minimum composite score:** 0.3 (below = no claim built)
- **Minimum tracking duration:** 500ms (accidental closes ignored)

### Quality score impact on payment

Quality gating is **binary**: claims below the 0.3 threshold are rejected entirely; claims above the threshold use the full clearing CPM from the auction with no discount. Proportional CPM scaling based on quality score is a post-alpha enhancement.

---

## 8. Claim Building (Hash Chain)

**File:** `background/claimBuilder.ts`

### Hash chain construction

Each user-campaign pair maintains an independent, append-only hash chain:

```
Claim 1 (genesis):  hash = keccak256(campaignId, publisher, user, impressions, cpm, nonce=1, 0x000...000)
Claim 2:            hash = keccak256(campaignId, publisher, user, impressions, cpm, nonce=2, claim1Hash)
Claim 3:            hash = keccak256(campaignId, publisher, user, impressions, cpm, nonce=3, claim2Hash)
...
```

### Per-claim fields

| Field | Source |
|-------|--------|
| `campaignId` | From auction winner |
| `publisher` | Campaign's publisher address |
| `user` | Connected wallet address |
| `impressionCount` | Always 1 (one impression per claim) |
| `clearingCpmPlanck` | From auction, quality-discounted |
| `nonce` | Sequential: `lastNonce + 1` |
| `previousClaimHash` | Previous claim's hash (or `0x00...00` for genesis) |
| `claimHash` | `keccak256(abi.encodePacked(...))` of above fields |

### Chain state persistence

- Stored per `(userAddress, campaignId)` in `chrome.storage.local`.
- Claims queued in `claimQueue` until submitted.
- On nonce mismatch (e.g. claims settled from another device), `syncFromChain()` resets local state to match on-chain truth.

---

## 9. Settlement

**Contract:** DatumSettlement

### Validation pipeline

For each claim in a batch (max 5 claims per batch):

| Step | Check | Rejection reason |
|------|-------|-----------------|
| — | All claims in batch must share same campaignId | Reason 0 |
| — | If a prior claim in the batch was rejected for nonce gap, all subsequent claims are skipped | Reason 1 |
| 1 | `impressionCount > 0` | Reason 2 |
| 2 | Campaign exists (`bidCpmPlanck != 0` — all real campaigns have bidCpm >= minimumCpmFloor > 0) | Reason 3 |
| 3 | Campaign is Active (status == 1) | Reason 4 |
| 4 | Publisher match: fixed campaigns require exact match; open campaigns (`cPublisher == address(0)`) accept any non-zero publisher | Reason 5 |
| 5 | `clearingCpmPlanck <= bidCpmPlanck` | Reason 6 |
| 6 | `nonce == lastNonce + 1` (sequential) | Reason 7 (gap — all subsequent rejected) |
| 7 | Genesis: previousClaimHash must be zero | Reason 8 |
| 8 | Non-genesis: previousClaimHash must match stored | Reason 9 |
| 9 | Recompute hash and verify match | Reason 10 |
| 10 | `totalPayment <= remainingBudget` | Reason 11 |
| 11 | ZK proof verification (if verifier set) | Reason 12 |

### On valid claim

1. Compute `totalPayment = (clearingCpmPlanck * impressionCount) / 1000`.
2. Call `campaigns.deductBudget(campaignId, totalPayment)` — transfers DOT from Campaigns to Settlement.
3. Split payment three ways (see [Section 10](#10-revenue-split)).
4. Update on-chain nonce and claim hash for the user-campaign pair.
5. Emit `ClaimSettled` event.

---

## 10. Revenue Split

```
totalPayment      = (clearingCpmPlanck * impressionCount) / 1000
publisherPayment  = totalPayment * snapshotTakeRateBps / 10000
remainder         = totalPayment - publisherPayment
userPayment       = remainder * 7500 / 10000    (75%)
protocolFee       = remainder - userPayment      (25%)
```

All amounts in planck (1 DOT = 10,000,000,000 planck).

### Example (bid CPM = 0.05 DOT, publisher take rate = 40%, 1 impression)

```
totalPayment     = 0.05 DOT * 1 / 1000 = 0.00005 DOT = 500,000 planck
publisherPayment = 500,000 * 4000 / 10000 = 200,000 planck  (0.00002 DOT)
remainder        = 300,000 planck
userPayment      = 300,000 * 7500 / 10000 = 225,000 planck  (0.0000225 DOT)
protocolFee      = 75,000 planck                              (0.0000075 DOT)
```

Funds accumulate as pull-payment balances. Each party withdraws independently:
- Publisher: `withdrawPublisher()`
- User: `withdrawUser()`
- Protocol: `withdrawProtocol(recipient)` (owner only)

---

## 11. Relay (Gasless) Settlement

**Contract:** DatumRelay

### Flow

1. **User signs:** Extension builds claim batch + deadline block, signs via EIP-712 typed data.
2. **Publisher co-signs (optional):** Publisher endpoint at `/.well-known/datum-attest` signs an attestation. If unreachable (3s timeout), falls back to empty co-signature ("degraded trust" — `publisherSig = "0x"`).
3. **Publisher submits:** `relay.settleClaimsFor(signedBatches)`.
4. **Relay verifies:**
   - EIP-712 user signature recovery — must match `batch.user`.
   - Publisher co-signature recovery (if non-empty AND campaign has a fixed publisher) — must match campaign's publisher. Open campaigns (`cPublisher == address(0)`) skip co-signature verification — attestation is handled off-chain by the SDK handshake.
   - Deadline check: `block.number <= batch.deadline`.
5. **Relay calls:** `settlement.settleClaims(batches)` as `msg.sender = relayContract` (authorized caller).

### EIP-712 domain

```
name: "DatumRelay"
version: "1"
chainId: <network chain ID>
verifyingContract: <relay contract address>
```

---

## 12. Auto-Submit

**File:** `background/index.ts`

### Authorization (B1 security)

1. User enables auto-submit in Settings and provides their wallet password.
2. Extension generates a **random 32-byte session password** (`crypto.getRandomValues`).
3. Private key encrypted with session password via PBKDF2 + AES-256-GCM.
4. Encrypted blob stored in `chrome.storage.local`.
5. Session password held **only in service worker memory** — lost on browser restart.
6. After restart: auto-submit silently deauthorizes. User must re-enable.

### Flush cycle

1. Alarm fires every `autoSubmitIntervalMinutes` (user-configurable).
2. Acquire mutex (skip if already flushing).
3. Check: auto-submit enabled? Settlement contract configured? Global pause off?
4. Decrypt private key using session password.
5. Build batches from claim queue.
6. Call `settlement.settleClaims(batches)` directly (not via relay — auto-submit uses user's own gas).
7. Parse `ClaimSettled`/`ClaimRejected` events from receipt.
8. Remove settled claims from queue.
9. Release mutex.

---

## 13. Content Safety

**File:** `shared/contentSafety.ts`

### Four-layer validation

| Layer | Location | Checks |
|-------|----------|--------|
| **Pin-time** | AdvertiserPanel (popup) | `validateAndSanitize()` before IPFS pin — advertiser sees rejection immediately |
| **Fetch-time** | campaignPoller (background) | 10KB size cap (Content-Length + body), `validateAndSanitize()` before caching |
| **Cache-time** | content/index.ts | `validateMetadata()` + `passesContentBlocklist()` re-validation from storage |
| **Render-time** | adSlot.ts (content) | `sanitizeCtaUrl()` — unsafe URLs render as non-clickable `<span>` |

### Schema validation (`validateMetadata`)

- All required fields present with correct types
- `creative.type === "text"`
- Field length caps: title 128, description 256, category 64, creative.text 512, cta 64, ctaUrl 2048

### URL sanitization (`sanitizeCtaUrl`)

- Only `https://` URLs pass
- Rejects: `javascript:`, `data:`, `blob:`, `file:`, `http:`, malformed URLs

### Content blocklist (`passesContentBlocklist`)

Case-insensitive substring match on concatenated text fields (title + description + category + creative text + CTA) against multi-word phrases:

- Gambling: "online gambling", "casino games", "sports betting", "online casino", "slot machines"
- Adult: "adult content", "adult entertainment", "explicit content", "pornographic"
- Drugs: "illegal drugs", "recreational drugs", "drug paraphernalia"
- Weapons: "buy firearms", "assault weapons", "illegal weapons"
- Tobacco: "tobacco products", "buy cigarettes", "vaping products"
- Counterfeit: "counterfeit goods", "replica designer", "fake documents"

Multi-word phrases are used to minimize false positives (e.g. "adult" alone would block "adult education").

### Shadow DOM isolation

Ad content renders inside a Shadow DOM container (`mode: "open"`). This prevents:
- Host page CSS from bleeding into the ad
- Host page JavaScript from reading or manipulating ad DOM
- Ad styles from affecting the host page

---

## 14. Governance Voting Mechanics

**Contract:** DatumGovernanceV2

### Vote weight

```
weight = stakeAmount * (2 ^ conviction)
```

Example: 1 DOT at conviction 3 = 1 * 8 = 8 DOT effective weight.

### Lockup duration

```
lockup = baseLockupBlocks * (2 ^ conviction)
```

Capped at `maxLockupBlocks` (default ~365 days / 5,256,000 blocks).

### Thresholds

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `quorumWeighted` | 100 DOT (10^12 planck) | Minimum total weighted votes before evaluation |
| `slashBps` | 1000 (10%) | Percentage of losing-side stake that is slashed |
| `baseLockupBlocks` | 14,400 (~24 hours) | Base lockup at conviction 0 |
| `maxLockupBlocks` | 5,256,000 (~365 days) | Absolute lockup cap |

### Activation condition

```
ayeWeighted * 10000 > totalWeighted * 5000   (aye > 50%)
AND totalWeighted >= quorumWeighted
```

### Termination condition

```
totalWeighted > 0                                (E51: at least one vote)
AND nayWeighted * 10000 >= totalWeighted * 5000   (nay >= 50%)
```

---

## 15. Slash and Rewards

**Contract:** DatumGovernanceSlash

### Who gets slashed?

After a campaign resolves:
- Campaign **Completed** → Nay voters lose 10% of their stake
- Campaign **Terminated** → Aye voters lose 10% of their stake

Slash is symmetric: both sides face the same risk.

### Slash collection

On `withdraw()`, the contract checks if the voter was on the losing side:

```
slash = lockAmount * slashBps / 10000
refund = lockAmount - slash
```

Slashed amounts accumulate in `slashCollected[campaignId]`.

### Reward distribution

1. **Finalize:** Anyone calls `slash.finalizeSlash(campaignId)` — snapshots the winning side's total weight into `winningWeight[campaignId]`. No funds are transferred at this step.
2. **Claim:** Each winner calls `slash.claimSlashReward(campaignId)` — reads the slash pool from `GovernanceV2.slashCollected(campaignId)` and transfers the winner's share directly from GovernanceV2 via `slashAction()`:

```
reward = slashCollected * voterWeight / winningWeight
```

3. One claim per winner per campaign.

---

## 16. Campaign Lifecycle State Machine

```
                      ┌─────────────────────────────────────────────────┐
                      │                                                 │
                      v                                                 │
  ┌─────────┐   governance   ┌────────┐   advertiser    ┌──────────┐   │
  │ Pending  │──────aye──────>│ Active │───pause────────>│  Paused  │   │
  │         │                │        │<───resume───────│          │   │
  └────┬────┘                └───┬──┬─┘                 └────┬─────┘   │
       │                         │  │                        │         │
       │ timeout                 │  │ governance nay         │ complete│
       │ (anyone)                │  │                        │         │
       v                         │  v                        v         │
  ┌─────────┐              ┌─────┴──────┐           ┌──────────────┐   │
  │ Expired │              │ Terminated │           │  Completed   │   │
  │ (refund)│              │(90%+10%slash)│          │   (refund)   │   │
  └─────────┘              └────────────┘           └──────────────┘   │
                                                         ^             │
                                                         │             │
                                                    budget = 0         │
                                                   (auto-complete)─────┘
```

| Transition | Trigger | Who | Budget action |
|-----------|---------|-----|---------------|
| Pending -> Active | `evaluateCampaign()` (aye > 50% + quorum) | Anyone | None |
| Pending -> Expired | `expirePendingCampaign()` (timeout elapsed) | Anyone | Full refund to advertiser |
| Active -> Paused | `togglePause(id, true)` | Advertiser | None |
| Paused -> Active | `togglePause(id, false)` | Advertiser | None |
| Active/Paused -> Completed | `completeCampaign()` | Advertiser or Settlement | Remaining refunded |
| Active/Paused -> Completed | `deductBudget()` when remaining = 0 | Settlement (auto) | None (budget exhausted) |
| Active/Paused -> Terminated | `terminateCampaign()` (nay >= 50%) | Governance | 90% refund, 10% to governance |

---

## 17. Timelock and Pause

### Global Pause (DatumPauseRegistry)

- Single boolean `paused` flag.
- Checked via `staticcall` by Campaigns, Settlement, Relay before state-mutating operations.
- Owner-only `pause()` / `unpause()`.
- Extension monitors pause status and shows a warning banner.

### Admin Timelock (DatumTimelock)

- All admin operations on Campaigns and Settlement flow through a 48-hour delay (`TIMELOCK_DELAY = 172800` seconds).
- Single-slot design: only one pending proposal at a time (no changeId queue).
- **Propose:** `propose(target, data)` — queues a call. Emits `ChangeProposed`.
- **Execute:** `execute()` after 48 hours (`block.timestamp >= pendingTimestamp + TIMELOCK_DELAY`). Emits `ChangeExecuted`.
- **Cancel:** `cancel()` — owner only. Emits `ChangeCancelled`.
- DatumCampaigns and DatumSettlement ownership is transferred to DatumTimelock post-deploy.

### Extension Monitoring (H2)

- `timelockMonitor.ts` polls Timelock events on every campaign poll cycle.
- Pending admin changes shown as a warning count in the extension header.
- Users can see what changes are queued and when they'll execute.

---

## 18. Claim Portability (Export/Import)

**File:** `shared/claimExport.ts` | **Extension tab:** Claims

### Export

1. User clicks "Export Claims" in the Claims tab.
2. Extension prompts wallet to sign an authentication message.
3. HKDF derives an encryption key from the wallet signature.
4. All claim chain states encrypted with AES-256-GCM.
5. Downloaded as a `.dat` file.

### Import

1. User clicks "Import Claims" and selects a `.dat` file.
2. Wallet signs the same authentication message.
3. HKDF derives the decryption key.
4. Decrypted claim states validated:
   - Address must match connected wallet.
   - On-chain nonce checked for each campaign.
   - Merge strategy: keep the higher nonce (more recent state wins).
5. Merged into local `chrome.storage.local`.

### Use case

Moving claim state between browsers/devices without losing the hash chain position. Without export/import, switching devices would mean starting a new chain (old claims still valid, but nonce would reset — requiring on-chain sync).

---

## 19. Publisher SDK Protocol

**Files:** `sdk/datum-sdk.js`, `content/sdkDetector.ts`, `content/handshake.ts`

### SDK Lifecycle

1. Publisher embeds `<script src="datum-sdk.js" data-categories="1,5,12" data-publisher="0x...">` on their page.
2. On load, the SDK dispatches `datum:sdk-ready` CustomEvent on `document`:
   ```
   detail: { publisher: "0x...", categories: [1, 5, 12], version: "1.0.0" }
   ```
3. The DATUM extension content script detects the SDK via:
   - Checking for `<script>` tags with `datum-sdk` in the `src` attribute
   - Listening for `datum:sdk-ready` event (2-second timeout)
4. SDK info (`SDKInfo`) includes: publisher address, categories array, SDK version, and whether `<div id="datum-ad-slot">` exists.

### Challenge-Response Handshake

After a campaign is selected via auction, the extension performs a handshake with the SDK:

1. Extension generates 32 random bytes (challenge) + 8-byte nonce via `crypto.getRandomValues()`.
2. Extension dispatches `datum:challenge` CustomEvent: `{ challenge, nonce }`.
3. SDK computes `SHA-256(publisher + ":" + challenge + ":" + nonce)` and responds via `datum:response`: `{ publisher, challenge, nonce, signature, timestamp }`.
4. Extension verifies the response (publisher match, challenge match, 3-second timeout).
5. Attestation stored for inclusion with the impression claim.

### Category Matching

When the SDK is detected, campaign filtering uses category bitmask overlap:

```
eligible = (campaignCategoryId ∈ sdkInfo.categories) AND
           (campaign is open OR campaign.publisher == sdkInfo.publisher)
```

If no SDK-filtered campaigns match, fallback to page-classification-based category matching (same as sites without SDK).

### Default House Ad

When no campaigns match (pool is empty), the extension injects a default house ad:

- **Content:** "A better web is possible" — links to https://polkadot.com/philosophy
- **Inline mode:** Renders in `<div id="datum-ad-slot">` if SDK is present
- **Overlay mode:** Fixed position bottom-right if no SDK
- No impression tracking, no claim building, no earning — purely informational

---

## 20. Wallet and Key Management

**File:** `shared/walletManager.ts`

### Multi-Account Wallet

- Supports multiple named accounts stored as `WalletEntry[]` in `chrome.storage.local` (`datumWallets` key).
- Each account: generate random key (`generateKey`) or import existing private key (`importKey`).
- Each private key encrypted independently: PBKDF2 (310,000 iterations, SHA-256) derives an AES-256-GCM key from the account's password.
- Active account tracked by `activeWalletName` in storage. Switch via `switchAccount()` (requires password re-entry).
- No external wallet extension required — all signing happens inside the DATUM extension.

### Password Strength (M3)

The wallet setup form shows a real-time strength indicator using a cumulative 5-point score: length >= 8 (+1), length >= 12 (+1), mixed case (+1), digits (+1), special chars (+1). Common patterns (password, qwerty, etc.) cap the score at 1.
- **Too short:** < 8 characters (minimum enforced)
- **Fair:** score <= 2
- **Good:** score 3
- **Strong:** score 4-5

### Key Operations

| Operation | Method |
|-----------|--------|
| Encrypt key | `encryptPrivateKey(key, password)` — PBKDF2 + AES-256-GCM |
| Decrypt key | `decryptPrivateKey(blob, password)` — reverse |
| Sign transaction | `wallet.sendTransaction(tx)` via ethers.js |
| Sign EIP-712 | `wallet.signTypedData(domain, types, value)` for relay claims |
| Export claims | HKDF key from `wallet.signMessage(authMessage)` |
