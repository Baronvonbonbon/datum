# Alpha-2 Changelog

**Date:** 2026-03-22 (hardening) / 2026-03-23 (S12 blocklist, Blake2 precompile) / 2026-03-24 (P1, P20)
**Compiler:** resolc 1.0.0 (up from 0.3.0)
**Status:** All 13 contracts compile. All under 49,152 B PVM limit. 185 tests passing.

---

## Summary

Alpha-2 restructures the DATUM protocol from 9 to 13 contracts to break the PVM bytecode ceiling that blocked all further development on Campaigns (490 B spare) and Settlement (332 B spare). Three new satellite contracts were extracted, the governance conviction model was replaced with a logarithmic curve, and the toolchain was upgraded to resolc 1.0.0.

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

### DatumSettlement — Restructured + Blake2 Precompile + S12 Blocklist

- Pull-payment balances + 3 withdrawals extracted to PaymentVault
- Budget deduction routed through BudgetLedger (not Campaigns)
- Auto-complete on budget exhaustion calls CampaignLifecycle
- ZK proof verification removed entirely (stub, moved to post-alpha)
- `IDatumPauseRegistry` typed interface replaced with plain `address` + inline staticcall
- Admin setters consolidated: `configure(budgetLedger, paymentVault, lifecycle, relay, publishers)` — single 5-arg function
- `setZKVerifier()` removed
- Cross-contract calls use hardcoded `bytes4` selectors (same PVM size as string signatures — resolc optimizes both)
- **O1: Blake2-256 claim hashing** via `ISystem(0x900).hashBlake256()` precompile — ~3x cheaper than keccak256 per claim on Substrate. Falls back to keccak256 on Hardhat EVM (via `SYSTEM_ADDR.code.length > 0` guard). Fits by removing `ContractReferenceChanged` events and merging admin functions.
- **S12: Settlement blocklist check** — `_validateClaim()` calls `publishers.isBlocked(claim.publisher)` via staticcall. Blocked publishers' claims rejected with reason code 11. Graceful rejection (not revert) — remaining claims in batch continue processing.
- **Size: 48,820 → 47,216 B (1,606 B freed, 1,936 spare)**

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
| DatumSettlement | 48,820 | 43,132 | 45,609 | **48,052** | **1,100** | O1 Blake2 + S12 blocklist + P1 verifier auth |
| **DatumCampaigns** | 48,662 | 38,564 | 38,023 | **42,466** | **6,686** | +S12 blocklist+allowlist checks |
| DatumGovernanceSlash | 30,298 | 36,520 | 37,160 | 37,160 | 11,992 | unchanged |
| DatumCampaignLifecycle | — | 30,197 | 32,512 | **40,910** | **8,242** | P20 inactivity timeout |
| DatumBudgetLedger | — | 22,345 | 28,650 | **29,809** | **19,343** | P20 lastSettlementBlock |
| DatumAttestationVerifier | — | — | — | **35,920** | **13,232** | P1 new contract |
| **DatumPublishers** | 22,614 | 22,813 | 26,775 | **35,741** | **13,411** | +S12 blocklist+allowlist |
| DatumTimelock | 18,342 | 18,342 | 18,342 | 18,342 | 30,810 | unchanged |
| DatumPaymentVault | — | 16,062 | 16,062 | **17,341** | **31,811** | O3 minimumBalance dust guard |
| DatumPauseRegistry | 4,047 | 4,047 | 4,047 | 4,047 | 45,105 | unchanged |
| DatumZKVerifier | 1,409 | 1,409 | 1,409 | 1,409 | 47,743 | unchanged |
| **Total** | **~260,065** | **323,334** | **342,706** | **405,314** | | 13 contracts |

