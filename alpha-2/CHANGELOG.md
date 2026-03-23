# Alpha-2 Changelog

**Date:** 2026-03-22 (hardening) / 2026-03-23 (S12 blocklist)
**Compiler:** resolc 1.0.0 (up from 0.3.0)
**Status:** All 12 contracts compile. All under 49,152 B PVM limit. 174 tests passing.

---

## Summary

Alpha-2 restructures the DATUM protocol from 9 to 12 contracts to break the PVM bytecode ceiling that blocked all further development on Campaigns (490 B spare) and Settlement (332 B spare). Three new satellite contracts were extracted, the governance conviction model was replaced with a logarithmic curve, and the toolchain was upgraded to resolc 1.0.0.

The restructuring freed **16,608 B** of combined headroom in the two critical contracts (Campaigns + Settlement), up from 822 B in alpha. This unblocks 8 deferred hardening items, 5 gas optimizations, and 3 feature requirements.

---

## Architecture: 9 → 12 Contracts

Three new satellites extracted from the two over-sized contracts:

| New Contract | Extracted From | Responsibility | PVM Size |
|---|---|---|---|
| **DatumPaymentVault** | Settlement | Pull-payment balances, 3 withdrawals, `_send()` | 16,062 B |
| **DatumBudgetLedger** | Campaigns | Budget escrow, daily caps, deduct-and-transfer | 22,345 B |
| **DatumCampaignLifecycle** | Campaigns | Complete, terminate, expire with refund routing | 30,197 B |

### DOT Payment Flow (new)

```
Advertiser → createCampaign{value} → Campaigns → BudgetLedger.initializeBudget{value}
                                                    (DOT held by BudgetLedger)

Settlement._settleSingleClaim:
  BudgetLedger.deductAndTransfer(campaignId, amount, paymentVault)
    → BudgetLedger sends DOT directly to PaymentVault
  PaymentVault.creditSettlement(publisher, pubPay, user, userPay, protocolFee)
    → non-payable: records balance split only (DOT already at Vault)

Lifecycle.terminateCampaign / completeCampaign / expirePendingCampaign:
  BudgetLedger.drainToAdvertiser(campaignId, advertiser)
    → refunds remaining budget to advertiser
```

### Governance Termination Chain (new)

```
GovernanceV2.evaluateCampaign()
  → lifecycle.terminateCampaign(campaignId)         [direct call, not via Campaigns]
    → campaigns.setCampaignStatus(id, Terminated)   [gated to lifecycleContract]
    → campaigns.setTerminationBlock(id, block.number)
    → budgetLedger.drainFraction(id, advertiser, refundPct)
```

GovernanceV2 calls Lifecycle directly (not through Campaigns), so `msg.sender == governanceContract` check works correctly in Lifecycle.

---

## Contract Changes

### DatumCampaigns — Restructured

- Campaign struct slimmed from 10 to 8 slots (budget fields removed)
- `setCampaignStatus()` and `setTerminationBlock()` added, gated to `lifecycleContract`
- `createCampaign()` calls `budgetLedger.initializeBudget{value}()` instead of writing budget fields
- Removed: `completeCampaign`, `terminateCampaign`, `expirePendingCampaign`, `deductBudget`, `getCampaignRemainingBudget`
- `getCampaignForSettlement()` now returns 4 values (no `remainingBudget` — lives on BudgetLedger)
- **Size: 48,662 → 38,564 B (10,098 B freed, 10,588 spare)**

### DatumSettlement — Restructured

- Pull-payment balances + 3 withdrawals extracted to PaymentVault
- Budget deduction routed through BudgetLedger (not Campaigns)
- Auto-complete on budget exhaustion calls CampaignLifecycle
- ZK proof verification removed entirely (stub, moved to post-alpha)
- `IDatumPauseRegistry` typed interface replaced with plain `address` + inline staticcall
- Admin setters consolidated: `configure(budgetLedger, paymentVault, lifecycle)` replaces 3 individual setters
- `setZKVerifier()` removed
- Cross-contract calls use hardcoded `bytes4` selectors (same PVM size as string signatures — resolc optimizes both)
- **Size: 48,820 → 43,132 B (5,688 B freed, 6,020 spare)**

