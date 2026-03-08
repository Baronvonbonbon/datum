# DATUM Alpha Build Roadmap

**Version:** 1.4
**Date:** 2026-03-08
**Scope:** Alpha build — feature-complete for Paseo testnet deployment with IPFS integration and open multi-account testing
**Base:** PoC MVP (tagged `poc-complete`) — 9 contracts (post-GovernanceV2), 100/100 tests, 7-tab extension (V2 overhaul complete), local devnet verified
**Build model:** Solo developer with Claude Code assistance

**Current status:** All contracts and extension code COMPLETE. All alpha-scope features implemented (C3, P3, P18, A1.3, P6, P19, P16, V2 overhaul). Extension builds clean (0 webpack errors, 570KB popup.js). **Next step: A3.2 local devnet validation (runtime E2E testing).**

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
| DatumTimelock | 17,962 B | 31,190 B | Standalone 48h admin timelock (A1.2) |
| DatumPublishers | 19,247 B | 29,905 B | Publisher registry + configurable take rates (30-80%) |
| DatumCampaigns | 48,760 B | 392 B | Campaign lifecycle, budget escrow, manual reentrancy guard (A1.3) |
| DatumGovernanceV2 | 37,677 B | 11,475 B | Dynamic voting + evaluateCampaign() + inline slash (P18) |
| DatumGovernanceSlash | 29,891 B | 19,261 B | Slash pool finalization + winner claims (P18) |
| DatumSettlement | 48,757 B | 395 B | Hash-chain validation, claim processing, 3-way payment split |
| DatumRelay | 46,225 B | 2,927 B | EIP-712 user signature + publisher co-sig, gasless settlement |
| DatumZKVerifier | 1,409 B | 47,743 B | Stub ZK proof verifier (accepts any non-empty proof) |

### Extension (7 tabs, 570 KB popup.js — V2 overhaul + P6 complete)

| Tab | Component | Function |
|-----|-----------|----------|
| Campaigns | CampaignList.tsx | Active campaigns with block/unblock, category filter, campaign info expansion |
| Claims | ClaimQueue.tsx | Pending claims, submit/relay, sign for publisher, earnings estimate, attestation badges, export/import (P6) |
| Earnings | UserPanel.tsx | User balance (DOT), withdraw, engagement stats (dwell, viewable, IAB viewability), per-campaign breakdown |
| Publisher | PublisherPanel.tsx | Balance + withdraw + relay submit + take rate management |
| My Ads | AdvertiserPanel.tsx | Campaign owner controls: pause/resume/complete/expire, campaign creation with IPFS CID |
| Govern | GovernancePanel.tsx | V2 voting (vote(), evaluateCampaign(), withdraw()), majority+quorum bars, conviction 0-6, slash finalization + reward claiming |
| Settings | Settings.tsx | Network, RPC, 9 contract addresses, IPFS gateway, auto-submit, ad preferences (max ads/hr, min CPM, silenced categories, blocked campaigns), interest profile, danger zone |

### Key design decisions locked in PoC

- **Denomination:** Planck (10^10 per DOT), native PolkaVM path
- **Wallet:** Embedded ethers.Wallet with AES-256-GCM encryption (PBKDF2 310k iterations)
- **Claim hash:** `keccak256(abi.encodePacked(...))` — no zkProof in hash (zkProof is a carrier field)
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

#### ERC-20 precompile (per-asset at deterministic addresses)

| Feature | DATUM relevance |
|---------|-----------------|
| Address: `0x[assetId(8hex)]...01200000` | **Future** — if DATUM issues a governance token or reward token via Asset Hub's Assets pallet, contracts can interact via standard ERC-20 interface without deploying a separate token contract. |
| `transfer()`, `balanceOf()`, `approve()` | Standard token operations against native Asset Hub assets. |

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
2. **Use `minimumBalance()` from System precompile** for transfer validation (prevents dust account creation)
3. **Use `has_key()` from Storage precompile** for cheaper existence checks in governance (voted? registered?)
4. **Document BN128 pairing availability** for future ZK verifier (P9) — if available, Groth16 verification becomes feasible on-chain

### Deferred to post-alpha

- Blake2-256 for internal hashing (requires claim struct migration)
- sr25519 signature verification (requires external wallet integration P17)
- XCM fee routing (requires HydraDX integration P11)
- ERC-20 precompile for governance token (requires token design)

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
- [ ] Add `minimumBalance()` check before DOT transfers (System precompile `0x0900`)

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
- [x] Build output: popup.js 570KB, background.js 366KB, content.js 18.1KB — 0 webpack errors (post P6 + taxonomy expansion)

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

#### A3.2 — Local devnet validation

- [ ] Start substrate-contracts-node + eth-rpc (Docker)
- [ ] Deploy alpha contracts via `alpha/scripts/deploy.ts`
- [ ] Run `alpha/scripts/setup-test-campaign.ts` with real IPFS metadata
- [ ] Load alpha-extension in Chrome, configure for local devnet
- [ ] Full E2E test:
  - Create campaign with IPFS metadata
  - Governance vote → activation
  - Browse matching page → ad appears with IPFS creative
  - Submit claims (manual + auto)
  - Verify second-price clearing CPM in claim data
  - Publisher relay submit
  - Withdraw (publisher + user)
  - Export claims → clear → import claims → verify integrity
  - Pause all contracts → verify mutations blocked → unpause
  - Propose admin change → verify 48h delay → apply