Hardening added 19,372 B PVM. S12 added 15,537 B across 3 contracts. O1 Blake2 net -521 B. O3 dust guard +1,279 B. P20 inactivity timeout +9,557 B (BudgetLedger + Lifecycle). P1 attestation verifier +36,756 B (new contract + Settlement auth). Settlement tightest at 1,100 B spare.

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
| Plain `address` instead of typed interface variables (`IDatumFoo public foo`) | ~3 KB per variable | **Only when the interface is not already imported.** If the contract already imports the interface (e.g., Relay imports `IDatumCampaignsSettlement`), the typed variable adds negligible cost and replacing with inline staticcall is **+1,160 B worse** (tested on Relay: 46,178 → 47,338 B). Same amortization pattern as OZ. |
| Consolidating admin setters into single `configure()` | ~2 KB | Fewer function dispatch entries |
| Hardcoded `if/else` conviction lookup vs storage arrays | ~2.7 KB | Pure functions cheaper than SLOAD chains |
| `abi.encodeWithSelector(bytes4)` vs `abi.encodeWithSignature(string)` | **0 B** | resolc optimizes both identically |
| OZ `ReentrancyGuard` modifier vs manual `_locked` bool | **Depends on existing OZ usage** | If contract already imports OZ (Settlement): OZ saves **5,994 B** — import cost amortized. If contract has no other OZ imports (Campaigns): OZ costs **+707 B** — import overhead exceeds single-site modifier savings. **Rule:** use OZ when the contract already inherits OZ; use manual `_locked` when it would be the only OZ import. |
| Removing ZK verification (staticcall + bytes handling + abi.decode) | ~4 KB | Significant for large contracts near the limit |
| Removing `ContractReferenceChanged` events (4 string emits) | ~2,640 B | Event string encoding is expensive in PVM. Remove from size-critical contracts. |
| ISystem precompile (hashBlake256 only, with code.length guard + keccak fallback) | +2,119 B | Cheaper than estimated ~4 KB — single precompile function costs less than multi-function interface. |
| Merging `setRelayContract()` into `configure()` (4→5 arg) | included above | Eliminating one external function saves dispatch + validation overhead. |

---

## Items Now Unblocked

The restructuring unblocks backlog items that were previously impossible due to PVM size constraints:

### Contract Hardening (was blocked)
- S2: Zero-address checks on all setters
- S3: Events on contract reference changes
- S4: ZK verification empty-return guard (when re-added)
- M4: Governance sweep of abandoned funds (GovernanceSlash: done; BudgetLedger: ready)

### Gas Optimizations (was blocked)
- **O1: Blake2-256 claim hashing — DONE.** `hashBlake256()` precompile in `_validateClaim()`. Made room by removing events (-2,640 B) + merging admin. Net -521 B vs pre-O1. Settlement now 45,088 B (4,064 spare). Extension + relay still use keccak256 — must migrate for end-to-end Blake2.
- **O3: `minimumBalance()` dust guard in PaymentVault — DONE.** E58 on all 3 withdrawal paths. +1,279 B (31,811 spare).
- O2: `weightLeft()` batch loop early abort (still tight on Relay: 2,974 B spare)
- ~~O4: `has_key()` storage precompile~~ — **Not implementable.** Pallet-revive does not expose storage-level precompiles through Solidity.

### Features (was blocked)
- P20: Campaign inactivity timeout (Campaigns now has 10,588 B spare)

---

## Contract Hardening (2026-03-22)

Seven hardening stages applied across 6 contracts. All 142 tests passing, PVM compilation clean.

### Changes by Contract

| Stage | Contract | Change | PVM Delta |
|-------|----------|--------|-----------|
| 1 | **BudgetLedger** | OZ `ReentrancyGuard` on `deductAndTransfer`, `drainToAdvertiser`, `drainFraction`. `ContractReferenceChanged` events on 3 admin setters. | +2,822 B |
| 2 | **Settlement** | Zero-address check on `setRelayContract()`. `ContractReferenceChanged` events on `configure()` (3 refs) and `setRelayContract()`. **Later reverted:** events removed and `setRelayContract()` merged into `configure()` to make room for O1 Blake2 precompile. | +2,477 B → net -521 B |
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
- **C-M3:** Reentrancy consistency — BudgetLedger now has OZ `ReentrancyGuard` (was the only value-transfer contract without one). Campaigns uses manual `_locked` — **verified cheaper** (+707 B if switched to OZ, because Campaigns has no other OZ imports to amortize the cost).
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
| Campaigns | Manual `_locked` (optimal — no OZ imports to amortize) | `createCampaign` (forwards to BudgetLedger) |
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

### DatumSettlement (+2,128 B PVM)

- **Settlement claim validation:** `_validateClaim()` calls `publishers.isBlocked(claim.publisher)` via inline staticcall. Rejected with reason code 11 (graceful, not revert). New `address public publishers` storage variable. `configure()` expanded from 4-arg to 5-arg (added `_publishers`).
- **Size: 45,088 → 47,216 B (+2,128 B, 1,936 spare)**

### What was NOT implemented (deferred)

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

## O3: minimumBalance() Dust Guard in PaymentVault (2026-03-24)

All three PaymentVault withdrawal paths (`withdrawPublisher`, `withdrawUser`, `withdrawProtocol`) now check `SYSTEM.minimumBalance()` on PolkaVM before sending DOT. Transfers below the existential deposit are rejected with E58, preventing dust accounts.

- Uses same `SYSTEM_ADDR.code.length > 0` guard pattern as GovernanceV2 and Settlement
- Check is in the single `_send()` internal function — covers all 3 withdrawal paths
- On Hardhat EVM, the guard is false (no precompile) — withdrawals proceed without the check
- **PVM cost: +1,279 B** (PaymentVault: 16,062 → 17,341 B, 31,811 spare)

