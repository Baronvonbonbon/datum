# Alpha-2 Implementation Plan — Contract Restructuring

**Version:** 1.1
**Date:** 2026-03-20 (plan) / 2026-03-23 (execution complete)
**Status:** PHASES 1-4 COMPLETE. Phase 5 deferred (PVM-blocked).
**Goal:** Restructure DatumCampaigns (48,662 B / 490 B spare) and DatumSettlement (48,820 B / 332 B spare) to free significant PVM bytecode headroom while preserving all existing functionality, enabling the deferred hardening and optimization work from the alpha backlog.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current Architecture](#2-current-architecture)
3. [Restructuring Strategy](#3-restructuring-strategy)
4. [Phase 1 — Extract Payment Vault from Settlement](#phase-1--extract-payment-vault-from-settlement)
5. [Phase 2 — Extract Budget Ledger from Campaigns](#phase-2--extract-budget-ledger-from-campaigns)
6. [Phase 3 — Extract Campaign Lifecycle from Campaigns](#phase-3--extract-campaign-lifecycle-from-campaigns)
7. [Phase 4 — Consolidate Admin and Add Deferred Hardening](#phase-4--consolidate-admin-and-add-deferred-hardening)
8. [Phase 5 — Gas Optimizations (Now Unblocked)](#phase-5--gas-optimizations-now-unblocked)
9. [Revised Architecture](#9-revised-architecture)
10. [Migration Strategy](#10-migration-strategy)
11. [Risk Assessment](#11-risk-assessment)
12. [Test Plan](#12-test-plan)
13. [Estimated PVM Budget After Restructuring](#13-estimated-pvm-budget-after-restructuring)

---

## 1. Problem Statement

DatumCampaigns and DatumSettlement are at the PVM bytecode ceiling (49,152 B initcode limit). This blocks:

- **8 contract hardening items** (S2–S12) — zero-address checks, events on wiring changes, governance sweep, on-chain blocklist
- **5 gas optimizations** (O1–O5) — Blake2-256 hashing, weight-limited batch abort, dust prevention in Settlement
- **3 feature requirements** (P7 upgrade path, P20 inactivity timeout, M4 abandoned fund sweep)

Adding a single `require` to either contract risks exceeding the limit. The contracts cannot evolve.

### Root Cause

resolc v0.3.0 produces PVM bytecodes 10-20x larger than solc EVM. Both contracts pack too much responsibility into a single deployment unit:

- **DatumCampaigns** owns campaign lifecycle (create, activate, pause, complete, terminate, expire), budget management (deduct, daily cap, auto-complete), metadata, and administrative setters — 13 external/public functions.
- **DatumSettlement** owns claim validation, hash chain verification, payment splitting, three pull-payment balances, three withdrawal functions, ZK verification delegation, and administrative setters — 10 external/public functions.

### Design Constraint

Each external call between contracts costs ~300-600 B PVM (ABI encode, CALL opcode, decode return). Adding a satellite that requires frequent cross-contract calls can be net negative. The restructuring must extract **self-contained subsystems** where the new interface is narrow (1-2 calls) and the removed code is large (1,000+ B).

---

## 2. Current Architecture

```
                    ┌──────────────┐
                    │ PauseRegistry│ 4,047 B
                    │   (leaf)     │
                    └──────┬───────┘
                           │ paused() staticcall
          ┌────────────────┼──────────────────────┐
          │                │                      │
  ┌───────▼────────┐  ┌───▼──────────────┐  ┌────▼───────────┐
  │  Campaigns     │  │  Settlement      │  │  Relay         │
  │  48,662 B      │  │  48,820 B        │  │  46,180 B      │
  │  490 B spare   │  │  332 B spare     │  │  2,972 B spare │
  │                │  │                  │  │                │
  │  13 functions  │  │  10 functions    │  │  2 functions   │
  │  Campaign      │  │  Claim validate  │  │  EIP-712 sig   │
  │  struct (10    │  │  Hash chain      │  │  verification  │
  │  slots)        │  │  Payment split   │  │                │
  │  Budget mgmt   │  │  3 balances      │  └───────┬────────┘
  │  Daily caps    │  │  3 withdrawals   │          │
  │  Lifecycle     │  │  ZK delegation   │          │ settleClaims()
  │  Metadata      │  └───────┬──────────┘          │
  └───────┬────────┘          │                     │
          │                   │ deductBudget()      │
          │◄──────────────────┘                     │
          │                   │ getCampaignFor...() │
          │◄──────────────────┼─────────────────────┘
          │
  ┌───────▼────────┐  ┌──────────────────┐
  │ GovernanceV2   │  │ GovernanceSlash  │
  │ 39,693 B       │  │ 30,298 B         │
  │ 9,459 B spare  │  │ 18,854 B spare   │
  └────────────────┘  └──────────────────┘
```

**Critical coupling:** DatumCampaigns is called by 4 other contracts (GovernanceV2, GovernanceSlash, Relay, Settlement) via `getCampaignForSettlement()`. Any restructuring must preserve this read interface.

---

## 3. Restructuring Strategy

The strategy is **vertical slicing** — extract self-contained subsystems into satellite contracts where the removed code significantly exceeds the interface cost.

### Extraction Targets (ordered by impact)

| # | Extract From | Extract What | New Contract | Est. Freed | Interface Cost | Net Gain |
|---|-------------|-------------|-------------|-----------|---------------|----------|
| 1 | Settlement | Payment balances + 3 withdrawals + `_send` | **DatumPaymentVault** | ~4,000-6,000 B | ~1,000 B (3 credit calls) | ~3,000-5,000 B |
| 2 | Campaigns | Budget deduction + daily cap logic | **DatumBudgetLedger** | ~3,000-4,500 B | ~600 B (1 deduct call) | ~2,400-3,900 B |
| 3 | Campaigns | Lifecycle transitions (terminate, expire, complete with refunds) | **DatumCampaignLifecycle** | ~3,500-5,000 B | ~800 B (shared state reads) | ~2,700-4,200 B |
| 4 | Both | Admin setters → Timelock direct-call | Timelock modification | ~1,200-1,800 B | 0 (removes code) | ~1,200-1,800 B |

**Total estimated freed:** ~9,300-14,900 B across both contracts — enough to absorb all deferred hardening (S2-S12), optimizations (O1-O3), and features (M4, P20).

---

## Phase 1 — Extract Payment Vault from Settlement

**Priority: Highest.** Largest net gain with cleanest separation boundary.

### What Moves Out

From `DatumSettlement` → new `DatumPaymentVault`:

| Component | Current Location | PVM Cost (est.) |
|-----------|-----------------|-----------------|
| `publisherBalance` mapping | Settlement slot 6 | — |
| `userBalance` mapping | Settlement slot 7 | — |
| `protocolBalance` uint256 | Settlement slot 8 | — |
| `withdrawPublisher()` | Settlement | ~1,500-2,000 B |
| `withdrawUser()` | Settlement | ~1,500-2,000 B |
| `withdrawProtocol(address)` | Settlement | ~1,500-2,000 B |
| `_send(address, uint256)` | Settlement (internal) | ~500-800 B (×3 if inlined) |
| `receive() external payable` | Settlement | minimal |

### New Contract: DatumPaymentVault

```solidity
contract DatumPaymentVault is IDatumPaymentVault, ReentrancyGuard, Ownable {
    address public settlement;   // only Settlement can credit

    mapping(address => uint256) public publisherBalance;
    mapping(address => uint256) public userBalance;
    uint256 public protocolBalance;

    // Called by Settlement after each settled claim
    function creditSettlement(
        address publisher, uint256 pubAmount,
        address user, uint256 userAmount,
        uint256 protocolAmount
    ) external payable;   // msg.value = total, caller must be settlement

    // User-facing withdrawals (unchanged API)
    function withdrawPublisher() external nonReentrant;
    function withdrawUser() external nonReentrant;
    function withdrawProtocol(address recipient) external onlyOwner nonReentrant;
}
```

**Estimated PVM size:** ~15,000-20,000 B (well within limit).

### Changes to DatumSettlement

- Remove: 3 balance mappings, 3 withdraw functions, `_send`, `receive()`
- Add: `IDatumPaymentVault vault` state variable
- Modify `_settleSingleClaim`: replace 3 mapping writes + 1 protocolBalance write with single `vault.creditSettlement{value: totalPayment}(publisher, pubPay, user, userPay, protocolFee)`
- The `deductBudget` call on Campaigns now sends DOT directly to PaymentVault (via Settlement forwarding), or Campaigns sends to Settlement which forwards to Vault in the same tx.

**Key design decision:** `creditSettlement` is `payable` — Settlement forwards the DOT from `deductBudget` directly to the Vault in one hop. No intermediate holding.

### What Settlement Gains

~4,000-6,000 B freed. Enough to add:
- O1: Blake2-256 claim hashing via system precompile (+4,177 B)
- O3: `minimumBalance()` dust checks in `_send` equivalent (+~2,000 B)
- S4: ZK verification empty-return guard (+~200 B)
- S3: Events on `setRelayContract`/`setZKVerifier` changes (+~400 B)

### Interface Impact

| Caller | Before | After |
|--------|--------|-------|
| Users withdrawing | `settlement.withdrawPublisher()` | `vault.withdrawPublisher()` |
| Owner withdrawing protocol | `settlement.withdrawProtocol(addr)` | `vault.withdrawProtocol(addr)` |
| Extension UI | Reads Settlement balances | Reads Vault balances |

Extension changes: update 3 contract calls in Earnings/Publisher panels to target Vault address instead of Settlement. Add `paymentVault` to contract addresses config.

---

## Phase 2 — Extract Budget Ledger from Campaigns

**Priority: High.** Removes the most complex function from Campaigns.

### What Moves Out

From `DatumCampaigns` → new `DatumBudgetLedger`:

| Component | Current Location | PVM Cost (est.) |
|-----------|-----------------|-----------------|
| `remainingBudget` per campaign | Campaign struct slot C | — |
| `dailyCapPlanck` per campaign | Campaign struct slot D | — |
| `dailySpent` per campaign | Campaign struct slot F | — |
| `lastSpendDay` per campaign | Campaign struct slot G | — |
| `deductBudget(uint256, uint256)` | Campaigns | ~2,500-4,000 B |
| Daily cap reset logic | Campaigns (in deductBudget) | included above |
| Auto-complete trigger | Campaigns (in deductBudget) | included above |
| `BudgetDeducted` event | Campaigns | ~300-500 B |

### New Contract: DatumBudgetLedger

```solidity
contract DatumBudgetLedger is IDatumBudgetLedger {
    address public campaigns;     // only Campaigns can initialize budgets
    address public settlement;    // only Settlement can deduct

    struct Budget {
        uint256 remaining;
        uint256 dailyCap;
        uint256 dailySpent;
        uint256 lastSpendDay;
    }
    mapping(uint256 => Budget) public budgets;

    // Called by Campaigns at creation time
    function initializeBudget(
        uint256 campaignId, uint256 budget, uint256 dailyCap
    ) external payable;    // msg.value = budget amount

    // Called by Settlement during claim processing
    function deductAndTransfer(
        uint256 campaignId, uint256 amount, address recipient
    ) external returns (bool exhausted);
    // Deducts from budget, enforces daily cap, sends DOT to recipient (Vault).
    // Returns true if budget is now zero (auto-complete signal).

    // Called by Campaigns on complete/terminate/expire for refunds
    function drainToAdvertiser(
        uint256 campaignId, address advertiser
    ) external;    // sends remaining budget to advertiser

    // View for off-chain
    function getRemainingBudget(uint256 campaignId) external view returns (uint256);
}
```

**Estimated PVM size:** ~18,000-24,000 B.

### Changes to DatumCampaigns

- Remove: 4 budget fields from Campaign struct (now 6 slots instead of 10), `deductBudget` function, `BudgetDeducted` event, daily cap reset logic
- Add: `IDatumBudgetLedger budgetLedger` state variable
- Modify `createCampaign`: instead of writing budget fields to Campaign struct, call `budgetLedger.initializeBudget{value: msg.value}(id, msg.value, dailyCap)`
- Modify `completeCampaign`/`terminateCampaign`/`expirePendingCampaign`: instead of reading `remainingBudget` and calling `_send` for refund, call `budgetLedger.drainToAdvertiser(id, advertiser)`
- Remove: `getCampaignRemainingBudget` view (now on BudgetLedger)

### Changes to DatumSettlement

- `_settleSingleClaim`: instead of calling `campaigns.deductBudget()`, call `budgetLedger.deductAndTransfer(campaignId, totalPayment, address(vault))`
- The `exhausted` return tells Settlement to call `campaigns.completeCampaign(id)` for auto-complete (or BudgetLedger signals Campaigns directly)

### What Campaigns Gains

~3,000-4,500 B freed. Enough to add:
- S2: Zero-address checks on all setters (+~400 B)
- S3: Events on wiring changes (+~600 B)
- M4: `sweepAbandonedBudget` (delegated to BudgetLedger) — unlocked
- P20: Campaign inactivity timeout (+~800 B)

### Simplified Campaign Struct

```solidity
struct Campaign {
    address advertiser;           // slot A
    address publisher;            // slot B
    uint256 pendingExpiryBlock;   // slot C
    uint256 terminationBlock;     // slot D
    uint256 bidCpmPlanck;         // slot E
    uint16 snapshotTakeRateBps;   // ┐
    CampaignStatus status;        //   packed → slot F
    uint8 categoryId;             // ┘
}
```

6 slots instead of 10. Every function that touches the struct gets faster and smaller.

---

## Phase 3 — Extract Campaign Lifecycle from Campaigns

**Priority: Medium.** Further thins Campaigns by extracting refund-path functions.

### What Moves Out

From `DatumCampaigns` → new `DatumCampaignLifecycle`:

| Component | Current Location | PVM Cost (est.) |
|-----------|-----------------|-----------------|
| `completeCampaign(uint256)` | Campaigns | ~1,500-2,000 B |
| `terminateCampaign(uint256)` | Campaigns | ~2,000-3,500 B |
| `expirePendingCampaign(uint256)` | Campaigns | ~1,500-2,000 B |
| Reentrancy guard (4 sites → 1 site remains) | Campaigns | ~1,200-2,400 B saved |
| `_send(address, uint256)` | Campaigns | ~500-800 B |
| Events: Completed, Terminated, Expired | Campaigns | ~600-900 B |

### New Contract: DatumCampaignLifecycle

```solidity
contract DatumCampaignLifecycle is IDatumCampaignLifecycle, ReentrancyGuard {
    IDatumCampaigns public campaigns;
    IDatumBudgetLedger public budgetLedger;
    IDatumPauseRegistry public pauseRegistry;

    // Called by governance (via Campaigns authorization)
    function terminateCampaign(uint256 campaignId) external nonReentrant;

    // Called by advertiser or settlement (auto-complete)
    function completeCampaign(uint256 campaignId) external nonReentrant;

    // Called by anyone (permissionless)
    function expirePendingCampaign(uint256 campaignId) external nonReentrant;
}
```

This contract reads campaign state from DatumCampaigns (advertiser, status), calls `budgetLedger.drainToAdvertiser()` for refunds, and calls back to Campaigns to update status. The status update on Campaigns becomes a single `setCampaignStatus(id, newStatus)` function gated to the Lifecycle contract.

**Estimated PVM size:** ~20,000-26,000 B.

### What Remains in DatumCampaigns (Core)

After Phase 2 + Phase 3, DatumCampaigns becomes a lean state contract:

```
DatumCampaigns (Core) — estimated ~25,000-32,000 B
├── createCampaign()          — campaign creation + struct init
├── activateCampaign()        — governance callback (Pending→Active)
├── setCampaignStatus()       — lifecycle callback (gated to Lifecycle contract)
├── togglePause()             — advertiser pause/resume
├── setMetadata()             — advertiser metadata
├── getCampaignForSettlement() — hot-path view (5 return values)
├── getCampaignStatus()       — thin view
├── getCampaignAdvertiser()   — thin view
├── Admin setters             — setSettlement, setGovernance, etc.
└── Campaign struct (6 slots) — lean, no budget fields
```

**~17,000-24,000 B freed** from original. Massive headroom for all backlog items plus future features.

---

## Phase 4 — Consolidate Admin and Add Deferred Hardening

With headroom now available, add the blocked backlog items.

### Into DatumCampaigns (Core)

| Item | Description | Est. Cost |
|------|-------------|-----------|
| S2 | `require(addr != address(0))` on all setters | ~400 B |
| S3 | `emit ContractReferenceChanged(name, oldAddr, newAddr)` on setters | ~600 B |
| P20 | `lastActivityBlock` field + `expireInactiveCampaign()` function | ~1,500 B |
| — | `setLifecycleContract(address)` setter for Phase 3 wiring | ~200 B |
| — | `setBudgetLedger(address)` setter for Phase 2 wiring | ~200 B |

### Into DatumSettlement

| Item | Description | Est. Cost |
|------|-------------|-----------|
| O1 | Blake2-256 claim hashing via `hashBlake256()` precompile | ~4,000 B |
| O3 | `minimumBalance()` dust guard in credit path | ~2,000 B |
| S4 | ZK verifier empty-return guard | ~200 B |
| S3 | Events on `setRelayContract`/`setZKVerifier` | ~400 B |

### Into DatumBudgetLedger

| Item | Description | Est. Cost |
|------|-------------|-----------|
| M4 | `sweepAbandonedBudget(campaignId)` — permissionless after timeout | ~1,500 B |
| — | Budget exhaustion events | ~300 B |

### Into DatumGovernanceSlash (already has 18,854 B spare)

| Item | Description | Est. Cost |
|------|-------------|-----------|
| M4 | `sweepSlashPool(campaignId)` — permissionless after deadline | ~1,500 B |

---

## Phase 5 — Gas Optimizations (Now Unblocked)

With Settlement headroom from Phase 1:

### O1: Blake2-256 Claim Hashing

Replace `keccak256(abi.encodePacked(campaignId, publisher, user, ...))` with `ISystem(0x900).hashBlake256(data)` in `_validateClaim`. ~3x cheaper per claim on Substrate.

**Requires:** Extension migration to compute Blake2-256 instead of keccak256 for claim hash chain. `@noble/hashes` already installed but unused.

**Migration path:** Support both hash types during transition:
1. Deploy updated Settlement that checks Blake2-256 first, falls back to keccak256
2. Extension update computes Blake2-256
3. After transition period, remove keccak256 fallback

### O2: Weight-Limited Batch Abort

With headroom in both Settlement and Relay, add `ISystem(0x900).weightLeft()` check in the claim processing loop. If remaining weight drops below a threshold, stop processing and return partial results instead of reverting the entire batch.

**Requires:** Both Settlement and Relay contracts to have precompile access (~4 KB each).

---

## 9. Revised Architecture

```
                         ┌──────────────┐
                         │ PauseRegistry│ 4,047 B
                         └──────┬───────┘
                                │
    ┌───────────────────────────┼──────────────────────┐
    │                           │                      │
┌───▼───────────────┐  ┌───────▼──────────┐  ┌────────▼─────────┐
│ Campaigns (Core)  │  │  Settlement      │  │  Relay           │
│ ~28,000 B         │  │  ~38,000 B       │  │  46,180 B        │
│ ~21,000 B spare   │  │  ~11,000 B spare │  │                  │
│                   │  │                  │  │                  │
│ Campaign struct   │  │  Claim validate  │  │  EIP-712 sig     │
│ (6 slots)         │  │  Hash chain      │  │  verification    │
│ Create/Activate   │  │  Payment split   │  │                  │
│ Pause/Metadata    │  │  ZK delegation   │  └──────────────────┘
│ Status updates    │  │                  │
│ Views             │  │  (no balances,   │
│                   │  │   no withdrawals)│
└─────┬─────────────┘  └────────┬─────────┘
      │                         │
      │  ┌──────────────────────┘
      │  │
┌─────▼──▼──────────┐  ┌──────────────────┐
│ BudgetLedger      │  │  PaymentVault    │
│ ~22,000 B         │  │  ~18,000 B       │
│                   │  │                  │
│ Budget per        │  │ publisherBalance │
│ campaign          │  │ userBalance      │
│ Daily caps        │  │ protocolBalance  │
│ Deduct + transfer │  │ 3 withdrawals   │
│ Sweep abandoned   │  │ Credit from      │
│                   │  │ settlement       │
└───────────────────┘  └──────────────────┘

┌───────────────────┐
│ CampaignLifecycle │
│ ~24,000 B         │
│                   │
│ Complete          │
│ Terminate         │
│ Expire            │
│ Refund via Ledger │
└───────────────────┘
```

**Contract count:** 9 → 12 (+PaymentVault, +BudgetLedger, +CampaignLifecycle)

**Net headroom gained:**
- Campaigns (Core): ~17,000-21,000 B spare (from 490 B)
- Settlement: ~8,000-11,000 B spare (from 332 B)

---

## 10. Migration Strategy

This is a **fresh deployment**, not an upgrade. Alpha-2 contracts replace alpha contracts entirely.

### Deployment Order

**Status: Contracts compiled + tested. Deploy scripts pending.**

1. `DatumPauseRegistry` (unchanged)
2. `DatumTimelock` (unchanged)
3. `DatumPublishers` (S5 + S12 — pauseRegistry, blocklist, allowlist)
4. `DatumPaymentVault` (new)
5. `DatumBudgetLedger` (new)
6. `DatumCampaigns` (restructured — Core + S12 checks)
7. `DatumCampaignLifecycle` (new)
8. `DatumGovernanceV2` (conviction 0-8, anti-grief, ContractReferenceChanged events)
9. `DatumGovernanceSlash` (sweep, ReentrancyGuard, deduped errors)
10. `DatumSettlement` (restructured — no balances, configure(), ContractReferenceChanged)
11. `DatumRelay` (unchanged)
12. `DatumZKVerifier` (unchanged)

### Wiring

Post-deploy wiring calls (actual, based on implemented contracts):

```
// Core wiring
campaigns.setSettlementContract(settlement)
campaigns.setGovernanceContract(governance)
campaigns.setLifecycleContract(lifecycle)
campaigns.setBudgetLedgerContract(budgetLedger)

// Settlement wiring (single 4-arg configure — relay included)
settlement.configure(budgetLedger, paymentVault, lifecycle, relay)

// Satellite wiring
vault.setSettlementContract(settlement)
budgetLedger.configure(campaigns, settlement, lifecycle)
lifecycle.configure(campaigns, budgetLedger, governance)
lifecycle.setSettlementContract(settlement)

// Governance wiring
governance.setSlashContract(slash)
governance.setLifecycle(lifecycle)
slash.setCampaigns(campaigns)  // or equivalent reference

// Ownership transfers to Timelock
campaigns.transferOwnership(timelock)
settlement.transferOwnership(timelock)
```

### Extension Changes

| Component | Change | Status |
|-----------|--------|--------|
| Contract addresses config | Add 3 new addresses: `paymentVault`, `budgetLedger`, `campaignLifecycle` | **DONE** |
| Earnings panel (UserPanel.tsx) | Read `userBalance` from Vault instead of Settlement | **DONE** |
| Publisher panel (PublisherPanel.tsx) | Read `publisherBalance` from Vault instead of Settlement | **DONE** |
| Publisher withdrawal | Call `vault.withdrawPublisher()` instead of `settlement.withdrawPublisher()` | **DONE** |
| User withdrawal | Call `vault.withdrawUser()` instead of `settlement.withdrawUser()` | **DONE** |
| Claims panel (ClaimQueue.tsx) | No change — claim submission still goes through Settlement/Relay | **DONE** |
| Campaign creation (AdvertiserPanel.tsx) | No change — `createCampaign()` API unchanged | **DONE** |
| Governance (GovernancePanel.tsx) | Updated for conviction 0-8 | **DONE** |
| Settings (Settings.tsx) | 3 new contract address fields | **DONE** |
| Error codes (errorCodes.ts) | E59-E63 added, E00-E63 range | **DONE** |
| deploy.ts | Extended wiring sequence | **TODO** |

---

## 11. Risk Assessment — Plan vs Actual

| Risk | Planned Severity | Actual Outcome |
|------|-----------------|----------------|
| **Cross-contract call overhead** | Medium | **Mitigated.** `creditSettlement` is non-payable (DOT already at Vault from BudgetLedger). Additional calls per settled claim: 2 (deductAndTransfer + creditSettlement). Acceptable. |
| **Re-entrancy across contracts** | High | **Mitigated.** OZ ReentrancyGuard on BudgetLedger, PaymentVault, GovernanceSlash, CampaignLifecycle. Campaigns uses manual `_locked` (cheaper PVM). GovernanceV2 follows CEI pattern (no guard — PVM too tight). |
| **State consistency** | High | **Mitigated.** Settlement flow is atomic within single nonReentrant tx. Lifecycle transitions are single-tx. 174 tests confirm no state desync. |
| **PVM size estimates wrong** | Medium | **Partially realized.** CampaignLifecycle was 30,197 B vs estimated ~24,000 B (25% over). Campaigns Core was 38,564 B vs estimated ~28,000 B (37% over). Overall restructuring still freed sufficient headroom but left less margin than planned. GovernanceV2 ended at 1,213 B spare after hardening — tightest contract. |
| **Gas increase** | Low | **Not benchmarked.** Full relay vs direct gas comparison still pending (backlog 1.7). |
| **Deploy complexity** | Low | **Deploy scripts not yet updated.** Alpha scripts target 9 contracts. Alpha-2 requires 12-contract deploy with expanded wiring. This is the current top priority. |

---

## 12. Test Plan — Results

### Test Counts

| Stage | Tests | Files | Status |
|-------|-------|-------|--------|
| Alpha (baseline) | 132 | 7 | All pass |
| Alpha-2 (restructure) | 142 | 9 | All pass |
| Alpha-2 + hardening | 142 | 9 | All pass |
| Alpha-2 + S12 blocklist | **174** | **10** | **All pass** |

### Test Files (alpha-2, 174 total)

| File | Tests | Coverage |
|------|-------|----------|
| `test/campaigns.test.ts` | — | Campaign creation, metadata, pause/resume, views |
| `test/governance.test.ts` | — | Voting, conviction 0-8, evaluation, termination, anti-grief |
| `test/settlement.test.ts` | — | Claim validation, hash chain, payment split, auto-complete |
| `test/relay.test.ts` | — | EIP-712 signatures, publisher co-sig, open campaigns |
| `test/lifecycle.test.ts` | — | Complete, terminate, expire, refund routing, authorization |
| `test/budget.test.ts` | — | Initialize, deduct, daily cap, drain, sweep dust |
| `test/vault.test.ts` | — | Credit authorization, withdrawals, reentrancy |
| `test/slash.test.ts` | — | Finalize, claim reward, sweep pool, authorization |
| `test/timelock.test.ts` | — | Propose, execute, cancel, delay enforcement |
| `test/blocklist.test.ts` | 25 | BK1-BK6 (blocklist), AL1-AL6 (allowlist) |

### PVM Compilation

All 12 contracts compile under 49,152 B PVM limit. Verified with `npx hardhat compile --network substrate`.

### Remaining Verification

- ~~Port alpha tests to alpha-2 architecture~~ **DONE**
- ~~PVM compilation clean~~ **DONE**
- Deploy scripts for 12-contract deploy — **TODO**
- Testnet deploy + E2E validation — **TODO**

---

## 13. PVM Budget — Plan vs Actual

### Pre-hardening (restructure only)

| Contract | Alpha | A2 Plan (est.) | A2 Actual | Spare | Status |
|----------|-------|----------------|-----------|-------|--------|
| PauseRegistry | 4,047 | 4,047 | 4,047 | 45,105 | Unchanged |
| Timelock | 18,342 | 18,342 | 18,342 | 30,810 | Unchanged |
| Publishers | 22,614 | ~22,800 | 22,813 | 26,339 | Minor change |
| **Campaigns** | **48,662** | **~28,000** | **38,564** | **10,588** | Restructured |
| GovernanceV2 | 39,693 | ~43,000 | 43,725 | 5,427 | +conviction 0-8 |
| GovernanceSlash | 30,298 | ~36,000 | 36,520 | 12,632 | +sweep |
| **Settlement** | **48,820** | **~38,000** | **43,132** | **6,020** | Restructured |
| Relay | 46,180 | 46,180 | 46,178 | 2,974 | Unchanged |
| ZKVerifier | 1,409 | 1,409 | 1,409 | 47,743 | Unchanged |
| **PaymentVault** | — | **~18,000** | **16,062** | **33,090** | New |
| **BudgetLedger** | — | **~22,000** | **22,345** | **26,807** | New |
| **CampaignLifecycle** | — | **~24,000** | **30,197** | **18,955** | New |

### Post-hardening + S12 (final state, 2026-03-23)

| Contract | Post-Restructure | Post-Hardening | Post-S12 | Spare | Delta |
|----------|-----------------|----------------|----------|-------|-------|
| GovernanceV2 | 43,725 | 47,939 | 47,939 | **1,213** | +4,214 |
| Relay | 46,178 | 46,178 | 46,178 | 2,974 | 0 |
| Settlement | 43,132 | 45,609 | **45,088** | **4,064** | +1,956 (net: hardening +2,477, O1 -521) |
| **Campaigns** | 38,564 | 38,023 | **42,466** | **6,686** | +3,902 |
| GovernanceSlash | 36,520 | 37,160 | 37,160 | 11,992 | +640 |
| CampaignLifecycle | 30,197 | 32,512 | 32,512 | 16,640 | +2,315 |
| BudgetLedger | 22,345 | 28,650 | 28,650 | 20,502 | +6,305 |
| **Publishers** | 22,813 | 26,775 | **35,741** | **13,411** | +12,928 |
| Timelock | 18,342 | 18,342 | 18,342 | 30,810 | 0 |
| PaymentVault | 16,062 | 16,062 | 16,062 | 33,090 | 0 |
| PauseRegistry | 4,047 | 4,047 | 4,047 | 45,105 | 0 |
| ZKVerifier | 1,409 | 1,409 | 1,409 | 47,743 | 0 |
| **Total** | 323,334 | 342,706 | **355,594** | | +32,260 |

**Hardening added 19,372 B PVM.** S12 added 13,409 B. O1 Blake2 precompile on Settlement net -521 B (removed events -2,640 B, added precompile +2,119 B). GovernanceV2 is tightest at 1,213 B spare — no further additions without restructuring.

**PVM size optimization notes:**
- Settlement ZK verification moved to DatumRelay (post-alpha, when real Groth16 is ready). Saved ~4 KB.
- Settlement admin setters consolidated into single `configure()` (4-arg, includes relay). Saved ~2 KB.
- Settlement pauseRegistry changed from typed interface to plain address + inline staticcall. Saved ~3 KB.
- Settlement `ContractReferenceChanged` events removed — string encoding costs ~660 B PVM per emit. Saved 2,640 B.
- Blake2 precompile (`hashBlake256()` single call site with code.length guard): +2,119 B. Cheaper than the ~4 KB estimate.
- **OZ ReentrancyGuard compiles 5,994 B smaller than manual `_locked` on resolc.** Never use inline guards.
- GovernanceV2 conviction weights/lockups hardcoded as if/else chains (no storage arrays). Saved ~2.7 KB vs array approach.
- All cross-contract references stored as plain `address` (no typed interface variables).

---

## Implementation Order

| Phase | Deliverable | Status | Date | Notes |
|-------|-------------|--------|------|-------|
| **Phase 1** | DatumPaymentVault + Settlement refactor | **DONE** | 2026-03-21 | Settlement 48,820 → 43,132 B. PaymentVault 16,062 B. |
| **Phase 2** | DatumBudgetLedger + Campaigns refactor | **DONE** | 2026-03-21 | Campaigns 48,662 → 38,564 B. BudgetLedger 22,345 B. |
| **Phase 3** | DatumCampaignLifecycle + Campaigns thinning | **DONE** | 2026-03-21 | CampaignLifecycle 30,197 B. Campaign struct 10 → 8 slots. |
| **Phase 4** | Hardening (S2/S3/S5/S7/C-M3/M4) + S12 blocklist | **DONE** | 2026-03-22/23 | 7 hardening stages + S12. 174 tests. +32,781 B PVM. |
| **Phase 5** | Blake2-256 + weight-limited batches | **O1 DONE, O2 DEFERRED** | 2026-03-23 | O1: Blake2 precompile added to Settlement (45,088 B, 4,064 spare). Made room by removing events (-2,640 B) + merging admin. Net -521 B. O2 exceeds both Settlement and Relay — still blocked. |

### Remaining Work

1. **Blake2 migration (extension + relay)** — Extension `behaviorChain.ts` and relay bot must switch claim hash from keccak256 to Blake2-256. `@noble/hashes` installed but unused. **Required before testnet deploy.**
2. **Deploy scripts** — Update `deploy.ts` for 12-contract deploy + wiring sequence. Settlement `configure()` now takes 4 args (relay folded in).
3. **Testnet deploy** — Deploy alpha-2 to Paseo, run E2E validation
4. **Relay fix** — Extension `signForRelay()` must POST to relay bot `/relay/submit` (currently stores locally only)
5. **O3** — `minimumBalance()` in PaymentVault withdrawals (feasible: 33,090 B spare)

### Phase 5 Status

**O1 (Blake2-256): DONE on contract side.** Made room by:
- Removing `ContractReferenceChanged` events from Settlement (saved 2,640 B — string event encoding is expensive)
- Merging `setRelayContract()` into `configure()` (4-arg)
- Blake2 precompile call cost only 2,119 B (vs estimated ~4 KB — single-function precompile is cheaper)
- Net result: -521 B vs pre-O1 Settlement. 45,088 B (4,064 spare).

Key empirical findings:
- **OZ ReentrancyGuard is 5,994 B smaller than manual `_locked` on resolc** — confirmed experimentally
- **Single precompile function costs ~2.1 KB**, not ~4 KB as previously estimated
- **String event encoding costs ~660 B PVM per emit** — avoid on size-critical contracts

**O2 (weightLeft batch abort): Still blocked.** Requires headroom in both Settlement (~4 KB) and Relay (~3.6 KB), exceeding both.

---

## 14. Governance Conviction Curves — Test Scenarios

Alpha-2 replaces Polkadot's exponential conviction model (`weight = 2^c`, `lockup = base * 2^c`) with logarithmic lockup scaling where each step up costs disproportionately more locked time per unit of voting weight. Conviction range is 0–8 with low-risk entry points (0-lock, 24h, 72h) before the main curve.

**Selected: Curve B (Balanced, extended)** — implemented in `DatumGovernanceV2.sol`.

The following alternative curves are candidates for testnet experimentation. Each uses the same lockup schedule (0 → 365d) but differs in weight multiplier, changing the risk/reward profile. Switching curves requires only updating the `_weight()` function.

### Curve A — Conservative (steep risk escalation)

Linear weight, exponential lockup. Max 6x for a full year. Every step hurts more. Discourages speculation — voters must be very sure to lock beyond conviction 2.

```
CONVICTION_WEIGHT = [0, 1, 2, 3, 4, 5, 6]

Conv │ Weight │ Lockup │ Days/x │ Marginal cost
  1  │   1x   │   7d   │   7.0  │ —
  2  │   2x   │  30d   │  15.0  │ +23d for +1x
  3  │   3x   │  90d   │  30.0  │ +60d for +1x
  4  │   4x   │ 180d   │  45.0  │ +90d for +1x
  5  │   5x   │ 270d   │  54.0  │ +90d for +1x
  6  │   6x   │ 365d   │  60.8  │ +95d for +1x
```

**When to test:** If governance sees excessive high-conviction voting or if slash penalties feel too weak. This curve makes casual high-conviction votes very expensive.

### Curve B — Balanced, extended (selected)

9-level curve (0–8) with low-risk entry (0-lock, 24h, 72h) then logarithmic escalation. Max 21x at 365d. Cost per unit rises through the middle, plateaus at the top.

```
Weights: [1, 1, 2, 3, 5, 8, 12, 16, 21]

Conv │ Weight │ Lockup │ Days/x │ Marginal cost
  0  │   1x   │    0   │   —    │ instant withdraw
  1  │   1x   │  24h   │   —    │ +24h for +0x (skin in the game)
  2  │   2x   │  72h   │   1.5  │ +48h for +1x
  3  │   3x   │   7d   │   2.3  │ +4d for +1x
  4  │   5x   │  30d   │   6.0  │ +23d for +2x
  5  │   8x   │  90d   │  11.3  │ +60d for +3x
  6  │  12x   │ 180d   │  15.0  │ +90d for +4x
  7  │  16x   │ 270d   │  16.9  │ +90d for +4x
  8  │  21x   │ 365d   │  17.4  │ +95d for +5x
```

### Curve C — Aggressive (rewards commitment)

Superlinear weight. Conviction-6 has 40x influence. Strong opinions rewarded heavily, but a wrong bet with 10% slash on a 365d lock is devastating.

```
CONVICTION_WEIGHT = [0, 1, 3, 8, 16, 28, 40]

Conv │ Weight │ Lockup │ Days/x │ Marginal cost
  1  │   1x   │   7d   │   7.0  │ —
  2  │   3x   │  30d   │  10.0  │ +23d for +2x
  3  │   8x   │  90d   │  11.3  │ +60d for +5x
  4  │  16x   │ 180d   │  11.3  │ +90d for +8x
  5  │  28x   │ 270d   │   9.6  │ +90d for +12x
  6  │  40x   │ 365d   │   9.1  │ +95d for +12x
```

**When to test:** If governance participation is too low and voters need stronger incentives. Risk: whales with conviction 6 can dominate.

### Curve D — S-curve (expensive middle, flat extremes)

Punishes "testing the waters" middle convictions. Once past the hump (conv 4+), additional commitment gets cheaper per unit. Creates a natural threshold — casual voters stay at 1-2, serious ones jump to 4+.

```
CONVICTION_WEIGHT = [0, 1, 2, 5, 12, 20, 30]

Conv │ Weight │ Lockup │ Days/x │ Marginal cost
  1  │   1x   │   7d   │   7.0  │ —
  2  │   2x   │  30d   │  15.0  │ +23d for +1x
  3  │   5x   │  90d   │  18.0  │ +60d for +3x
  4  │  12x   │ 180d   │  15.0  │ +90d for +7x
  5  │  20x   │ 270d   │  13.5  │ +90d for +8x
  6  │  30x   │ 365d   │  12.2  │ +95d for +10x
```

**When to test:** If governance bifurcates into "don't care" (conv 1) and "all in" (conv 6) with no middle ground. This curve taxes the transition zone to see if it produces more deliberate conviction selection.

### Comparison at max conviction

| Curve | Levels | Max Weight | Days/x at max | Character |
|-------|--------|-----------|---------------|-----------|
| A     | 1–6    | 6x        | 60.8          | "Every vote is expensive" |
| **B** | **0–8** | **21x**  | **17.4**      | **"Low entry, balanced top" (selected)** |
| C     | 1–6    | 40x       | 9.1           | "Conviction is king" |
| D     | 1–6    | 30x       | 12.2          | "Commit or don't bother" |

### Testing approach

Deploy each curve on testnet with identical campaign/voter scenarios and compare:
- Voter participation rate at each conviction level
- Time to quorum
- Frequency of governance terminations
- Slash pool sizes and claim rates
- Whether whale dominance emerges at high conviction
