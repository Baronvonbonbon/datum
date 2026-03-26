# DATUM Alpha-2 — UI Implementation Plan

**Date:** 2026-03-24
**Status:** Draft
**Scope:** Extension (minimal user flows) + Web App (advanced advertiser/publisher/governance/admin)

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [Shared Library (`@datum/shared`)](#3-shared-library-datumshared)
4. [Extension — Minimal User UI](#4-extension--minimal-user-ui)
5. [Web App — Full Dashboard](#5-web-app--full-dashboard)
6. [Web App: Advertiser Interface](#6-web-app-advertiser-interface)
7. [Web App: Publisher Interface](#7-web-app-publisher-interface)
8. [Web App: Governance Interface](#8-web-app-governance-interface)
9. [Web App: Admin Interface](#9-web-app-admin-interface)
10. [Web App: Explorer / Public Views](#10-web-app-explorer--public-views)
11. [Wallet & Authentication](#11-wallet--authentication)
12. [Settings & Configuration](#12-settings--configuration)
13. [Migration from Alpha-Extension](#13-migration-from-alpha-extension)
14. [Flow Coverage Matrix](#14-flow-coverage-matrix)
15. [Implementation Phases](#15-implementation-phases)

---

## 1. Design Philosophy

### Extension = User/Viewer Only

The browser extension serves **one role**: the ad viewer who browses, views ads, accumulates claims, and earns. Everything a user needs to participate passively in the DATUM network runs in the extension:

- View ads served by publishers (Shadow DOM injection, SDK handshake)
- Build cryptographic claim hash chains (engagement tracking, quality scoring)
- Submit claims (direct or sign for relay)
- Check earnings and withdraw
- Manage wallet and connection settings

### Web App = Everything Else

All advanced, role-specific, and administrative flows move to a standalone web application (React SPA, deployable as static site). This includes:

- **Advertiser:** Create/manage campaigns, fund budgets, set metadata, pause/resume, view spending
- **Publisher:** Register, set take rate, manage categories, configure allowlist, withdraw earnings, SDK setup
- **Governance:** Vote on campaigns, evaluate outcomes, withdraw stakes, claim slash rewards
- **Admin:** Timelock proposals, pause/unpause, blocklist management, protocol fee withdrawal, contract reference updates

### Why This Split?

1. **Extension popup is 400×600px** — cramming 7 tabs with complex forms creates a poor UX
2. **Extension must be lightweight** — fewer dependencies = faster load, smaller bundle, less review surface
3. **Advanced roles (advertiser, publisher, governance) are infrequent** — users don't create campaigns or vote every day, but they browse constantly
4. **Web app can offer proper layouts** — tables, charts, multi-step forms, and responsive design
5. **Security surface** — less code in the extension = less attack surface for the wallet

### What the Extension Keeps

The extension retains **all background functionality** that requires persistent browser presence:

- `campaignPoller.ts` — on-chain campaign scanning + IPFS metadata fetch
- `engagement.ts` — viewport tracking and quality scoring
- `behaviorChain.ts` / `behaviorCommit.ts` — hash chain building
- `auction.ts` — Vickrey second-price ad selection
- `adSlot.ts` — Shadow DOM ad rendering
- `content/index.ts` — content script injection + SDK detection
- `background/index.ts` — service worker message handling, auto-submit
- `walletManager.ts` — encrypted wallet storage
- `phishingList.ts` — CTA URL + address filtering
- `contentSafety.ts` — metadata validation + sanitization
- `sdkDetector.ts` / `handshake.ts` — publisher SDK interaction
- `claimExport.ts` — encrypted claim backup/restore
- `timelockMonitor.ts` — pending change detection (banner only)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    @datum/shared                         │
│  types.ts, networks.ts, contracts.ts, abis/,            │
│  errorCodes.ts, dot.ts, ipfs.ts, categories             │
└────────────┬───────────────────────────┬────────────────┘
             │                           │
    ┌────────▼──────────┐      ┌─────────▼──────────────┐
    │  Browser Extension │      │     Web Application     │
    │  (MV3, ~5 views)  │      │   (React SPA, ~20 views)│
    │                    │      │                          │
    │  Popup:            │      │  /advertiser/*           │
    │   - Earnings       │      │  /publisher/*            │
    │   - Claims         │      │  /governance/*           │
    │   - Settings       │      │  /admin/*                │
    │                    │      │  /explorer/*             │
    │  Background:       │      │  /settings               │
    │   - campaignPoller │      │                          │
    │   - engagement     │      │  Wallet: Browser ext     │
    │   - behaviorChain  │      │  or injected provider    │
    │   - auction        │      │  (MetaMask-style)        │
    │   - autoSubmit     │      │                          │
    │                    │      │                          │
    │  Content:          │      │                          │
    │   - adSlot         │      │                          │
    │   - SDK handshake  │      │                          │
    └───────────────────┘      └──────────────────────────┘
             │                           │
             └───────────┬───────────────┘
                         │
              ┌──────────▼──────────┐
              │  Polkadot Hub /     │
              │  Paseo TestNet      │
              │  (13 contracts)     │
              └─────────────────────┘
```

---

## 3. Shared Library (`@datum/shared`)

Extract from `alpha-extension/src/shared/` into a standalone npm package (or monorepo workspace) consumed by both extension and web app.

### Files to Extract (as-is)

| File | Contents |
|------|----------|
| `types.ts` | Claim, ClaimBatch, Campaign, CampaignMetadata, CampaignStatus, ContractAddresses, StoredSettings, CATEGORY_NAMES, category hierarchy |
| `networks.ts` | NETWORK_CONFIGS, DEFAULT_SETTINGS, getCurrencySymbol |
| `contracts.ts` | getProvider, getCampaignsContract, getPublishersContract, getGovernanceV2Contract, getGovernanceSlashContract, getSettlementContract, getRelayContract, getBudgetLedgerContract, getPaymentVaultContract, getLifecycleContract, getAttestationVerifierContract, getTimelockContract |
| `abis/` | All 13 contract ABIs (JSON) |
| `errorCodes.ts` | humanizeError, ERROR_MESSAGES map (E00-E64, P, reason codes) |
| `dot.ts` | formatDOT, parseDOT, DOT_DECIMALS |
| `ipfs.ts` | cidToBytes32, bytes32ToCid, fetchIPFSMetadata |
| `ipfsPin.ts` | pinToIPFS, testPinataKey |
| `contentSafety.ts` | validateAndSanitize, CONTENT_BLOCKLIST, URL_SCHEME_ALLOWLIST |

### New Shared Utilities (for web app)

| Utility | Purpose |
|---------|---------|
| `conviction.ts` | CONVICTION_WEIGHTS, CONVICTION_LOCKUPS, formatLockupDuration — currently duplicated/hardcoded in GovernancePanel |
| `campaignFilters.ts` | Filter/sort campaign lists by status, category, advertiser, publisher |
| `blockTime.ts` | formatBlockDelta, blocksToTime, timeToBlocks (currently in PublisherPanel) |
| `events.ts` | Event log parsing helpers for all 13 contracts (CampaignCreated, ClaimSettled, VoteCast, etc.) |

### Contracts to Add to `contracts.ts`

The alpha-extension's `contracts.ts` currently covers 9 contracts. Add:

- `getBudgetLedgerContract(addresses, signerOrProvider)` — BudgetLedger ABI
- `getPaymentVaultContract(addresses, signerOrProvider)` — PaymentVault ABI
- `getLifecycleContract(addresses, signerOrProvider)` — CampaignLifecycle ABI
- `getAttestationVerifierContract(addresses, signerOrProvider)` — AttestationVerifier ABI

### Contract Addresses Config

Both extension and web app share the same `ContractAddresses` type. Update to include all 13 contracts:

```typescript
export interface ContractAddresses {
  campaigns: string;
  publishers: string;
  governanceV2: string;
  governanceSlash: string;
  settlement: string;
  relay: string;
  pauseRegistry: string;
  timelock: string;
  zkVerifier: string;
  // Alpha-2 additions:
  budgetLedger: string;
  paymentVault: string;
  lifecycle: string;
  attestationVerifier: string;
}
```

---

## 4. Extension — Minimal User UI

### Popup Tabs (3 tabs, down from 7)

```
[ Earnings ]  [ Claims ]  [ Settings ]
```

#### 4.1 Earnings Tab (was "User" / UserPanel)

**Shows:**
- User balance in PaymentVault (`paymentVault.userBalance(address)`)
- Lifetime earnings (from ClaimSettled events or local tracking)
- Recent claim settlements (last 10, from local storage + chain events)
- Withdraw button → calls `paymentVault.withdrawUser()`

**Data sources:**
- `paymentVault.userBalance(address)` — current withdrawable
- `chrome.storage.local` claim history — local record
- ClaimSettled events (optional, can be expensive to scan)

**Removed from extension (moved to web app):**
- Publisher balance / withdrawal (→ web /publisher)
- Protocol balance / withdrawal (→ web /admin)

#### 4.2 Claims Tab (was ClaimQueue)

**Shows:**
- Pending claim count per campaign
- Total pending value (estimated earnings)
- "Submit All" button → calls `attestationVerifier.settleClaimsAttested()` (P1 path)
- "Sign for Relay" button → EIP-712 sign + POST to relay endpoint (fix relay gap 10.1)
- Auto-submit status indicator (if enabled)
- Claim export/import buttons

**Unchanged from alpha-extension:**
- Claim building logic remains in background (`behaviorChain.ts`)
- Auto-submit remains in background service worker
- EIP-712 signing for relay batches

**Fix required (10.1 Relay Gap):**
- After `signForRelay()`, POST signed batches to publisher relay URL
- Relay URL = attestation endpoint base URL + `/relay/submit`
- Show submission status (success/failure/pending)

#### 4.3 Settings Tab (simplified)

**Shows:**
- Network selector (Local / Paseo / Westend / Kusama / Polkadot Hub)
- RPC URL (auto-populated from network, editable)
- Test Connection button (SI-1)
- Contract addresses (collapsible, with "Load Deployed" button)
- Auto-submit toggle + interval + password authorization (B1)
- IPFS gateway URL
- Ad preferences (max ads/hour, min bid CPM, silenced categories, blocked campaigns)
- Interest profile (collapsible, with reset)
- Danger zone (clear queue, reset chain state)

**Removed from extension settings:**
- Publisher address override (→ web /publisher)
- Pinata API key (→ web /advertiser, only advertisers pin metadata)

#### 4.4 Popup Header

**Shows:**
- DATUM logo
- Active account name + truncated address (click to copy)
- Account switcher dropdown (MA-2)
- Lock button
- Chain heartbeat bar (connected/disconnected, block number, native balance)
- Timelock pending change warning banner (H2)

#### 4.5 Wallet Screens (unchanged)

- No-wallet: Import / Generate buttons
- Locked: Password entry, account switcher, Add Account / Remove All
- Setup: Account name, private key (import), password with strength indicator (M3)
- Key backup: Copy + "I've saved my key" flow (WS-1)

---

## 5. Web App — Full Dashboard

### Technology

- **Framework:** React 18+ (same as extension popup, for component reuse)
- **Router:** React Router v6 (client-side SPA)
- **Styling:** CSS modules or Tailwind CSS (upgrade from inline styles)
- **Build:** Vite (fast builds, ESM-native)
- **Wallet:** ethers.js v6 (same as extension) with browser extension wallet or injected provider

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  DATUM     [Network: Paseo ▼]  [0xAbCd...1234] [Disconnect]│
├────────┬─────────────────────────────────────────────────┤
│        │                                                  │
│ NAV    │              MAIN CONTENT                        │
│        │                                                  │
│ Explorer   │                                              │
│ Advertiser │                                              │
│ Publisher  │                                              │
│ Governance │                                              │
│ Admin      │                                              │
│ Settings   │                                              │
│            │                                              │
└────────┴─────────────────────────────────────────────────┘
```

### Navigation

| Section | Route | Role | Description |
|---------|-------|------|-------------|
| Explorer | `/` | Public | Campaign browser, protocol stats |
| Advertiser | `/advertiser` | Advertiser | Campaign management |
| Publisher | `/publisher` | Publisher | Registration, earnings, SDK |
| Governance | `/governance` | Voter | Voting, evaluation, slash |
| Admin | `/admin` | Owner | Timelock, pause, blocklist |
| Settings | `/settings` | All | Network, contracts, wallet |

### Wallet Connection

The web app does NOT embed its own wallet. It connects via:

1. **DATUM Extension** — if installed, the extension exposes `window.datum` provider (new, see §11)
2. **Injected provider** — MetaMask, SubWallet, Talisman, or any EIP-1193 provider (`window.ethereum`)
3. **Manual key** — paste private key (testing only, same as extension import, session-only)

---

## 6. Web App: Advertiser Interface

**Route:** `/advertiser`

### 6.1 Campaign Dashboard (`/advertiser`)

**Table columns:** ID, Status (badge), Publisher (address or "Open"), Budget (remaining / initial), Daily Cap, Bid CPM, Category, Take Rate, Metadata (link), Actions

**Filters:** Status (Pending/Active/Paused/Completed/Terminated/Expired), Open/Targeted, Category

**Data source:** Scan `DatumCampaigns.nextCampaignId()`, filter by `getCampaignAdvertiser(id) == connectedAddress`

### 6.2 Create Campaign (`/advertiser/create`)

**Form fields:**

| Field | Type | Validation | Contract Reference |
|-------|------|-----------|-------------------|
| Publisher Address | text (0x...) or toggle "Open Campaign" | If targeted: must be registered publisher (check `publishers.getPublisher()`). If open: sets `address(0)` | `createCampaign(publisher, ...)` |
| Budget | number (DOT) | > 0, becomes `msg.value` | `msg.value` |
| Daily Cap | number (DOT) | > 0, ≤ budget | `dailyCapPlanck` |
| Bid CPM | number (DOT) | ≥ minimumCpmFloor (read from contract) | `bidCpmPlanck` |
| Category | dropdown (26 categories) | 1-26 | `categoryId` |

**Pre-submission checks:**
- S12: `publishers.isBlocked(connectedAddress)` — show error if advertiser is blocked
- S12: If targeted, `publishers.isBlocked(publisher)` — show error if publisher is blocked
- S12: If targeted and `publishers.allowlistEnabled(publisher)`, check `publishers.isAllowedAdvertiser(publisher, connectedAddress)` — show warning if not allowed
- Balance check: `provider.getBalance(connectedAddress)` ≥ budget + gas estimate

**Post-creation flow:**
1. Transaction confirmed → show campaign ID
2. Prompt: "Set campaign metadata?" → navigate to metadata form

### 6.3 Set Campaign Metadata (`/advertiser/campaign/:id/metadata`)

**Form fields:**

| Field | Type | Validation | Reference |
|-------|------|-----------|-----------|
| Title | text | ≤ 128 chars | CampaignMetadata.title |
| Description | text area | ≤ 256 chars | CampaignMetadata.description |
| Category Label | text | ≤ 64 chars | CampaignMetadata.category |
| Creative Text | text area | ≤ 512 chars | CampaignMetadata.creative.text |
| CTA Label | text | ≤ 64 chars | CampaignMetadata.creative.cta |
| CTA URL | URL | HTTPS only, ≤ 2048 chars, sanitized | CampaignMetadata.creative.ctaUrl |
| Image URL | URL (optional) | HTTPS or IPFS gateway | CampaignMetadata.creative.imageUrl |

**Submission flow:**
1. Validate with `contentSafety.validateAndSanitize(metadata)`
2. Pin to IPFS via `ipfsPin.pinToIPFS(metadata, pinataApiKey)` — requires Pinata API key in settings
3. Convert CID to bytes32 via `cidToBytes32(cid)`
4. Call `campaigns.setMetadata(campaignId, metadataHash)`
5. Show IPFS link to pinned metadata

**Pinata API key:** Configured in web app settings (`/settings`), stored in `localStorage`.

### 6.4 Campaign Actions (`/advertiser/campaign/:id`)

**Detail view with action buttons:**

| Action | Condition | Contract Call | Notes |
|--------|-----------|---------------|-------|
| Pause | Status == Active | `campaigns.togglePause(id, true)` | |
| Resume | Status == Paused | `campaigns.togglePause(id, false)` | |
| Complete | Status == Active or Paused | `lifecycle.completeCampaign(id)` | Refunds remaining budget |
| Edit Metadata | Any status | `campaigns.setMetadata(id, hash)` | Only advertiser |
| View Budget | Any | Read `budgetLedger.getBudget(id)` | Shows remaining, dailyCap, dailySpent, lastSettlementBlock |
| View Votes | Pending or Active | Read governance aye/nay weights | Shows if quorum met |

**Budget detail panel:**
- Remaining balance (from BudgetLedger)
- Daily cap / daily spent / days active
- Settlement history (ClaimSettled events for this campaign)
- Revenue breakdown (publisher / user / protocol splits)

### 6.5 Campaign Spending Analytics (`/advertiser/campaign/:id/analytics`)

- Impressions settled (from ClaimSettled events)
- Total spent vs. remaining budget
- Daily spend chart (from DayReset events or block-bucketed ClaimSettled)
- Publisher earnings breakdown (if open campaign, may have multiple publishers)
- Average clearing CPM

---

## 7. Web App: Publisher Interface

**Route:** `/publisher`

### 7.1 Publisher Dashboard (`/publisher`)

**Status panel:**
- Registration status (registered / not registered)
- Current take rate (BPS and %)
- Pending take rate update (if any, with countdown to effective block)
- Category bitmask (visual: 26 checkboxes)
- Allowlist status (enabled/disabled, count of allowed advertisers)
- Earnings balance in PaymentVault
- Blocklist status (show if blocked, with warning)

### 7.2 Register as Publisher (`/publisher/register`)

**Form:**

| Field | Type | Validation |
|-------|------|-----------|
| Take Rate | slider + number | 30.00% - 80.00% (3000-8000 BPS) |

**Pre-check:** `publishers.isBlocked(connectedAddress)` — show error E62 if blocked

**Call:** `publishers.registerPublisher(takeRateBps)`

### 7.3 Update Take Rate (`/publisher/rate`)

**Two-step flow (delay-gated):**

1. **Queue update:** `publishers.updateTakeRate(newTakeRateBps)`
   - Show: new rate, effective block number, estimated time until effective
2. **Apply update** (after delay): `publishers.applyTakeRateUpdate()`
   - Show: countdown timer, "Apply Now" button (enabled when delay elapsed)

**Display:** Current rate vs. pending rate, delay blocks remaining, estimated time.

### 7.4 Manage Categories (`/publisher/categories`)

**Visual:** Grid of 26 category checkboxes (same as alpha-extension PublisherPanel)

| Category | ID | Bit |
|----------|----|-----|
| Arts & Entertainment | 1 | bit 1 |
| Autos & Vehicles | 2 | bit 2 |
| ... | ... | ... |
| Travel | 26 | bit 26 |

**Call:** `publishers.setCategories(bitmask)` — compute bitmask from selected checkboxes

**Also show:** Matching campaigns count per category (scan active campaigns by categoryId)

### 7.5 Manage Allowlist (`/publisher/allowlist`)

**Toggle:** Enable/disable allowlist
- `publishers.setAllowlistEnabled(enabled)` — warns that disabling opens to all advertisers

**Allowlist table:**
- Add advertiser address: `publishers.setAllowedAdvertiser(advertiser, true)`
- Remove advertiser: `publishers.setAllowedAdvertiser(advertiser, false)`
- List: scan `AdvertiserAllowlistUpdated` events to build current set

### 7.6 Publisher Earnings (`/publisher/earnings`)

**Shows:**
- Current balance: `paymentVault.publisherBalance(address)`
- Withdraw button: `paymentVault.withdrawPublisher()`
- Settlement history: ClaimSettled events where publisher == connectedAddress
- Earnings by campaign (grouped)
- Total lifetime earnings

### 7.7 Publisher SDK Setup (`/publisher/sdk`)

**Instructions + copy-to-clipboard snippets:**

```html
<!-- DATUM Publisher SDK -->
<script src="https://datum.network/sdk/datum-sdk.js"
        data-publisher="0xYOUR_ADDRESS"
        data-categories="1,6,26">
</script>
<div id="datum-ad-slot"></div>
```

**Fields:**
- Publisher address (pre-filled from connected wallet)
- Selected categories (pre-filled from on-chain bitmask)
- Ad slot div ID (customizable, default `datum-ad-slot`)

**Live preview:** Show what the ad slot will look like with sample metadata.

### 7.8 Relay Setup Guide (`/publisher/relay`)

**Documentation view** (read-only, links to relay-bot-template):
- How to run a publisher relay
- Attestation endpoint: `POST /.well-known/datum-attest`
- Relay endpoint: `POST /relay/submit`
- Flush endpoint: `POST /relay/flush`
- Status endpoint: `GET /relay/status`
- Systemd service template
- EIP-712 domain configuration

---

## 8. Web App: Governance Interface

**Route:** `/governance`

### 8.1 Campaign Voting Dashboard (`/governance`)

**Table columns:** ID, Status (badge), Advertiser, Category, Bid CPM, Budget, Aye Weight, Nay Weight, Quorum %, My Vote, Actions

**Sections:**
- **Pending campaigns** (need votes to activate) — highlight if quorum not yet met
- **Active campaigns** (can be voted for termination) — show grace period status
- **Resolved campaigns** (completed/terminated/expired) — show slash status

**Filters:** Status, Category, "My votes only", "Needs quorum"

**Data source:** Scan all campaigns, read `governance.ayeWeighted(id)`, `governance.nayWeighted(id)`, `governance.resolved(id)`, `governance.getVote(id, connectedAddress)`

### 8.2 Vote on Campaign (`/governance/vote/:id`)

**Campaign detail panel:**
- All campaign info (advertiser, publisher, budget, daily cap, bid CPM, category)
- IPFS metadata preview (title, description, creative) — via `bytes32ToCid(metadataHash)`
- Current vote tally: aye vs. nay (bar chart), quorum progress bar

**Vote form:**

| Field | Type | Notes |
|-------|------|-------|
| Direction | Aye / Nay toggle | |
| Amount | number (DOT) | Becomes `msg.value` |
| Conviction | slider 0-8 | Show weight multiplier + lockup duration |

**Conviction reference table (inline):**

| Level | Weight | Lockup | Description |
|-------|--------|--------|-------------|
| 0 | 1x | None | No risk, instant withdraw |
| 1 | 2x | 1 day | Low-risk entry |
| 2 | 3x | 3 days | |
| 3 | 4x | 7 days | |
| 4 | 6x | 21 days | |
| 5 | 9x | 90 days | |
| 6 | 14x | 180 days | |
| 7 | 18x | 270 days | |
| 8 | 21x | 365 days | Maximum conviction |

**Effective weight preview:** `amount × conviction_weight` shown before submitting

**Call:** `governance.vote(campaignId, isAye, conviction)` with `{value: amountPlanck}`

### 8.3 Evaluate Campaign (`/governance/evaluate/:id`)

**Shows:** Current aye/nay weights, quorum threshold, quorum met?, grace period status

**Conditions displayed:**
- **Activation (Pending → Active):** aye > 50% + quorum met (E46, E47)
- **Termination (Active → Terminated):** nay ≥ 50% + termination quorum (E52) + grace period elapsed (E53)
- **Resolution (Completed/Terminated):** not yet resolved (E49)

**Button:** "Evaluate" → `governance.evaluateCampaign(campaignId)`
- Show specific error context if evaluation fails (E46 = quorum not met, E47 = aye majority required, E52 = nay below termination quorum, E53 = grace period not elapsed)

### 8.4 My Votes (`/governance/my-votes`)

**Table:** Campaign ID, Direction (Aye/Nay), Amount Locked, Conviction, Locked Until Block, Status (locked/unlockable/withdrawn), Slash Risk

**Actions per vote:**
- **Withdraw** (if lockup expired): `governance.withdraw(campaignId)`
  - Show: refund amount, slash deduction (if losing side), net return
  - Warn if on losing side: "You will be slashed X% (Y DOT)"
- **Claim Slash Reward** (if winner on resolved campaign):
  - First: `governanceSlash.finalizeSlash(campaignId)` if not finalized
  - Then: `governanceSlash.claimSlashReward(campaignId)`
  - Show: estimated reward based on voter's weight proportion

### 8.5 Governance Parameters (`/governance/parameters`)

**Read-only display:**
- Quorum (weighted): `governance.quorumWeighted()`
- Slash BPS: `governance.slashBps()`
- Termination quorum: `governance.terminationQuorum()`
- Termination grace blocks: `governance.terminationGraceBlocks()`
- Pending timeout blocks: `governance.pendingTimeoutBlocks()`

### 8.6 Expire Inactive Campaign (P20) (`/governance`)

**In campaign list, show "Expire" button when:**
- Status == Active or Paused
- `block.number > budgetLedger.lastSettlementBlock(id) + 432,000`

**Call:** `lifecycle.expireInactiveCampaign(campaignId)` — permissionless

**Show:** Last settlement block, inactivity duration, timeout threshold

---

## 9. Web App: Admin Interface

**Route:** `/admin`

**Access:** All views are public (read), but write actions require owner wallet.

### 9.1 Timelock Dashboard (`/admin/timelock`)

**Pending proposal panel:**
- Target contract address (resolve to name if known)
- Calldata (decode to function name + parameters — GV-4 enhancement)
- Proposed timestamp
- Execution window (48h countdown)
- Status: Pending / Executable / Expired

**Actions:**
- **Propose:** Target address + function selector + encoded parameters → `timelock.propose(target, data)`
- **Execute:** `timelock.execute()` — enabled after 48h delay
- **Cancel:** `timelock.cancel()` — owner only

**Decoded proposal display (GV-4):**
- Match target address to known contract names
- Decode calldata using contract ABIs (e.g., `setSettlementContract(0x1234)`)
- Show human-readable description: "Change Settlement contract from 0xOLD to 0xNEW"

### 9.2 Pause Registry (`/admin/pause`)

**Status:** PAUSED / ACTIVE (large indicator)

**Actions:**
- Pause: `pauseRegistry.pause()` — confirm dialog
- Unpause: `pauseRegistry.unpause()` — confirm dialog

**What's affected:** List of contracts that check `pauseRegistry.paused()`:
- Publishers (registration, take rate updates)
- Campaigns (creation)
- Settlement (claim processing)
- Relay (claim forwarding)
- CampaignLifecycle (lifecycle transitions)

**What's NOT affected:** Governance voting, withdrawals, slash claims, metadata updates

### 9.3 Blocklist Management (`/admin/blocklist`)

**Current blocked addresses:** Table from `AddressBlocked` / `AddressUnblocked` events

**Actions:**
- Block address: `publishers.blockAddress(addr)` — owner only
- Unblock address: `publishers.unblockAddress(addr)` — owner only

**Warning:** "Blocklist is NOT timelock-gated in alpha. Must migrate to timelock before mainnet."

**Impact preview:** Before blocking, show:
- Is this address a registered publisher? (campaigns would continue, but new registrations blocked)
- Is this address an active advertiser? (existing campaigns continue, new creation blocked)
- Settlement rejection: claims involving blocked publishers rejected with reason code 11

### 9.4 Protocol Fee Withdrawal (`/admin/protocol`)

**Shows:**
- Protocol balance: `paymentVault.protocolBalance()`
- Owner address: `paymentVault.owner()`

**Action:** "Withdraw to..." → `paymentVault.withdrawProtocol(recipient)`

**Note:** PaymentVault owner is NOT transferred to Timelock — direct owner withdrawal.

### 9.5 Contract Wiring Reference (`/admin/contracts`)

**Shows all 13 contract addresses with their roles and current wiring:**

| Contract | Address | Owner | Key References |
|----------|---------|-------|---------------|
| PauseRegistry | 0x... | deployer | — |
| Timelock | 0x... | deployer | — |
| Publishers | 0x... | deployer | pauseRegistry |
| Campaigns | 0x... | Timelock | pauseRegistry, publishers, budgetLedger, settlement, governance, lifecycle |
| BudgetLedger | 0x... | deployer | campaigns, settlement, lifecycle |
| CampaignLifecycle | 0x... | deployer | campaigns, budgetLedger, governance, pauseRegistry |
| PaymentVault | 0x... | deployer | settlement |
| GovernanceV2 | 0x... | deployer | campaigns, lifecycle, slash |
| GovernanceSlash | 0x... | deployer | governance |
| Settlement | 0x... | Timelock | budgetLedger, paymentVault, lifecycle, relay, publishers, attestationVerifier, pauseRegistry |
| Relay | 0x... | deployer | settlement, campaigns, pauseRegistry |
| AttestationVerifier | 0x... | deployer | settlement, campaigns |
| ZKVerifier | 0x... | deployer | — (stub) |

---

## 10. Web App: Explorer / Public Views

**Route:** `/` (home), `/explorer`

### 10.1 Protocol Overview (`/`)

**Stats dashboard (no wallet needed):**
- Total campaigns (nextCampaignId)
- Active campaigns count
- Registered publishers count (from PublisherRegistered events)
- Total settled claims (from ClaimSettled events, or contract counters)
- Protocol status: Paused / Active

### 10.2 Campaign Browser (`/explorer/campaigns`)

**Public campaign list** (same data as extension's CampaignList, but full-page table):
- All campaigns with status, advertiser, publisher, bid CPM, budget, category
- Click to expand: metadata (from IPFS), vote tally, settlement stats
- Filter by status, category, open/targeted

### 10.3 Campaign Detail (`/explorer/campaign/:id`)

**Full detail page:**
- Campaign parameters (all on-chain fields)
- Metadata (IPFS, rendered creative preview)
- Budget info (from BudgetLedger)
- Vote tally (aye/nay weights, quorum progress)
- Settlement history (ClaimSettled events)
- Status timeline (Created → Pending → Active → Completed, with block numbers)

### 10.4 Publisher Directory (`/explorer/publishers`)

**List of registered publishers:**
- Address, take rate, categories (decoded bitmask), registration block
- Allowlist status (enabled/disabled)
- Blocklist status

### 10.5 Governance Activity (`/explorer/governance`)

**Recent governance events:**
- VoteCast events (campaign, voter, direction, amount, conviction)
- CampaignEvaluated events (campaign, outcome)
- VoteWithdrawn events (campaign, voter, returned, slashed)
- SlashRewardClaimed events

---

## 11. Wallet & Authentication

### Extension Wallet (existing)

The extension keeps its current wallet implementation:
- `walletManager.ts`: multi-account, AES-256-GCM + PBKDF2 encryption
- Stored in `chrome.storage.local` (per-browser, encrypted at rest)
- Unlocked wallet held in service worker memory (session-scoped)

### Web App Wallet Connection

The web app supports multiple connection methods:

#### Option A: DATUM Extension Provider (preferred)

The extension exposes `window.datum` to web pages (new content script injection):

```typescript
// Extension injects into page context:
window.datum = {
  isConnected: () => boolean,
  getAddress: () => Promise<string>,
  signTransaction: (tx) => Promise<string>,
  signTypedData: (domain, types, value) => Promise<string>,
  on: (event, callback) => void,
};
```

**Security:** Extension shows confirmation popup for each sign request (like MetaMask).

**Implementation:** New content script (`provider.ts`) that relays messages between page and extension background.

#### Option B: Injected EIP-1193 Provider

Standard `window.ethereum` from MetaMask, SubWallet, Talisman, etc.

```typescript
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
```

#### Option C: Manual Key (testing only)

Same as extension: paste private key, encrypt in sessionStorage, clear on tab close.

Show warning: "TESTING ONLY — NO SECURITY GUARANTEES"

### Shared Wallet State

If the user has the DATUM extension AND is using the web app:
- Web app detects `window.datum` and auto-connects
- Address stays in sync
- Signing uses extension's encrypted wallet (more secure than raw key in web app)

---

## 12. Settings & Configuration

### Extension Settings (popup, simplified)

As described in §4.3 — network, RPC, contract addresses, auto-submit, ad preferences.

### Web App Settings (`/settings`)

**Network & RPC:**
- Same network selector and RPC URL as extension
- Test Connection (SI-1)
- Contract mismatch detection (SI-2)

**Contract Addresses:**
- All 13 contracts (editable text fields)
- "Load Deployed" button (from local file or published JSON)
- Network-specific defaults (from `NETWORK_CONFIGS`)

**IPFS / Pinata:**
- Pinata API key (for advertiser metadata pinning)
- IPFS gateway URL
- Test Pinata connection

**Wallet:**
- Connected wallet display
- Connection method indicator (Extension / MetaMask / Manual)
- Disconnect button

**Storage:** Web app settings stored in `localStorage` (separate from extension's `chrome.storage.local`).

---

## 13. Migration from Alpha-Extension

### Files that Stay in Extension

| File | Reason |
|------|--------|
| `popup/App.tsx` | Rewritten (3 tabs) |
| `popup/ClaimQueue.tsx` | Simplified (remove relay UI, keep submit/sign) |
| `popup/UserPanel.tsx` | Renamed to `EarningsPanel.tsx`, simplified |
| `popup/Settings.tsx` | Simplified (remove publisher/pinata sections) |
| `background/index.ts` | Unchanged (core service worker) |
| `content/index.ts` | Unchanged (ad injection + SDK) |
| `shared/walletManager.ts` | Unchanged |
| All `shared/` utils | Extracted to `@datum/shared` package, imported by both |
| `behaviorChain.ts`, `behaviorCommit.ts` | Unchanged |
| `engagement.ts`, `auction.ts`, `adSlot.ts` | Unchanged |
| `campaignPoller.ts` | Unchanged |
| `phishingList.ts`, `contentSafety.ts` | Unchanged |
| `sdkDetector.ts`, `handshake.ts` | Unchanged |
| `claimExport.ts` | Unchanged |
| `timelockMonitor.ts` | Unchanged |
| `zkProofStub.ts` | Unchanged |
| `publisherAttestation.ts` | Unchanged |
| `qualityScore.ts` | Unchanged |

### Files Removed from Extension (moved to web app)

| File | Web App Destination |
|------|-------------------|
| `popup/AdvertiserPanel.tsx` | `/advertiser/*` pages |
| `popup/PublisherPanel.tsx` | `/publisher/*` pages |
| `popup/GovernancePanel.tsx` | `/governance/*` pages |
| `popup/CampaignList.tsx` | `/explorer/campaigns` (expanded) |

### New Extension Files

| File | Purpose |
|------|---------|
| `content/provider.ts` | Inject `window.datum` provider for web app wallet connection |
| `popup/EarningsPanel.tsx` | Simplified user earnings view (from UserPanel) |

### New Web App Files (approximate)

```
web/
├── src/
│   ├── main.tsx                    # Entry point
│   ├── App.tsx                     # Router + layout
│   ├── components/
│   │   ├── Layout.tsx              # Header + sidebar + main
│   │   ├── WalletConnect.tsx       # Connection modal
│   │   ├── NetworkSelector.tsx     # Shared network picker
│   │   ├── CampaignStatusBadge.tsx # Reusable status badge
│   │   ├── AddressDisplay.tsx      # Truncated address with copy
│   │   ├── DOTAmount.tsx           # Formatted DOT display
│   │   ├── ConvictionSlider.tsx    # Conviction selector with info
│   │   ├── CategoryPicker.tsx      # 26-category grid
│   │   └── TransactionStatus.tsx   # Pending/confirmed/failed
│   ├── pages/
│   │   ├── explorer/
│   │   │   ├── Overview.tsx        # Protocol stats
│   │   │   ├── Campaigns.tsx       # Campaign browser
│   │   │   ├── CampaignDetail.tsx  # Single campaign view
│   │   │   ├── Publishers.tsx      # Publisher directory
│   │   │   └── GovernanceActivity.tsx
│   │   ├── advertiser/
│   │   │   ├── Dashboard.tsx       # My campaigns list
│   │   │   ├── CreateCampaign.tsx  # Campaign creation form
│   │   │   ├── CampaignDetail.tsx  # Management + actions
│   │   │   ├── SetMetadata.tsx     # IPFS metadata form
│   │   │   └── Analytics.tsx       # Spending analytics
│   │   ├── publisher/
│   │   │   ├── Dashboard.tsx       # Status + earnings
│   │   │   ├── Register.tsx        # Registration form
│   │   │   ├── TakeRate.tsx        # Rate management
│   │   │   ├── Categories.tsx      # Category grid
│   │   │   ├── Allowlist.tsx       # Advertiser allowlist
│   │   │   ├── Earnings.tsx        # Withdrawal + history
│   │   │   ├── SDKSetup.tsx        # SDK snippet + preview
│   │   │   └── RelayGuide.tsx      # Relay setup docs
│   │   ├── governance/
│   │   │   ├── Dashboard.tsx       # Campaign voting list
│   │   │   ├── Vote.tsx            # Vote form + campaign detail
│   │   │   ├── Evaluate.tsx        # Evaluation actions
│   │   │   ├── MyVotes.tsx         # Vote management + withdraw
│   │   │   └── Parameters.tsx      # Governance parameters
│   │   ├── admin/
│   │   │   ├── Timelock.tsx        # Proposal management
│   │   │   ├── PauseRegistry.tsx   # Pause/unpause
│   │   │   ├── Blocklist.tsx       # Address blocking
│   │   │   ├── ProtocolFees.tsx    # Fee withdrawal
│   │   │   └── ContractWiring.tsx  # Contract reference display
│   │   └── Settings.tsx            # Network + contracts + wallet
│   ├── hooks/
│   │   ├── useWallet.ts            # Wallet connection state
│   │   ├── useContract.ts          # Contract instance factory
│   │   ├── useNetwork.ts           # Network/RPC state
│   │   └── useCampaigns.ts         # Campaign list + filters
│   └── lib/
│       └── wallet-provider.ts      # window.datum / window.ethereum adapter
├── index.html
├── vite.config.ts
├── package.json
└── tsconfig.json
```

---

## 14. Flow Coverage Matrix

Every flow from PROCESS-FLOWS.md mapped to its UI location.

### Advertiser Flows (§1)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Create Campaign | 1.1 | Web `/advertiser/create` | Multi-step form |
| Set Metadata (IPFS) | 1.2 | Web `/advertiser/campaign/:id/metadata` | Pinata integration |
| Pause Campaign | 1.3 | Web `/advertiser/campaign/:id` action | Single button |
| Resume Campaign | 1.4 | Web `/advertiser/campaign/:id` action | Single button |
| Complete Campaign Early | 1.5 | Web `/advertiser/campaign/:id` action | Confirmation dialog |

### Publisher Flows (§2)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Register | 2.1 | Web `/publisher/register` | Take rate form |
| Set Categories | 2.2 | Web `/publisher/categories` | 26-checkbox grid |
| Update Take Rate (queue) | 2.3 | Web `/publisher/rate` | Two-step flow |
| Apply Take Rate | 2.4 | Web `/publisher/rate` | Countdown + apply |
| Manage Allowlist | 2.5 | Web `/publisher/allowlist` | Toggle + address list |
| Withdraw Earnings | 2.6 | Web `/publisher/earnings` | Balance + withdraw |

### User/Viewer Flows (§3)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Browse & View Ads | 3.1 | Extension background + content | Automatic |
| Build Claims | 3.2 | Extension background | Automatic |
| Submit Claims (direct) | 3.3 | Extension Claims tab | "Submit All" button |
| Submit Claims (attested, P1) | 3.3a | Extension Claims tab | Default submit path |
| Sign for Relay | 3.4 | Extension Claims tab | "Sign for Relay" + POST |
| Withdraw Earnings | 3.5 | Extension Earnings tab | Balance + withdraw |
| Export/Import Claims | 3.6 | Extension Claims tab | Encrypted backup |

### Governance Flows (§4)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Vote on Campaign | 4.1 | Web `/governance/vote/:id` | Conviction form |
| Evaluate (Activation) | 4.2 | Web `/governance/evaluate/:id` | Condition checks |
| Evaluate (Termination) | 4.3 | Web `/governance/evaluate/:id` | Grace period + quorum |
| Evaluate (Resolve) | 4.4 | Web `/governance/evaluate/:id` | Post-completion |
| Withdraw Vote Stake | 4.5 | Web `/governance/my-votes` | Slash warning |
| Finalize Slash | 4.6 | Web `/governance/my-votes` | Pre-claim step |
| Claim Slash Reward | 4.7 | Web `/governance/my-votes` | Winner reward |

### Settlement Flows (§5)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Direct Settlement | 5.1 | Extension Claims tab | Via AttestationVerifier |
| Relay Settlement | 5.2 | Extension Claims tab (sign) | Publisher relay handles submission |

### Admin Flows (§6)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Timelock Propose/Execute/Cancel | 6.1 | Web `/admin/timelock` | Decoded proposals |
| Global Pause/Unpause | 6.2 | Web `/admin/pause` | Large status indicator |
| Blocklist Management | 6.3 | Web `/admin/blocklist` | Block/unblock addresses |
| Contract Reference Updates | 6.4 | Web `/admin/timelock` (via propose) | Requires timelock flow |
| Withdraw Protocol Fees | 6.5 | Web `/admin/protocol` | Owner-only withdrawal |

### Automated / Permissionless Flows (§7)

| Flow | ID | UI Location | Notes |
|------|----|------------|-------|
| Expire Pending Campaign | 7.1 | Web `/governance` (campaign list action) | Permissionless button |
| Sweep Slash Pool | 7.2 | Web `/governance/my-votes` or `/admin` | 365-day post-finalization |
| Sweep Budget Dust | 7.3 | Web `/admin` (or explorer) | Terminal campaigns only |
| Expire Inactive Campaign (P20) | 7.4 | Web `/governance` (campaign list action) | 30-day inactivity |

---

## 15. Implementation Phases

### Phase 1: Shared Library Extraction

**Goal:** Extract `@datum/shared` from alpha-extension so both targets can consume it.

**Tasks:**
1. Create `packages/shared/` workspace (or npm package)
2. Move all `src/shared/` files, update imports
3. Add missing contract helpers (BudgetLedger, PaymentVault, Lifecycle, AttestationVerifier)
4. Update `ContractAddresses` to include all 13 contracts
5. Extract `conviction.ts` and `blockTime.ts` from inline code
6. Verify extension still builds and all 140 Jest tests pass

### Phase 2: Extension Simplification

**Goal:** Strip extension popup down to 3 tabs (Earnings, Claims, Settings).

**Tasks:**
1. Remove `AdvertiserPanel.tsx`, `PublisherPanel.tsx`, `GovernancePanel.tsx`, `CampaignList.tsx` from popup
2. Simplify `App.tsx` — 3 tabs instead of 7
3. Rename `UserPanel` → `EarningsPanel`, simplify to PaymentVault balance + withdraw
4. Simplify `Settings.tsx` — remove publisher address, Pinata key sections
5. Update Claims tab to default to attested path (P1)
6. Fix relay gap (10.1): POST signed batches to relay after signing
7. Add `content/provider.ts` for `window.datum` injection
8. Verify extension builds, loads, all background functionality works

### Phase 3: Web App Scaffold

**Goal:** Basic web app with wallet connection and settings.

**Tasks:**
1. Create `web/` project with Vite + React + React Router
2. Implement `Layout.tsx` with sidebar navigation
3. Implement wallet connection (Extension provider → MetaMask → Manual)
4. Implement `Settings.tsx` (network, contracts, Pinata)
5. Implement shared components (AddressDisplay, DOTAmount, StatusBadge, TransactionStatus)

### Phase 4: Explorer (Public Views)

**Goal:** Anyone can browse protocol state without connecting a wallet.

**Tasks:**
1. Protocol Overview — aggregate stats
2. Campaign Browser — table with filters
3. Campaign Detail — full info + metadata + votes
4. Publisher Directory — registered publishers

### Phase 5: Advertiser Interface

**Goal:** Full campaign management.

**Tasks:**
1. Campaign Dashboard (my campaigns list)
2. Create Campaign form (with pre-checks: blocklist, allowlist, balance)
3. Set Metadata form (contentSafety validation + Pinata pin)
4. Campaign actions (pause/resume/complete)
5. Budget detail panel (BudgetLedger reads)
6. Spending analytics (event-based)

### Phase 6: Publisher Interface

**Goal:** Full publisher management.

**Tasks:**
1. Publisher Dashboard (status + earnings)
2. Registration form
3. Take rate management (queue + apply)
4. Category management (26-checkbox grid)
5. Allowlist management (toggle + address table)
6. Earnings + withdrawal
7. SDK setup guide + snippet generator
8. Relay setup documentation

### Phase 7: Governance Interface

**Goal:** Full governance participation.

**Tasks:**
1. Campaign voting dashboard (pending + active + resolved)
2. Vote form (conviction slider + amount)
3. Evaluate campaign (activation + termination + resolution)
4. My Votes (withdraw + slash claim)
5. Governance parameters display
6. Permissionless actions (expire inactive, expire pending)

### Phase 8: Admin Interface

**Goal:** Protocol administration.

**Tasks:**
1. Timelock dashboard (propose + execute + cancel + decoded display)
2. Pause registry control
3. Blocklist management
4. Protocol fee withdrawal
5. Contract wiring reference display

---

## Appendix: Alpha-Extension Component Line Counts (for reference)

| Component | Lines | Destination |
|-----------|-------|-------------|
| App.tsx | 892 | Extension (rewritten, ~300 lines) |
| Settings.tsx | 764 | Extension (simplified, ~400 lines) + Web Settings |
| GovernancePanel.tsx | ~800 | Web `/governance/*` |
| AdvertiserPanel.tsx | ~700 | Web `/advertiser/*` |
| PublisherPanel.tsx | ~600 | Web `/publisher/*` |
| CampaignList.tsx | ~400 | Web `/explorer/campaigns` |
| ClaimQueue.tsx | ~500 | Extension Claims tab (simplified, ~350 lines) |
| UserPanel.tsx | ~300 | Extension Earnings tab (~200 lines) |
| background/index.ts | ~1200 | Extension (unchanged) |
| content/index.ts | ~400 | Extension (unchanged) |
| shared/* | ~3000 | `@datum/shared` package |

**Estimated total:**
- Extension popup: ~950 lines (down from ~4,500)
- Extension background + content: ~2,800 lines (unchanged)
- Shared library: ~3,500 lines (extracted + new)
- Web app: ~5,000-7,000 lines (new)


---

## Backlog

Items deferred post-alpha, not yet scheduled.

### BL-1: Claim Submit CAPTCHA

**Goal:** Bot-resistance layer before a user's engagement claim enters the settlement pipeline.

**Concept:** Before the extension or web app submits a claim batch, require the user to solve a lightweight challenge that proves human engagement. This pairs with the existing quality score (dwell, viewability, etc.) to add a second anti-fraud layer.

**Options under consideration:**
- **Proof-of-work CAPTCHA** — client-side hash puzzle (no third-party, preserves privacy). Difficulty tunable per campaign CPM.
- **Publisher-hosted CAPTCHA** — relay endpoint returns a challenge token after CAPTCHA pass; token included in attested batch.
- **On-chain nonce commitment** — user commits a nonce pre-view, reveals post-view; prevents replay without CAPTCHA service.

**Blocks:** Requires relay endpoint changes + attestation schema extension. Coordinate with P1 attestation flow.

**UI surface:** Small modal/overlay in extension adSlot at claim-submit time, or inline on web claims page.

---

### BL-2: ZK Proof Integration (Groth16 / BN128)

**Goal:** Replace the stub `zkProofStub.ts` (which submits `0x01` + behaviorCommit) with a real Groth16 circuit proving claim validity without revealing raw engagement data.

**Current state:** `DatumZKVerifier.verify(proof, hash)` is a stub (`proof.length > 0`). ZK verification was removed from `DatumSettlement` in alpha-2 to save PVM bytes. Planned for post-alpha via separate verifier or relay.

**Required work:**
1. Design circuit: inputs = (campaignId, publisher, user, nonce, engagementScore); public output = claimHash.
2. Trusted setup (Powers of Tau + campaign-specific).
3. `DatumZKVerifier` — real Groth16 verifier using BN128 pairing precompile (P9). Confirm BN128 precompile availability on Polkadot Hub.
4. Re-integrate ZK check into `DatumSettlement` (or `DatumAttestationVerifier`) — Settlement currently has ~1,100 B PVM spare; may need further size reduction or satellite contract.
5. Extension `zkProofStub.ts` → real proof generation (snarkjs / circom WASM in service worker).
6. Web app claim submission page — show proof generation progress, allow export of proof for manual submission.

**UI surface:** Web `/claims/submit` page + extension Claims tab proof generation indicator.

**Blocks:** BN128 precompile confirmation on PolkaVM, circuit design, trusted setup ceremony.
