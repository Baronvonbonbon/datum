# Alpha-2 Changelog

**Date:** 2026-03-22 (hardening) / 2026-03-23 (S12 blocklist, Blake2 precompile)
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

### DatumSettlement — Restructured + Blake2 Precompile

- Pull-payment balances + 3 withdrawals extracted to PaymentVault
- Budget deduction routed through BudgetLedger (not Campaigns)
- Auto-complete on budget exhaustion calls CampaignLifecycle
- ZK proof verification removed entirely (stub, moved to post-alpha)
- `IDatumPauseRegistry` typed interface replaced with plain `address` + inline staticcall
- Admin setters consolidated: `configure(budgetLedger, paymentVault, lifecycle, relay)` — single 4-arg function replaces `configure()` + `setRelayContract()`
- `setZKVerifier()` removed
- Cross-contract calls use hardcoded `bytes4` selectors (same PVM size as string signatures — resolc optimizes both)
- **O1: Blake2-256 claim hashing** via `ISystem(0x900).hashBlake256()` precompile — ~3x cheaper than keccak256 per claim on Substrate. Falls back to keccak256 on Hardhat EVM (via `SYSTEM_ADDR.code.length > 0` guard). Fits by removing `ContractReferenceChanged` events and merging admin functions.
- **Size: 48,820 → 45,088 B (3,732 B freed, 4,064 spare)**

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
| DatumSettlement | 48,820 | 43,132 | 45,609 | **45,088** | **4,064** | O1 Blake2 + admin merge |
| **DatumCampaigns** | 48,662 | 38,564 | 38,023 | **42,466** | **6,686** | +S12 blocklist+allowlist checks |
| DatumGovernanceSlash | 30,298 | 36,520 | 37,160 | 37,160 | 11,992 | unchanged |
| DatumCampaignLifecycle | — | 30,197 | 32,512 | 32,512 | 16,640 | unchanged |
| DatumBudgetLedger | — | 22,345 | 28,650 | 28,650 | 20,502 | unchanged |
| **DatumPublishers** | 22,614 | 22,813 | 26,775 | **35,741** | **13,411** | +S12 blocklist+allowlist |
| DatumTimelock | 18,342 | 18,342 | 18,342 | 18,342 | 30,810 | unchanged |
| DatumPaymentVault | — | 16,062 | 16,062 | 16,062 | 33,090 | unchanged |
| DatumPauseRegistry | 4,047 | 4,047 | 4,047 | 4,047 | 45,105 | unchanged |
| DatumZKVerifier | 1,409 | 1,409 | 1,409 | 1,409 | 47,743 | unchanged |
| **Total** | **~260,065** | **323,334** | **342,706** | **355,594** | | **+13,409 B S12, -521 B O1** |

Hardening added 19,372 B PVM across 8 contracts. S12 added 13,409 B across 2 contracts. O1 Blake2 precompile net -521 B on Settlement (removed events, merged admin, added precompile). GovernanceV2 remains tightest at 1,213 B spare.

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
| OZ `ReentrancyGuard` modifier vs manual `_locked` bool | OZ is **5,994 B smaller** | Counterintuitive — modifiers compile far smaller on resolc. Never use inline `_locked` pattern. |
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
- O3: `minimumBalance()` dust guard in PaymentVault (33,090 B spare — feasible)
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

### Key Finding: OZ ReentrancyGuard vs Manual `_locked`

Experimentally confirmed that replacing OZ `ReentrancyGuard` with a manual `bool _locked` + inline modifier **costs +5,994 B** on resolc. The OZ modifier pattern compiles dramatically smaller. This confirms the previous finding and quantifies it precisely: **never use inline reentrancy guards on resolc**.

### Key Finding: Event String Encoding is Expensive

`ContractReferenceChanged(string name, address old, address new)` events with string parameters cost ~660 B PVM each (4 emits = 2,640 B). On size-critical contracts, prefer events with only indexed/typed params, or omit events entirely when the state change is observable via view functions.

### Contract API Change

`setRelayContract(address)` removed. `configure()` now takes 4 args:
```solidity
function configure(
    address _budgetLedger,
    address _paymentVault,
    address _lifecycle,
    address _relay
) external;
```

### Claim Hash: On-Chain vs Off-Chain

On **PolkaVM** (pallet-revive), Settlement now hashes claims with Blake2-256. The extension and relay bot still compute keccak256. For end-to-end Blake2:
1. Extension `behaviorChain.ts` must switch to `@noble/hashes/blake2b` (already installed, unused)
2. Relay bot claim hash computation must switch to Blake2-256
3. Until migrated, claims submitted via the extension will fail hash validation on Substrate — **the keccak256 fallback in `_validateClaim()` only applies on Hardhat EVM, not on PolkaVM** where `SYSTEM_ADDR.code.length > 0` is true

**Migration required before alpha-2 testnet deploy.** See backlog item 1.10.

### Tests

174/174 passing (unchanged count). Keccak256 fallback exercised on Hardhat EVM. 4 test files updated for new `configure()` signature.

---

## Remaining Work

1. ~~**Tests:** Port alpha's 132 Hardhat tests to alpha-2 architecture~~ — **Done.** 174 tests across 10 test files (includes S12 blocklist).
2. **Deploy scripts:** Update `deploy.ts` for 12-contract deploy + extended wiring sequence. Settlement `configure()` now takes 4 args (relay included).
3. ~~**Extension:** Update contract addresses config (3 new addresses), redirect withdrawal calls to PaymentVault~~ — **Done.** Extension v0.2.0 with 12-contract support, 140/140 Jest tests.
4. **Testnet deploy:** Deploy alpha-2 to Paseo, run E2E validation
5. **Relay fix:** Extension `signForRelay()` must POST signed batches to relay bot `/relay/submit` — currently stores locally only (see PROCESS-FLOWS.md §10.1)
6. **Blake2 migration (extension + relay):** Extension `behaviorChain.ts` and relay bot must switch claim hash from keccak256 to Blake2-256 to match Settlement on PolkaVM. Required before alpha-2 testnet deploy. `@noble/hashes` already installed in extension.