This matches GovernanceV2's existing E58 dust prevention. All contracts that transfer native DOT to external addresses now guard against dust:
- **GovernanceV2:** `withdraw()` + `slashAction()` — E58
- **PaymentVault:** `_send()` (all 3 withdrawals) — E58
- **BudgetLedger:** `drainToAdvertiser()` / `drainFraction()` — no guard (sends to known advertiser addresses, amounts are budget-scale)

### O4: Storage Precompile `has_key()` — Not Implementable

O4 proposed using a `has_key()` storage precompile for cheaper existence checks on voted/registered mappings. Investigation found that pallet-revive does not expose storage-level precompiles through Solidity. The System precompile at 0x900 only provides `minimumBalance()`, `weightLeft()`, and `hashBlake256()`. O4 requires pallet-revive to add a Solidity-callable storage existence check, which is not available. **Closed as not implementable with current toolchain.**

---

## O1: Blake2-256 Claim Hashing via System Precompile (2026-03-23)

Settlement claim hash validation switched from `keccak256` to `ISystem(0x900).hashBlake256()` with automatic keccak256 fallback on EVM (Hardhat tests).

### Problem

Blake2-256 is the native Substrate hash — ~3x cheaper gas than keccak256 on pallet-revive. O1 was blocked: the precompile call was estimated at ~4 KB PVM, but Settlement only had 3,543 B spare.

### Solution

Made room by removing low-value PVM overhead, then added the precompile:

| Change | PVM Delta |
|--------|-----------|
| Remove `ContractReferenceChanged` events (4 string-encoded emits in `configure()` + `setRelayContract()`) | **-2,640 B** |
| Merge `setRelayContract()` into `configure()` (now 4-arg: budgetLedger, paymentVault, lifecycle, relay) | (included above) |
| Add ISystem import + `SYSTEM`/`SYSTEM_ADDR` constants + `hashBlake256()` call + `code.length` guard + keccak fallback | **+2,119 B** |
| **Net** | **-521 B** |

### Key Finding: Precompile Cost Lower Than Expected

Previous estimate was ~4 KB PVM per precompile staticcall. Actual cost for a single `hashBlake256()` call with `code.length > 0` guard was **2,119 B** — roughly half. The ~4 KB estimate was for multi-function interface usage (e.g., GovernanceV2 uses both `minimumBalance()` across two call sites). A single-function, single-call-site precompile is significantly cheaper.

### Key Finding: Typed Interface Variables — Same Amortization as OZ

