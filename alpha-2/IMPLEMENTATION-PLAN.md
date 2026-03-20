# Alpha-2 Implementation Plan — Contract Restructuring

**Version:** 1.0
**Date:** 2026-03-20
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

1. `DatumPauseRegistry` (unchanged)
2. `DatumTimelock` (unchanged or minor modification)
3. `DatumPublishers` (unchanged)
4. `DatumPaymentVault` (new)
5. `DatumBudgetLedger` (new)
6. `DatumCampaigns` (restructured — Core only)
7. `DatumCampaignLifecycle` (new)
8. `DatumGovernanceV2` (minor interface update for getCampaignForSettlement return changes, if any)
9. `DatumGovernanceSlash` (add sweep function)
10. `DatumSettlement` (restructured — no balances)
11. `DatumRelay` (unchanged or minor)
12. `DatumZKVerifier` (unchanged)

### Wiring

Post-deploy wiring calls expand slightly:

```
campaigns.setSettlement(settlement)
campaigns.setGovernance(governance)
campaigns.setLifecycle(lifecycle)
campaigns.setBudgetLedger(budgetLedger)
settlement.setRelay(relay)
settlement.setZKVerifier(zkVerifier)
settlement.setPaymentVault(vault)
settlement.setBudgetLedger(budgetLedger)
vault.setSettlement(settlement)       // authorize credit calls
budgetLedger.setCampaigns(campaigns)  // authorize init calls
budgetLedger.setSettlement(settlement) // authorize deduct calls
budgetLedger.setLifecycle(lifecycle)  // authorize drain calls
lifecycle.setCampaigns(campaigns)
lifecycle.setBudgetLedger(budgetLedger)
governance.setCampaigns(campaigns)    // may need lifecycle reference too
slash.setCampaigns(campaigns)
// Ownership transfers to Timelock as before
```

### Extension Changes

| Component | Change |
|-----------|--------|
| Contract addresses config | Add 3 new addresses: `paymentVault`, `budgetLedger`, `campaignLifecycle` |
| Earnings panel (UserPanel.tsx) | Read `userBalance` from Vault instead of Settlement |
| Publisher panel (PublisherPanel.tsx) | Read `publisherBalance` from Vault instead of Settlement |
| Publisher withdrawal | Call `vault.withdrawPublisher()` instead of `settlement.withdrawPublisher()` |
| User withdrawal | Call `vault.withdrawUser()` instead of `settlement.withdrawUser()` |
| Claims panel (ClaimQueue.tsx) | No change — claim submission still goes through Settlement/Relay |
| Campaign creation (AdvertiserPanel.tsx) | No change — `createCampaign()` API unchanged |
| Governance (GovernancePanel.tsx) | No change unless GovernanceV2 interface changes |
| Settings (Settings.tsx) | 3 new contract address fields |
| deployed-addresses.json | 3 new entries |
| deploy.ts | Extended wiring sequence |

---

## 11. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Cross-contract call overhead** — 3 new satellite contracts = more external calls on the settlement hot path | Medium | `creditSettlement` is 1 call replacing 3 SSTORE+SLOAD pairs — net PVM reduction. `deductAndTransfer` replaces existing cross-contract call. Total additional calls per settled claim: ~1-2. |
| **Re-entrancy across contracts** — value transfers between 4+ contracts in one tx | High | PaymentVault receives DOT via `payable` function (no callback). BudgetLedger sends via `.call{value}` but only to Vault or advertiser. ReentrancyGuard on Settlement covers the full tx. Vault has its own ReentrancyGuard for withdrawals. |
| **State consistency** — campaign status in Campaigns, budget in BudgetLedger, balances in Vault must stay synchronized | High | Atomic: `_settleSingleClaim` calls BudgetLedger.deduct then Vault.credit in sequence within a single nonReentrant tx. Lifecycle transitions are single-tx (read status → drain budget → update status). No partial states possible. |
| **PVM size estimates wrong** — satellite contracts might be larger than expected | Medium | Build and measure after Phase 1 before committing to later phases. Each phase is independently valuable. |
| **Gas increase** — more cross-contract calls = more gas per settlement | Low | Pallet-revive cross-contract calls are weight-based, not gas-based. The weight cost of a CALL to a deployed contract is relatively flat. More calls but less computation per contract = roughly equivalent total weight. Benchmark after Phase 1. |
| **Deploy complexity** — 12 contracts + extended wiring | Low | `deploy.ts` already handles 9 contracts with full wiring and validation. Adding 3 more is mechanical. Post-wire validation catches misconfiguration. |