### DatumGovernanceV2 — Logarithmic Conviction

Replaced Polkadot's exponential conviction model with logarithmic lockup scaling. Conviction 0–8 with low-risk entry points (0-lock, 24h, 72h) and escalating cost through the upper range:

| Conv | Weight | Lockup | Blocks | Marginal Cost |
|------|--------|--------|--------|---------------|
| 0 | 1x | 0 | 0 | instant withdraw |
| 1 | 2x | 1d | 14,400 | +1d for +1x (low-risk entry) |
| 2 | 3x | 3d | 43,200 | +2d for +1x |
| 3 | 4x | 7d | 100,800 | +4d for +1x |
| 4 | 6x | 21d | 302,400 | +14d for +2x |
| 5 | 9x | 90d | 1,296,000 | +69d for +3x |
| 6 | 14x | 180d | 2,592,000 | +90d for +5x |
| 7 | 18x | 270d | 3,888,000 | +90d for +4x |
| 8 | 21x | 365d | 5,256,000 | +95d for +3x |

- Conviction 0–8 (9 levels). Conv 0 = no lock, conv 1 = 1d commitment, max 21x at 365d
- Weights and lockups hardcoded as `if/else` chains in pure internal functions (saves ~2.7 KB vs storage arrays)
- Constructor takes 5 params (removed `baseLockup`, `maxLockup` — lockups are hardcoded)
- `convictionWeight(uint8)` external pure view added for GovernanceSlash
- Termination calls Lifecycle directly (not via Campaigns)
- Alternative curves documented in IMPLEMENTATION-PLAN.md §14
- **Size: 39,693 → 43,725 B (+4,032 B from new features, 5,427 spare)**

### DatumGovernanceSlash — Sweep Added

- `sweepSlashPool()` added (M4): permissionless after `SWEEP_DEADLINE_BLOCKS` (5,256,000 = ~365 days)
- `finalizedBlock` mapping tracks when finalization happened
- Uses `convictionWeight()` view from GovernanceV2 for consistent weight calculation
- **Size: 30,298 → 36,520 B (+6,222 B, 12,632 spare)**

### DatumPublishers — S5 Global Pause

- Replaced OZ `Pausable` with global `DatumPauseRegistry` check (S5: consistent with all other contracts)
- Constructor now takes `_pauseRegistry` address as second argument
- Removed `pause()`/`unpause()` owner functions (no longer has local pause state)
- Custom `whenNotPaused` modifier calls `pauseRegistry.paused()`
- **Size: 22,614 → 26,775 B (+4,161 B, 22,377 spare)**

### DatumRelay — Unchanged

- Updated for 4-value `getCampaignForSettlement` return (no `remainingBudget`)
- **Size: 46,180 → 46,178 B (2,974 spare)**

### Unchanged Contracts

- DatumPauseRegistry: 4,047 B
- DatumTimelock: 18,342 B
- DatumZKVerifier: 1,409 B

---

## New Interfaces

| Interface | Key Functions |
|---|---|
| `IDatumPaymentVault` | `creditSettlement` (non-payable), `withdrawPublisher`, `withdrawUser`, `withdrawProtocol` |
| `IDatumBudgetLedger` | `initializeBudget` (payable), `deductAndTransfer`, `drainToAdvertiser`, `drainFraction` |
| `IDatumCampaignLifecycle` | `completeCampaign`, `terminateCampaign`, `expirePendingCampaign` |

### Updated Interfaces

- `IDatumCampaigns`: Campaign struct (8 fields), added `setCampaignStatus`, `setTerminationBlock`, `getCampaignPublisher`, `getPendingExpiryBlock`, `lifecycleContract`; removed `completeCampaign`, `terminateCampaign`, `expirePendingCampaign`, `deductBudget`, `getCampaignRemainingBudget`
- `IDatumCampaignsMinimal`: Removed `terminateCampaign`; 4-value `getCampaignForSettlement`
- `IDatumSettlement`: Removed withdrawal functions and balance views (moved to PaymentVault)

---

## PVM Size Budget

