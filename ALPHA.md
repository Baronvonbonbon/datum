# DATUM Alpha Build Roadmap

**Version:** 1.9
**Date:** 2026-03-13
**Scope:** Alpha build — feature-complete for Paseo testnet deployment with IPFS integration, Publisher SDK, open campaigns, multi-account wallet, UX polish, and open testing
**Base:** PoC MVP (tagged `poc-complete`) — 9 contracts (post-GovernanceV2), 111/111 tests, 7-tab extension (V2 overhaul + Part 4B fixes + Publisher SDK complete + Part 4D UX audit + multi-account), local devnet verified
**Build model:** Solo developer with Claude Code assistance

**Current status:** All contracts, extension code, Part 4B pre-launch review fixes, Publisher SDK, open campaigns, Part 4D UX audit (Phase 1 + Phase 2) COMPLETE. 111/111 Hardhat tests. 140/140 Jest extension tests. Extension builds clean (0 webpack errors, 599KB popup.js, 375KB background.js, 32KB content.js). **A3.2 local devnet E2E PASSED** (all 6 sections: campaign lifecycle, settlement, withdrawals, pause/unpause, governance slash, timelock). Multi-account wallet (MA-1 through MA-4) implemented. ERC-20/DATUM token removed from roadmap — all economics on DOT/KSM. **Next step: A3.2 browser E2E (manual) → A3.3 Paseo deployment.**

---

## Part 1: PoC MVP Summary Review

### What was built

The PoC validates three hypotheses on a local Hardhat EVM devnet with a Chrome MV3 extension:

| Hypothesis | Validation |
|------------|-----------|
| Economic model correct | 64/64 tests: exact revenue formula, daily cap, snapshot take rate, 3-way payment split |
| Conviction governance correct | Multipliers, thresholds, lockup cap, pull payments, graduated nay penalty, aye/nay rewards |
| State machine correct | All transitions: Pending → Active → Completed/Terminated/Expired, pause/resume, auto-complete |

### Contract system (5+1+1+1+1 contracts, all < 49,152 B PVM after A1.3)

| Contract | PVM size | Spare | Purpose |
|----------|----------|-------|---------|
| DatumPauseRegistry | 4,047 B | 45,105 B | Global emergency pause circuit breaker (A1.1) |
| DatumTimelock | 18,342 B | 30,810 B | Standalone 48h admin timelock (A1.2) |
| DatumPublishers | 22,614 B | 26,538 B | Publisher registry + configurable take rates (30-80%) + category bitmask |
| DatumCampaigns | 48,662 B | 490 B | Campaign lifecycle, budget escrow, open campaigns, manual reentrancy guard (A1.3) |
| DatumGovernanceV2 | 39,693 B | 9,459 B | Dynamic voting + evaluateCampaign() + inline slash (P18) + minimumBalance dust prevention |
| DatumGovernanceSlash | 30,298 B | 18,854 B | Slash pool finalization + winner claims (P18), H1 div-by-zero guard |
| DatumSettlement | 48,820 B | 332 B | Hash-chain validation, claim processing, 3-way payment split, open campaign resolution |
| DatumRelay | 46,180 B | 2,972 B | EIP-712 user signature + publisher co-sig (skipped for open campaigns), gasless settlement |
| DatumZKVerifier | 1,409 B | 47,743 B | Stub ZK proof verifier (accepts any non-empty proof) |

### Extension (7 tabs, 599 KB popup.js — V2 overhaul + P6 + Part 4B + content safety + Publisher SDK + open campaigns + multi-account + Part 4D UX)

| Tab | Component | Function |
|-----|-----------|----------|
| Campaigns | CampaignList.tsx | Active campaigns with block/unblock, category filter, campaign info expansion |
| Claims | ClaimQueue.tsx | Pending claims, submit/relay, sign for publisher, earnings estimate, attestation badges, export/import (P6) |
| Earnings | UserPanel.tsx | User balance (DOT), withdraw, engagement stats (dwell, viewable, IAB viewability), per-campaign breakdown |
| Publisher | PublisherPanel.tsx | Balance + withdraw + relay submit + take rate management + category checkboxes + SDK embed snippet |
| My Ads | AdvertiserPanel.tsx | Campaign owner controls: pause/resume/complete/expire, campaign creation (open or publisher-specific) with IPFS CID |
| Govern | GovernancePanel.tsx | V2 voting (vote(), evaluateCampaign(), withdraw()), majority+quorum bars, conviction 0-6, slash finalization + reward claiming |
| Settings | Settings.tsx | Network, RPC, 9 contract addresses, IPFS gateway, auto-submit, ad preferences (max ads/hr, min CPM, silenced categories, blocked campaigns), interest profile, danger zone |

### Key design decisions locked in PoC

- **Denomination:** Planck (10^10 per DOT), native PolkaVM path
- **Wallet:** Embedded ethers.Wallet with AES-256-GCM encryption (PBKDF2 310k iterations). Multi-account support implemented (MA-1 through MA-4): named accounts, switch/rename/delete, legacy migration.
- **Claim hash:** `keccak256(abi.encodePacked(...))` — no zkProof in hash (zkProof is a carrier field). Blake2-256 deferred (Settlement 332 B spare, precompile call adds ~4 KB PVM).
- **Settlement caller:** User direct (`settleClaims`) or publisher relay (`settleClaimsFor` with EIP-712 signature)
- **Batch size:** MAX_CLAIMS_PER_BATCH = 5 (on-chain enforced)
- **Campaign selection:** Vickrey second-price auction (P19) — effectiveBid = bidCpm × interestWeight, clearingCpm from 2nd price, solo 70%, floor 30%; fallback to weighted random
- **Metadata:** Off-chain IPFS (CID → bytes32 event), on-chain `uint8 categoryId`

### Resolved issues (A1-A5 bugs, B1-B3 denomination, 11 review issues)

All P0/P1/P2 bugs identified in REVIEW.md are fixed. 64/64 tests pass. Gate G1 (contracts) and Gate G2 (extension E2E) both passed.

### Known trust assumptions remaining

| Component | Trust assumption | Alpha mitigation | Status | Full solution |
|-----------|-----------------|------------------|--------|---------------|
| Impression count | Extension self-reports | Publisher co-signature (implemented, degraded trust mode) | PoC done | Mandatory attestation + TEE/ZK |
| Clearing CPM | Extension hardcodes bidCpmPlanck | **P19: Second-price auction** | **✅ DONE** | ZK proof of auction outcome (P9) |
| Aye reward amounts | Owner computes off-chain | Document trust assumption | PoC done | On-chain proportional computation (P4, absorbed into P18) |
| Contract references | Owner can change instantly | **P3: Admin timelock** — 48h delay via DatumTimelock | **✅ DONE** | Governance approval for reference changes |
| Claim state | Browser storage only | **P6: Claim portability** — encrypted export/import | **✅ DONE** | Deterministic derivation from seed + on-chain state |
| Emergency stop | No global pause | **C3: Circuit breaker** — DatumPauseRegistry | **✅ DONE** | Governance-controlled pause |

### Known limitations (accepted for alpha)

| Item | Detail | Risk | Mitigation |
|------|--------|------|------------|
| Daily cap timestamp | `DatumCampaigns` uses `block.timestamp / 86400` for daily cap tracking. Validators can manipulate `block.timestamp` by ±15 seconds. | Low — ±15s on 86400s period is negligible (<0.02%) | Accepted PoC risk. Documented in contract comment (line 280). |
| Slash sweep | Unclaimed slash rewards in `DatumGovernanceSlash` have no expiry deadline. Unclaimed funds are locked forever. | Low — only affects governance participants who don't claim | Post-alpha: add admin-callable sweep after 90-day deadline (M4). |

---

## Part 2: Polkadot Hub Host Function Opportunities

pallet-revive provides ~41 host functions (syscalls) and several precompile contracts at fixed addresses. These offer optimizations over pure Solidity implementations.

### Precompiles available NOW on Polkadot Hub

#### Standard EVM precompiles (builtin)

| Address | Name | DATUM relevance |
|---------|------|-----------------|
| `0x01` | **ECRecover** | **Critical** — relay signature verification (`ecrecover` in DatumRelay). Must verify this works on PVM before testnet. |
| `0x02` | **SHA-256** | Low — we use keccak256. Could use for alternative hash schemes if needed. |
| `0x05` | **ModExp** | None currently. Would enable RSA-based verification if needed. |
| `0x06-08` | **BN128 add/mul/pairing** | **Future** — enables on-chain Groth16 ZK proof verification (P9). Pairing precompile is the key enabler for ZK verifier contracts. |

#### System precompile (`0x0000...0900`)

| Function | DATUM relevance |
|----------|-----------------|
| `hashBlake256(bytes)` | **Optimization** — Blake2-256 is ~3x cheaper than keccak256 on Substrate. Could use for internal hashing (claim chain, behavior chain) where EVM compatibility isn't required. Would need claim struct migration. |
| `hashBlake128(bytes)` | Lower security margin than 256-bit but cheaper. Useful for non-security-critical hashing (storage keys). |
| `sr25519Verify(sig, msg, pubkey)` | **Future** — enables native Polkadot wallet signatures instead of EVM ecrecover. Post-MVP when external wallets (P17) are integrated. |
| `ecdsaToEthAddress(pubkey)` | Utility for address derivation. Already available via ecrecover precompile. |
| `minimumBalance()` | **Useful** — query existential deposit for DOT transfer validation. Ensures we don't create dust accounts. |
| `weightLeft()` | **Gas optimization** — check remaining weight mid-execution. Could abort expensive loops early (e.g., batch settlement) instead of hitting gas limit. |

#### Storage precompile (`0x0000...0901`)

| Function | DATUM relevance |
|----------|-----------------|
| `get_range(key, offset, length)` | **Optimization** — partial reads of large storage values. Could read only the first N bytes of a claim batch instead of deserializing the entire struct. Useful for validation checks before full processing. |
| `get_prefix(key, max_length)` | Similar to get_range for header/metadata reads. |
| `length(key)` | **Optimization** — check data size before reading. Useful for batch size validation without loading the full batch. Cheaper than loading + measuring. |
| `has_key(key)` | Existence check without reading value. Cheaper than SLOAD for boolean checks (e.g., "has this user voted?"). |

#### XCM precompile (`0x0000...0a0000`)

| Function | DATUM relevance |
|----------|-----------------|
| `execute(message, weight)` | **P11 (post-alpha)** — protocol fee routing to HydraDX for DOT→stablecoin swaps. Execute XCM locally to initiate cross-chain transfers. |
| `send(destination, message)` | Send messages to other parachains. Could route protocol fees to a treasury parachain. |
| `weighMessage(message)` | Estimate XCM execution cost before sending. |

### Host functions (syscalls) with alpha relevance

| Syscall | Current Solidity equivalent | Optimization |
|---------|---------------------------|-------------|
| `hash_keccak_256` | `keccak256()` in Solidity | Already used implicitly. No change needed — Solidity compiler emits this syscall. |
| `balance_of(address)` | `address.balance` | Direct balance query. Already works via Solidity. |
| `block_number` | `block.number` | Already works. Used for lockup calculations. |
| `sr25519_verify` | No Solidity equivalent | **Unstable API** — enables native Polkadot signature verification. Alpha: skip (embedded wallet uses secp256k1). Post-MVP: enables native wallet integration without EIP-712. |

### Recommended alpha optimizations

1. **Verify ECRecover precompile on Paseo** (blocker — relay breaks without it)
2. ~~**Use `minimumBalance()` from System precompile**~~ **✅ IMPLEMENTED** — DatumGovernanceV2 `withdraw()` and `slashAction()` check `minimumBalance()` before DOT transfers. Error E58 = below existential deposit. Uses `SYSTEM_ADDR.code.length > 0` guard to skip on Hardhat EVM. GovernanceV2 grew 37,677→39,829 B (+2,152 B), still within limit. **Not added to Settlement/Relay** — precompile calls add ~4 KB PVM each, exceeding their tight bytecode budgets.
3. **Use `has_key()` from Storage precompile** for cheaper existence checks in governance (voted? registered?)
4. **Document BN128 pairing availability** for future ZK verifier (P9) — if available, Groth16 verification becomes feasible on-chain

### Deferred to post-alpha (PVM size constraints)