- [ ] Fix any runtime issues

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

## Part 5: Post-Alpha Track (prioritized for beta)

After Gate GA, these items become the beta development cycle:

| Priority | Item | Description |
|----------|------|-------------|
| ~~1~~ | ~~**P18: Governance V2**~~ | **✅ COMPLETE** — Implemented in alpha. DatumGovernanceV2 + DatumGovernanceSlash. |
| 1 | **P7: Contract upgrade path** | UUPS proxy or migration pattern. Required before Kusama mainnet. |
| 3 | **P1: Mandatory attestation** | Publisher co-sig enforcement (no degraded trust mode). Attestation endpoint implementation. |
| 4 | **P17: External wallets** | WalletConnect v2 for Paseo/Kusama. Keep embedded wallet as lite mode. |
| 5 | **P5: Multi-publisher campaigns** | Open publisher pool per campaign. Major architectural change. |
| 6 | **P9: ZK proof Phase 1** | Replace stub verifier with real Groth16 circuit. Requires BN128 pairing precompile. |
| ~~7~~ | ~~**P16: Behavioral analytics**~~ | **✅ COMPLETE** — Implemented in alpha extension. engagement.ts, behaviorChain.ts, behaviorCommit.ts, zkProofStub.ts. |
| 8 | **P20: Active campaign inactivity timeout** | Auto-completable by anyone after N blocks with no settlements. Prevents dust-budget lock when advertiser loses key. |

---

## File Structure (alpha)

```
/home/k/Documents/datum/
├── ref/                          Spec documents (unchanged)
├── poc/                          PoC MVP (frozen, tagged poc-complete)
├── extension/                    PoC extension (frozen)
├── alpha/                        Alpha contracts + tests
│   ├── contracts/                Modified contracts (pause, timelock, DatumTimelock.sol NEW)
│   ├── test/                     Extended test suite (75+)
│   ├── scripts/
│   │   ├── deploy.ts             Deploy to Paseo
│   │   ├── setup-test-campaign.ts
│   │   ├── e2e-smoke.ts          Paseo smoke test
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
│       │   ├── campaignPoller.ts Modified — A1.3 slim getters, all statuses
│       │   ├── claimBuilder.ts   Modified — accept clearingCpmPlanck from auction
│       │   ├── claimQueue.ts     Queue management + batch building
│       │   ├── index.ts          Modified — V2 message handlers, pause check, auction routing
│       │   ├── interestProfile.ts Modified — getNormalizedWeight()
│       │   ├── publisherAttestation.ts  Publisher co-sig requests
│       │   ├── userPreferences.ts NEW — block/silence/rate-limit/minCPM
│       │   └── zkProofStub.ts    NEW — dummy ZK proof generator (P16)
│       ├── content/
│       │   ├── adSlot.ts         Modified — auction badge, earning display
│       │   ├── engagement.ts     NEW — IntersectionObserver engagement capture (P16)
│       │   ├── index.ts          Modified — auction + engagement + preferences
│       │   └── taxonomy.ts       Multi-signal page classification
│       ├── popup/
│       │   ├── AdvertiserPanel.tsx NEW — campaign owner controls
│       │   ├── App.tsx           Modified — 7 tabs
│       │   ├── CampaignList.tsx  Modified — block/filter/info controls
│       │   ├── ClaimQueue.tsx    Claim management + attestation badges + export/import (P6)
│       │   ├── GovernancePanel.tsx Modified — V2 API (vote, evaluate, slash)
│       │   ├── PublisherPanel.tsx Modified — removed campaign creation
│       │   ├── Settings.tsx      Modified — ad preferences, V2 addresses
│       │   ├── UserPanel.tsx     Modified — engagement stats
│       │   └── WalletSetup.tsx   Embedded wallet setup
│       └── shared/
│           ├── abis/             9 contract ABIs from alpha/artifacts/
│           ├── claimExport.ts     NEW — P6 encrypted export/import (AES-256-GCM, HKDF)
│           ├── contracts.ts      Modified — V2 factory functions
│           ├── messages.ts       Modified — V2 + preferences + engagement types
│           ├── networks.ts       Modified — V2 address keys + Paseo network
│           ├── types.ts          Modified — V2 types, engagement, preferences, 26 categories + subcategories
│           └── ...
├── REVIEW.md                     Updated through PoC completion
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

---

## Sources

- [pallet-revive Syscall API](https://paritytech.github.io/polkadot-sdk/master/pallet_revive/trait.SyscallDoc.html)
- [Polkadot Hub Smart Contracts](https://docs.polkadot.com/reference/polkadot-hub/smart-contracts/)
- [PolkaVM Design](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/polkavm-design/)
- [Precompiles Overview](https://docs.polkadot.com/smart-contracts/precompiles/)
- [XCM Precompile](https://docs.polkadot.com/smart-contracts/precompiles/xcm/)
- [System Precompile](https://docs.polkadot.com/smart-contracts/precompiles/system/)
- [Storage Precompile](https://docs.polkadot.com/smart-contracts/precompiles/storage/)
- [ERC-20 Precompile](https://docs.polkadot.com/smart-contracts/precompiles/erc20/)
- [Contracts on AssetHub Roadmap (Forum)](https://forum.polkadot.network/t/contracts-on-assethub-roadmap/9513)
- [Smart Contracts on Polkadot Hub: Progress Update (Forum)](https://forum.polkadot.network/t/smart-contracts-on-polkadot-hub-progress-update/14596)
