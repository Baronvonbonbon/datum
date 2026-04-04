# DATUM

**Decentralized Ad Targeting Utility Marketplace**

An experiment in building an automated, privacy-preserving ad exchange on Polkadot Hub using pallet-revive (PolkaVM). DATUM explores the feasibility of on-chain programmatic advertising where users are directly compensated in DOT for their attention, no personal data leaves the user's device, and advertisers receive cryptographic assurance that impressions are real.

## Motivation

The digital advertising industry is built on surveillance. Users are tracked across the web, their behavior profiled and sold, while receiving nothing in return. Ad fraud costs advertisers billions annually, and publishers depend on opaque intermediaries that extract most of the value.

DATUM asks: what if the economics worked differently?

- **Users** earn DOT for viewing ads. Their browsing data stays on their device. The only information that leaves is a cryptographic attestation that they participated in an ad campaign.
- **Advertisers** get verifiable impressions backed by hash-chain proofs, settled transparently on-chain with no intermediary markup.
- **Publishers** embed a lightweight SDK on their sites, set their own take rates and content tags, and receive payment directly through smart contract settlement.

## How it works

1. **Advertisers** create campaigns by depositing DOT into DatumCampaigns, specifying a bid CPM and targeting tags. Campaigns can target a specific publisher or be **open** (any matching publisher can serve them).
2. **Governance reviewers** stake DOT to vote on campaign quality with conviction multipliers (0-8x). Campaigns activate when aye votes cross a majority threshold with quorum; nay votes can terminate bad campaigns. Losing-side voters pay a symmetric slash (10% of stake), distributed to winning-side voters.
3. **Publishers** embed the DATUM SDK (`<script src="datum-sdk.js">`) on their sites, declaring targeting tags and providing a `<div id="datum-ad-slot">` placement. The SDK performs a challenge-response handshake with the extension for two-party impression attestation.
4. **Users** browse the web with the DATUM Chrome extension. The extension detects the SDK, filters campaigns by tag overlap, runs a second-price auction, and records impressions as hash-chain claims — all on-device. When no campaigns match, a default house ad appears.
5. **Settlement** happens when claims are submitted on-chain. The contract validates the hash chain, deducts from campaign budget, and splits payment three ways: publisher (configurable 30-80%), user (75% of remainder), and protocol (25% of remainder).
6. **Reputation** tracks publisher settlement acceptance rates (BM-8) and detects per-campaign anomalies (BM-9). A relay bot EOA is the approved reporter; after each settlement batch it records settled/rejected counts per publisher+campaign pair.

No ad server. No tracking pixels. No user profiles leaving the browser.

---

## Walkthrough — Alice, Bob, Carol, Dave, and Eve

Five people use DATUM. **Alice** is a user who browses the web. **Bob** publishes a tech blog. **Carol** is an advertiser selling hardware wallets. **Dave** reviews campaigns as a governance voter. **Eve** runs a relay bot.

### Step 1 — Bob registers as a publisher and sets up the SDK