- **Blake2-256 for claim hashing** — `hashBlake256()` via system precompile is ~3x cheaper than keccak256. However, adding the precompile call + `SYSTEM_ADDR.code.length > 0` guard + `bytes memory packed` variable adds ~4,177 B to Settlement PVM (only 332 B spare). Requires resolc optimizer improvements or Settlement refactoring. Extension-side Blake2 ready (`@noble/hashes/blake2.js` tested).
- **weightLeft() batch loop early abort** — Graceful partial settlement when weight runs low mid-loop. Adds ~3,598 B to Relay PVM (only 2,972 B spare). Same issue for Settlement. Deferred until resolc improves.
- sr25519 signature verification (requires external wallet integration P17)
- XCM fee routing (requires HydraDX integration P11)


### ISystem interface (NEW — `alpha/contracts/interfaces/ISystem.sol`)

Solidity interface for the Polkadot Hub system precompile at address `0x0000...0900`:

```solidity
interface ISystem {
    function minimumBalance() external view returns (uint256);
    function weightLeft() external view returns (uint64 refTime, uint64 proofSize);
    function hashBlake256(bytes memory data) external view returns (bytes32);
}
```

**Critical implementation note:** Solidity `try/catch` on precompile calls fails on Hardhat EVM. Address 0x900 has no code, so the call returns empty data, and ABI decoding fails *inside the caller* (not caught by `catch`). The correct guard is `SYSTEM_ADDR.code.length > 0` before calling. On Polkadot Hub, the precompile has code and functions normally.

---

## Part 3: Alpha Build Scope

### Alpha goals

1. **Feature-complete for Paseo deployment** — all four alpha-scope post-MVP items implemented
2. **IPFS integration** — real IPFS metadata pinning and retrieval (not synthetic hashes)
3. **Open multi-account testing** — no artificial account limits; anyone on Paseo can interact
4. **No KYB enforcement** — campaign creators are permissionless (KYB is post-alpha, P10)

### Alpha-scope items

| Item | Type | Status | Description |
|------|------|--------|-------------|
| **C3: Global pause/circuit breaker** | Contract | **✅ COMPLETE** | DatumPauseRegistry — Campaigns, Settlement, Relay check `paused()` via staticcall. 8/8 tests (P1-P8). |
| **P3: Admin timelock** | Contract | **✅ COMPLETE** | Standalone DatumTimelock — `propose(target, calldata)` → 48h → `execute()`. Campaigns + Settlement ownership transferred post-deploy. 15/15 tests (T1-T15). |
| **P18: Governance V2** | Contract | **✅ COMPLETE** | DatumGovernanceV2 (dynamic voting, evaluateCampaign, symmetric slash) + DatumGovernanceSlash (slash pool, winner claims). 26/26 tests (V1-V8, W1-W5, E1-E5, S1-S5, D1-D4). Replaces GovernanceVoting + GovernanceRewards. |
| **A1.3: PVM size reduction** | Contract | **✅ COMPLETE** | DatumCampaigns: removed OZ ReentrancyGuard (manual `bool _locked` + E57), removed `getCampaign()` (slim getters), removed `id`+`budgetPlanck` from struct. Saved 3,902 B (52,662→48,760). All 9 contracts under 49,152 B PVM limit. |
| **P6: Claim state portability** | Extension | **✅ COMPLETE** | `claimExport.ts`: AES-256-GCM encrypted export/import (HKDF from wallet signature), merge strategy (keep higher nonce), on-chain nonce validation. Export/Import buttons in ClaimQueue. |
| **P19: Second-price auction** | Extension | **✅ COMPLETE** | Vickrey auction in `auction.ts` — effectiveBid = bidCpm × interestWeight, clearingCpm from 2nd price, solo 70%, floor 30%. Integrated into campaign selection + claim builder. |
| **P16: Behavioral analytics** | Extension | **✅ COMPLETE** | On-device engagement capture (dwell, scroll, tab focus, IAB viewability), behavior hash chain, commitment computation, ZK proof stub. |
| **V2 Extension Overhaul** | Extension | **✅ COMPLETE** | 7 tabs, V2 governance panel, advertiser panel, user preferences (block/silence/rate-limit), engagement stats in UserPanel, 9-contract ABI set. |

### Non-scope (explicitly deferred)

- P9 (ZK proof) — requires P2 auction mechanism first
- P10 (KYB identity) — explicitly deferred per user requirement
- P11 (XCM fee routing) — requires HydraDX integration
- P17 (External wallets) — WalletConnect/iframe bridge, post-alpha UX

---

## Part 4: Alpha Build Checklist

### Phase A1 — Contract Hardening

**Prerequisite:** PoC contracts copied to `alpha/contracts/` ✅

#### A1.1 — Global pause / circuit breaker (C3) — ✅ COMPLETE

**Implementation:** DatumPauseRegistry pattern (Option B from original plan).

- [x] Deploy single `DatumPauseRegistry` contract: `bool paused`, owner-only `pause()`/`unpause()`
- [x] Contracts with pause checks (inline `require(!pauseRegistry.paused(), "P")` via staticcall):
  - DatumCampaigns: `createCampaign`, `activateCampaign`, `terminateCampaign`
  - DatumSettlement: `settleClaims`
  - DatumRelay: `settleClaimsFor`
  - DatumPublishers: own OZ `Pausable` (separate from global pause)