| Contract | Alpha | A2 Pre-Harden | A2 Post-Harden | A2 Post-S12 | Spare | Notes |
|---|---|---|---|---|---|---|
| **DatumGovernanceV2** | 39,693 | 43,725 | 47,939 | 47,939 | **1,213** | tightest — no S12 check |
| DatumRelay | 46,180 | 46,178 | 46,178 | 46,178 | 2,974 | unchanged |
| DatumSettlement | 48,820 | 43,132 | 45,609 | 45,609 | 3,543 | S12 check deferred |
| **DatumCampaigns** | 48,662 | 38,564 | 38,023 | **42,466** | **6,686** | +S12 blocklist+allowlist checks |
| DatumGovernanceSlash | 30,298 | 36,520 | 37,160 | 37,160 | 11,992 | unchanged |
| DatumCampaignLifecycle | — | 30,197 | 32,512 | 32,512 | 16,640 | unchanged |
| DatumBudgetLedger | — | 22,345 | 28,650 | 28,650 | 20,502 | unchanged |
| **DatumPublishers** | 22,614 | 22,813 | 26,775 | **35,741** | **13,411** | +S12 blocklist+allowlist |
| DatumTimelock | 18,342 | 18,342 | 18,342 | 18,342 | 30,810 | unchanged |
| DatumPaymentVault | — | 16,062 | 16,062 | 16,062 | 33,090 | unchanged |
| DatumPauseRegistry | 4,047 | 4,047 | 4,047 | 4,047 | 45,105 | unchanged |
| DatumZKVerifier | 1,409 | 1,409 | 1,409 | 1,409 | 47,743 | unchanged |
| **Total** | **~260,065** | **323,334** | **342,706** | **356,115** | | **+13,409 B S12** |

Hardening added 19,372 B PVM across 8 contracts. S12 added 13,409 B across 2 contracts. GovernanceV2 remains tightest at 1,213 B spare.

---

## Toolchain

- **resolc:** 0.3.0 → 1.0.0 (`@parity/resolc: ^1.0.0`)
- **Hardhat plugin:** `@parity/hardhat-polkadot-resolc` (unchanged)
- **Solidity:** 0.8.24 (unchanged)
- **OpenZeppelin:** 5.0 (unchanged)
- **Optimizer:** LLVM level `z` (optimize for size)

### resolc 1.0.0 Notable Changes

- `calldataload`/`calldatacopy` OOB fix (correctness)
- Selective bytecode compilation
- v0.6.0 `--relax` linker option for potentially smaller code
- `transfer()` multi-site codegen bug status unknown — `_send()` workaround retained

---

## PVM Size Optimization Findings

Lessons learned during alpha-2 development:

| Technique | Savings | Notes |
|---|---|---|
| Plain `address` instead of typed interface variables (`IDatumFoo public foo`) | ~3 KB per variable | Typed interface generates ABI overhead in PVM |
| Consolidating admin setters into single `configure()` | ~2 KB | Fewer function dispatch entries |
| Removing `IDatumPauseRegistry` import → plain address + inline staticcall | ~3 KB | Avoids importing interface |
| Hardcoded `if/else` conviction lookup vs storage arrays | ~2.7 KB | Pure functions cheaper than SLOAD chains |
| `abi.encodeWithSelector(bytes4)` vs `abi.encodeWithSignature(string)` | **0 B** | resolc optimizes both identically |
| OZ `ReentrancyGuard` modifier vs manual `_locked` bool | OZ is **smaller** | Counterintuitive — modifiers compile smaller |
| Removing ZK verification (staticcall + bytes handling + abi.decode) | ~4 KB | Significant for large contracts near the limit |

---

## Items Now Unblocked

The restructuring unblocks backlog items that were previously impossible due to PVM size constraints:

### Contract Hardening (was blocked)
- S2: Zero-address checks on all setters
- S3: Events on contract reference changes
- S4: ZK verification empty-return guard (when re-added)
- M4: Governance sweep of abandoned funds (GovernanceSlash: done; BudgetLedger: ready)

### Gas Optimizations (was blocked)
- O1: Blake2-256 claim hashing via system precompile (Settlement now has 6,020 B spare)
- O3: `minimumBalance()` dust guard in Settlement
- O2: `weightLeft()` batch loop early abort (still tight on Relay: 2,974 B spare)