Tested replacing `IDatumCampaignsSettlement public campaigns` and `IDatumPauseRegistry public pauseRegistry` in DatumRelay with plain `address` + inline staticcall (matching Settlement's pattern). Result: **+1,160 B worse** (46,178 → 47,338 B).

The ~3 KB saving from plain `address` only applies when the interface is **not already imported**. Settlement saves because it never imports `IDatumCampaignsSettlement` — it uses `address public campaigns` with raw `abi.encodeWithSelector`. But Relay imports `IDatumCampaignsSettlement` and `IDatumPauseRegistry` already, so the typed variable cost is amortized. The inline staticcall boilerplate (`abi.encodeWithSelector` + return decoding + error check) adds more bytecode than the typed variable would have cost.

**Rule:** Only replace typed interface variables with plain `address` when removing the interface import entirely. If the interface stays (e.g., for struct definitions or other call sites), keep the typed variable.

### Key Finding: OZ ReentrancyGuard vs Manual `_locked` — It Depends

The cost depends on whether the contract already imports OZ:

- **Settlement** (already inherits OZ `ReentrancyGuard` + `Ownable`): switching to manual `_locked` costs **+5,994 B**. The OZ import overhead is already amortized across multiple inheritance sites.
- **Campaigns** (no OZ imports at all): switching to OZ `ReentrancyGuard` costs **+707 B**. The OZ import overhead exceeds the single-call-site modifier savings.

**Rule of thumb:** Use OZ `ReentrancyGuard` when the contract already inherits from OZ (import cost amortized). Use manual `_locked` when it would be the sole OZ import — the import base cost (~1-2 KB) isn't worth it for a single modifier site.

### Key Finding: Event String Encoding is Expensive

`ContractReferenceChanged(string name, address old, address new)` events with string parameters cost ~660 B PVM each (4 emits = 2,640 B). On size-critical contracts, prefer events with only indexed/typed params, or omit events entirely when the state change is observable via view functions.

### Contract API Change

`setRelayContract(address)` removed. `configure()` now takes 5 args (publishers added for S12 blocklist):
```solidity
function configure(
    address _budgetLedger,
    address _paymentVault,
    address _lifecycle,
    address _relay,
    address _publishers
) external;
```

### Claim Hash: On-Chain vs Off-Chain

On **PolkaVM** (pallet-revive), Settlement now hashes claims with Blake2-256. The extension and relay bot still compute keccak256. For end-to-end Blake2:
1. Extension `behaviorChain.ts` must switch to `@noble/hashes/blake2b` (already installed, unused)
2. Relay bot claim hash computation must switch to Blake2-256
3. Until migrated, claims submitted via the extension will fail hash validation on Substrate — **the keccak256 fallback in `_validateClaim()` only applies on Hardhat EVM, not on PolkaVM** where `SYSTEM_ADDR.code.length > 0` is true

**Migration required before alpha-2 testnet deploy.** See backlog item 1.10.

### Tests

176/176 passing. Keccak256 fallback exercised on Hardhat EVM. 4 test files updated for new `configure()` 5-arg signature. 2 new tests (G, G2) for settlement blocklist check.

---

## P20: Campaign Inactivity Timeout (2026-03-24)

Campaigns with no settlement activity for `inactivityTimeoutBlocks` can be expired by anyone. Full remaining budget refunded to advertiser.

### Changes

- **DatumBudgetLedger:** New `mapping(uint256 => uint256) public lastSettlementBlock` — set to `block.number` on `initializeBudget()`, updated on each `deductAndTransfer()`. +1,159 B PVM (29,809 B, 19,343 spare).
- **DatumCampaignLifecycle:** New `expireInactiveCampaign(uint256 campaignId)` — permissionless. Checks `block.number > lastSettlementBlock + inactivityTimeoutBlocks`. Sets status to Completed, drains budget to advertiser. Constructor now takes `(pauseRegistry, inactivityTimeoutBlocks)`. +8,398 B PVM (40,910 B, 8,242 spare).
- **IDatumBudgetLedger:** Added `lastSettlementBlock(uint256)` view.
- **IDatumCampaignLifecycle:** Added `expireInactiveCampaign(uint256)`.
- **Error code E64:** Inactivity timeout not yet reached.

### Default Timeout

30 days = 432,000 blocks at 6s block time. Configurable via constructor.

### Tests (5 new: LC10-LC14)

- LC10: expire inactive Active campaign after timeout — full refund
- LC11: expire before timeout reverts E64
- LC12: expire inactive Pending campaign reverts E14
- LC13: expire inactive Paused campaign succeeds
- LC14: lastSettlementBlock set on budget initialization

---

## P1: Mandatory Publisher Attestation — DatumAttestationVerifier (2026-03-24)

New contract: `DatumAttestationVerifier` wraps `settleClaims()` with mandatory EIP-712 publisher co-signature verification. Users call `settleClaimsAttested()` instead of `settleClaims()` directly.

### Design

- For campaigns with a designated publisher (`publisher != address(0)`), `publisherSig` must be a valid EIP-712 `PublisherAttestation` signature from that publisher.
- For open campaigns (`publisher == address(0)`), `publisherSig` is ignored — no attestation required.
- Settlement updated: `attestationVerifier` address added to authorized callers in `settleClaims()` (alongside user and relay).
- Separate `setAttestationVerifier(address)` setter on Settlement (not folded into `configure()`).

### PVM Sizes

- **DatumAttestationVerifier:** 35,920 B (13,232 spare) — new contract (13th).
- **DatumSettlement:** 47,216 → 48,052 B (+836 B, 1,100 spare) — `attestationVerifier` storage + OR check + setter.

### Tests (4 new: H1-H4)

- H1: valid publisher co-sig settles successfully
- H2: missing co-sig reverts E33
- H3: wrong signer reverts E34
- H4: non-user caller reverts E32

---

## Remaining Work

1. ~~**Tests:** Port alpha's 132 Hardhat tests to alpha-2 architecture~~ — **Done.** 185 tests across 10 test files.
2. **Deploy scripts:** Update `deploy.ts` for 13-contract deploy + extended wiring sequence. Settlement `configure()` 5-arg + `setAttestationVerifier()`. CampaignLifecycle constructor 2-arg.
3. ~~**Extension:** Update contract addresses config (3 new addresses), redirect withdrawal calls to PaymentVault~~ — **Done.** Extension v0.2.0 with 12-contract support, 140/140 Jest tests. Needs update for AttestationVerifier.
4. **Testnet deploy:** Deploy alpha-2 to Paseo, run E2E validation
5. **Relay fix:** Extension `signForRelay()` must POST signed batches to relay bot `/relay/submit` — currently stores locally only (see PROCESS-FLOWS.md §10.1)
6. **Blake2 migration (extension + relay):** Extension `behaviorChain.ts` and relay bot must switch claim hash from keccak256 to Blake2-256 to match Settlement on PolkaVM. Required before alpha-2 testnet deploy. `@noble/hashes` already installed in extension.