- [x] **NOT paused** (defense-in-depth, user fund access preserved):
  - GovernanceVoting: `voteAye`, `voteNay` — paused indirectly via Campaigns (activateCampaign/terminateCampaign check pause). Sub-threshold votes only stake DOT — harmless during pause.
  - GovernanceRewards: `creditAyeReward` (owner-only, don't call during pause), `distributeSlashRewards` (internal state only)
  - All withdrawals, stake withdrawals, claim rewards, completeCampaign, expirePendingCampaign, view functions, receive()
- [x] Tests P1-P8: owner-only pause/unpause, create/activate/terminate/settle blocked when paused, withdrawals work when paused, views work when paused
- [x] PVM bytecode sizes verified under limit

**Finding — PVM size impact:** Adding `pauseRegistry` state var + constructor param + staticcall check adds ~3 KB per contract in resolc PVM output. GovernanceVoting (380 B spare) and GovernanceRewards (407 B spare) could not absorb this. Solution: removed pause from governance contracts entirely — defense-in-depth via Campaigns-level pause is sufficient. See A1.2 findings below.

#### A1.2 — Admin timelock (P3) — ✅ COMPLETE

**Implementation evolved through two iterations:**

**Iteration 1 (inline timelock):** Added `proposeChange(role, addr)` / `applyChange()` / `cancelChange()` directly to DatumCampaigns and DatumSettlement. 3 functions + 3 state vars + 3 events + 1 constant per contract. All 87 tests passed on Hardhat EVM. However, PVM compilation revealed 4 contracts exceeded the 49,152 B limit:

| Contract | PoC Baseline | With Inline Timelock + Pause | Over by |
|----------|-------------|------------------------------|---------|
| DatumCampaigns | 48,359 B | 56,680 B | 7,528 B |
| DatumSettlement | 46,495 B | 53,728 B | 4,576 B |
| DatumGovernanceVoting | 48,772 B | 52,161 B | 3,009 B |
| DatumGovernanceRewards | 48,745 B | 51,508 B | 2,356 B |

**Root cause:** resolc PVM bytecodes are 10-20x larger than solc EVM bytecodes. The inline timelock pattern (3 functions + 3 vars + 3 events) adds ~7-8 KB per contract in PVM output — far more than the ~1-2 KB estimate based on EVM bytecode size.

**Research conducted:** Investigated host-call shortcuts (system-level pause syscall, access-control precompile) — none exist. The inline approach was already optimal for EVM; the only path forward was architectural extraction.

**Iteration 2 (standalone timelock) — final:**

- [x] Created standalone `DatumTimelock` contract (~4 KB PVM):
  - `propose(address target, bytes calldata data)` — owner stores pending call + timestamp
  - `execute()` — anyone calls after 48h; forwards stored calldata to target
  - `cancel()` — owner clears pending
  - `transferOwnership(address)` — owner can transfer timelock itself
- [x] Reverted DatumCampaigns to simple `onlyOwner` setters: `setSettlementContract()`, `setGovernanceContract()`, `transferOwnership()`
- [x] Reverted DatumSettlement to simple `onlyOwner` setters: `setRelayContract()`, `setZKVerifier()` (OZ Ownable already has `transferOwnership`)
- [x] Removed `pauseRegistry` from GovernanceVoting constructor (6 params, was 7)
- [x] Removed `pauseRegistry` from GovernanceRewards constructor (2 params, was 3)
- [x] Deploy script: wire contracts directly, then `campaigns.transferOwnership(timelock)` + `settlement.transferOwnership(timelock)`
- [x] Future admin changes: `timelock.propose(target, abi.encodeCall(setter, newAddr))` → 48h → `timelock.execute()`
- [x] Tests T1-T15: execute before delay reverts, execute after delay succeeds, cancel clears pending, only owner propose/cancel, anyone can execute, old reference works during delay, settlement relay/zkVerifier via timelock, direct calls on timelocked contracts revert

**Estimated PVM sizes after refactor:**

| Contract | Before (inline) | After (extracted) | Change |
|----------|----------------|-------------------|--------|
| DatumCampaigns | 56,680 B | ~48,880 B | -7,800 B ✅ |
| DatumSettlement | 53,728 B | ~46,728 B | -7,000 B ✅ |
| DatumGovernanceVoting | 52,161 B | ~48,772 B | -3,389 B ✅ |
| DatumGovernanceRewards | 51,508 B | ~48,745 B | -2,763 B ✅ |
| DatumTimelock (new) | — | ~4,000 B | new ✅ |

**Test results:** 87/87 Hardhat EVM, 0 failures. Test breakdown:
- 16 campaign lifecycle (L1-L8, snapshots, metadata M1-M3, CPM floor, publishers C3)
- 14 governance (G1-G8, Issue 9, double vote, A1 resolveFailedNay, minReviewerStake)
- 6 integration scenarios (A-F)
- 8 global pause (P1-P8)
- 24 settlement + relay + ZK (S1-S8, A2, gap, snapshots, withdrawals, R1-R10, Z1-Z3)
- 15 admin timelock (T1-T15)
- 4 misc (publishers, metadata, CPM floor)

#### A1.3 — PVM size reduction — ✅ COMPLETE

DatumCampaigns was 52,662 B (3,510 B over PVM limit). Size reduction applied:

- [x] **DatumCampaigns:** Removed OZ `ReentrancyGuard` → manual `bool _locked` + inline `require(!_locked, "E57")` pattern. Saved ~1,500 B in PVM.
- [x] **DatumCampaigns:** Removed `getCampaign()` full struct return → 3 slim getters: `getCampaignStatus()`, `getCampaignAdvertiser()`, `getCampaignRemainingBudget()`. Saved ~800 B.
- [x] **DatumCampaigns:** Removed `id` field from Campaign struct (redundant — always equals mapping key). Existence check changed from `c.id != 0` to `c.advertiser != address(0)`. Saved ~600 B.
- [x] **DatumCampaigns:** Removed `budgetPlanck` field from Campaign struct (equals initial `remainingBudget`, never read after creation, still emitted in CampaignCreated event). Saved ~200 B.
- [x] **DatumSettlement:** Kept OZ ReentrancyGuard + Ownable (manual pattern caused +6,551 B PVM bloat due to resolc codegen — OZ modifier pattern compiles more efficiently than inline `require`).
- [x] Updated all tests: 100/100 pass. Updated IDatumCampaigns interface + MockCampaigns mock.
- [x] PVM sizes verified: **DatumCampaigns 48,760 B** (392 spare, was 52,662), **DatumSettlement 48,757 B** (395 spare, unchanged).

**Key finding:** resolc handles OZ modifier-based ReentrancyGuard more efficiently than inline `bool _locked` patterns. The manual pattern caused Settlement to grow from 48,757 B to 55,308 B (+6,551 B). This is the opposite of EVM behavior. For DatumCampaigns, removing OZ ReentrancyGuard worked because the struct field removals and `getCampaign()` elimination provided sufficient savings to offset any codegen differences.

**New error code:** E57 = reentrancy guard (replaces OZ nonReentrant in DatumCampaigns only).

Remaining A1.3 items (deferred to A3.2):
- [ ] Run gas benchmarks on local substrate-contracts-node
- [ ] Verify `ecrecover` precompile works on substrate-contracts-node
- [x] Add `minimumBalance()` check before DOT transfers (System precompile `0x0900`) — **Implemented in GovernanceV2 only** (withdraw + slashAction). Settlement/Relay too tight on PVM bytecode (+4 KB per contract for precompile call). New error E58.

### Phase A2 — Extension Enhancements

**Prerequisite:** Extension copied to `alpha-extension/`

#### A2.1 — Second-price auction (P19 Phase 1) + Behavioral analytics (P16) + V2 Extension Overhaul — ✅ COMPLETE

**Implementation (2026-03-08):** Full extension overhaul to V2 feature parity.

**P19 Second-price auction:**
- [x] Created `auction.ts`: `auctionForPage(campaigns, pageCategories, interestProfile) → AuctionResult`
- [x] effectiveBid = bidCpm × interestWeight (floor 0.1). Solo: 70%. Floor: 30%. Second-price: secondEffectiveBid / winnerInterestWeight, clamped to [30%, 100%] of bidCpm.
- [x] Modified `interestProfile.ts`: added `getNormalizedWeight(profile, categoryName) → number`
- [x] Modified `content/index.ts`: receives `clearingCpmPlanck` and `mechanism` from auction result
- [x] Modified `claimBuilder.ts`: accepts optional `clearingCpmPlanck` from auction, falls back to `bidCpmPlanck`

**P16 Behavioral analytics:**
- [x] Created `engagement.ts`: IntersectionObserver (50% threshold), scroll depth, tab focus, IAB viewability (≥50% visible ≥1s), min 500ms tracking
- [x] Created `behaviorChain.ts`: per-(user, campaignId) append-only keccak256 hash chain
- [x] Created `behaviorCommit.ts`: single bytes32 commitment from chain state (headHash, eventCount, avgDwell, avgViewable, viewabilityRate)
- [x] Created `zkProofStub.ts`: dummy proof `0x01` + commitment (satisfies DatumZKVerifier stub)
- [x] UserPanel.tsx: engagement stats (dwell, viewable, IAB viewability rate), per-campaign breakdown, chain head hash

**V2 Extension Overhaul:**
- [x] ABIs sourced from `alpha/artifacts/` (9 contracts). Removed V1 ABIs (GovernanceVoting, GovernanceRewards).
- [x] Types: updated ContractAddresses (9 keys), removed `id`/`budget` from Campaign struct, added UserPreferences, EngagementEvent, BehaviorChainState
- [x] Contracts: replaced V1 governance factories with V2, added getPauseRegistryContract
- [x] GovernancePanel.tsx: V2 API — `vote()`, `evaluateCampaign()`, `withdraw()` with slash, slash finalization + reward claiming, majority+quorum bars, conviction 0-6
- [x] AdvertiserPanel.tsx (NEW): campaign owner controls — pause/resume/complete/expire, campaign creation moved from PublisherPanel
- [x] CampaignList.tsx: block/unblock campaigns, category filter, campaign info expansion
- [x] Settings.tsx: ad preferences (max ads/hr, min CPM, silenced categories, blocked campaigns), V2 contract addresses (9 fields)
- [x] userPreferences.ts (NEW): block/silence/rate-limit/minCPM, persisted in chrome.storage.local
- [x] Background index.ts: all new message handlers, global pause check before auto-flush, auction-based selection with legacy fallback
- [x] campaignPoller.ts: A1.3 slim getters, fetches Pending/Active/Paused campaigns, IPFS metadata caching
- [x] Content script: auction-based selection + engagement tracking + preference filtering
- [x] Build output: popup.js 580KB, background.js 373KB, content.js 28KB — 0 webpack errors (post P6 + taxonomy + SDK + open campaigns + default ad)

#### A2.2 — Claim state portability (P6)

- [x] Add to `alpha-extension/src/popup/ClaimQueue.tsx`:
  - "Export Claims" button → encrypts claim queue + chain state with wallet signature
  - "Import Claims" button → decrypts and merges with current state
- [x] Create `alpha-extension/src/shared/claimExport.ts`:
  - `exportClaims(signer) → Blob` — reads all claim data from chrome.storage.local, encrypts with AES-256-GCM using key derived from wallet signature of fixed message
  - `importClaims(file, signer) → ImportResult` — decrypts, validates chain integrity, merges
  - Export format: `{ version: 1, userAddress, chains: { [campaignId]: ChainState }, queue: ClaimData[], exportTimestamp }`
- [x] Validation on import:
  - Verify user address matches current wallet
  - Check on-chain `lastNonce` — reject if imported nonce is behind on-chain state
  - Merge strategy: keep higher nonce, append newer claims
- [ ] Add manual test procedure to README

#### A2.3 — Extension Paseo configuration

- [x] Add Paseo network to `alpha-extension/src/shared/networks.ts`:
  - Paseo RPC URL
  - Placeholder contract addresses (filled after deployment)
  - Paseo as selectable network in Settings
- [x] Update Settings.tsx: network dropdown includes Paseo
- [ ] Update `alpha-extension/src/background/campaignPoller.ts`:
  - Add `ContractChangeProposed` event monitoring (from P3 timelock)
  - Surface warnings in popup when admin changes are pending
- [x] Verify extension builds clean with alpha changes

#### A2.4 — IPFS integration (real pinning)

- [ ] Evaluate IPFS pinning services for alpha:
  - Pinata (free tier: 100 files, 500 MB) — good for alpha
  - nft.storage (free, backed by Filecoin) — unlimited but slower
  - web3.storage — Filecoin-backed, good free tier
- [ ] Add IPFS upload to `alpha-extension/src/popup/PublisherPanel.tsx`:
  - "Upload Metadata to IPFS" button → posts JSON to pinning service API
  - Returns CID → auto-fills metadata CID input
  - Requires API key (configured in Settings)
- [ ] Add IPFS pinning API key field to Settings.tsx
- [ ] Verify metadata round-trip: upload JSON → get CID → create campaign → set metadata → poller fetches → CampaignList displays

### Phase A3 — Testing & Deployment

#### A3.1 — Alpha test suite — ✅ COMPLETE

- [x] All PoC tests migrated and updated for GovernanceV2 + A1.3 changes
- [x] Campaign tests: 16 (L1-L8, snapshots, metadata M1-M3, CPM floor, publishers C3)
- [x] Governance V2 tests: 26 (V1-V8, W1-W5, E1-E5, S1-S5, D1-D4)
- [x] Integration tests: 6 (A-F)
- [x] Pause tests: 8 (P1-P8)
- [x] Settlement + Relay + ZK tests: 29 (S1-S8, A2, gap, snapshots, withdrawals, R1-R10, Z1-Z3)
- [x] Timelock tests: 15 (T1-T15)
- [x] Total: **100/100 tests pass** (exceeds 75+ target)
- [x] Run: `cd alpha && npx hardhat test` — 100 passing, 0 failing, ~4s

#### A3.2 — Local devnet validation ✅ COMPLETE (2026-03-11)

- [x] Start substrate-contracts-node + eth-rpc (Docker)
- [x] Deploy alpha contracts via `alpha/scripts/deploy.ts --network substrate`
- [x] Run `alpha/scripts/e2e-full-flow.ts --network substrate` — all 6 sections pass:
  1. Campaign lifecycle: create → vote → activate → metadata ✅
  2. Settlement: hash chain claim submitted and settled (1M impressions, 16 DOT payment) ✅
  3. Withdrawals: publisher (8 DOT) + user (6 DOT) balances withdrawn ✅
  4. Pause/unpause: circuit breaker toggled, settlement blocked while paused ✅
  5. Governance slash: second campaign → aye vote → nay vote → terminate → finalize slash ✅
  6. Timelock: propose → execute (correctly reverts, 48h not expired) → cancel ✅
- [x] Bugs found and fixed during E2E:
  - Claim hash field order in e2e script (publisher/user swapped vs contract)
  - Signer funding: pallet-revive needs ~10^24 planck per signer (gas costs ~5×10^21 per call)
  - Quorum: 30 DOT stake below 100 DOT quorum, bumped to 150 DOT
  - Existential deposit: 10 impressions produced sub-ED payment, bumped to 1M with 100 DOT budget
- [x] Test account funding (`fund-test-accounts.ts`): 24 accounts funded — 6 config, 3 advertisers, 3 viewers, 2 publishers, 3 voters, 2 light-funded, 5 ED edge cases
- [x] **Denomination rounding finding:** The real transfer floor on pallet-revive devchain is NOT the existential deposit — it's the eth-rpc denomination rounding bug. `value % 10^6 >= 500_000` causes rejection. Values of 999k and 500k planck are rejected, but 1M and 1k both succeed. ED on devchain is very low (~1000 planck). All contract value transfers must use clean multiples of 10^6 planck for amounts >= 10^6.
- [ ] Load alpha-extension in Chrome, configure for local devnet (browser E2E — manual step)
- [ ] Fix any runtime issues from browser E2E

#### A3.3 — Paseo testnet deployment

- [ ] Verify pallet-revive active on Paseo (`system.pallets` includes `Contracts` or `Revive`)
- [ ] Acquire Paseo testnet DOT via faucet for deployer wallet
- [ ] Set env: `PASEO_RPC`, `DEPLOYER_PRIVATE_KEY`
- [ ] Deploy: `cd alpha && npx hardhat run scripts/deploy.ts --network paseo`
  - Deploy order: PauseRegistry → Timelock → Publishers → Campaigns → GovernanceV2 → GovernanceSlash → Settlement → Relay → ZKVerifier
  - Wire (immediate): v2.setSlashContract(slash), campaigns.setGovernanceContract(v2), campaigns.setSettlementContract(settlement), settlement.setRelayContract(relay), settlement.setZKVerifier(zkVerifier)
  - Transfer ownership: campaigns.transferOwnership(timelock), settlement.transferOwnership(timelock)
- [ ] Record addresses in `alpha/deployments/paseo.json`
- [ ] Set testnet-appropriate thresholds:
  - `activationThreshold`: low (e.g., 1 DOT weighted — allows easy testing)
  - `terminationThreshold`: low (e.g., 0.5 DOT weighted)
  - `minReviewerStake`: low (e.g., 0.1 DOT)
  - `minimumCpmFloor`: low (e.g., 0.0001 DOT)
- [ ] Verify ECRecover precompile: submit a relay-signed batch on Paseo
- [ ] Run `alpha/scripts/e2e-smoke.ts` against Paseo

#### A3.4 — Alpha extension for Paseo

- [ ] Update `alpha-extension/src/shared/networks.ts` with Paseo contract addresses
- [ ] Set Paseo as default network
- [ ] Build: `cd alpha-extension && npm run build`
- [ ] Load in Chrome, test against Paseo:
  - Create campaign with real IPFS metadata
  - Vote → activate
  - Browse → ad appears → claims generated with auction clearing CPM
  - Submit claims → settlement on Paseo
  - Withdraw
- [ ] Document load instructions in `alpha-extension/README.md`

#### A3.5 — Open testing

- [ ] Publish Paseo contract addresses publicly
- [ ] Document how external testers can:
  - Get Paseo DOT from faucet
  - Load the alpha extension
  - Register as publisher
  - Create campaigns
  - Browse and earn
  - Vote on governance
- [ ] No KYB enforcement — anyone can create campaigns
- [ ] Monitor contract events for unexpected patterns

### Gate GA (Alpha Complete)

- [x] Admin timelock active on Campaigns + Settlement (48h delay via DatumTimelock) — 15/15 tests (T1-T15)
- [x] Global pause tested and verified on Hardhat EVM — 8/8 tests (P1-P8)
- [x] Governance V2 replaces V1 — 26/26 tests (V1-V8, W1-W5, E1-E5, S1-S5, D1-D4)
- [x] PVM bytecode sizes confirmed under 49,152 B — all 9 contracts fit (A1.3 complete)
- [x] 100 tests pass in alpha test suite (exceeds 75+ target)
- [ ] All alpha contracts deployed on Paseo, addresses in `alpha/deployments/paseo.json`
- [x] Extension builds clean (0 webpack errors), V2 overhaul complete (7 tabs, P19 auction, P16 behavioral)
- [x] Second-price auction producing clearing CPMs < bidCpmPlanck (auction.ts integrated)
- [x] Claim export/import code complete (claimExport.ts + ClaimQueue buttons) — round-trip needs runtime verification in A3.2
- [ ] IPFS metadata pinning and retrieval works end-to-end
- [ ] At least 3 external testers have completed a full flow on Paseo
- [ ] No critical bugs in first 7 days of Paseo operation

---

## Part 4B: Pre-Launch Review Findings (2026-03-08)

Comprehensive code review of all contracts, extension, deploy scripts, tests, and documentation. Findings organized by priority tier.

### Tier 0 — Blockers (fix before any external testing)

#### ~~B1 — Auto-submit private key stored unencrypted~~ ✅ FIXED
- **Fix applied:** Session-scoped encryption. Private key encrypted with PBKDF2+AES-256-GCM using random session password held in service worker memory. Key encrypted at rest in chrome.storage.local. Session password lost on browser restart (requires re-authorization).

#### ~~B2 — Deploy script has no error handling or wiring validation~~ ✅ FIXED
- **Fix applied:** Per-step try/catch with step numbers, post-wire read-back validation (7 checks), addresses only written after validation, re-run safety (checks one-time setters before calling), ownership transfer skip if already transferred.

### Tier 1 — High priority (fix before Paseo deployment / A3.3)

#### ~~H1 — Division-by-zero guard in GovernanceSlash~~ ✅ FIXED
- **Fix applied:** Added `require(winningWeight[campaignId] > 0, "E03")` before division in `claimSlashReward()`. Added test S6 (all-winners-withdrew edge case). 101/101 tests pass.

#### ~~H2 — A2.3: Timelock event monitoring in extension~~ ✅ FIXED
- **Fix applied:** New `timelockMonitor.ts` polls ChangeProposed/Executed/Cancelled events. Integrated into campaign poll alarm. Warning banner in App.tsx header shows pending admin change count. New `getTimelockContract` factory + `GET_TIMELOCK_PENDING` message type.

#### ~~H3 — A2.4: IPFS pinning integration~~ ✅ FIXED
- **Fix applied:** New `ipfsPin.ts` (Pinata API). Pinata JWT field in Settings.tsx with test button. "Pin to IPFS" button in AdvertiserPanel CreateCampaignForm with title/description/creative fields. CID auto-fills metadata input. `pinataApiKey` added to StoredSettings.

#### ~~H4 — RPC URL validation for non-local networks~~ ✅ FIXED
- **Fix applied:** Settings.tsx warns on HTTP for non-local networks on save. Orange warning banner below RPC URL input.

#### ~~H5 — Extend E2E setup script for full flow coverage~~ ✅ FIXED
- **Fix applied:** New `e2e-full-flow.ts` covering: campaign lifecycle (create→vote→activate→metadata), settlement (hash chain + settleClaims), withdrawals (publisher+user), pause/unpause cycle, governance slash (vote→terminate→finalize→claim), timelock (propose→execute reverts→cancel). Run with `npx hardhat run scripts/e2e-full-flow.ts --network substrate`.

### Tier 2 — Medium priority (fix before production / mainnet)

#### ~~M1 — Deploy output validation test~~ ✅ FIXED (via B2)
- Covered by deploy.ts validation phase: checks all 9 keys present and non-zero before writing file.

#### ~~M2 — Zero-address wiring assertion in tests~~ ✅ FIXED (via B2)
- Covered by deploy.ts post-wire validation: reads back 7 references and verifies against expected addresses.

#### ~~M3 — Wallet password strength warning~~ ✅ FIXED
- **Fix applied:** Password strength indicator in App.tsx wallet setup. Checks length, case mix, digits, symbols, common patterns. Shows colored label: Too short / Weak / Fair / Good / Strong.

#### M4 — Governance sweep of abandoned/dust funds (post-alpha)

Two sources of stuck funds:

1. **Unclaimed slash rewards:** `GovernanceSlash.claimSlashReward()` has no expiry — unclaimed slash pools are locked forever.
2. **Abandoned campaign budgets:** Completed or Terminated campaigns with non-zero `remainingBudget` (e.g. rounding dust, advertiser lost keys) have no reclaim path.

**Constraint:** DatumCampaigns is at 48,760 B (392 spare). Cannot add a full sweep function without exceeding the 49,152 B PVM limit.

**Design (two-contract pattern):**

*GovernanceSlash* (18,854 B spare) — orchestrator + slash sweep:
- `sweepSlashPool(uint256 campaignId)` — callable by anyone after `sweepAfterBlocks` (e.g. 1,296,000 blocks / ~90 days) post-resolution. Transfers unclaimed slash pool balance to caller as bounty incentive.
- New storage: `uint256 public sweepAfterBlocks` (constructor-set or owner-settable via timelock).

*DatumCampaigns* — thin entry point (~400-600 B, requires size savings first):
- `sweepAbandonedBudget(uint256 campaignId, address recipient) external` — callable by GovernanceSlash only. Requires terminal status (Completed/Terminated/Expired) + `block.number > terminationBlock + sweepAfterBlocks`. Sends `remainingBudget` to `recipient`, zeroes balance.
- GovernanceSlash calls `campaigns.sweepAbandonedBudget(id, msg.sender)` so the caller receives the dust as a keeper bounty.

**Size budget for Campaigns entry point:**
- Need ~400-600 B. Current spare: 392 B.
- Options: (a) wait for resolc optimizer improvements, (b) slim existing code (remove `togglePause` saves ~300-400 B but breaks tests), (c) extract sweep to a separate thin contract that Campaigns authorizes.
- Recommended: wait for resolc improvements or extract to `DatumSweeper` contract with a `campaigns.setSweepContract(addr)` one-line setter.

**Interface additions (IDatumCampaigns.sol):**
```solidity
event CampaignSwept(uint256 indexed campaignId, address indexed recipient, uint256 amount);
function sweepAbandonedBudget(uint256 campaignId, address recipient) external;
```

**Interface additions (IDatumGovernanceSlash.sol):**
```solidity
event SlashPoolSwept(uint256 indexed campaignId, address indexed sweeper, uint256 amount);
function sweepSlashPool(uint256 campaignId) external;
```

**Test plan:** S-sweep1 (slash sweep after deadline), S-sweep2 (slash sweep before deadline reverts), C-sweep1 (campaign sweep after deadline), C-sweep2 (campaign sweep before deadline reverts), C-sweep3 (sweep non-terminal status reverts), C-sweep4 (sweep zero-balance is no-op).

#### ~~M5 — Document daily cap timestamp limitation~~ ✅ FIXED
- **Fix applied:** Added "Known limitations" table to ALPHA.md (Part 1) and README.md with timestamp and slash expiry notes.

#### ~~M6 — Publisher attestation should enforce HTTPS~~ ✅ FIXED
- **Fix applied:** `publisherAttestation.ts` rejects non-localhost HTTP domains. Logs warning and falls back to degraded trust mode.

### Tier 3 — Low priority (post-beta / nice-to-have)

- [ ] **L1:** `MAX_SCAN_ID` in `campaignPoller.ts` hardcoded to 1000 — may need increase on Polkadot Hub
- [ ] **L2:** Campaign poll interval (5 min) should be user-configurable in Settings
- [ ] **L3:** Two-step ownership transfer pattern (`transferOwnership` → `acceptOwnership`) instead of single `owner = newOwner`
- [ ] **L4:** Add concurrent settlement test (multiple users settling same block)
- [x] **L5:** ~~Add test for GovernanceSlash all-winners-withdrew edge case~~ ✅ Added S6 test
- [ ] **L6:** Add manual test procedure to README for claim export/import (from A2.2 checklist)

### Content Safety Rails (2026-03-09)

Ad creative metadata from IPFS now passes through validation before rendering:

| Layer | File | Protection |
|-------|------|-----------|
| Fetch | `campaignPoller.ts` | 10KB metadata size cap (Content-Length + body check), schema + URL + blocklist validation via `validateAndSanitize()` |
| Storage | `content/index.ts` | Defense-in-depth re-validation of cached metadata before render (catches pre-update cache, storage corruption) |
| Render | `adSlot.ts` | Shadow DOM isolation (page CSS/JS cannot access ad DOM), `sanitizeCtaUrl()` — only `https://` allowed, unsafe URLs render as non-clickable `<span>` |
| Shared | `contentSafety.ts` | Schema shape check, field length caps (title ≤128, desc ≤256, text ≤512, cta ≤64, ctaUrl ≤2048), URL scheme allowlist, content blocklist (multi-word phrases for adult/gambling/drugs/weapons/tobacco/counterfeit) |

### Review Scores

| Category | Score | Notes |
|----------|-------|-------|
| Contract security | 95/100 | H1 div-by-zero fixed. BUG3 zero-vote fixed. C-M1 timelock cancel fixed. Timestamp daily cap documented. |
| Reentrancy protection | 19/20 | OZ ReentrancyGuard + manual locks, CEI pattern throughout |
| Access control | 19/20 | Owner checks, caller verification, Timelock integration |
| Extension crypto | 10/10 | AES-256-GCM, PBKDF2 310K, HKDF. B1 fixed: auto-submit key encrypted with session-scoped password. |
| Error handling | 10/10 | B2 fixed: deploy.ts has per-step try/catch, post-wire validation, re-run safety. |
| Test coverage | 9.5/10 | 111/111 tests + E2E full-flow script. Missing: concurrent settlement (L4), BUG3 regression test (T1). |
| Documentation | 10/10 | ALPHA.md, REVIEW.md, MVP.md, README.md internally consistent. Known limitations documented. |

---

## Part 4C: Alpha Review Findings (2026-03-09)

Comprehensive audit of all contracts, extension code, tests, and deploy scripts. Findings organized by severity and component.

### Bugs (all fixed, validated in A3.2 devnet E2E)

#### ~~BUG1~~ — e2e-full-flow.ts nonce = 0 ✅ FIXED
- **Location:** `alpha/scripts/e2e-full-flow.ts:114`
- **Problem:** `nonce = 0n` but Settlement requires nonce >= 1 for genesis claims.
- **Fix applied:** Changed to `const nonce = 1n`.

#### ~~BUG2~~ — e2e-full-flow.ts wrong getter names ✅ FIXED
- **Location:** `alpha/scripts/e2e-full-flow.ts:158, 159, 174, 175`
- **Problem:** Calls `publisherBalances`/`userBalances` (plural) but actual mappings are singular.
- **Fix applied:** Changed all four calls to `publisherBalance`/`userBalance`.

#### ~~BUG3~~ — Zero-vote termination of Active campaigns ✅ FIXED
- **Location:** `alpha/contracts/DatumGovernanceV2.sol:188-190`
- **Problem:** `evaluateCampaign()` for Active/Paused campaigns checks `nayWeighted * 10000 >= total * 5000`. If total = 0 (no votes), this is `0 >= 0` which passes. Anyone can terminate an Active campaign with zero governance votes, triggering a 10% budget slash.
- **Fix applied:** Added `require(total > 0, "E51")` before the nay majority check in the `status == 1 || status == 2` branch.

### Contracts — High Priority (fix before A3.3 Paseo)

#### C-H1 — Missing zero-address checks on contract reference setters
- **Location:** `DatumCampaigns.sol:81-87`, `DatumSettlement.sol:83-89`
- **Problem:** `setSettlementContract()`, `setGovernanceContract()`, `setRelayContract()`, `setZKVerifier()` all accept `address(0)` with no validation. A misconfigured timelock proposal could wire a zero address.
- **Fix:** Add `require(addr != address(0), "E00")` to all four setters. Exception: `setZKVerifier(address(0))` is valid (disables ZK verification), so document rather than block.

#### C-H2 — Missing events on contract reference changes
- **Location:** `DatumCampaigns.sol:81-87`, `DatumSettlement.sol:83-89`, `DatumCampaigns.sol:89-92`, `DatumTimelock.sol:68-71`
- **Problem:** `setSettlementContract()`, `setGovernanceContract()`, `setRelayContract()`, `setZKVerifier()`, and `transferOwnership()` make critical state changes with no events. Off-chain monitoring cannot detect wiring changes.
- **Fix:** Add events: `SettlementContractSet(address)`, `GovernanceContractSet(address)`, `RelayContractSet(address)`, `ZKVerifierSet(address)`, `OwnershipTransferred(address indexed previous, address indexed newOwner)`.

#### C-H3 — ZK proof verification accepts empty return
- **Location:** `DatumSettlement.sol:217-224`
- **Problem:** ZK staticcall with `ok2=true` but `ret.length < 32` implicitly passes verification (the decode branch is skipped). A malicious or broken verifier returning empty bytes bypasses ZK checks.
- **Fix:** Change condition to `if (!ok2 || ret.length < 32 || !abi.decode(ret, (bool)))` — require explicit `true` return.

#### C-H4 — DatumPublishers uses separate pause from PauseRegistry
- **Location:** `DatumPublishers.sol:56, 75, 90`
- **Problem:** DatumPublishers inherits OZ `Pausable` (local pause) rather than checking `pauseRegistry.paused()`. Two independent pause mechanisms: global registry could be unpaused while Publishers is locally paused, or vice versa.
- **Fix (post-alpha):** Replace OZ `Pausable` with `pauseRegistry.paused()` check, or document dual-pause as intentional.

### Contracts — Medium Priority

#### ~~C-M1~~ — Timelock cancel() doesn't validate pending exists ✅ FIXED
- **Location:** `DatumTimelock.sol:59-65`
- **Problem:** `cancel()` doesn't check `pendingTarget != address(0)`. Calling cancel with no pending proposal emits `ChangeCancelled(address(0))` — misleading for monitors.
- **Fix applied:** Added `require(pendingTarget != address(0), "E35")`.

#### C-M2 — Inconsistent error codes reused
- **Problem:** Error code "E03" is used for three different conditions across GovernanceSlash (winningWeight > 0, share > 0) and Settlement (withdrawal balance > 0).
- **Fix (post-alpha):** Assign unique codes for each condition.

#### C-M3 — Manual reentrancy guard in Campaigns vs OZ in Settlement
- **Location:** `DatumCampaigns.sol` (manual `_locked`), `DatumSettlement.sol` (OZ `nonReentrant`)
- **Problem:** Inconsistent pattern. Manual guard works correctly but is more error-prone when adding new functions.
- **Note:** Switching to OZ `ReentrancyGuard` in Campaigns would likely exceed the 392 B PVM spare. Document as intentional trade-off.

### Extension — High Priority

#### ~~E-H1~~ — Claim builder nonce race condition ✅ FIXED
- **Location:** `background/claimBuilder.ts:22-83`
- **Problem:** `getChainState()` → build claim → `setChainState()` is not atomic. Two simultaneous impressions (two tabs loading at once) could both read nonce N and create two claims with nonce N+1. The duplicate nonce gets rejected by Settlement.
- **Fix applied:** Added per-(user, campaignId) promise-chain mutex (`withLock()`) that serializes all access to chain state for a given user+campaign pair.

#### ~~E-H2~~ — Content script unhandled promise rejections ✅ FIXED
- **Location:** `content/index.ts:19, 43, 98-104`, `content/engagement.ts:185`
- **Problem:** Multiple `chrome.runtime.sendMessage()` calls have no `.catch()`. If the background service worker is inactive or restarting, messages silently fail — lost impressions and engagement data.
- **Fix applied:** Wrapped all `sendMessage` calls in try-catch. Fire-and-forget messages use inline `try { ... } catch {}`. Awaited messages (`GET_ACTIVE_CAMPAIGNS`, `SELECT_CAMPAIGN`) return early on failure.

#### ~~E-H3~~ — Deployed addresses loaded without network validation ✅ FIXED
- **Location:** `popup/Settings.tsx:190-219`, `alpha/scripts/deploy.ts`
- **Problem:** "Load Deployed" button loads addresses from `deployed-addresses.json` without checking they match the current network setting. User could load mainnet addresses on testnet or vice versa.
- **Fix applied:** `deploy.ts` now writes `network` field to `deployed-addresses.json`. `Settings.tsx` compares against current network and shows confirmation dialog on mismatch.

#### ~~E-H4~~ — SDK handshake spoofing: no signature verification ✅ FIXED
- **Location:** `content/handshake.ts:35-49`
- **Problem:** Handshake only checks `detail.challenge === challenge` but does not verify the SHA-256 signature. Any page script can listen for `datum:challenge` events and respond with a matching challenge, spoofing the publisher attestation.
- **Fix applied:** `handshake.ts` now recomputes the expected SHA-256 hash (`SHA-256(publisher + ":" + challenge + ":" + nonce)`) and verifies it matches `detail.signature`. Also verifies `detail.publisher` matches the expected publisher address. Rejects empty signatures and mismatches.

#### ~~E-H5~~ — Quality score computed in untrusted content script ✅ FIXED
- **Location:** `content/engagement.ts`, `background/index.ts`, `background/claimBuilder.ts`
- **Problem:** Quality score was computed in the content script (`computeQualityScore()` in engagement.ts) and sent to background via `ENGAGEMENT_QUALITY_RESULT` message. A malicious page could intercept or forge these messages to inflate quality scores and earn higher CPM payouts. Additionally, the `qualityScore` CPM discount in `claimBuilder.onImpression()` was dead code — never triggered because `qualityScore` was never included in the `IMPRESSION_RECORDED` message.
- **Fix applied:** (1) Moved `computeQualityScore()` and `meetsQualityThreshold()` to `shared/qualityScore.ts`. (2) Background `ENGAGEMENT_RECORDED` handler now computes quality in trusted context and retroactively removes queued claims that fail the threshold. (3) Removed dead CPM discount code from `claimBuilder.ts`. (4) Content script sends only raw `EngagementEvent` data.

### Extension — Medium Priority

#### E-M1 — Auto-submit deauth not visible in UI
- **Location:** `background/index.ts:427`, `popup/Settings.tsx:324`
- **Problem:** Session password is lost on service worker restart. UI shows "authorized (this session)" but doesn't warn that restart deauthorizes. User may believe auto-submit is running when it's not.
- **Fix:** Ping auto-submit authorization status on Settings mount. Show warning banner if enabled but not authorized.

#### E-M2 — Interest profile storage race
- **Location:** `background/interestProfile.ts:52-68`
- **Problem:** `getProfile()` → mutate → `set()` is not atomic. Multiple tabs updating simultaneously can lose profile writes.
- **Fix:** Use a write mutex or queue-and-flush pattern.

#### E-M3 — Metadata fetch failure not retried
- **Location:** `background/campaignPoller.ts:105-107`
- **Problem:** Failed IPFS metadata fetch is silently skipped. On the next poll cycle, the TTL check at line 84 prevents retry (the timestamp is set even on success-only path, but the absence of `metaKey` means it will retry — this is actually fine). However, if the gateway is temporarily down, all campaigns show placeholder creatives with no indication of fetch failure.
- **Fix:** Track fetch failure count and surface in UI after 3+ consecutive failures.

#### E-M4 — Signed relay batches never auto-expire from storage
- **Location:** `popup/PublisherPanel.tsx:240-247`
- **Problem:** Signed batches with expired deadlines remain in `chrome.storage.local` until manually cleared. Stale UI shows expired batches.
- **Fix:** Add cleanup in campaign poll alarm — remove signed batches where `deadline <= currentBlock`.

#### E-M5 — Category filter not persisted across tab switches
- **Location:** `popup/CampaignList.tsx:23`
- **Problem:** `categoryFilter` state resets when switching tabs. Minor UX friction.
- **Fix:** Persist in `chrome.storage.session`.

#### E-M6 — Governance conviction tooltip missing
- **Location:** `popup/GovernancePanel.tsx:32-40`
- **Problem:** `CONVICTION_LABELS` show "1x, 2x, 4x..." but don't explain that conviction multiplies both vote weight AND lock duration. Users could misunderstand lockup commitment.
- **Fix:** Add tooltip or note: "Multiplies both voting power and lock duration."

### Tests — Missing Coverage

#### T-1 — Zero-vote edge cases
- Add test: `evaluateCampaign` on Active campaign with 0 votes (currently passes — BUG3).
- Add test: `evaluateCampaign` on non-existent campaign.

#### T-2 — Settlement edge cases
- Add test: `deductBudget()` with amount = 0 (should revert or no-op).
- Add test: `deductBudget()` on Paused campaign (should revert E15).
- Add test: settle same claim twice (replay with same nonce — should get E07).
- Add test: claim with `impressionCount` producing rounding-to-zero payment.

#### T-3 — Governance edge cases
- Add test: `vote()` with `msg.value = 0` (should revert E41).
- Add test: conviction = 6 produces exactly 64x weight and lockup capped at maxLockupBlocks.
- Add test: `withdraw()` on Paused campaign before resolution.

#### T-4 — Timelock edge cases
- Add test: `cancel()` with no pending proposal.
- Add test: `propose()` overwrites a pending proposal (reset timer).
- Add test: `execute()` where target call reverts.

#### T-5 — PauseRegistry idempotency
- Add test: `pause()` when already paused.
- Add test: `unpause()` when already unpaused.

#### T-6 — Publisher edge cases
- Add test: `registerPublisher` at exactly min (3000) and max (8000) take rate.
- Add test: `registerPublisher` called twice (duplicate registration).

#### T-7 — Integration gaps
- Add test: multiple campaigns from same advertiser with independent states.
- Add test: multiple batches in single `settleClaims` call (each ≤ 5 claims, total > 5).
- Add test: revenue split with non-round amounts (rounding validation).

---

## Part 4D: Extension UX Audit & Multi-Account (2026-03-13)

Comprehensive functional review of all 7 popup panels, background service, content script, and ad delivery pipeline. Findings organized by component with severity and implementation effort. Includes multi-account wallet feature for testing.

### Multi-Account Wallet (MA) — New Feature

Support multiple named accounts with import/generate/switch/remove per account. Required for testing (advertiser, publisher, voter, user roles from single browser).

#### MA-1 — Storage layer: multi-wallet support
- **Location:** `shared/walletManager.ts`
- **Current:** Single `datumEncryptedWallet` key, single `connectedAddress`, single `unlockedWallet` in memory.
- **Change:** Replace with `wallets` map (`Record<accountName, EncryptedWalletData>`), `activeWalletName` key, per-account unlock. Each account = one private key = one address.
- **Storage schema:**
  ```
  "wallets": { "Advertiser": EncryptedWalletData, "Publisher": EncryptedWalletData, ... }
  "activeWalletName": "Advertiser"
  "connectedAddress": "0x..."
  ```
- **New exports:** `listWallets()`, `getWalletAddress(name)`, `setActiveWallet(name)`, `deleteWallet(name)`, `renameWallet(old, new)`. Overload `importKey`/`generateKey`/`unlock` to accept account name.
- **Effort:** Medium

#### MA-2 — Popup wallet UI: account picker and management
- **Location:** `popup/App.tsx`
- **Change:** Add account selector dropdown in header (name + abbreviated address). Account management: "Add Account" (import or generate with name), "Switch Account" (unlock different account), "Rename Account", "Remove Account" (with typed confirmation for funded accounts).
- **States:** `walletNames: string[]`, `activeWallet: string | null`. Pass through to all child panels via `address` prop (unchanged).
- **UX:** Lock all accounts on "Lock" button. Switching accounts requires password entry for target account.
- **Effort:** Medium

#### MA-3 — Background: per-account auto-submit
- **Location:** `background/index.ts`
- **Change:** `AUTHORIZE_AUTO_SUBMIT` now includes `accountName`. Session password map: `Map<accountName, string>`. `autoFlushDirect()` uses active account's session key. `WALLET_CONNECTED` message includes `accountName`.
- **Effort:** Low

#### MA-4 — Migration: single-wallet to multi-wallet
- **Location:** `shared/walletManager.ts`
- **Change:** On first load, if `datumEncryptedWallet` exists but `wallets` does not, migrate to `wallets: { "Account 1": <existing data> }` and set `activeWalletName: "Account 1"`. Delete legacy key after migration.
- **Effort:** Low

### Campaign Lifecycle (CL)

#### CL-1 — Auto-hide resolved campaigns ✅ DONE
- **Severity:** High | **Effort:** Low
- **Location:** `popup/CampaignList.tsx`, `popup/AdvertiserPanel.tsx`, `popup/GovernancePanel.tsx`
- **Problem:** Expired (5), Terminated (4), and Completed (3) campaigns persist in UI indefinitely. No cleanup.
- **Fix:** Add configurable auto-hide after N blocks (default 14,400 = ~24h). "Show resolved" toggle already exists in GovernancePanel — extend to CampaignList and AdvertiserPanel. Add "Clear resolved" button.

#### CL-2 — Stale claims for dead campaigns ✅ DONE
- **Severity:** High | **Effort:** Low
- **Location:** `background/index.ts` (ALARM_POLL_CAMPAIGNS), `popup/ClaimQueue.tsx`
- **Problem:** Claims queued for terminated/expired campaigns remain in queue indefinitely. `pruneInactiveCampaigns()` runs on poll but user is never notified that claims are unsubmittable.
- **Fix:** Proactively prune claims for campaigns in terminal states (3/4/5). Show notification in ClaimQueue: "X claims removed — campaign terminated/expired."

#### CL-3 — No expiration visibility ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/CampaignList.tsx`, `popup/AdvertiserPanel.tsx`
- **Problem:** Pending campaigns have a ~7 day timeout (`pendingExpiryBlock`) but it's not exposed by slim getters. Users can't see when auto-expiry occurs.
- **Fix:** Show "Expires in ~X days" hint on Pending campaigns (estimate from creation block + 100,800 blocks). Use CampaignCreated event block number as creation reference.

#### CL-4 — Metadata cached beyond campaign death ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `background/campaignPoller.ts`
- **Problem:** IPFS metadata cached with 1-hour TTL but never cleaned when campaign terminates. Storage grows indefinitely.
- **Fix:** Delete `metadata:${campaignId}` entries when campaign enters terminal state.

#### CL-5 — Paused campaign status unexplained ✅ DONE
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/CampaignList.tsx`
- **Problem:** Paused campaigns are returned by poller but filtered out by content script (status !== 1). Users don't understand why a campaign they were seeing stopped delivering.
- **Fix:** Show "Paused" badge on campaign cards with tooltip: "This campaign is temporarily paused by its advertiser or governance."

### User Preference & Control Gaps (UP)

#### UP-1 — Min CPM threshold has no UI ✅ DONE (already existed in Settings Ad Preferences)
- **Severity:** High | **Effort:** Low
- **Location:** `popup/Settings.tsx`
- **Problem:** `minBidCpm` exists in UserPreferences and is enforced in auction filtering, but Settings panel has no input field. Dead feature — users can't set it.
- **Fix:** Add "Minimum bid CPM (DOT)" text input next to the maxAdsPerHour slider in Ad Preferences section.

#### UP-2 — No address blocklist management UI ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `popup/Settings.tsx`
- **Problem:** `phishingList.ts` has `addBlockedAddress`/`removeBlockedAddress` API but no panel exposes it. Users can't manually block a specific advertiser or publisher.
- **Fix:** Add "Blocked Addresses" section in Settings (below Ad Preferences). List current blocked addresses with remove buttons. Add input + "Block Address" button. Show phishing list status (last fetch time, domain count).

#### UP-3 — Blocked campaigns persist forever ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `shared/userPreferences.ts`
- **Problem:** Blocking a campaign adds its ID to `blockedCampaigns[]`. IDs for terminated/expired campaigns accumulate without cleanup.
- **Fix:** On campaign poll, remove blocked IDs for campaigns in terminal states (3/4/5).

#### UP-4 — Silenced categories bypass for uncategorized ⬜
- **Severity:** Medium | **Effort:** Low
- **Location:** `background/index.ts` (SELECT_CAMPAIGN), `shared/userPreferences.ts`
- **Problem:** Campaigns with `categoryId=0` (uncategorized) bypass all category silencing. No way to block uncategorized ads.
- **Fix:** Add "Uncategorized" as a silenceable option in Settings category tree.

#### UP-5 — No auction transparency ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `popup/CampaignList.tsx` or new panel
- **Problem:** Users can't see which campaigns competed, why one won, clearing CPM mechanism (solo/second-price/floor), or interest weight contribution.
- **Fix:** Store last auction result in `chrome.storage.local`. Show in CampaignList or a dedicated "Last Ad" info section: winning campaign, clearing CPM, participant count, mechanism, interest weight.

#### UP-6 — Rate limit counter not visible ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/UserPanel.tsx` or `popup/Settings.tsx`
- **Problem:** `maxAdsPerHour` enforced but no "X/12 ads shown this hour" display.
- **Fix:** Show impression count for current hour alongside maxAdsPerHour setting.

#### UP-7 — Per-campaign claim management ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `popup/ClaimQueue.tsx`
- **Problem:** Only "Submit All" or "Clear All" — can't submit or discard claims for a single campaign.
- **Fix:** Add per-campaign row actions: "Submit" (single campaign batch) and "Discard" (remove claims for one campaign).

#### UP-8 — No per-campaign frequency cap ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `content/index.ts`, `background/index.ts`
- **Problem:** `maxAdsPerHour` is global. A single high-bid campaign can dominate all ad slots.
- **Fix:** Add per-campaign dedup window (already 5 min per campaign+hostname). Consider extending to configurable per-campaign hourly cap.

### Wallet & Security UX (WS)

#### WS-1 — Generated key: no copy button ✅ DONE
- **Severity:** High | **Effort:** Low
- **Location:** `popup/App.tsx`
- **Problem:** Private key shown once during wallet generation with no copy-to-clipboard. Users must manually select text in small popup.
- **Fix:** Add "Copy to clipboard" button next to generated key display. Clear clipboard after 60 seconds.

#### WS-2 — Password minimum too low ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/App.tsx`
- **Problem:** 4-character minimum password. Insufficient for production.
- **Fix:** Increase to 8-character minimum. Keep strength indicator (M3).

#### WS-3 — Auto-submit lost on restart: no warning ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/Settings.tsx`, `background/index.ts`
- **Problem:** Session password in-memory only. After SW restart, auto-submit silently stops. No notification.
- **Fix:** On Settings mount, ping `CHECK_AUTO_SUBMIT`. If `autoSubmit=true` but not authorized, show warning: "Auto-submit was interrupted — re-authorize to resume." (Partially addressed by E-M1, but needs UI banner.)

#### WS-4 — Remove Wallet needs stronger confirmation ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/App.tsx`
- **Problem:** Single confirmation dialog for wallet removal. Losing wallet = losing all funds.
- **Fix:** Require typed confirmation: "Type DELETE to confirm wallet removal."

### Governance UX (GV)

#### GV-1 — Conviction lockup duration not in human time ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/GovernancePanel.tsx`
- **Problem:** Dropdown shows "1x (base lockup)" but not "~24 hours" or "~365 days".
- **Fix:** Extend `CONVICTION_LABELS` with estimated time: `"1x (~24h lockup)"`, `"2x (~48h)"`, ..., `"32x (~365d)"`.

#### GV-2 — No warning before first vote (irreversible) ✅ DONE
- **Severity:** High | **Effort:** Low
- **Location:** `popup/GovernancePanel.tsx`
- **Problem:** Contract prevents re-voting (E42). UI doesn't warn that voting is a one-time, locked commitment per campaign.
- **Fix:** Add confirmation dialog before `castVote()`: "Voting is permanent — you cannot change your vote on this campaign. Your stake will be locked for [duration]. Continue?"

#### GV-3 — Quorum progress not shown on campaign cards ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/GovernancePanel.tsx`
- **Problem:** Pending campaigns show aye/nay bar but not "X/100 DOT quorum" progress.
- **Fix:** Add quorum progress bar or "X/100 DOT" text on each Pending campaign card.

#### GV-4 — Timelock pending changes opaque ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `popup/GovernancePanel.tsx` or `popup/App.tsx` (timelock warning banner)
- **Problem:** Timelock `ChangeProposed` events show raw hex calldata. Users can't understand what's changing.
- **Fix:** ABI-decode known function selectors (setSettlementContract, setGovernanceContract, etc.) and display human-readable descriptions: "Settlement contract changing to 0x...1234 in 48 hours."

### Publisher UX (PU)

#### PU-1 — Take rate effective block not shown ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/PublisherPanel.tsx`
- **Problem:** When publisher sets new take rate, no display of when it becomes effective.
- **Fix:** If `pendingTakeRateBps !== currentTakeRateBps`, show "New rate effective at block #X (~Y hours)."

#### PU-2 — Relay deadline in blocks, not time ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/PublisherPanel.tsx`, `popup/ClaimQueue.tsx`
- **Problem:** "Deadline block 12345" is meaningless to users. Needs human-readable time.
- **Fix:** Convert block delta to estimated time: `(deadlineBlock - currentBlock) × 6s`. Show "~4h remaining" or "Expired."

#### PU-3 — Publisher attestation failures silent ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/ClaimQueue.tsx`
- **Problem:** If co-signature endpoint is unreachable, batch shows "Unattested" with no error message.
- **Fix:** Show attestation error reason: "Publisher endpoint unreachable" or "Signature rejected."

#### PU-4 — Zero-category registration allowed ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/PublisherPanel.tsx`
- **Problem:** Can register with no categories. SDK won't match any campaigns.
- **Fix:** Warn: "No categories selected — your site won't match any campaigns." Disable "Save Categories" if none selected, or show warning.

### Earnings & Analytics (EA)

#### EA-1 — No earnings history ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `popup/UserPanel.tsx`
- **Problem:** Only shows current withdrawable balance. No record of past withdrawals or daily earning rate.
- **Fix:** Track withdrawal events (WithdrawalUser) and settlement events per poll. Store daily totals. Show simple chart or list: "Today: +X DOT, This week: +Y DOT."

#### EA-2 — No per-campaign earnings breakdown ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `popup/UserPanel.tsx`
- **Problem:** Engagement section shows aggregate. No "Campaign #3 earned you X DOT" view.
- **Fix:** Compute estimated earnings from `behaviorChain.eventCount × clearingCpm × 0.75`. Show per-campaign in breakdown.

#### EA-3 — Behavior chains never cleaned up ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `background/index.ts`, `popup/UserPanel.tsx`
- **Problem:** `behaviorChain:address:campaign` keys grow indefinitely in storage.
- **Fix:** Delete chains for campaigns in terminal states during poll alarm. Or cap at 100 entries per user (remove oldest).

#### EA-4 — Withdrawal minimum not shown ✅ DONE
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/UserPanel.tsx`, `popup/PublisherPanel.tsx`
- **Problem:** Users may try to withdraw dust and hit denomination rounding (value % 10^6 >= 500k rejected by eth-rpc).
- **Fix:** Show minimum withdrawal threshold (1M planck = 0.0001 DOT). Disable Withdraw button if balance < minimum.

### Settings & Infrastructure (SI)

#### SI-1 — No RPC connectivity test ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/Settings.tsx`
- **Problem:** User can set invalid RPC URL with no feedback until operations fail.
- **Fix:** Add "Test Connection" button next to RPC URL input. Call `provider.getBlockNumber()` and show result or error.

#### SI-2 — Network switch doesn't warn about contract mismatch ✅ DONE
- **Severity:** Medium | **Effort:** Low
- **Location:** `popup/Settings.tsx`
- **Problem:** Switching network without updating contract addresses = silent failures on every operation.
- **Fix:** On network change, check if stored contract addresses match known addresses for the selected network. Warn if mismatch. Offer to auto-clear or auto-load known addresses.

#### SI-3 — Contract address validation missing ⬜
- **Severity:** Low | **Effort:** Low
- **Location:** `popup/Settings.tsx`
- **Problem:** Accepts any string as contract address. No hex or checksum validation.
- **Fix:** Validate `0x` prefix + 40 hex chars on save. Show inline error for malformed addresses.

### Content & Ad Delivery (AD)

#### AD-1 — Quality rejection after ad display ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `background/index.ts` (ENGAGEMENT_RECORDED), `content/index.ts`
- **Problem:** Ad is shown → engagement tracked → quality scored → if below threshold, claim removed. User already saw the ad. Advertiser's budget isn't charged but user saw low-quality placement.
- **Fix:** Consider pre-scoring based on historical quality for the campaign/site combination. Reject before render if site historically produces low-quality engagements for this campaign.

#### AD-2 — No ad feedback mechanism ⬜
- **Severity:** Medium | **Effort:** Medium
- **Location:** `content/adSlot.ts`, `background/index.ts`
- **Problem:** Users can't report an ad as inappropriate, misleading, or irrelevant from the rendered ad itself. Only recourse is blocking via popup.
- **Fix:** Add small "Report" or "x" icon on ad overlay/inline. Options: "Not interested", "Inappropriate", "Misleading". Auto-block campaign + record feedback for analytics.

#### AD-3 — Content blocklist naive substring match ⬜
- **Severity:** Low | **Effort:** Medium
- **Location:** `shared/contentSafety.ts`
- **Problem:** "online casino" catches literal match but not obfuscation ("0nline cas1no", "onl ine casino").
- **Fix:** Post-alpha: normalize unicode, strip non-alpha, add leetspeak dictionary. Current blocklist is sufficient for alpha.

### Summary: Implementation Priority

**Phase 1 — Quick wins (before A3.2 browser E2E): ✅ ALL COMPLETE**
- MA-1, MA-2, MA-3, MA-4 — Multi-account wallet (testing enabler) ✅
- WS-1 — Copy button for generated key (60s clipboard auto-clear) ✅
- GV-2 — Vote permanence warning (confirm dialog with slash info) ✅
- UP-1 — Min CPM threshold UI (already existed in Settings) ✅
- CL-1 — Auto-hide resolved campaigns (CampaignList + AdvertiserPanel) ✅

**Phase 2 — Before A3.3 Paseo: ✅ ALL COMPLETE**
- CL-2 — Prune stale claims + notification (ClaimQueue pruned count display) ✅
- CL-3 — Pending expiration visibility (tooltip + inline note) ✅
- CL-5 — Paused campaign tooltip ✅
- GV-1 — Conviction lockup human time (~24h, ~48h, ..., ~365d) ✅
- GV-3 — Quorum progress display (X/Y DOT on campaign cards) ✅
- PU-1 — Take rate effective block (human time with formatBlockDelta) ✅
- PU-2 — Relay deadline in human time (~Xh remaining) ✅
- SI-1 — RPC connectivity test (block number + latency) ✅
- SI-2 — Network/contract mismatch warning (code check + ABI validation) ✅
- WS-2 — Password minimum increase (4→8 chars) ✅
- WS-3 — Auto-submit deauth warning (banner when enabled but not authorized) ✅
- EA-4 — Withdrawal minimum display (1M planck floor, UserPanel) ✅

**Phase 3 — Post-alpha polish:**
- UP-2 — Address blocklist management UI
- UP-4 — Silenced "Uncategorized" option
- UP-5 — Auction transparency
- UP-7 — Per-campaign claim management
- UP-8 — Per-campaign frequency cap
- GV-4 — Timelock ABI decoding
- EA-1 — Earnings history
- EA-2 — Per-campaign earnings breakdown
- AD-1 — Pre-scoring quality rejection
- AD-2 — In-ad feedback/report mechanism

**Deferred (beta):**
- AD-3 — Advanced content blocklist (unicode normalization, leetspeak)
- UP-3 — Auto-cleanup blocked campaign IDs
- CL-4 — Metadata cache cleanup on terminal state
- EA-3 — Behavior chain storage cleanup
- WS-4 — Typed DELETE confirmation
- SI-3 — Contract address hex validation
- UP-6 — Ads-per-hour counter display
- PU-3 — Attestation error display
- PU-4 — Zero-category registration warning

---

## Part 5: Post-Alpha Track (prioritized for beta)

After Gate GA, these items become the beta development cycle:

| Priority | Item | Description |
|----------|------|-------------|
| ~~1~~ | ~~**P18: Governance V2**~~ | **✅ COMPLETE** — Implemented in alpha. DatumGovernanceV2 + DatumGovernanceSlash. |
| 1 | **P7: Contract upgrade path** | UUPS proxy or migration pattern. Required before Kusama mainnet. |
| ~~2~~ | ~~**P21: Publisher SDK**~~ | **✅ COMPLETE** — `sdk/datum-sdk.js` + `sdk/example-publisher.html`. CustomEvent handshake protocol, inline ad injection, category declaration, extension SDK detection + handshake. |
| 3 | **P1: Mandatory attestation** | Publisher co-sig enforcement (no degraded trust mode). SDK handshake provides two-party attestation; mandatory mode post-alpha. |
| 4 | **P17: External wallets** | WalletConnect v2 for Paseo/Kusama. Keep embedded wallet as lite mode. |
| ~~5~~ | ~~**P5: Multi-publisher campaigns**~~ | **✅ COMPLETE** — Open campaigns (`publisher = address(0)`) allow any matching publisher. Category bitmask filtering. Dynamic publisher resolution at impression time. |
| 6 | **P9: ZK proof Phase 1** | Replace stub verifier with real Groth16 circuit. Requires BN128 pairing precompile. |
| ~~7~~ | ~~**P16: Behavioral analytics**~~ | **✅ COMPLETE** — Implemented in alpha extension. engagement.ts, behaviorChain.ts, behaviorCommit.ts, zkProofStub.ts. |
| 8 | **P20: Active campaign inactivity timeout** | Auto-completable by anyone after N blocks with no settlements. Prevents dust-budget lock when advertiser loses key. |

---

## Post-Alpha Optimization Opportunities

Consolidated list of all optimization, improvement, and feature opportunities deferred beyond alpha. Organized by category and priority.

### Gas & Runtime Optimizations

| # | Optimization | Affected contracts | Estimated PVM cost | Blocker | Priority |
|---|-------------|-------------------|-------------------|---------|----------|
| O1 | **Blake2-256 claim hashing** — replace `keccak256` with `hashBlake256()` via system precompile. ~3x cheaper per claim on Substrate runtime. | Settlement (+4,177 B), extension claimBuilder.ts | +4,177 B PVM (Settlement has 332 B spare) | resolc optimizer or Settlement refactor | High |
| O2 | **`weightLeft()` batch loop early abort** — check remaining weight each iteration, break gracefully for partial settlement instead of full revert. | Settlement (+4 KB), Relay (+3,598 B) | ~3.5-4 KB PVM each | resolc optimizer or contract extraction | High |
| O3 | **`minimumBalance()` in Settlement `_send()`** — prevent dust transfers below existential deposit (already in GovernanceV2). | Settlement (+~2 KB) | ~2 KB PVM (332 B spare) | resolc optimizer or Settlement refactor | Medium |
| O4 | **Storage precompile `has_key()`** — cheaper existence checks for voted/registered mappings vs full SLOAD. | GovernanceV2 (9,323 spare), Publishers (26,538 spare) | ~1-2 KB PVM each | Delegate-call requirement adds complexity | Low |
| O5 | **Storage precompile `get_range()`/`length()`** — partial reads of large storage values, batch size validation without full load. | Settlement | ~1-2 KB PVM | Same delegate-call complexity | Low |

### Security & Correctness

| # | Item | Location | Impact | Priority |
|---|------|----------|--------|----------|
| ~~S1~~ | ~~**BUG3: Zero-vote campaign termination**~~ | ~~GovernanceV2~~ | ~~Critical~~ | **✅ FIXED** — `require(total > 0, "E51")` added |
| S2 | **C-H1: Missing zero-address checks on contract reference setters** — `setSettlement/Governance/Relay/ZKVerifier` accept `address(0)`. | Campaigns:81-87, Settlement:83-89 | High — misconfigured timelock proposal bricks contracts | **Fix before A3.3** |
| S3 | **C-H2: Missing events on contract reference changes** — no events for `setXxxContract()` or `transferOwnership()`. Off-chain monitoring blind to wiring changes. | Campaigns, Settlement, Timelock | High — monitoring gap | **Fix before A3.3** |
| S4 | **C-H3: ZK verification accepts empty return** — staticcall with `ok2=true` but `ret.length < 32` silently passes. | Settlement:217-224 | High — ZK bypass (mitigated: stub verifier accepts all) | **Fix before mainnet** |
| S5 | **C-H4: Publishers dual pause** — DatumPublishers uses OZ `Pausable` (local) instead of `pauseRegistry.paused()` (global). Two independent pause states. | Publishers:56,75,90 | Medium — inconsistent pause semantics | Post-alpha |
| ~~S6~~ | ~~**C-M1: Timelock cancel() no pending check**~~ | ~~Timelock~~ | ~~Low~~ | **✅ FIXED** — `require(pendingTarget != address(0), "E35")` added |
| S7 | **C-M2: Error code E03 reused** — same code for 3 different conditions across GovernanceSlash and Settlement. | GovernanceSlash, Settlement | Low — debugging confusion | Post-alpha |
| ~~S8~~ | ~~**E-H1: Claim builder nonce race**~~ | ~~claimBuilder.ts~~ | ~~Medium~~ | **✅ FIXED** — per-(user, campaign) promise-chain mutex |
| ~~S9~~ | ~~**E-H2: Unhandled promise rejections**~~ | ~~content scripts~~ | ~~Medium~~ | **✅ FIXED** — try-catch on all sendMessage |
| ~~S10~~ | ~~**E-H3: Deployed addresses network validation**~~ | ~~Settings.tsx~~ | ~~Medium~~ | **✅ FIXED** — network field + mismatch dialog |
| ~~S11~~ | ~~**Phishing domain blocking (CTA URLs)**~~ | ~~phishingList.ts, campaignPoller.ts, content/index.ts~~ | ~~High~~ | **✅ DONE** — polkadot.js/phishing deny list, 3-layer defense (poller + content + auction) |
| S12 | **On-chain publisher/advertiser blocklist** | DatumPublishers (26 KB spare) | Medium — extension-only filtering bypassable by direct contract calls | Post-beta |

### Feature Development

| # | Feature | Description | Dependency | Priority |
|---|---------|-------------|------------|----------|
| F1 | **P7: Contract upgrade path** | UUPS proxy or migration pattern for Settlement (holds user balances). Required before mainnet. | None — design decision | 1 (beta) |
| F2 | **P1: Mandatory publisher attestation** | Enforce publisher co-sig (no degraded trust). SDK handshake provides foundation. | P21 (done) | 2 (beta) |
| F3 | **P17: External wallets** | WalletConnect v2 for SubWallet/Talisman/Polkadot.js. Keep embedded wallet as lite mode. | None | 3 (beta) |
| F4 | **P9: ZK proof Phase 1** | Replace stub verifier with real Groth16 circuit for behavioral + auction proofs. | BN128 pairing precompile on Polkadot Hub | 4 (beta) |
| F5 | **P20: Campaign inactivity timeout** | Auto-complete after N blocks with no settlements. Prevents dust-budget lock. | None | 5 (beta) |
| F6 | **M4: Governance sweep** | Reclaim abandoned slash pools + campaign dust via `sweepSlashPool()` + `sweepAbandonedBudget()`. Two-contract pattern designed (see Part 4B). | Campaigns PVM headroom (392 B spare) | Post-beta |
| F7 | **sr25519 signature verification** | Native Polkadot wallet signatures via system precompile. Eliminates EIP-712/secp256k1 requirement. | P17 (external wallets), sr25519Verify precompile stability | Post-beta |
| F8 | **XCM fee routing** | Protocol fee routing to HydraDX for DOT→stablecoin swaps via XCM precompile. | HydraDX integration (P11) | Post-beta |
| F9 | **Phishing address list (H160)** | Populate H160 blocklist from Ethereum-specific phishing feeds (e.g. MetaMask/EthPhishingDetect). SS58 addresses from polkadot.js/phishing `address.json` are not directly useful (different key type). Infrastructure ready (`addBlockedAddress`/`removeBlockedAddress` API). | None | 5 (beta) |
| F10 | **Settings UI for blocked addresses** | Admin panel to view/add/remove blocked H160 addresses and review phishing deny list status (last fetch, domain count). | F9 | Post-beta |
| F11 | **On-chain domain blocklist** | Move phishing domain deny list on-chain (DatumPublishers has 26 KB spare) so settlement itself rejects phishing campaigns. Currently extension-only — direct contract callers bypass filtering. | S12, PVM headroom | Post-beta |

### Extension Improvements

| # | Item | Description | Priority |
|---|------|-------------|----------|
| ~~X1~~ | ~~**E-M1: Auto-submit deauth visibility**~~ — ping auth status on Settings mount, warn if enabled but service worker restarted. | **✅ DONE** (WS-3) |
| X2 | **E-M2: Interest profile storage race** — write mutex for concurrent profile updates from multiple tabs. | Medium |
| X3 | **E-M3: Metadata fetch failure retry** — track consecutive failures, surface in UI after 3+. | Low |
| X4 | **E-M4: Signed relay batch expiry** — auto-remove expired batches from storage during poll alarm. | Low |
| X5 | **E-M5: Category filter persistence** — persist across tab switches via `chrome.storage.session`. | Low |
| X6 | **E-M6: Conviction tooltip** — explain that conviction multiplies both vote weight AND lock duration. | Low |
| X7 | **Phishing list fetch resilience** — retry with exponential backoff on fetch failure; surface stale-cache warning in Settings if deny list is >24h old. | Low |

### Test Coverage Gaps

| # | Area | Tests needed |
|---|------|-------------|
| T1 | Zero-vote edges | `evaluateCampaign` with 0 votes reverts E51 (BUG3 regression test); non-existent campaign |
| T2 | Settlement edges | `deductBudget(0)`; deduct on Paused; replay nonce; rounding-to-zero payment |
| T3 | Governance edges | `vote()` with 0 value; conviction=6 weight/lockup; withdraw on Paused pre-resolution |
| T4 | Timelock edges | cancel with no pending; propose overwrites pending; execute with reverting target |
| T5 | PauseRegistry | pause when paused; unpause when unpaused |
| T6 | Publisher edges | register at min/max take rate; duplicate registration |
| T7 | Integration gaps | multi-campaign same advertiser; multi-batch settleClaims; rounding validation |

### Low Priority / Nice-to-Have

| # | Item | Description |
|---|------|-------------|
| L1 | `MAX_SCAN_ID` increase | campaignPoller.ts hardcoded to 1000 — may need increase on Polkadot Hub |
| L2 | Configurable poll interval | 5 min campaign poll interval should be user-settable in Settings |
| L3 | Two-step ownership transfer | `transferOwnership()` → `acceptOwnership()` pattern instead of immediate transfer |
| L4 | Concurrent settlement test | Multiple users settling in same block |
| L6 | Claim export/import manual test | README procedure for P6 encrypted export/import |

---

## File Structure (alpha)

```
/home/k/Documents/datum/
├── ref/                          Spec documents (unchanged)
├── poc/                          PoC MVP (frozen, tagged poc-complete)
├── extension/                    PoC extension (frozen)
├── alpha/                        Alpha contracts + tests
│   ├── contracts/                9 contracts (H1: GovernanceSlash div-by-zero guard)
│   │   ├── interfaces/
│   │   │   ├── ISystem.sol       System precompile interface (0x0900) — minimumBalance, weightLeft, hashBlake256
│   ├── test/                     Extended test suite (111 tests, + open campaigns OC1-OC4, categories)
│   ├── scripts/
│   │   ├── deploy.ts             Deploy with error handling + validation (B2)
│   │   ├── setup-test-campaign.ts
│   │   ├── e2e-full-flow.ts      Full E2E test script (H5) — 6 sections, validated on devnet
│   │   ├── fund-wallet.ts
│   │   └── check-state.ts
│   ├── deployments/
│   │   ├── local.json
│   │   └── paseo.json
│   └── hardhat.config.ts
├── alpha-extension/              Alpha extension (V2 overhaul complete)
│   └── src/
│       ├── background/
│       │   ├── auction.ts        NEW — Vickrey second-price auction (P19)
│       │   ├── behaviorChain.ts  NEW — per-(user,campaign) engagement hash chain (P16)
│       │   ├── behaviorCommit.ts NEW — behavior commitment bytes32 (P16)
│       │   ├── campaignMatcher.ts  Legacy fallback selector
│       │   ├── campaignPoller.ts Modified — A1.3 slim getters, all statuses + timelock poll (H2)
│       │   ├── claimBuilder.ts   Modified — accept clearingCpmPlanck from auction
│       │   ├── claimQueue.ts     Queue management + batch building
│       │   ├── index.ts          Modified — V2 handlers, pause, auction, B1 encrypted auto-submit
│       │   ├── interestProfile.ts Modified — getNormalizedWeight()
│       │   ├── publisherAttestation.ts  Modified — HTTPS enforcement (M6)
│       │   ├── timelockMonitor.ts NEW — ChangeProposed event polling + caching (H2)
│       │   ├── userPreferences.ts NEW — block/silence/rate-limit/minCPM
│       │   └── zkProofStub.ts    NEW — dummy ZK proof generator (P16)
│       ├── content/
│       │   ├── adSlot.ts         Modified — overlay, inline (SDK), default house ad (polkadot.com/philosophy)
│       │   ├── engagement.ts     NEW — IntersectionObserver engagement capture (P16); quality scoring moved to shared/
│       │   ├── handshake.ts      NEW — challenge-response with SDK (3s timeout, SHA-256 signature verification)
│       │   ├── index.ts          Modified — SDK detection, category filtering, handshake, inline/overlay/default ad
│       │   ├── sdkDetector.ts    NEW — detect datum-sdk.js via script tag or CustomEvent (2s timeout)
│       │   └── taxonomy.ts       Multi-signal page classification
│       ├── popup/
│       │   ├── AdvertiserPanel.tsx NEW — campaign creation (open/publisher-specific) + owner controls
│       │   ├── App.tsx           Modified — 7 tabs
│       │   ├── CampaignList.tsx  Modified — block/filter/info controls
│       │   ├── ClaimQueue.tsx    Claim management + attestation badges + export/import (P6)
│       │   ├── GovernancePanel.tsx Modified — V2 API (vote, evaluate, slash)
│       │   ├── PublisherPanel.tsx Modified — category checkboxes, SDK embed snippet, removed campaign creation
│       │   ├── Settings.tsx      Modified — ad preferences, V2 addresses
│       │   ├── UserPanel.tsx     Modified — engagement stats
│       │   └── WalletSetup.tsx   Embedded wallet setup
│       └── shared/
│           ├── abis/             9 contract ABIs from alpha/artifacts/
│           ├── claimExport.ts    NEW — P6 encrypted export/import (AES-256-GCM, HKDF)
│           ├── contracts.ts      Modified — V2 factory functions + getTimelockContract (H2)
│           ├── ipfsPin.ts        NEW — Pinata IPFS pin utility (H3)
│           ├── messages.ts       Modified — V2 + preferences + engagement + auto-submit + timelock types
│           ├── networks.ts       Modified — V2 address keys + Paseo + pinataApiKey
│           ├── qualityScore.ts   NEW — engagement quality scoring (pure functions, computed in background)
│           ├── types.ts          Modified — V2 types, engagement, preferences, 26 categories + subcategories
│           ├── walletManager.ts  Modified — exports encryptPrivateKey/decryptPrivateKey (B1)
│           └── ...
├── sdk/                          Publisher SDK
│   ├── datum-sdk.js              CustomEvent handshake, category declaration (~3KB)
│   └── example-publisher.html    Demo page with SDK integration
├── REVIEW.md                     Updated through Publisher SDK overhaul
├── MVP.md                        v2.0 — includes P18/P19 plans
└── ALPHA.md                      This document
```

---

## Key Technical Decisions for Alpha

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pause pattern | DatumPauseRegistry (single contract) + inline `require(!pauseRegistry.paused(), "P")` | **Changed from original plan.** Per-contract `bool paused` was the original choice, but PVM size analysis showed ~3 KB overhead per contract for state var + staticcall. Registry avoids per-contract storage. GovernanceVoting/Rewards excluded from pause (defense-in-depth via Campaigns). |
| Timelock pattern | Standalone DatumTimelock contract: `propose(target, calldata)` → 48h → `execute()` | **Changed from original plan.** Inline `proposeChange(role, addr)` / `applyChange()` added ~7-8 KB per contract in PVM bytecode — exceeded 49,152 B limit on 4 contracts. Extraction to standalone contract saves ~7 KB per timelocked contract at cost of ownership transfer step. |
| Governance pause | Removed — defense-in-depth via Campaigns | GovernanceVoting/Rewards had only 380-407 B spare before any changes. Adding `pauseRegistry` state var + staticcall exceeded limit. Acceptable because: (1) voteAye→activateCampaign is paused at Campaigns, (2) voteNay→terminateCampaign is paused at Campaigns, (3) sub-threshold votes only stake DOT (harmless during pause). |
| Auction mechanism | On-device second-price (Vickrey) | No centralized aggregator, no oracle, deterministic. Extension-only change for Phase 1. |
| Clearing CPM floor | 30% of bidCpmPlanck | Ensures meaningful payment even without competition. Configurable. |
| Claim export encryption | AES-256-GCM, key from wallet signature of fixed message | User doesn't need separate password; key derivation is deterministic from wallet. |
| IPFS pinning | Pinata free tier for alpha | 100 files / 500 MB sufficient for testing. Evaluate alternatives at beta. |
| Testnet | Paseo | Closer to Polkadot Hub spec than Westend. Recommended by docs. |
| Open campaigns | `publisher = address(0)` + 50% snapshot take rate | PVM size constraint: external call to publisher registry too expensive in Settlement (3,105 B over). Publisher registration validated off-chain by extension and Relay. |
| System precompile usage | GovernanceV2 only (minimumBalance) | Settlement (+3,845 B over) and Relay (+626 B over) have insufficient PVM headroom for precompile calls. GovernanceV2 has 9,323 B spare after adding minimumBalance checks. Blake2-256 and weightLeft deferred to post-alpha. |
| Claim hash algorithm | keccak256 (not Blake2-256) | Blake2-256 via system precompile would save gas at runtime but adds ~4 KB PVM bytecode to Settlement (only 332 B spare). Keeping keccak256 preserves compatibility and avoids size overflow. Revisit when resolc optimizer improves or Settlement is refactored. |
| Publisher SDK | CustomEvent protocol (datum:sdk-ready, datum:challenge, datum:response) | No postMessage (CSP issues), no DOM injection from SDK (isolation). Extension detects SDK, SDK doesn't detect extension — SDK is passive. |
| Default house ad | polkadot.com/philosophy link when no campaigns match | Prevents blank slot on SDK-enabled pages. No tracking, no claims, no earning. |
| Account limits | None | Open to all Paseo testnet users. No KYB enforcement for alpha. |

### PVM Size Lessons Learned

1. **resolc PVM bytecodes are 10-20x larger than solc EVM bytecodes.** A function that compiles to 200 B in EVM can produce 2-4 KB in PVM. This makes EVM-based size estimates unreliable for PVM planning.
2. **Storage variables cost more than expected.** Each new `address public` state variable + constructor param adds ~1-2 KB in PVM (vs ~100 B in EVM), likely due to ABI encoder/decoder codegen.
3. **Cross-contract calls (staticcall) are expensive in bytecode.** Each `require(!pauseRegistry.paused(), "P")` adds ~500 B-1 KB in PVM. Interface imports add further overhead.
4. **Architectural extraction is the primary size reduction tool.** Moving code to a separate contract is the most effective way to reduce PVM size — more effective than inlining, constant folding, or optimizer tuning.
5. **Function count matters more than function complexity.** Three simple functions (propose/apply/cancel) cost more bytecode than one complex function, because each function adds ABI dispatch, selector matching, and argument decoding overhead in PVM.
6. **OZ modifier patterns can be more efficient than inline code in resolc.** Manual `bool _locked` reentrancy guard (inline `require` at top/bottom of 4 functions) caused DatumSettlement to grow +6,551 B vs OZ's `nonReentrant` modifier. resolc's codegen for modifiers shares code across call sites more effectively than repeated inline statements. Test both approaches and measure PVM output — EVM intuitions don't transfer.
7. **Removing large struct returns saves significant PVM bytecode.** Replacing `getCampaign()` (14-field struct ABI encode) with 3 scalar getters saved ~800 B. Full struct returns generate expensive ABI encoder codegen in resolc.
8. **Removing unused struct fields saves PVM bytecode.** Each field in a storage struct adds ABI encoding cost (constructor init, struct literals, any function that returns the struct). Removing `id` and `budgetPlanck` from Campaign struct saved ~800 B combined.
9. **Precompile staticcalls are extremely expensive in PVM bytecode (~4 KB per contract).** Adding `ISystem(0x900).minimumBalance()` + `ISystem(0x900).weightLeft()` + `ISystem(0x900).hashBlake256()` caused Settlement to exceed the PVM limit by 3,845 B and Relay by 626 B. Even a single precompile call with its interface import, address constant, and `code.length > 0` guard adds ~2 KB. Only add precompile calls to contracts with >5 KB spare PVM headroom.
10. **Solidity `try/catch` does not work for calls to addresses with no deployed code (e.g., precompiles on Hardhat EVM).** When calling an address with no code, the call returns empty data, and ABI decoding fails *inside* the caller — this revert is not caught by `catch`. Use `addr.code.length > 0` guard checks instead of `try/catch` for precompile calls that may not exist on all chains.

---

## Sources

- [pallet-revive Syscall API](https://paritytech.github.io/polkadot-sdk/master/pallet_revive/trait.SyscallDoc.html)
- [Polkadot Hub Smart Contracts](https://docs.polkadot.com/reference/polkadot-hub/smart-contracts/)
- [PolkaVM Design](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/polkavm-design/)
- [Precompiles Overview](https://docs.polkadot.com/smart-contracts/precompiles/)
- [XCM Precompile](https://docs.polkadot.com/smart-contracts/precompiles/xcm/)
- [System Precompile](https://docs.polkadot.com/smart-contracts/precompiles/system/)
- [Storage Precompile](https://docs.polkadot.com/smart-contracts/precompiles/storage/)

- [Contracts on AssetHub Roadmap (Forum)](https://forum.polkadot.network/t/contracts-on-assethub-roadmap/9513)
- [Smart Contracts on Polkadot Hub: Progress Update (Forum)](https://forum.polkadot.network/t/smart-contracts-on-polkadot-hub-progress-update/14596)