### Features (was blocked)
- P20: Campaign inactivity timeout (Campaigns now has 10,588 B spare)

---

## Contract Hardening (2026-03-22)

Seven hardening stages applied across 6 contracts. All 142 tests passing, PVM compilation clean.

### Changes by Contract

| Stage | Contract | Change | PVM Delta |
|-------|----------|--------|-----------|
| 1 | **BudgetLedger** | OZ `ReentrancyGuard` on `deductAndTransfer`, `drainToAdvertiser`, `drainFraction`. `ContractReferenceChanged` events on 3 admin setters. | +2,822 B |
| 2 | **Settlement** | Zero-address check on `setRelayContract()`. `ContractReferenceChanged` events on `configure()` (3 refs) and `setRelayContract()`. | +2,477 B |
| 3 | **GovernanceSlash** | OZ `ReentrancyGuard` on `claimSlashReward`, `sweepSlashPool`. | +640 B |
| 4 | **CampaignLifecycle** | `ContractReferenceChanged` events on `setCampaigns`, `setBudgetLedger`, `setGovernanceContract`, `setSettlementContract`. | +2,315 B |
| 5 | **GovernanceV2** | `ContractReferenceChanged` events on `setSlashContract`, `setLifecycle`. | +4,214 B |
| 6 | **Campaigns** | Manual `noReentrant` guard (`_locked` bool, E57) on `createCampaign`. | -541 B |
| 7 | **GovernanceSlash** | Error code dedup: E52→E59 (slash already finalized), E53→E60 (not resolved), E03→E61 (zero slash balance). Extension `errorCodes.ts` updated. | ~0 B |
| 8 | **Publishers** | S5: Replaced OZ `Pausable` with global `DatumPauseRegistry`. Constructor takes `_pauseRegistry` address. Removed local `pause()`/`unpause()`. | +3,962 B |
| 9 | **BudgetLedger** | M4: `sweepDust(campaignId)` — permissionless sweep of terminal campaign dust to protocol owner. Checks campaign status via staticcall to `getCampaignStatus()`. | +3,483 B |

### Backlog Items Resolved

- **S2:** Zero-address checks on contract reference setters — complete across all contracts.
- **S3:** Events on contract reference changes — `ContractReferenceChanged(name, oldAddr, newAddr)` emitted by all 6 contracts with admin setters (Campaigns already had this; BudgetLedger, Settlement, CampaignLifecycle, GovernanceV2 added).
- **C-M3:** Reentrancy consistency — BudgetLedger now has OZ `ReentrancyGuard` (was the only value-transfer contract without one). Campaigns uses manual `_locked` (cheaper PVM than OZ import).
- **S5:** Publishers dual pause — replaced OZ `Pausable` with global `pauseRegistry.paused()`. All contracts now use the same circuit breaker.
- **S7:** Error code E03/E52/E53 dual meanings — GovernanceSlash now uses E59/E60/E61.
- **M4:** Budget dust sweep — `BudgetLedger.sweepDust()` clears rounding dust from terminal campaigns (Completed/Terminated/Expired). Permissionless, sends to protocol owner. Combined with GovernanceSlash `sweepSlashPool()`, all abandoned funds now have a reclaim path.

### Error Code Changes

| Old | New | Context |
|-----|-----|---------|
| E52 (GovernanceSlash) | **E59** | Slash already finalized for campaign |
| E53 (GovernanceSlash) | **E60** | Campaign not yet resolved (cannot finalize slash) |
| E03 (GovernanceSlash) | **E61** | No slash pool to claim or sweep (zero balance) |

E52/E53 in GovernanceV2 (termination quorum / grace period) remain unchanged.

### Reentrancy Guard Coverage (post-hardening)

