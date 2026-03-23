# DATUM Alpha-2 — Complete Process Flows

**Date:** 2026-03-23
**Contracts:** 12 (alpha-2), compared against 9 (alpha)

---

## Table of Contents

1. [Advertiser Flows](#1-advertiser-flows)
2. [Publisher Flows](#2-publisher-flows)
3. [User (Viewer) Flows](#3-user-viewer-flows)
4. [Governance Participation Flows](#4-governance-participation-flows)
5. [Settlement & Claim Flows](#5-settlement--claim-flows)
6. [Admin / Owner Flows](#6-admin--owner-flows)
7. [Automated / Permissionless Flows](#7-automated--permissionless-flows)
8. [Payment Flow Summary](#8-payment-flow-summary)
9. [Alpha vs Alpha-2 Comparison](#9-alpha-vs-alpha-2-comparison)
10. [Missing & Unresolved Flows](#10-missing--unresolved-flows)

---

## 1. Advertiser Flows

### 1.1 Create Campaign

**Contracts:** DatumCampaigns → DatumPublishers (read) → DatumBudgetLedger (escrow)

1. Advertiser calls `DatumCampaigns.createCampaign(publisher, dailyCapPlanck, bidCpmPlanck, categoryId)` with DOT as `msg.value`
2. Pause check via `pauseRegistry.paused()`
3. S12 blocklist check: `publishers.isBlocked(msg.sender)` — revert E62 if blocked
4. If `publisher != address(0)` (targeted campaign):
   - S12 blocklist check: `publishers.isBlocked(publisher)` — revert E62
   - Fetch publisher: `publishers.getPublisher(publisher)` — revert E17 if not registered
   - Snapshot `takeRateBps` from publisher
   - S12 allowlist check: if `publishers.allowlistEnabled(publisher)`, require `publishers.isAllowedAdvertiser(publisher, msg.sender)` — revert E63
5. If `publisher == address(0)` (open campaign): snapshot = 5000 (DEFAULT_TAKE_RATE_BPS)
6. Validate: `msg.value > 0` (E11), `dailyCap > 0 && dailyCap <= budget` (E12), `bidCpm >= minimumCpmFloor` (E27)
7. Create Campaign struct: status=Pending, set `pendingExpiryBlock`
8. Call `budgetLedger.initializeBudget{value}(campaignId, budget, dailyCap)` — escrow DOT
9. Emit `CampaignCreated(campaignId, advertiser, publisher, budget, dailyCap, bidCpm, snapshotRate, categoryId)`
10. Return `campaignId`

**Payment:** Advertiser → DatumBudgetLedger (escrowed)

### 1.2 Set Campaign Metadata (IPFS)

**Contract:** DatumCampaigns

1. Advertiser calls `setMetadata(campaignId, metadataHash)`
2. Validate: caller == campaign advertiser (E21)
3. Emit `CampaignMetadataSet(campaignId, metadataHash)`

**Note:** No on-chain storage — metadata hash is event-only. Extension reads from IPFS using the hash.

### 1.3 Pause Campaign

**Contract:** DatumCampaigns

1. Advertiser calls `togglePause(campaignId, true)`
2. Validate: caller == advertiser (E21), status == Active (E22)
3. Set status = Paused
4. Emit `CampaignPaused(campaignId)`

### 1.4 Resume Campaign

**Contract:** DatumCampaigns

1. Advertiser calls `togglePause(campaignId, false)`
2. Validate: caller == advertiser (E21), status == Paused (E23)
3. Set status = Active
4. Emit `CampaignResumed(campaignId)`

### 1.5 Complete Campaign Early

**Contracts:** DatumCampaignLifecycle → DatumCampaigns (state) → DatumBudgetLedger (refund)

1. Advertiser (or Settlement on budget exhaustion) calls `lifecycle.completeCampaign(campaignId)`
2. Validate: caller == advertiser OR caller == settlement, status is Active or Paused
3. Set campaign status = Completed via `campaigns.setCampaignStatus()`
4. Refund remaining budget: `budgetLedger.drainToAdvertiser(campaignId, advertiser)`
5. Emit `CampaignCompleted(campaignId)`

**Payment:** DatumBudgetLedger → Advertiser (remaining balance)

---

## 2. Publisher Flows

### 2.1 Register as Publisher

**Contract:** DatumPublishers

1. Publisher calls `registerPublisher(takeRateBps)`
2. Pause check
3. S12 blocklist: `require(!blocked[msg.sender], "E62")`
4. Validate: not already registered, `takeRateBps` in [3000, 8000]
5. Create Publisher struct: registered=true, takeRateBps, categoryBitmask=0
6. Emit `PublisherRegistered(publisher, takeRateBps)`

### 2.2 Set Ad Categories

**Contract:** DatumPublishers

1. Publisher calls `setCategories(bitmask)`
2. Pause check, validate registered
3. Set `categoryBitmask` (bits 1-26 for 26 categories)
4. Emit `CategoriesUpdated(publisher, bitmask)`

### 2.3 Update Take Rate (Queued)

**Contract:** DatumPublishers

1. Publisher calls `updateTakeRate(newTakeRateBps)`
2. Pause check, validate registered, rate in [3000, 8000]
3. Store `pendingTakeRateBps` + `takeRateEffectiveBlock = block.number + delay`
4. Emit `PublisherTakeRateQueued(publisher, newRate, effectiveBlock)`

### 2.4 Apply Take Rate Update

**Contract:** DatumPublishers

1. Publisher calls `applyTakeRateUpdate()`
2. Pause check, validate registered, pending exists, delay elapsed
3. Commit `pendingTakeRateBps → takeRateBps`, clear pending
4. Emit `PublisherTakeRateApplied(publisher, newRate)`

### 2.5 Manage Advertiser Allowlist (S12)

**Contract:** DatumPublishers

**Enable/disable allowlist:**
1. Publisher calls `setAllowlistEnabled(enabled)`
2. Pause check, validate registered
3. Set `allowlistEnabled[msg.sender] = enabled`
4. Emit `AllowlistToggled(publisher, enabled)`

**Add/remove advertiser:**
1. Publisher calls `setAllowedAdvertiser(advertiser, allowed)`
2. Pause check, validate registered, `advertiser != address(0)` (E00)
3. Set `_allowedAdvertisers[msg.sender][advertiser] = allowed`
4. Emit `AdvertiserAllowlistUpdated(publisher, advertiser, allowed)`

**Effect:** When `allowlistEnabled[publisher]` is true, only allowlisted advertisers can create targeted campaigns for that publisher. Open campaigns (`publisher=address(0)`) bypass the allowlist entirely.

### 2.6 Withdraw Publisher Earnings

**Contract:** DatumPaymentVault

1. Publisher calls `withdrawPublisher()`
2. Validate: `publisherBalance[msg.sender] > 0` (E03)
3. Read balance, clear to 0
4. Transfer DOT to publisher
5. Emit `PublisherWithdrawal(publisher, amount)`

**Payment:** DatumPaymentVault → Publisher

---

## 3. User (Viewer) Flows

### 3.1 Browse & View Ads (Extension)

**Off-chain flow (no contract interaction):**

1. Extension `campaignPoller.ts` scans on-chain campaigns (IDs 1-1000)
2. Fetches IPFS metadata for campaigns with `metadataHash` events
3. `background/index.ts SELECT_CAMPAIGN` runs Vickrey auction:
   - Filter by publisher category match, active status, unblocked
   - `auction.ts`: effectiveBid = bidCpm × interestWeight, second-price clearing
4. `content/index.ts` renders ad in Shadow DOM via `adSlot.ts`
5. `engagement.ts` tracks viewport dwell/focus/scroll via IntersectionObserver
6. Quality scoring: `qualityScore.ts` (dwell 35%, focus 25%, viewability 25%, scroll 15%)
7. If quality meets threshold: `behaviorChain.ts` builds hash chain commitment

### 3.2 Build Claims (Extension)

**Off-chain flow:**

1. Each qualifying ad view produces a claim: `(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousClaimHash)`
2. Claim hash = `keccak256(campaignId, publisher, user, impressionCount, clearingCpm, nonce, prevHash)`
3. Claims queued in `chrome.storage.local`
4. `ClaimQueue.tsx` shows pending claims with "Submit All" and "Sign for Publisher" options

### 3.3 Submit Claims Directly (User Pays Gas)

**Contract:** DatumSettlement

1. User calls `settlement.settleClaims(batches)` from extension
2. See [Flow 5.1](#51-direct-settlement-user-pays-gas) for full detail

**Payment:** User pays gas. Earnings credited to PaymentVault.

### 3.4 Sign Claims for Relay (Publisher Pays Gas)

**Extension flow (partially broken — see [10.1](#101-relay-round-trip-gap)):**

1. User clicks "Sign for Publisher (zero gas)" in `ClaimQueue.tsx`
2. `signForRelay()` groups claims by campaign, signs EIP-712 typed data
3. Requests publisher attestation from `/.well-known/datum-attest`
4. Stores signed batches in `chrome.storage.local` under `signedBatches`
5. **GAP:** Does NOT POST to relay bot's `/relay/submit` endpoint

### 3.5 Withdraw User Earnings

**Contract:** DatumPaymentVault

1. User calls `withdrawUser()`
2. Validate: `userBalance[msg.sender] > 0` (E03)
3. Read balance, clear to 0
4. Transfer DOT to user
5. Emit `UserWithdrawal(user, amount)`

**Payment:** DatumPaymentVault → User

### 3.6 Export/Import Claims (Encrypted Backup)

**Extension flow (off-chain):**

1. `claimExport.ts` exports claims encrypted with AES-256-GCM
2. Key derived via HKDF from wallet signature
3. Import merges by keeping higher-nonce claims per campaign

---

## 4. Governance Participation Flows

### 4.1 Vote on Campaign

**Contract:** DatumGovernanceV2

1. Voter calls `vote(campaignId, aye, conviction)` with DOT as `msg.value`
2. Validate: conviction in [0, 8], `msg.value > 0` (E41), no existing vote (E42)
3. Fetch campaign status — must be Pending or Active (E43)
4. Compute weight = `msg.value × convictionWeight(conviction)`
5. Compute lockup = `convictionLockup(conviction)` blocks
6. Store Vote: direction (1=aye, 2=nay), lockAmount, conviction, lockedUntilBlock
7. Update `ayeWeighted[campaignId]` or `nayWeighted[campaignId]`
8. If first nay vote: set `firstNayBlock[campaignId]`
9. Emit `VoteCast(campaignId, voter, aye, amount, conviction)`

**Conviction table (9 levels, hardcoded if/else):**

| Conviction | Weight | Lockup |
|-----------|--------|--------|
| 0 | 1× | 0 (instant withdraw) |
| 1 | 2× | 1 day (14,400 blocks) |
| 2 | 3× | 3 days |
| 3 | 4× | 7 days |
| 4 | 6× | 21 days |
| 5 | 9× | 90 days |
| 6 | 14× | 180 days |
| 7 | 18× | 270 days |
| 8 | 21× | 365 days (5,256,000 blocks) |

**Payment:** Voter → DatumGovernanceV2 (locked stake)

### 4.2 Evaluate Campaign (Activation)

**Contract:** DatumGovernanceV2 → DatumCampaigns

1. Anyone calls `evaluateCampaign(campaignId)`
2. Campaign status must be Pending
3. Check: total weighted votes >= `quorumWeighted` (E46)
4. Check: aye > 50% of total (E47)
5. Call `campaigns.activateCampaign(campaignId)` — status → Active
6. Emit `CampaignEvaluated(campaignId, 1)`

### 4.3 Evaluate Campaign (Termination)

**Contract:** DatumGovernanceV2 → DatumCampaignLifecycle → DatumBudgetLedger

1. Anyone calls `evaluateCampaign(campaignId)`
2. Campaign status must be Active or Paused
3. Check: total > 0 (E51), nay >= 50% (E48)
4. Check: nay >= `terminationQuorum` (E52) — anti-grief
5. Check: `block.number >= firstNayBlock + graceBlocks` (E53) — anti-grief
6. Call `lifecycle.terminateCampaign(campaignId)`:
   - `budgetLedger.drainFraction(campaignId, governanceContract, 1000)` — 10% slash
   - `budgetLedger.drainToAdvertiser(campaignId, advertiser)` — 90% refund
   - Set campaign status = Terminated, record terminationBlock
7. Set `resolved[campaignId] = true`
8. Emit `CampaignEvaluated(campaignId, 4)`

**Payment:** BudgetLedger → 10% GovernanceV2 (slash pool), 90% Advertiser

### 4.4 Evaluate Campaign (Resolve Completed/Terminated)

**Contract:** DatumGovernanceV2

1. Anyone calls `evaluateCampaign(campaignId)` on a Completed or Terminated campaign
2. Check: not already resolved (E49)
3. Set `resolved[campaignId] = true`
4. Emit `CampaignEvaluated(campaignId, status)`

### 4.5 Withdraw Vote Stake

**Contract:** DatumGovernanceV2

1. Voter calls `withdraw(campaignId)`
2. Validate: vote exists (E44), lockup expired (E45)
3. Remove voter weight from totals
4. If campaign resolved and voter on losing side:
   - Completed → nay voters slashed
   - Terminated → aye voters slashed
   - `slash = lockAmount × slashBps / 10000`
   - Add slash to `slashCollected[campaignId]`
5. `refund = lockAmount - slash`
6. Check: refund >= minimumBalance (E58) via system precompile
7. Clear vote, transfer refund to voter
8. Emit `VoteWithdrawn(campaignId, voter, returned, slashed)`

**Payment:** GovernanceV2 → Voter (refund minus slash)

### 4.6 Finalize Slash Distribution

**Contract:** DatumGovernanceSlash

1. Anyone calls `finalizeSlash(campaignId)`
2. Validate: not already finalized (E59), campaign resolved (E60)
3. Fetch final status:
   - Completed → `winningWeight = ayeWeighted`
   - Terminated → `winningWeight = nayWeighted`
4. Store `winningWeight[campaignId]`, set finalized

### 4.7 Claim Slash Reward

**Contract:** DatumGovernanceSlash → DatumGovernanceV2

1. Winner calls `claimSlashReward(campaignId)`
2. Validate: finalized (E54), not already claimed (E55), vote exists (E44), lockup expired (E45)
3. Verify voter on winning side (E56)
4. `voterWeight = lockAmount × convictionWeight(conviction)`
5. `share = slashCollected × voterWeight / winningWeight`
6. Validate: share > 0 (E61)
7. Mark claimed, call `voting.slashAction(0, campaignId, voter, share)`

**Payment:** GovernanceV2 → Voter (proportional slash reward)

---

## 5. Settlement & Claim Flows

### 5.1 Direct Settlement (User Pays Gas)

**Contracts:** DatumSettlement → DatumCampaigns (read) → DatumBudgetLedger (deduct) → DatumPaymentVault (credit) → DatumCampaignLifecycle (auto-complete)

1. User/relay calls `settlement.settleClaims(batches[])`
2. Pause check
3. For each batch: validate caller == `batch.user` OR caller == `relayContract` (E32)
4. For each claim in batch (max 5 per batch — E28):
   - **Validate:** impressionCount > 0, campaign exists + active, publisher matches, clearingCpm <= bidCpm, nonce sequential, hash chain valid
   - **Settle:** `totalPayment = (clearingCpm × impressionCount) / 1000`
   - Revenue split:
     - `publisherPayment = totalPayment × snapshotTakeRate / 10000`
     - `remainder = totalPayment - publisherPayment`
     - `userPayment = remainder × 75%`
     - `protocolFee = remainder × 25%`
   - `budgetLedger.deductAndTransfer(campaignId, totalPayment, paymentVault)` — enforces daily cap (E26)
   - `paymentVault.creditSettlement(publisher, pubAmt, user, userAmt, protocolAmt)`
   - Update nonce + hash chain state
   - If budget exhausted: `lifecycle.completeCampaign(campaignId)` — auto-complete
   - Emit `ClaimSettled(...)` or `ClaimRejected(campaignId, user, nonce, reasonCode)`
5. Return `SettlementResult(settledCount, rejectedCount, totalPaid)`

**Payment flow:** BudgetLedger → PaymentVault (split into publisher/user/protocol balances)

### 5.2 Relay Settlement (Publisher Pays Gas)

**Contracts:** DatumRelay → DatumSettlement → (same as 5.1)

1. Relay operator calls `relay.settleClaimsFor(signedBatches[])`
2. Pause check
3. For each SignedClaimBatch:
   - Validate: `block.number <= deadline` (E29)
   - **EIP-712 user signature:** recover signer from (user, campaignId, firstNonce, lastNonce, claimCount, deadline) → must match `batch.user` (E31)
   - **Optional publisher co-signature:** if provided and campaign not open, recover signer from (campaignId, user, firstNonce, lastNonce, claimCount) → must match `campaign.publisher` (E34)
   - Open campaigns (`publisher == address(0)`): co-sig skipped
4. Convert to ClaimBatch[], forward to `settlement.settleClaims()`
5. Return `SettlementResult` from settlement

**Payment flow:** Relay operator pays gas. Settlement proceeds same as 5.1.

---

## 6. Admin / Owner Flows

### 6.1 Timelock: Propose → Execute → Cancel

**Contract:** DatumTimelock

**Propose:**
1. Owner calls `propose(target, data)`
2. Store pending proposal, set `pendingTimestamp = block.timestamp`
3. Emit `ChangeProposed(target, data, effectiveTime)`

**Execute (48h later):**
1. Anyone calls `execute()`
2. Validate: pending exists (E36), 48h elapsed (E37)
3. Execute `target.call(data)`, clear pending
4. Emit `ChangeExecuted(target, data)`

**Cancel:**
1. Owner calls `cancel()`
2. Validate: pending exists (E35)
3. Clear pending
4. Emit `ChangeCancelled(target)`

### 6.2 Global Pause / Unpause

**Contract:** DatumPauseRegistry

- `pause()` — owner only. Sets `paused = true`. Blocks: campaign creation, settlement, publisher registration/updates, relay, lifecycle transitions.
- `unpause()` — owner only. Sets `paused = false`.

**Not blocked by pause:** Governance voting, vote withdrawal, slash claims, earnings withdrawal, campaign metadata, expire pending.

### 6.3 Blocklist Management (S12)

**Contract:** DatumPublishers

- `blockAddress(addr)` — owner only. Sets `blocked[addr] = true`. Emit `AddressBlocked`.
- `unblockAddress(addr)` — owner only. Sets `blocked[addr] = false`. Emit `AddressUnblocked`.

**Effect:** Blocked addresses cannot `registerPublisher()` or be used in `createCampaign()` (as advertiser or publisher). Existing campaigns and balances unaffected.

### 6.4 Contract Reference Updates

**Via Timelock (Campaigns + Settlement ownership transferred):**

- `campaigns.setSettlementContract(addr)`
- `campaigns.setGovernanceContract(addr)`
- `campaigns.setLifecycleContract(addr)`
- `campaigns.setBudgetLedgerContract(addr)`
- `settlement.setRelayContract(addr)`
- `settlement.configure(campaigns, budgetLedger, paymentVault, lifecycle)`
- `budgetLedger.configure(campaigns, settlement, lifecycle)`
- `lifecycle.configure(campaigns, budgetLedger, governance)`
- `paymentVault.setSettlementContract(addr)`

All emit `ContractReferenceChanged(name, oldAddr, newAddr)`.

### 6.5 Withdraw Protocol Fees

**Contract:** DatumPaymentVault

1. Owner calls `withdrawProtocol(recipient)`
2. Validate: owner (E18), recipient != address(0) (E00), balance > 0 (E03)
3. Transfer `protocolBalance` to recipient
4. Emit `ProtocolWithdrawal(recipient, amount)`

---

## 7. Automated / Permissionless Flows

### 7.1 Expire Pending Campaign

**Contract:** DatumCampaignLifecycle → DatumBudgetLedger

1. Anyone calls `expirePendingCampaign(campaignId)`
2. Validate: status == Pending, `block.number > pendingExpiryBlock` (E24)
3. Set status = Expired
4. Refund full budget: `budgetLedger.drainToAdvertiser(campaignId, advertiser)`
5. Emit `CampaignExpired(campaignId)`

### 7.2 Sweep Slash Pool (365 days after finalization)

**Contract:** DatumGovernanceSlash → DatumGovernanceV2

1. Anyone calls `sweepSlashPool(campaignId)`
2. Validate: finalized, 365 days elapsed since finalization
3. Transfer unclaimed slash pool to protocol owner
4. Emit sweep

### 7.3 Sweep Budget Dust (Terminal campaigns)

**Contract:** DatumBudgetLedger

1. Anyone calls `sweepDust(campaignId)`
2. Validate: remaining > 0 (E03), campaign terminal (status >= 3)
3. Transfer dust to protocol owner
4. Emit `DustSwept`

---

## 8. Payment Flow Summary

```
                           ┌─────────────────────────┐
                           │   ADVERTISER             │
                           │   (creates campaign)     │
                           └──────────┬──────────────┘
                                      │ msg.value (DOT)
                                      ▼
                           ┌─────────────────────────┐
                           │   DatumBudgetLedger      │
                           │   (escrowed budget)      │
                           └──────────┬──────────────┘
                                      │
               ┌──────────────────────┼──────────────────────┐
               │ deductAndTransfer    │ drainToAdvertiser     │ drainFraction
               │ (per settled claim)  │ (complete/expire)     │ (terminate 10%)
               ▼                      ▼                       ▼
    ┌──────────────────┐   ┌─────────────────┐    ┌──────────────────┐
    │ DatumPaymentVault│   │   ADVERTISER    │    │ DatumGovernanceV2│
    │ (accumulates)    │   │   (refund)      │    │ (slash pool)     │
    └────────┬─────────┘   └─────────────────┘    └────────┬─────────┘
             │                                              │
   ┌─────────┼──────────┐                       ┌──────────┼──────────┐
   │         │          │                       │ withdraw  │ slashAction
   ▼         ▼          ▼                       ▼           ▼
PUBLISHER   USER    PROTOCOL              VOTER (refund  WINNER
(take rate) (75%)   (25%)                 minus slash)  (slash reward)
```

### Revenue Split Per Settled Claim

```
totalPayment = (clearingCpm × impressionCount) / 1000

publisherPayment = totalPayment × snapshotTakeRate / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder × 75%
protocolFee      = remainder × 25%
```

Example at 50% take rate, 10 DOT total:
- Publisher: 5.00 DOT
- User: 3.75 DOT
- Protocol: 1.25 DOT

---

## 9. Alpha vs Alpha-2 Comparison

### Structural Changes (9 → 12 contracts)

| Alpha | Alpha-2 | Change |
|-------|---------|--------|
| DatumCampaigns (monolithic) | DatumCampaigns + DatumBudgetLedger + DatumCampaignLifecycle | Budget escrow and lifecycle transitions extracted into satellites |
| DatumSettlement (holds balances) | DatumSettlement + DatumPaymentVault | Pull-payment vault extracted; Settlement no longer holds DOT |
| — | S12 Blocklist on Publishers | New: global blocklist + per-publisher allowlist |

### Function Migration

| Function | Alpha Location | Alpha-2 Location |
|----------|---------------|------------------|
| `completeCampaign()` | Campaigns | CampaignLifecycle |
| `terminateCampaign()` | Campaigns | CampaignLifecycle |
| `expirePendingCampaign()` | Campaigns | CampaignLifecycle |
| `deductBudget()` | Campaigns | BudgetLedger.deductAndTransfer() |
| Budget storage (remaining, dailyCap, dailySpent) | Campaign struct in Campaigns | Separate Budget struct in BudgetLedger |
| `withdrawPublisher()` | Settlement | PaymentVault |
| `withdrawUser()` | Settlement | PaymentVault |
| `withdrawProtocol()` | Settlement | PaymentVault |
| Balance storage (publisher/user/protocol) | Settlement | PaymentVault |

### New in Alpha-2

| Feature | Contract | Description |
|---------|----------|-------------|
| S12 Global Blocklist | Publishers | `blocked` mapping, `blockAddress()`, `unblockAddress()`, `isBlocked()` |
| S12 Per-Publisher Allowlist | Publishers | `allowlistEnabled`, `setAllowlistEnabled()`, `setAllowedAdvertiser()` |
| S12 Blocklist enforcement | Campaigns | `isBlocked()` check on advertiser + publisher in `createCampaign()` |
| S12 Allowlist enforcement | Campaigns | `allowlistEnabled()` + `isAllowedAdvertiser()` check in `createCampaign()` |
| Budget satellite | BudgetLedger | `initializeBudget()`, `deductAndTransfer()`, `drainToAdvertiser()`, `drainFraction()` |
| Dust sweep | BudgetLedger | `sweepDust()` for terminal campaign rounding dust |
| Slash sweep | GovernanceSlash | `sweepSlashPool()` for unclaimed slash after 365 days |
| Payment vault | PaymentVault | `creditSettlement()`, `withdrawPublisher()`, `withdrawUser()`, `withdrawProtocol()` |
| Lifecycle satellite | CampaignLifecycle | `completeCampaign()`, `terminateCampaign()`, `expirePendingCampaign()` |
| OZ ReentrancyGuard | BudgetLedger, GovernanceSlash | Proper reentrancy protection on value transfers |
| `ContractReferenceChanged` events | All wired contracts | Transparent admin contract swaps |
| Escalating conviction (9 levels) | GovernanceV2 | 0-8 conviction (alpha had 0-6) with hardcoded if/else lookup |
| Anti-grief termination | GovernanceV2 | `terminationQuorum` (E52) + grace period (E53) + `firstNayBlock` |
| Error code dedup | GovernanceSlash | E59/E60/E61 (was reusing E52/E53/E03) |

### Removed in Alpha-2

| Feature | Reason |
|---------|--------|
| ZK verification in Settlement | Removed to save PVM — `zkVerifier.verify()` staticcall removed. ZK deferred to post-alpha. |
| Budget fields in Campaign struct | Extracted to BudgetLedger — Campaign struct reduced from ~8 budget slots |

---

## 10. Missing & Unresolved Flows

### 10.1 Relay Round-Trip Gap (BROKEN)

**Status:** Extension does NOT complete the relay flow.

`ClaimQueue.tsx signForRelay()` signs EIP-712 batches, requests publisher attestation from `/.well-known/datum-attest`, then stores signed batches in `chrome.storage.local` under `signedBatches` — but **never POSTs them to the relay bot's `/relay/submit` endpoint**.

`PublisherPanel.tsx relaySubmit()` calls `relay.settleClaimsFor()` on-chain directly from the publisher's browser wallet, reading signed batches from shared `chrome.storage.local`. This only works if the publisher is running the extension on the same browser as the user.

The relay bot at `relay-bot/relay-bot.mjs` has a working `/relay/submit` endpoint but nothing calls it. Result: `attestationsIssued: 1`, `batchesReceived: 0`.

**Fix needed:** `signForRelay()` must POST signed batches to publisher relay endpoint after signing. Relay URL is derivable from the attestation endpoint base URL.

### 10.2 Settlement Blocklist Check (DEFERRED — PVM)

S12 blocklist is NOT checked in `Settlement._validateClaim()`. A blocked publisher's existing campaigns can still settle claims. Settlement has only 3,543 B spare; staticcall to `isBlocked()` costs ~800 B.

**Resolution:** Deferred until Settlement is restructured or resolc produces smaller output.

### 10.3 GovernanceV2 Vote Blocklist Check (DEFERRED — PVM)

Blocked addresses can still vote in governance. GovernanceV2 has only 1,213 B spare — no room for an `isBlocked()` cross-contract call.

**Resolution:** Low risk (voting doesn't enable fund theft; slash mechanism penalizes bad actors). Deferred.

### 10.4 Blocklist Not Timelock-Gated (ALPHA ONLY)

`blockAddress()` and `unblockAddress()` are `onlyOwner` (direct). No 48h transparency delay.

**Resolution:** MUST migrate to timelock-gated before mainnet. Acceptable for alpha (small user base, testnet).

### 10.5 No Governance Blocklist Override

Owner can block addresses unilaterally. No community override mechanism.

**Resolution:** Future goal — Option C hybrid: admin emergency-block + governance conviction vote to unblock. See S12-BLOCKLIST-ANALYSIS.md §3.

### 10.6 No Vote Stacking / Increase

Contract enforces one vote per address per campaign. Cannot increase stake without withdrawing and re-voting (losing lockup progress).

**Resolution:** Backlog item — `increaseStake(campaignId)` function. Needs PVM headroom on GovernanceV2 (only 1,213 B spare).

### 10.7 No Campaign Inactivity Timeout

Active campaigns with zero settlement activity run indefinitely. If advertiser loses key, budget is locked forever (except `sweepDust()` only works on terminal campaigns).

**Resolution:** Backlog P20 — auto-complete after N blocks with no settlements.

### 10.8 No Dispute / Challenge Mechanism

No way to dispute a settled claim. Once `ClaimSettled` is emitted, payment is final.

**Resolution:** Backlog — 7-day challenge window with advertiser bond. Requires significant design work.

### 10.9 No Contract Upgrade Path

All contracts are non-upgradeable. PaymentVault holds user balances. Lost owner key = permanently locked `protocolBalance`.

**Resolution:** Backlog P7 — UUPS proxy or migration pattern. Required before mainnet.

### 10.10 Direct Settlement Has No Attestation Enforcement

`settlement.settleClaims()` accepts claims from `msg.sender == batch.user` with no publisher co-signature requirement. Users can self-report impressions.

**Resolution:** Backlog P1 — mandatory publisher attestation. Currently optional (degraded trust mode). Post-alpha: `DatumAttestationVerifier` wrapper contract.

### 10.11 Open Campaign Take Rate Is Fixed

Open campaigns (`publisher=address(0)`) snapshot `DEFAULT_TAKE_RATE_BPS = 5000` (50%). Not market-driven or configurable.

**Resolution:** Backlog — dynamic per-publisher rates. PVM constraint.

### 10.12 No Claim Expiry

Stale claims can be submitted indefinitely. The nonce chain prevents replay, but old claims with outdated clearing prices are still valid.

**Resolution:** Accepted limitation — nonce chain prevents double-spend. A claim deadline field exists on relay (`deadline` on SignedClaimBatch) but not on direct settlement.

### 10.13 ZK Verification Stub

`DatumZKVerifier.verify()` accepts any non-empty proof (`proof.length > 0`). No real ZK circuit exists.

**Resolution:** Backlog P9 — real Groth16/PLONK circuit. Requires BN128 pairing precompile on Polkadot Hub.

### 10.14 No Multi-Chain Settlement

Single chain only (Polkadot Hub). No XCM cross-chain claims.

**Resolution:** Backlog — XCM-based cross-chain settlement post-mainnet.

### 10.15 Withdrawal Has No Minimum Balance Check (PaymentVault)

`GovernanceV2.withdraw()` checks `minimumBalance()` via system precompile (E58). `PaymentVault` withdrawal functions do not — dust withdrawals could fail silently due to denomination rounding.

**Resolution:** Backlog O3 — add `minimumBalance()` check to PaymentVault. PVM cost acceptable (PaymentVault has 33,090 B spare), but not yet implemented.

### 10.16 No Publisher Deregistration

Publishers cannot unregister or deactivate themselves. Once registered, the publisher entry is permanent.

**Resolution:** Not documented in backlog. Low priority — publisher can set take rate to maximum (8000) to discourage campaigns, or enable allowlist with no advertisers allowed.

### 10.17 No Advertiser Campaign Listing

No on-chain function to enumerate all campaigns by a given advertiser. Extension scans sequentially (IDs 1-1000).

**Resolution:** Accepted limitation. On-chain enumeration would add significant PVM. Extension `campaignPoller.ts` handles discovery.

### 10.18 Revenue Split Not Governance-Controlled

75/25 user/protocol split is hardcoded in Settlement. Not adjustable via governance or timelock.

**Resolution:** Backlog — governance parameter with timelock protection.

### 10.19 Minimum CPM Floor Not Governance-Controlled

`minimumCpmFloor` on Campaigns is owner-settable, not governance-controlled.

**Resolution:** Backlog — governance parameter.

---

## Cross-Contract Dependency Map

```
PauseRegistry ←── Publishers ←── Campaigns ──→ BudgetLedger
     ↑                ↑              ↑               ↑
     │                │              │               │
     ├── CampaignLifecycle ─────────┼───────────────┘
     │                              │
     ├── Settlement ────────────────┤──→ PaymentVault
     │        ↑                     │         ↑
     │        │                     │         │
     └── Relay ──→ Settlement       │    (creditSettlement)
                                    │
              GovernanceV2 ─────────┘──→ CampaignLifecycle
                   ↑
                   │
              GovernanceSlash

              Timelock ──→ (any owned contract)
```

**Ownership:**
- PauseRegistry: deployer (direct)
- Timelock: deployer (direct)
- Publishers: deployer (direct)
- Campaigns: Timelock (transferred post-deploy)
- Settlement: Timelock (transferred post-deploy)
- GovernanceV2: deployer (direct)
- GovernanceSlash: deployer (direct)
- BudgetLedger: deployer (direct)
- CampaignLifecycle: deployer (direct)
- PaymentVault: deployer (direct)
- Relay: deployer (direct)
- ZKVerifier: deployer (direct)
