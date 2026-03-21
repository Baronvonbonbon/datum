# Alpha-2 Changelog

**Date:** 2026-03-20
**Compiler:** resolc 1.0.0 (up from 0.3.0)
**Status:** All 12 contracts compile. All under 49,152 B PVM limit. No tests yet.

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

| Conv | Weight | Lockup | Days/x | Marginal Cost |
|------|--------|--------|--------|---------------|
| 0 | 1x | 0 | — | instant withdraw |
| 1 | 1x | 24h | — | +24h for +0x (skin in the game) |
| 2 | 2x | 72h | 1.5 | +48h for +1x |
| 3 | 3x | 7d | 2.3 | +4d for +1x |
| 4 | 5x | 30d | 6.0 | +23d for +2x |
| 5 | 8x | 90d | 11.3 | +60d for +3x |
| 6 | 12x | 180d | 15.0 | +90d for +4x |
| 7 | 16x | 270d | 16.9 | +90d for +4x |
| 8 | 21x | 365d | 17.4 | +95d for +5x |

- Conviction 0–8 (9 levels). Conv 0 = no lock, conv 1 = 24h commitment, max 21x at 365d
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

### DatumPublishers — Minor

- **Size: 22,614 → 22,813 B (+199 B, 26,339 spare)**

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

| Contract | Alpha | Alpha-2 | Spare | Delta |
|---|---|---|---|---|
| DatumRelay | 46,180 | 46,178 | 2,974 | -2 |
| DatumGovernanceV2 | 39,693 | 43,725 | 5,427 | +4,032 |
| **DatumSettlement** | **48,820** | **43,132** | **6,020** | **-5,688** |
| **DatumCampaigns** | **48,662** | **38,564** | **10,588** | **-10,098** |
| DatumGovernanceSlash | 30,298 | 36,520 | 12,632 | +6,222 |
| DatumCampaignLifecycle | — | 30,197 | 18,955 | new |
| DatumPublishers | 22,614 | 22,813 | 26,339 | +199 |
| DatumBudgetLedger | — | 22,345 | 26,807 | new |
| DatumTimelock | 18,342 | 18,342 | 30,810 | 0 |
| DatumPaymentVault | — | 16,062 | 33,090 | new |
| DatumPauseRegistry | 4,047 | 4,047 | 45,105 | 0 |
| DatumZKVerifier | 1,409 | 1,409 | 47,743 | 0 |
| **Total** | **~260,065** | **323,280** | | **+63,215** |

Total PVM increase is 63 KB across 12 contracts (3 new), but the two critical contracts shed a combined 15,786 B — the headroom that matters.

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

## Remaining Work

1. **Tests:** Port alpha's 132 Hardhat tests to alpha-2 architecture, add tests for 3 new satellites + conviction curve + cross-contract flows
2. **Deploy scripts:** Update `deploy.ts` for 12-contract deploy + extended wiring sequence
3. **Extension:** Update contract addresses config (3 new addresses), redirect withdrawal calls to PaymentVault, update conviction display for 1–6 range
4. **Testnet deploy:** Deploy alpha-2 to Paseo, run E2E validation