Bob opens the DATUM web app, goes to the **Publisher** section, and registers his address on DatumPublishers. He sets his take rate at 40% (capped 30–80%). He configures a **relay signer** — an EOA (Eve's bot address) that can co-sign attestations on his behalf so users can pay zero gas. He sets an optional **profile hash** pointing to IPFS metadata describing his site.

Bob then sets his **targeting tags** via `DatumTargetingRegistry.setTags()`. Tags are `bytes32` hashes (`keccak256("topic:technology")`), up to 32 per publisher.

Finally, Bob embeds the SDK on his site:

```html
<script src="datum-sdk.js" data-publisher="0xBob..."></script>
<div id="datum-ad-slot"></div>
```

### Step 2 — Carol creates a campaign

Carol opens the **Advertiser** section and creates a campaign via `DatumCampaigns.createCampaign()`:
- Deposits **10 DOT** as escrow budget (held in DatumBudgetLedger)
- Sets a daily cap of **1 DOT**
- Bids **0.05 DOT per 1000 impressions** (maximum CPM)
- Toggles **Open Campaign** — `publisher = address(0)` — any matching publisher can serve it
- Sets required tags (e.g. `topic:technology`) — up to 8, AND-logic matched against publisher tags
- Fills out ad creative: title, body, CTA, landing URL
- Pins metadata to IPFS; stores hash via `Campaigns.setMetadata()`

The campaign goes on-chain with status **Pending**. Carol's budget is locked.

### Step 3 — Dave votes to activate the campaign

Dave opens the **Governance** section. He sees Carol's campaign and votes **Aye** via `GovernanceV2.vote(campaignId, true, conviction)`, staking 0.5 DOT at conviction level 2 (4× weight multiplier, 3-day lockup → 2.0 DOT effective weight). Other voters stack up. Once weighted votes exceed the quorum (100 DOT) and aye > 50%, anyone calls **`evaluateCampaign`** — campaign moves to **Active**.

If nay had won: campaign **Terminated**, 90% of Carol's budget refunded, 10% slashed to nay voters. Losing voters always pay 10% of their stake.

### Step 4 — Alice browses Bob's site and sees an ad

Alice visits Bob's tech blog. The DATUM content script (entirely in-browser):

1. **Detects the Publisher SDK** — reads Bob's publisher address from the embed tag.
2. **Classifies the page** against targeting tags using domain, title, and meta signals.
3. **Filters campaigns** — Carol's open campaign requires `topic:technology`; Bob's tags include it. Eligible.
4. **Runs a second-price auction** — highest effective bid wins but pays second-highest price. Solo campaigns pay 70% of bid CPM.
5. **Performs a handshake** — extension sends a challenge via `CustomEvent`; SDK responds with a publisher co-signature, creating a two-party attestation.
6. **Injects the ad** — Carol's creative renders in Bob's `<div id="datum-ad-slot">` via Shadow DOM. If no SDK slot exists, overlay at bottom-right. If no campaigns matched, house ad appears.
7. **Tracks engagement** — IntersectionObserver measures dwell time, tab focus, scroll depth, IAB viewability. Low-quality views (< 1 second, unfocused) are dropped.
8. **Builds a hash-chain claim** — if engagement score ≥ 0.3, computes `blake2b(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousClaimHash)` and queues locally.

### Step 5 — Claims are submitted on-chain

Alice can submit claims directly via `Settlement.settleClaims()` (she pays gas) or co-sign them for Eve's relay bot to submit via `AttestationVerifier.settleClaimsAttested()` (publisher pays gas, Alice pays nothing). Auto-submit mode submits every few minutes using a session-encrypted key.

Settlement validates the hash chain, deducts from Carol's budget, and distributes:

```
Total:           0.05 DOT per 1000 impressions (clearing CPM)
Bob (40%):       0.020 DOT / 1000 views
Alice (75%×60%): 0.0225 DOT / 1000 views
Protocol (25%×60%): 0.0075 DOT / 1000 views
```

Balances accumulate as pull-payment entries in DatumPaymentVault.

### Step 6 — Eve's relay bot records reputation stats (BM-8)

After each batch Eve's relay bot submits, it parses the `ClaimSettled` and `ClaimRejected` events. For each unique `(publisher, campaignId)` pair, it aggregates settled and rejected counts, then calls `DatumPublisherReputation.recordSettlement(publisher, campaignId, settled, rejected)`. Eve's EOA is an approved reporter (added by admin via `addReporter()`).

The contract tracks global and per-campaign stats. Score = `settled / (settled + rejected) × 10000` bps. If a publisher's campaign rejection rate exceeds 2× their global rate and the sample is ≥ 10, `isAnomaly()` returns true (BM-9 cross-campaign anomaly detection).

### Step 7 — Everyone withdraws

- Bob calls `PaymentVault.withdrawPublisher()` from the Publisher section.
- Alice calls `PaymentVault.withdrawUser()` from the extension Earnings tab.
- Dave withdraws governance stake via `GovernanceV2.withdrawStake()` after lockup expires. If he voted on the winning side, full stake back. Losing side: -10%.
- Carol completes the campaign via `CampaignLifecycle.completeCampaign()` to reclaim any remaining budget, or it drains naturally via settlement.

---

## System Flow Analysis by Role

### Role 1 — User (Alice)

**What they do:** View ads, build hash-chain claims in-extension, submit settlement transactions.

| Phase | Component | Function / Action |
|-------|-----------|-------------------|
| Page visit | Extension content script | Page classification, SDK detection |
| Campaign matching | Extension background | `campaignPoller` — loads active campaigns via `CampaignCreated` events; matches by tag overlap and status |
| Auction | Extension background | Vickrey second-price auction across matching campaigns |
| Handshake | Content ↔ SDK | `CustomEvent('datum-challenge')` / `datum-response` — two-party attestation |
| Engagement | Content script | IntersectionObserver + focus tracking; score ≥ 0.3 to qualify |
| Claim build | Extension offscreen | `blake2b(campaignId, publisher, user, impressionCount, clearingCpm, nonce, prevHash)` |
| Settlement (self) | Settlement | `settleClaims(SignedBatch)` → validates chain, deducts budget, pays vault |
| Settlement (relayed) | AttestationVerifier | `settleClaimsAttested(batch, publisherSig)` → publisher co-signs, user pays nothing |
| Earnings | PaymentVault | `withdrawUser()` — pull payment, any time |
| Claim export | Extension | Encrypted `.dat` export/import (P6) |

**Events fired on settlement:**
- `ClaimSettled(campaignId, publisher, user, nonce, impressionCount, clearingCpm, amount)`
- `ClaimRejected(campaignId, nonce, reason)` — reason codes 0-17

---

### Role 2 — Advertiser (Carol)

**What they do:** Create and manage campaigns, set budgets and targeting, monitor analytics.

| Phase | Component | Function / Action |
|-------|-----------|-------------------|
| Campaign creation | Campaigns | `createCampaign(advertiser, publisher, budget, bidCpm, dailyCap, requiredTags, categoryId, requireZkProof)` |
| Budget deposit | BudgetLedger | Called internally by Campaigns; escrows DOT |
| Metadata | Campaigns | `setMetadata(campaignId, ipfsHash)` — ad creative (title, body, CTA, URL) |
| Daily cap update | BudgetLedger | `setDailyBudgetCap(campaignId, newCap)` — adjustable while active |
| Campaign completion | CampaignLifecycle | `completeCampaign(campaignId)` — refunds remaining budget |
| Analytics | Explorer events | Reads `ClaimSettled` events for impression counts, spend, CPM trends |
| Campaign list | Campaigns | `getCampaign(id)`, `getCampaignStatus(id)`, `getCampaignForSettlement(id)` |

**Events fired:**
- `CampaignCreated(campaignId, advertiser, publisher, budget, bidCpm, dailyCap, requiredTags)`
- `CampaignCompleted(campaignId, refundAmount)` on completion/expiry

**Targeting validation:** `CampaignValidator.validateCreation(advertiser, publisher, requiredTags)` is called atomically during `createCampaign()`. Validates publisher is registered, tags are valid, take rate is within bounds.

---

### Role 3 — Publisher (Bob, Diana)

**What they do:** Register, configure targeting and rate, run the relay bot, earn from impressions.

| Phase | Component | Function / Action |
|-------|-----------|-------------------|
| Registration | Publishers | `register()` — marks address as registered publisher |
| Take rate | Publishers | `setTakeRate(bps)` — 3000-8000 bps (30-80%), delayed change |
| Relay signer | Publishers | `setRelaySigner(addr)` — EOA that can co-sign attestations |
| Profile | Publishers | `setProfile(ipfsHash)` — publisher metadata (name, URL, description) |
| Tags | TargetingRegistry | `setTags(bytes32[])` — up to 32 tags per publisher |
| Allowlist | Publishers | `addToAllowlist(addr)` / `removeFromAllowlist(addr)` — restrict which advertisers can target |
| SDK embed | Browser | `<script data-publisher="0x...">` + `<div id="datum-ad-slot">` |
| Relay: batch submit | Relay | `settleClaimsFor(batches, pubSig)` — publisher pays gas, users pay nothing |
| Relay: co-signed | AttestationVerifier | `settleClaimsAttested(batch, publisherSig)` — EIP-712 co-signature |
| Earnings | PaymentVault | `withdrawPublisher()` — pull payment |
| Snapshot | Campaigns | `getCampaignRelaySigner(id)`, `getCampaignPublisherTags(id)` — immutable snapshots from creation time |

**Key constraint:** Take rate changes trigger a delay (anti-gaming). The rate snapshot stored in Campaigns at creation time is what settlement uses — mid-campaign rate changes don't affect existing campaigns.

---

### Role 4 — Governance Voter (Dave)

**What they do:** Review campaign quality, stake DOT with conviction, activate or terminate campaigns.

| Phase | Component | Function / Action |
|-------|-----------|-------------------|
| View pending | GovernanceV2 | Reads `CampaignCreated` events, filters by status=Pending |
| Cast vote | GovernanceV2 | `vote(campaignId, aye, conviction)` payable — transfers stake |
| Evaluate | GovernanceV2 | `evaluateCampaign(campaignId)` — if quorum met: Activate or Terminate |
| Slash finalization | GovernanceSlash | `finalizeSlash(campaignId)` — distributes 10% of losing-side stake to winners |
| Claim reward | GovernanceSlash | `claimReward(campaignId)` — winning voter collects share |
| Withdraw stake | GovernanceV2 | `withdrawStake(campaignId)` — after lockup period expires |
| My votes | GovernanceV2 | `getVote(campaignId, voter)` — view lockup, weight, side |
| Parameters | GovernanceV2 | `quorum()`, `slashBps()`, `terminationQuorum()`, conviction weights (hardcoded [1,2,3,4,6,9,14,18,21]) |

**Conviction lockups (blocks at 6s/block):**
- 0: no lockup, 1× weight
- 1: 14,400 blocks (~1 day), 2×
- 2: 43,200 blocks (~3 days), 3×
- 3: 100,800 blocks (~7 days), 4×
- 4: 302,400 blocks (~21 days), 6×
- 5: 1,296,000 blocks (~90 days), 9×
- 6: 2,592,000 blocks (~180 days), 14×
- 7: 3,888,000 blocks (~270 days), 18×
- 8: 5,256,000 blocks (~365 days), 21×

**Events:** `VoteCast(campaignId, voter, aye, amount, conviction)`, `CampaignActivated(campaignId)`, `CampaignTerminated(campaignId)`

---

### Role 5 — Protocol Admin (Alice EOA / Timelock)

**What they do:** Configure protocol parameters, manage emergency pause, enforce blocklist, sweep fees.

Most admin actions route through DatumTimelock (48h delay). Emergency pause is direct.

| Action | Contract | Function |
|--------|----------|----------|
| Emergency pause | PauseRegistry | `pause()` / `unpause()` — affects all `whenNotPaused` guarded functions |
| Propose timelock action | Timelock | `propose(target, data)` — queues a call with 48h delay |
| Execute timelock | Timelock | `execute(target, data)` — after delay elapses |
| Block address (S12) | Publishers | `blockAddress(addr)` — routes via Timelock; blocks from settlement |
| Unblock address | Publishers | `unblockAddress(addr)` — routes via Timelock |
| Blocklist check | Publishers | `isBlocked(addr)` — read-only; Settlement staticcalls this per-batch |
| Rate limiter config | RateLimiter | `setWindowParams(windowSize, maxImpressions)` — BM-5 per-publisher window cap |
| Wire rate limiter | Settlement | `setRateLimiter(addr)` — address(0) disables |
| Protocol fee config | BudgetLedger | `setProtocolFeeBps(bps)` |
| Drain fraction config | BudgetLedger | `setDrainFraction(bps)` |
| Sweep protocol fees | PaymentVault | `sweepProtocolFees(to)` |
| Sweep slash pool | GovernanceSlash | `sweepSlashPool(campaignId)` — reclaims unclaimed rewards after 365d |
| Add reputation reporter | Reputation | `addReporter(addr)` — approves EOA to call recordSettlement |
| Remove reporter | Reputation | `removeReporter(addr)` |
| ZK verifier | ClaimValidator | `setZKVerifier(addr)` — swap stub for real Groth16 verifier |
| Governance wiring | GovernanceV2 | `setSlashContract(addr)`, `setHelper(addr)` |

**Ownership model:** Campaigns and Settlement are owned by Timelock. Publishers is owned by Timelock. Most other contracts are owned by the deployer EOA. Ownership transfers are done in `deploy.ts`.

---

### Role 6 — Reporter / Relay Bot (Eve)

**What they do:** Submit settlement batches on behalf of publishers, record reputation stats after each batch.

| Phase | Component | Function / Action |
|-------|-----------|-------------------|
| Serve challenges | Relay bot HTTP | `GET /relay/challenge` — returns nonce + expiry |
| Receive batches | Relay bot HTTP | `POST /relay/submit` — accepts signed claim batches from extension |
| Co-sign claims | AttestationVerifier | EIP-712 sign over batch hash with publisher's relay signer key |
| Submit batch | Relay / AttestationVerifier | `settleClaimsFor()` or `settleClaimsAttested()` |
| Parse events | relay-bot.mjs | Reads `ClaimSettled` (has `publisher` arg) and `ClaimRejected` (nonce-keyed to pre-built map) from receipt logs |
| Aggregate stats | relay-bot.mjs | Sums `(settled, rejected)` per unique `(publisher, campaignId)` pair |
| Record reputation | Reputation | `recordSettlement(publisher, campaignId, settled, rejected)` — one call per unique pair |
| Check reporter | Reputation | `reporters(addr)` — admin can verify bot is approved |

**Reputation contract state after `recordSettlement`:**
- `getPublisherStats(publisher)` → `(settled, rejected, score)` — global across all campaigns
- `getCampaignStats(publisher, campaignId)` → `(settled, rejected)` — per campaign
- `isAnomaly(publisher, campaignId)` → `bool` — true if campaign rejection rate > 2× global rate and sample ≥ 10

---

## Full Settlement Flow

```
[Alice Extension]
   build hash-chain claim
       ↓ (auto-submit or manual)
[AttestationVerifier.settleClaimsAttested(batch, pubSig)]
       ↓
[DatumClaimValidator._validateBatch()]
   ├─ check chain continuity (nonces, prevHash)
   ├─ check campaign status (via Campaigns staticcall)
   ├─ check publisher match
   ├─ check clearing CPM ≤ bid CPM
   ├─ check impression count ≤ 100,000 (HIGH fix)
   ├─ check S12 blocklist (Publishers staticcall)
   ├─ check BM-2 per-user impression cap
   ├─ check BM-5 rate limiter (RateLimiter staticcall)
   ├─ check BM-7 allowlist
   └─ check ZK proof if requireZkProof=true
       ↓ (settled claims only)
[DatumBudgetLedger.deductSettlement(campaignId, amount)]
   ├─ check daily cap
   └─ deduct from campaign escrow
       ↓
[DatumPaymentVault.credit(publisher, user, protocol, amounts)]
   ├─ publisher balance += snapshotTakeRate%
   ├─ user balance += 75% of remainder
   └─ protocol balance += 25% of remainder
       ↓
Events: ClaimSettled / ClaimRejected per claim
       ↓
[Eve relay-bot: parse events]
   build (publisher, campaignId) → (settled, rejected) map
       ↓
[DatumPublisherReputation.recordSettlement(publisher, campaignId, s, r)]
   update global + per-campaign stats
   (anomaly check available via isAnomaly())
```

---

## Architecture

### Smart Contracts (20 contracts, Solidity on PolkaVM)

| Group | Contract | Role |
|-------|----------|------|
| Infrastructure | `DatumZKVerifier` | Stub ZK proof verifier (real Groth16 post-alpha, BN128 precompile required) |
| Infrastructure | `DatumPauseRegistry` | Global emergency pause circuit breaker (`whenNotPaused`) |
| Infrastructure | `DatumTimelock` | Single-slot admin delay (48h) for sensitive config changes |
| Infrastructure | `DatumPaymentVault` | Pull-payment vault: publisher, user, protocol balances |
| Campaign | `DatumBudgetLedger` | Campaign escrow, daily caps, settlement deduction tracking |
| Campaign | `DatumTargetingRegistry` | Tag registry (bytes32 hashes, AND-logic, up to 32/publisher, 8/campaign) |
| Campaign | `DatumCampaignValidator` | Creation-time validation satellite (publisher check, tag validation, take rate) |
| Campaign | `DatumCampaigns` | Campaign creation, metadata, status management, relay signer snapshots |
| Campaign | `DatumCampaignLifecycle` | complete / terminate / expire + P20 inactivity timeout (30d) |
| Settlement | `DatumClaimValidator` | Claim validation satellite: chain continuity, budget, blocklist, rate-limit, ZK |
| Settlement | `DatumSettlement` | Main entry: hash-chain validation, 3-way payment split via PaymentVault |
| Settlement | `DatumSettlementRateLimiter` | BM-5: window-based per-publisher impression cap (optional, address(0) = disabled) |
| Settlement | `DatumAttestationVerifier` | P1: EIP-712 mandatory publisher co-signature for all campaign settlements |
| Publisher | `DatumPublishers` | Registration, take rates, relay signer, profile, S12 blocklist, allowlists |
| Publisher | `DatumRelay` | EIP-712 gasless relay: publisher submits batches on behalf of users |
| Governance | `DatumGovernanceV2` | Conviction voting (9 levels, 0-8), symmetric slash, escalating lockups |
| Governance | `DatumGovernanceHelper` | Read-only aggregation: slash computation, dust guard, batch queries |
| Governance | `DatumGovernanceSlash` | Per-campaign slash pool finalization, winner reward distribution, 365d sweep |
| Satellites | `DatumReports` | Community reporting: `reportPage(campaignId, reason)`, `reportAd(campaignId, reason)`. Reasons 1-5. |
| Satellites | `DatumPublisherReputation` | BM-8/BM-9: per-publisher settlement acceptance rate + cross-campaign anomaly detection |

All contracts compile to PolkaVM (RISC-V) bytecode using resolc v1.0.0, optimizer mode `z`. 219/219 tests passing on Hardhat EVM. 19 of 20 deployed on Paseo (DatumPublisherReputation deploy pending).

### Browser Extension — `alpha-3/extension/`

4-tab popup (Claims, Earnings, Settings, Filters), 20-contract support, Blake2-256 claim hashing, mandatory publisher attestation (P1), event-driven campaign polling with O(1) lookups, EIP-1193 provider bridge (`window.datum`). 165/165 Jest tests.

Key capabilities: Vickrey auction, engagement tracking, Blake2 hash-chain claims, IPFS multi-gateway (5 gateways with fallback), Shadow DOM ad injection, phishing list, content safety, AES-256-GCM multi-account wallet, auto-submit (B1), claim export (P6), timelock monitor (H2), relay POST, in-ad dismiss (✕ with popover), tag-based campaign filtering (allow/block topics).

### Web App — `web/`

React 18 + Vite 6 + TypeScript + ethers v6. 28 pages across 6 sections. 0 TS errors. 20-contract support.

| Section | Pages | Coverage |
|---------|-------|----------|
| Explorer (4) | Overview, Campaigns, CampaignDetail, Publishers | Browse without wallet; view live campaign stats, settlements, publisher list |
| Advertiser (5) | Dashboard, CreateCampaign, CampaignDetail, SetMetadata, Analytics | Full campaign lifecycle + earnings analytics with graph |
| Publisher (8) | Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile | Full publisher config + earnings + SDK embed guide + profile hash |
| Governance (4) | Dashboard, Vote, MyVotes, Parameters | Conviction voting, slash finalize, withdraw stake, protocol params |
| Admin (6) | Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation | Hidden from nav; all admin functions including BM-5 + BM-8/9 |
| Settings (1) | Settings | Network, RPC, 20 contract addresses, IPFS pinning config |

### Publisher SDK — `sdk/`

Lightweight JS tag (~3 KB). `<script data-publisher="0x...">` + `<div id="datum-ad-slot">`. Challenge-response handshake with extension, returns publisher co-signature for attestation path.

### Publisher Relay — `relay-bot/` (gitignored)

Live systemd service on localhost:3400. HTTP endpoints for challenge/submit. Co-signs attestations, submits batches via `DatumRelay.settleClaimsFor()` or `AttestationVerifier.settleClaimsAttested()`. Blake2-256 claim hashing. After each batch: parses ClaimSettled/ClaimRejected events, calls `DatumPublisherReputation.recordSettlement()` per unique (publisher, campaignId) pair (BM-8/BM-9).

### Demo Page — `docs/`

`index.html` with inline ad slot pointing to Diana's publisher address. `datum-sdk.js` copy. `relay-bot-template/` reference for external publishers.

---

## Repository Layout

```
alpha-3/              Canonical contracts (20), tests (219), extension (165 tests)
  contracts/          Solidity source (20 contracts + interfaces + mocks)
  test/               Hardhat test suite (219 tests, Hardhat EVM)
  extension/          Browser extension (4 tabs, 165 Jest tests, Blake2, P1, filters)
  scripts/            deploy.ts (20-contract), setup-testnet.ts
  hardhat.config.ts   Networks: hardhat, substrate (local Docker), polkadotTestnet, polkadotHub
  deployed-addresses.json   Live Paseo v4 addresses (19/20 deployed 2026-04-04)

web/                  Web app (React + Vite, 28 pages, 20-contract)
  src/pages/          Explorer, Advertiser (5), Publisher (8), Governance, Admin (6), Settings
  src/shared/         ABIs (20), types, networks, conviction curve, error codes
  src/components/     Layout, TransactionStatus, shared UI
  src/context/        WalletContext, SettingsContext

sdk/                  Publisher SDK (datum-sdk.js + example)
docs/                 Demo page + relay template
archive/              PoC, alpha (9-contract), alpha-2 (13-contract), alpha extension

STATUS.md             Current project status + critical path
BACKLOG.md            Bugs, issues, missing features tracker
SECURITY-AUDIT.md     3-part audit with fix status tracker
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Docker (for local substrate devchain)
- Chrome (extension has an embedded wallet — no external wallet extension required)

### Contracts

```bash
cd alpha-3
npm install

# Run tests (Hardhat EVM)
npx hardhat test             # 219/219 pass

# Compile for PolkaVM
npx hardhat compile --network polkadotHub   # requires resolc v1.0.0
```

### Web App

```bash
cd web
npm install
npm run dev                  # Vite dev server
npm run build                # Production build (dist/)
npx tsc --noEmit             # TypeScript validation
```

### Extension

```bash
cd alpha-3/extension
npm install
npm run build                # 0 webpack errors
# Load dist/ as unpacked extension in chrome://extensions
```

### Local Devchain

```bash
cd alpha-3

# Start substrate node + eth-rpc adapter (Docker)
docker compose up -d

# Deploy 20 contracts with full wiring + ownership transfer
npx hardhat run scripts/deploy.ts --network substrate

# Post-deploy setup (fund accounts, register publishers, create test campaign)
npx hardhat run scripts/setup-testnet.ts --network substrate
```

**Devchain notes:** Pallet-revive gas is in weight units (~10^15). The eth-rpc denomination rounding rule rejects transfers where `value % 10^6 >= 500_000` — use clean multiples of 10^6 planck. `getTransactionReceipt` returns null for confirmed txs on Paseo; deploy/setup scripts use nonce polling + `getCreateAddress` workaround.

### Paseo Testnet (live)

All 20 alpha-3 contracts are deployed on Paseo (Chain ID 420420417).

| Resource | URL |
|----------|-----|
| Web App | https://datum.javcon.io |
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | `https://blockscout-testnet.polkadot.io/` |
| Faucet | `https://faucet.polkadot.io/` (select "Paseo") |

Contract addresses are in `alpha-3/deployed-addresses.json`. Deployment details in `STATUS.md`.

```bash
cd alpha-3
export DEPLOYER_PRIVATE_KEY="0x..."

# Deploy 20 contracts + wire + ownership transfer
npx hardhat run scripts/deploy.ts --network polkadotTestnet

# Fund accounts, register publishers, create test campaign, wire reputation reporter
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

---

## Status

See [STATUS.md](STATUS.md) for detailed project status and critical path.

- [x] **PoC** — 7 contracts, 64/64 tests (archived)
- [x] **Alpha** — 9 contracts deployed on Paseo, 132/132 tests (archived)
- [x] **Alpha-2** — 13 contracts, 187/187 tests, extension 165/165, Paseo deploy (archived)
- [x] **Alpha-3 contracts** — 20 contracts: TargetingRegistry, CampaignValidator, ClaimValidator, GovernanceHelper, Reports, RateLimiter, PublisherReputation
- [x] **Extension (alpha-3)** — 165/165 tests, 20-contract, event-driven polling, O(1) lookups, 4-tab popup (Filters tab), in-ad dismiss
- [x] **Web app** — 28 pages, React + Vite, 20-contract support
- [x] **Publisher SDK + relay** — SDK embed tag, relay bot with BM-8/BM-9 reputation recording
- [x] **Paseo testnet** — all 20 alpha-3 contracts deployed (v4, 2026-04-04)
- [x] **Blake2 hash migration** — extension + relay both use `@noble/hashes/blake2.js`, matches Settlement on PolkaVM
- [x] **Security audit (CRITICAL/HIGH)** — C-1, C-2, H-1, H-2, H-3, S4, S6, T1-T3 all fixed
- [x] **BM-5 rate limiter** — DatumSettlementRateLimiter deployed + wired
- [x] **BM-8/BM-9 reputation** — DatumPublisherReputation implemented; relay bot wired; web admin UI at /admin/reputation; deploy pending
- [ ] **E2E browser validation** — full flow on Paseo with extension + relay + web app (re-seed with setup-testnet.ts first)
- [ ] **Open testing** — publish addresses, external tester flow
- [ ] **Mainnet** — Kusama → Polkadot Hub

---

## Why PolkaVM

DATUM targets Polkadot Hub via pallet-revive rather than an EVM chain:

- **Native DOT settlement** — campaign escrow, governance stakes, and payments are all in native DOT with no bridges or wrapped tokens
- **Shared security** — contracts execute on Polkadot Hub directly, inheriting relay chain security
- **XCM interoperability** — future cross-chain features (fee routing, cross-chain governance) become native XCM calls
- **Ecosystem alignment** — Polkadot identity primitives, OpenGov tooling, and treasury funding are directly accessible

The tradeoffs are real: resolc produces 10-20x larger bytecode than solc (some alpha-3 contracts exceed the 49,152 B nominal limit but deploy fine on Paseo), cross-contract calls are more expensive, and the toolchain is maturing. The Solidity source is portable — if pallet-revive doesn't mature, deployment to an EVM parachain remains viable.

---

## Known Limitations

- **Daily cap timestamp:** `DatumCampaigns` uses `block.timestamp / 86400`. Block validators can manipulate ±15 seconds, negligible relative to 86,400-second daily period (<0.02% error).
- **Unclaimed slash rewards:** `GovernanceSlash.sweepSlashPool()` reclaims unclaimed rewards after 365 days (M4 — implemented).
- **Denomination rounding:** The pallet-revive eth-rpc adapter rejects transfers where `value % 10^6 >= 500_000`. All on-chain payment amounts must be clean multiples of 10^6 planck.
- **PVM size limit:** The nominal 49,152 B limit is not enforced on Paseo testnet. GovernanceV2 deploys at ~57 KB. May be enforced on mainnet.
- **Open-campaign attestation trust (medium):** For open campaigns (`publisher = address(0)`), AttestationVerifier trusts `claims[0].publisher` as the signer identity. Post-alpha: validate against TargetingRegistry.
- **Reputation reporter centralization:** Only approved EOAs (relay bot) can call `recordSettlement`. Single point of failure if relay bot is offline. Post-alpha: multi-reporter quorum or decentralized reporting.

---

## Deferred (Explicitly Out of Scope for Alpha)

| Item | Status |
|------|--------|
| ZK proof of auction/engagement | Stub verifier deployed; real Groth16 requires BN128 pairing precompile (P9) |
| Decentralized KYB identity | Permissionless for alpha; evaluating zkMe and Polkadot PoP for beta (P10) |
| HydraDX XCM fee routing | Protocol fees accumulate in contract; XCM routing post-alpha (P11) |
| External wallet integration | Multi-account embedded wallet; WalletConnect v2 post-alpha (P17) |
| ~~Multi-publisher campaigns~~ | **Done** — open campaigns (`publisher = address(0)`) allow any matching publisher (P5) |
| Contract upgrade path | Non-upgradeable; UUPS proxy or migration for beta (P7) |
| ~~Mandatory publisher attestation~~ | **Done** — `DatumAttestationVerifier` enforces EIP-712 publisher co-sig for all campaigns (P1) |
| Rich media ad rendering | Text creatives with IPFS metadata; image/video post-alpha |
| ~~Tag-based targeting~~ | **Done** — `DatumTargetingRegistry` with bytes32 tag hashes, AND-logic (TX-1) |
| ~~Bot mitigation rate limiter~~ | **Done** — `DatumSettlementRateLimiter` window-based per-publisher cap (BM-5) |
| ~~Publisher reputation scoring~~ | **Done** — `DatumPublisherReputation` BM-8/BM-9; deploy pending |
| S12 governance-managed blocklist | Hybrid admin-emergency + governance-override — post-alpha contract change |
| BM-3 relay PoW challenge | Server-side PoW; no contract change needed — planned next |
| BM-6 viewability dispute window | Requires 7-day governance design — deferred |

---

## License

Apache-2.0