---

## 12. Test Plan

### Existing Tests (must all pass)

The 132 existing Hardhat tests cover the same functionality. After restructuring, every test must produce identical outcomes. Tests will need mechanical updates to account for new contract addresses and changed call targets for withdrawals.

### New Tests Required

| Area | Tests |
|------|-------|
| **PaymentVault** | Credit authorization (only Settlement), withdrawal flows (publisher/user/protocol), reentrancy protection, zero-balance withdrawal rejection, receive() acceptance |
| **BudgetLedger** | Initialize authorization (only Campaigns), deduct + daily cap enforcement, day rollover, auto-complete signal, drain authorization (only Lifecycle), sweep abandoned budget after timeout |
| **CampaignLifecycle** | Complete (advertiser + auto-complete), terminate (governance + slash calc + refund), expire (permissionless + block check), reentrancy protection, authorization checks |
| **Cross-contract integration** | Full settlement flow through all 4 contracts (Settlement → BudgetLedger → PaymentVault), lifecycle transition with refund through BudgetLedger, governance termination through Lifecycle |
| **GovernanceSlash sweep** | Sweep unclaimed slash pool after deadline, sweep rejection before deadline |

### Regression Strategy

1. Port all 132 existing tests to new contract addresses — adjust withdrawal calls, add setup for new contracts
2. Run full E2E script (`e2e-full-flow.ts`) against restructured contracts
3. Compile all 12 contracts with `--network polkadotHub` and verify PVM sizes
4. Deploy to local devnet and run fund-test-accounts + setup-test-campaign
5. Deploy to Paseo testnet and run `setup:testnet`

---

## 13. Estimated PVM Budget After Restructuring

| Contract | Alpha (current) | Alpha-2 (est.) | Spare (est.) | Status |
|----------|----------------|----------------|-------------|--------|
| PauseRegistry | 4,047 | 4,047 | 45,105 | Unchanged |
| Timelock | 18,342 | 18,342 | 30,810 | Unchanged |
| Publishers | 22,614 | 22,614 | 26,538 | Unchanged |
| **Campaigns (Core)** | **48,662** | **~28,000** | **~21,000** | Restructured |
| GovernanceV2 | 39,693 | 39,693 | 9,459 | Unchanged |
| GovernanceSlash | 30,298 | ~31,800 | ~17,350 | +sweep |
| **Settlement** | **48,820** | **~38,000** | **~11,000** | Restructured |
| Relay | 46,180 | 46,180 | 2,972 | Unchanged |
| ZKVerifier | 1,409 | 1,409 | 47,743 | Unchanged |
| **PaymentVault** | — | **~18,000** | **~31,000** | New |
| **BudgetLedger** | — | **~22,000** | **~27,000** | New |
| **CampaignLifecycle** | — | **~24,000** | **~25,000** | New |

**Total PVM across 12 contracts:** ~294,000 B (vs ~260,000 B across 9 contracts currently). The 34,000 B increase in total bytecode is traded for ~32,000 B of freed headroom in the two critical contracts.

---

## Implementation Order

| Phase | Deliverable | Depends On | Unblocks |
|-------|-------------|------------|----------|
| **Phase 1** | DatumPaymentVault + Settlement refactor | Nothing | O1, O3, S3, S4 in Settlement |
| **Phase 2** | DatumBudgetLedger + Campaigns refactor | Phase 1 (Settlement needs new deduct path) | S2, S3, P20, M4 in Campaigns |
| **Phase 3** | DatumCampaignLifecycle + Campaigns thinning | Phase 2 (Lifecycle needs BudgetLedger) | Maximum headroom in Campaigns |
| **Phase 4** | Hardening items across all contracts | Phases 1-3 | Mainnet readiness |
| **Phase 5** | Blake2-256 + weight-limited batches | Phase 1 + extension update | Gas optimization |

Each phase is independently deployable and testable. Phase 1 alone solves Settlement's most critical constraint. Phases can be implemented incrementally with full test coverage at each step.