| Contract | Guard | Value Transfers |
|----------|-------|-----------------|
| BudgetLedger | OZ `ReentrancyGuard` | `deductAndTransfer`, `drainToAdvertiser`, `drainFraction` |
| Settlement | OZ `ReentrancyGuard` | via BudgetLedger/PaymentVault calls |
| CampaignLifecycle | OZ `ReentrancyGuard` | via BudgetLedger drain calls |
| PaymentVault | OZ `ReentrancyGuard` | `withdrawPublisher`, `withdrawUser`, `withdrawProtocol` |
| GovernanceV2 | — | `withdraw` (direct `.call{value}`), `slashAction` (direct `.call{value}`) |
| GovernanceSlash | OZ `ReentrancyGuard` | via `slashAction` on GovernanceV2 |
| Campaigns | Manual `_locked` | `createCampaign` (forwards to BudgetLedger) |
| Publishers | OZ `ReentrancyGuard` | none (no value transfers, defense-in-depth) |

**Note:** GovernanceV2 `withdraw()` and `slashAction()` lack reentrancy guards but follow checks-effects-interactions (state zeroed before `.call{value}`). Adding OZ `ReentrancyGuard` would exceed PVM limit (only 1,213 B spare).

---

## S12: On-Chain Blocklist & Publisher Allowlist (2026-03-23)

Global address blocklist and per-publisher advertiser allowlist. 25 new tests, 174 total.

### DatumPublishers (+8,966 B PVM)

- **Global blocklist:** `mapping(address => bool) public blocked`. Owner-managed via `blockAddress()`/`unblockAddress()` (both `onlyOwner`, require non-zero address).
- **Blocklist on registration:** `registerPublisher()` checks `!blocked[msg.sender]` (E62).
- **Per-publisher allowlist:** `allowlistEnabled` mapping + `_allowedAdvertisers` nested mapping. Publishers toggle via `setAllowlistEnabled()`, manage entries via `setAllowedAdvertiser()`. Both gated to registered publishers and respect global pause.
- **Views:** `isBlocked(addr)`, `isAllowedAdvertiser(publisher, advertiser)`.
- **Events:** `AddressBlocked`, `AddressUnblocked`, `AllowlistToggled`, `AdvertiserAllowlistUpdated`.

### DatumCampaigns (+4,443 B PVM)

- **createCampaign blocklist checks:** `!publishers.isBlocked(msg.sender)` (E62) for advertiser, `!publishers.isBlocked(publisher)` (E62) for targeted publisher (non-zero only).
- **createCampaign allowlist check:** If `publisher != address(0) && publishers.allowlistEnabled(publisher)`, require `publishers.isAllowedAdvertiser(publisher, msg.sender)` (E63). Open campaigns (`publisher=address(0)`) bypass allowlist entirely.

### What was NOT implemented (deferred)

- **Settlement claim check:** Skipped (3,543 B spare, ~800 B cost). Existing campaigns with a newly-blocked publisher can still settle.
- **GovernanceV2 vote check:** Skipped (1,213 B spare, no room). Blocked voting is low-risk.
- **Timelock gating:** Direct `onlyOwner` for alpha. **Must migrate to timelock before mainnet.**
- **Governance-managed blocklist:** Future goal — open blocklist to governance control (Option C hybrid: admin emergency block + governance override).

### New Error Codes

| Code | Meaning |
|------|---------|
| **E62** | Address is blocked (advertiser or publisher on protocol deny list) |
| **E63** | Advertiser not on publisher's allowlist |

### Tests (25 new, `test/blocklist.test.ts`)

- BK1-BK6: Global blocklist (add, remove, events, access control, registerPublisher, createCampaign, open campaigns)
- AL1-AL6: Per-publisher allowlist (toggle, entries, events, createCampaign enforce, open campaign bypass, pause respect)

---

## Remaining Work

1. ~~**Tests:** Port alpha's 132 Hardhat tests to alpha-2 architecture~~ — **Done.** 174 tests across 10 test files (includes S12 blocklist).
2. **Deploy scripts:** Update `deploy.ts` for 12-contract deploy + extended wiring sequence
3. ~~**Extension:** Update contract addresses config (3 new addresses), redirect withdrawal calls to PaymentVault~~ — **Done.** Extension v0.2.0 with 12-contract support, 140/140 Jest tests.
4. **Testnet deploy:** Deploy alpha-2 to Paseo, run E2E validation
5. **Relay fix:** Extension `signForRelay()` must POST signed batches to relay bot `/relay/submit` — currently stores locally only (see PROCESS-FLOWS.md §10.1)
