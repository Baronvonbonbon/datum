# DATUM MVP Implementation Plan

**Version:** 1.7
**Date:** 2026-02-24
**Last updated:** 2026-03-03 — Roadmap item 2.21 (publisher co-signature in DatumRelay) implemented. `SignedClaimBatch` gains `bytes publisherSig` field. Relay verifies publisher EIP-712 attestation when present; empty sig = degraded trust mode (backward compatible). DatumRelay constructor now takes `(settlement, campaigns)`. New error codes E33/E34. 4 new tests (R7-R10). 58/58 EVM tests pass. Extension types + ABI updated. Phase 2B Steps F+G remain complete; Step H still pending (manual Chrome E2E on local devnet).
**Scope:** Five-contract system + browser extension, deployed through local → testnet → Kusama → Polkadot Hub
**Build model:** Solo developer with Claude Code assistance

---

## Overview

The MVP consists of four deliverables:

1. **Contracts** — DatumPublishers, DatumCampaigns, DatumGovernanceVoting, DatumGovernanceRewards, DatumSettlement validated on PolkaVM
2. **Browser Extension** — Chrome extension with full publisher-SDK simulation, wallet-signed claim submission, manual and auto modes
3. **Testnet** — Live deployment on Westend or Paseo with real wallets and real block times
4. **Mainnet** — Progressive rollout: Kusama → Polkadot Hub

### Deferred (explicitly out of MVP scope)

| Item | Reason |
|------|---------|
| ZK proof of auction outcome | `zkProof` field reserved in Claim struct; circuit work separate track |
| Decentralized KYB identity | MVP uses T1 allowlist; identity verification (zkMe or Polkadot PoP) is a post-MVP upgrade |
| HydraDX XCM fee routing | Protocol fees accumulate in contract; XCM routing is post-MVP |
| Viewability dispute mechanism | Requires oracle or ZK; post-MVP |
| Taxonomy on-chain governance | Hardcoded taxonomy in MVP; per-campaign category targeting is MVP scope |
| Publisher quality scoring | Excluded from settlement math in MVP |
| Revenue split governance | 75/25 hardcoded; governance upgrade post-MVP |
| Rich media ad rendering | MVP renders text banner with campaign title/description; image/video rendering post-MVP |
| Advanced governance game theory | MVP uses 10% slash cap; post-MVP models: symmetric risk (nay voters lose stake if campaign succeeds), time-delayed termination (grace period before slash), dispute bonds (nay voters post bonds forfeited on failure), graduated response (escalating slash based on evidence severity) |
| Contract ownership transfer | DatumCampaigns uses manual owner pattern (no OZ Ownable) for PVM size; add `transferOwnership()` for multisig migration pre-mainnet |
| Impression attestation | MVP self-reports impressions via extension; post-MVP: publisher co-signature on impression batches, then ZK/TEE attestation |
| Clearing CPM auction mechanism | MVP uses `clearingCpm = bidCpm` (fixed price); post-MVP: off-chain batch auction per epoch with second-price clearing |
| Admin timelock | MVP admin setters are immediate; post-MVP: 48-hour timelock on `setSettlementContract`/`setGovernanceContract` with on-chain event for user exit window |
| On-chain aye reward computation | MVP computes aye reward shares off-chain (`creditAyeReward` is owner-only); post-MVP: on-chain proportional distribution when PVM bytecode limits relax |
| Multi-publisher campaigns | MVP binds campaign to single publisher; post-MVP: open publisher pool with category-based matching, payment to serving publisher |
| Claim state portability | MVP stores claim queue in `chrome.storage.local`; post-MVP: encrypted export/import or deterministic derivation from on-chain state + user seed |
| Contract upgrade path | MVP contracts are non-upgradeable; post-MVP: proxy pattern or migration function for Settlement (holds user balances) |

---

## Phase Gates

Each phase has a binary gate. Nothing in the next phase begins until all gate criteria pass.

| Gate | Criteria |
|------|----------|
| **G1** | All 58 tests pass on Hardhat EVM; 44/46 core pass on substrate (2 skipped by design). resolc compiles all six contracts under 49,152-byte PVM limit. `zkProof` field present in Claim struct. Gas benchmarks recorded in BENCHMARKS.md. Publisher relay (`settleClaimsFor`) implemented with EIP-712 signatures. Publisher co-signature verification (2.21) implemented in DatumRelay. |
| **G2** | Extension installs in Chrome without errors. User can connect a Polkadot.js or SubWallet wallet. Campaign list loads from a local or testnet node with creative metadata (title, description, IPFS CID). At least one impression is recorded and one claim is submitted successfully (manual mode). Auto mode submits without user interaction. Publisher can create a campaign and upload creative metadata via the extension UI. Local interest profile accumulates across visits; campaign selection uses weighted scoring (not first-match). Settings shows interest profile with reset option. |
| **G3** | All five contracts deployed to Westend or Paseo. Full E2E smoke test passes: campaign created → governance activates → extension records impressions → claims submitted → publisher withdraws. No hardcoded addresses or test values remain in extension. |
| **G4-K** | Contracts deployed to Kusama. At least one real campaign created and activated by a real third-party advertiser (not the deployer). Ownership transferred to multisig. |
| **G4-P** | Contracts deployed to Polkadot Hub mainnet. Extension published to Chrome Web Store. |

---

## Phase 1 — Local Substrate Validation

**Gate:** G1
**Estimated duration:** 1–2 weeks
**Prerequisite:** None — starts immediately

### Tasks

#### 1.1 — resolc compilation
- [x] Verify `@parity/resolc` is installed: `node -e "require('@parity/resolc')"` — install if missing
- [x] Run `npm run compile:polkavm` from `/poc/`
- [x] Fix any resolc-specific compilation errors (common: unsupported opcodes, ABI encoding edge cases, `abi.encodePacked` with dynamic types)
- [x] Confirm artifacts are emitted under `artifacts/` for all contracts
- [x] Fix any warnings that indicate PolkaVM incompatibility
- [x] Switch resolc optimizer from `parameters: "3"` to `parameters: "z"` in `hardhat.config.ts`

#### 1.1b — Contract splitting for PVM size limits
All PVM bytecodes must be < 48 KB (49,152 bytes). See Appendix G for full details.

**Measured sizes after splits, before reduction (resolc mode `z`, 2026-02-25):**

| Contract | PVM bytes | Limit | Status |
|---|---|---|---|
| DatumPublishers | 19,247 | 49,152 | ✅ |
| DatumGovernanceVoting | 48,663 | 49,152 | ✅ (489 B to spare) |
| MockCampaigns | 41,871 | 49,152 | ✅ |
| DatumCampaigns | 52,250 | 49,152 | ❌ over by 3,098 B (fixed in 1.1c) |
| DatumGovernanceRewards | 56,718 | 49,152 | ❌ over by 7,566 B (fixed in 1.1c) |
| DatumSettlement | 55,708 | 49,152 | ❌ over by 6,556 B (fixed in 1.1c) |

- [x] **DatumGovernance → DatumGovernanceVoting + DatumGovernanceRewards** (89 KB → 48.7 KB + 55.4 KB)
  - [x] Create `IDatumGovernanceVoting.sol` and `IDatumGovernanceRewards.sol` from split `IDatumGovernance.sol`
  - [x] Create `DatumGovernanceVoting.sol`: voting logic, activation/termination triggers, slash distribution, config
  - [x] Create `DatumGovernanceRewards.sol`: claim/withdraw logic, aye reward distribution, failed nay resolution
  - [x] Rewards reads VoteRecords via Voting's view functions (cross-contract calls)
  - [x] Update `DatumCampaigns.governanceContract` to point to Voting contract
  - [x] Verify `DatumGovernanceVoting` PVM bytecode < 48 KB ✅
  - [x] Verify `DatumGovernanceRewards` PVM bytecode < 48 KB ✅ (46,962 B after 1.1c reduction)
- [x] **DatumCampaigns → DatumCampaigns + DatumPublishers** (59 KB → 52.3 KB + 18.8 KB)
  - [x] Create `IDatumPublishers.sol` with Publisher struct, registration, take rate management
  - [x] Create `DatumPublishers.sol` with publisher state and logic
  - [x] Update `DatumCampaigns.sol`: remove publisher state/logic, add `DatumPublishers publishers` reference
  - [x] `createCampaign()` calls `publishers.getPublisher()` for take rate snapshot
  - [x] Update `campaigns.test.ts` to deploy both contracts; publisher-specific tests use publishers contract
  - [x] Verify `DatumPublishers` PVM bytecode < 48 KB ✅
  - [x] Verify `DatumCampaigns` PVM bytecode < 48 KB ✅ (48,044 B after 1.1c reduction + _send() fix)
- [x] **MockCampaigns** — 41,871 B at mode `z` ✅ no split needed
- [x] Update integration tests for new contract wiring (deploy order: Publishers → Campaigns → GovernanceVoting → GovernanceRewards → Settlement)
- [x] Update `scripts/deploy.ts` for new deploy order and cross-contract wiring
- [x] All tests pass on Hardhat EVM after split (58/58 including Phase 1.6 relay + 2.21 publisher co-sig tests)

#### 1.1c — PVM size reduction (COMPLETE as of 2026-02-25)

**Measured sizes after all fixes (resolc mode `z`, 2026-02-27):** *(superseded by 2.14b measurements after Phase 2B changes)*

| Contract | PVM bytes | Limit | Spare | Status |
|---|---|---|---|---|
| DatumPublishers | 19,247 | 49,152 | 29,905 | ✅ |
| DatumGovernanceVoting | 48,663 | 49,152 | 489 | ✅ |
| MockCampaigns | 41,871 | 49,152 | 7,281 | ✅ |
| DatumCampaigns | 48,044 | 49,152 | 1,108 | ✅ (was 49,132; `_send()` pattern reduced size) |
| DatumGovernanceRewards | 46,962 | 49,152 | 2,190 | ✅ |
| DatumSettlement | ~46,000 | 49,152 | ~3,100 | ✅ (+ MAX_CLAIMS_PER_BATCH constant) |

**Current sizes (resolc mode `z`, 2026-03-02, after Phase 2B + 2.14b reduction):**

| Contract | PVM bytes | Limit | Spare | Status |
|---|---|---|---|---|
| DatumPublishers | 19,247 | 49,152 | 29,905 | ✅ |
| DatumCampaigns | 48,169 | 49,152 | 983 | ✅ |
| DatumGovernanceVoting | 47,510 | 49,152 | 1,642 | ✅ |
| DatumGovernanceRewards | 48,745 | 49,152 | 407 | ✅ (tightest) |
| DatumSettlement | 44,893 | 49,152 | 4,259 | ✅ (slim interface saved 4.6 KB) |
| DatumRelay | 33,782 | 49,152 | 15,370 | ✅ |

Techniques applied:
- [x] **DatumCampaigns**: Remove Pausable + whenNotPaused; shorten revert strings to E-codes
- [x] **DatumSettlement**: Inline `computeClaimHash` (no longer public); `ClaimRejected` uses `uint8 reasonCode` instead of string; remove Pausable; short revert strings
- [x] **DatumGovernanceRewards**: Replace `distributeAyeRewards` voter loop with `creditAyeReward(campaignId, voter)` (owner supplies per-voter amounts computed off-chain); short revert strings; remove OZ imports
- [x] All 58/58 tests pass on Hardhat EVM after reduction + relay addition + publisher co-sig

#### 1.2 — substrate-contracts-node setup
- [x] Install `substrate-contracts-node` binary (via Docker: `paritypr/substrate:master-a209e590`)
- [x] Start node in development mode: `docker run --dev --rpc-external --rpc-cors=all` + eth-rpc adapter
- [x] Add `substrate` network entry to `hardhat.config.ts` pointing at `http://127.0.0.1:8545` (eth-rpc adapter)
- [x] Verify connection: `npx hardhat run scripts/debug-substrate.ts --network substrate` — deploys + calls succeed

**Key pallet-revive finding (2026-02-25):** Gas estimates are in pallet-revive weight units (~10^15), not EVM gas. The `gasEstimate * 2n` pattern used in hardhat signers causes "Invalid Transaction" because it exceeds the per-tx gas cap. Fix: pass `gasLimit: gasEstimate` (exact) or no override (auto-estimate). This affects both test fixtures and the `debug-substrate.ts` script (already fixed).

#### 1.3 — test suite on substrate-contracts-node
- [x] Create `test/helpers/mine.ts`: cross-network `mineBlocks(n)`, `advanceTime(s)`, `isSubstrate()`, `fundSigners()` helpers
  - Hardhat: uses `hardhat_mine` / `evm_increaseTime` + `evm_mine` (instant)
  - Substrate: polls `eth_blockNumber` until N new blocks appear (real block time ~3-4s)
  - `isSubstrate()` detects by chainId `420420420`
  - `fundSigners()`: transfers 10B DOT from Alith to unfunded signers (only signers 0-1 pre-funded)
- [x] Replace all `provider.send("hardhat_mine", ...)` and `evm_*` calls in campaigns, governance, integration tests
- [x] Dynamic block timeouts: `PENDING_TIMEOUT = 3n` and `TAKE_RATE_DELAY = 3n` on substrate (vs 100n/50n on Hardhat)
- [x] Native transfer pattern: all production contracts use `_send()` internal helper with `.call{value}("")`
  - resolc codegen bug: multiple `transfer()` call sites in one contract produce broken RISC-V for some code paths
  - `.call{value}` is not affected by resolc's transfer heuristic, so it works reliably as a single call site
  - DatumCampaigns: 4 transfer sites → single `_send()` (PVM size 49,132 → 48,044 bytes)
  - DatumSettlement: 3 withdraw functions → shared `_send()` helper
- [x] Refactor all test suites from `beforeEach` to `before` for contract deployment
  - PVM contract deploys take 60-120s each on substrate; `beforeEach` would timeout at 300s
  - Each test creates its own campaign ID to isolate state
- [x] Fund test signers with 10^24 planck (increased from 10^22 — gas costs ~5×10^21 per contract call on dev chain)
- [x] Set mocha timeout to 300s (substrate tests take 5-30s per test after single deploy)
- [x] Run `npx hardhat test --network substrate` — **44/46 tests pass, 2 skipped** (12 min total)

**Substrate test results (2026-02-27): 44 passing, 2 pending, 0 failing ✅**

| Suite | EVM | Substrate | Notes |
|-------|-----|-----------|-------|
| DatumCampaigns | 12 pass, 1 skip | 12 pass, 1 skip | L7 daily-cap skipped (needs timestamp manipulation) |
| DatumGovernance | 13 pass, 1 skip | 13 pass, 1 skip | minReviewerStake skipped (deploys 3 contract sets, too slow) |
| Integration | 5 pass | 5 pass | |
| DatumSettlement | 14 pass | 14 pass | |
| **Total** | **44 pass, 2 skip** | **44 pass, 2 skip** | |

**Root causes fixed (2026-02-27):**

| Root cause | Tests affected | Fix |
|-----------|---------------|-----|
| Insufficient signer funding | 11 governance + 2 integration | Gas per contract call ~5×10^21 planck on dev chain. `FUND_AMOUNT` raised from 10^22 to 10^24 planck. Mock pre-funded with `BUDGET × 20n` in `before()` hook. |
| eth-rpc denomination rounding bug | G3 + 2 settlement withdraws | Substrate eth-rpc divides wei by 10^6 to get planck. Values where `value % 10^6 >= 500_000` are **rejected** (rounding causes mismatch). Fix: all transferred values must be exact multiples of 10^6. Settlement `BID_CPM` changed to `parseDOT("0.016")` for clean 3-way splits. G3 `smallStake` changed to `MIN_REVIEWER_STAKE - 1_000_000n`. |
| Settlement `.transfer()` failure | 2 settlement withdraws | `_send()` helper changed from `.transfer()` to `.call{value}("")` + `require(ok, "E02")`. resolc may inline internal helpers, recreating the multi-site transfer bug; `.call{value}` is not affected by resolc's transfer heuristic. |

**Summary of contract changes (2026-02-26 → 2026-02-27):**
- `DatumSettlement.sol`: `withdrawPublisher()`, `withdrawUser()`, `withdrawProtocol(recipient)` all delegate to `_send()` internal helper. `_send()` uses `.call{value}` (not `.transfer()`).
- `IDatumSettlement.sol`: Updated interface with new function names.
- `DatumGovernanceRewards.sol`: `claimAyeReward()` forwards DOT to voting contract via `.call{value}`, then calls `voting.rewardsAction(0,...)`.

- [x] Fix Blocker 1 (gas doubling/Invalid Transaction): resolved by `fundSigners()` + `before` refactor
- [x] Fix Blocker 2 (E02 withdraw): resolved by `.call{value}` in `_send()` helper
- [x] Fix Blocker A: contract-state-only assertions on substrate (balance mappings, not native balance)
- [x] Fix Blocker B: campaign ID tracking via CampaignCreated event parsing from receipt
- [x] Fix Blocker C: L7 daily-cap already skipped on substrate
- [x] Fix resolc codegen bug: `_send()` with `.call{value}` in Settlement, `claimAyeReward` via voting
- [x] Fund signer 7+: `fundSigners()` default count raised to 10, amount raised to 10^24
- [x] Skip `minReviewerStake` on substrate (fresh deploy too slow)
- [x] All 58/58 tests pass on Hardhat EVM (46 core + 6 relay R1-R6 + 4 co-sig R7-R10 + 1 integration F + 1 double-withdraw)
- [x] All 44/46 core tests pass on substrate (2 skipped: L7, minReviewerStake)
- [x] Denomination rounding bug documented (value % 10^6 >= 500_000 → rejected)

**Permanent substrate-only constraints:**
1. **Denomination alignment**: All native transfer amounts (msg.value, withdrawal amounts) must be exact multiples of 10^6 planck. The eth-rpc proxy rejects values where `value % 10^6 >= 500_000`.
2. **Gas costs**: Contract calls cost ~5×10^21 planck on dev chain. This is a dev chain artifact; production costs will differ.
3. **No timestamp manipulation**: `evm_increaseTime` / `evm_mine` not available. Tests requiring specific timestamps must be skipped.
4. **Slow deploys**: PVM contract deployment takes 60-120s. Tests must use `before()` (not `beforeEach()`) for deployment.

#### 1.4 — gas benchmarks
- [x] Instrument test suite to capture gas used for each key function on the substrate node
- [x] Record baseline values for all six key functions on substrate and Hardhat EVM
- [x] `settleClaims` scales 5.30x for 10 claims on PVM (measured before guard) → added `MAX_CLAIMS_PER_BATCH = 5` to `DatumSettlement.sol`
- [x] Document benchmarks in `/poc/BENCHMARKS.md`

**Benchmark results — PVM (pallet-revive dev chain, gasPrice=1000):**

| Function | PVM weight | EVM gas | PVM est. (DOT) |
|----------|-----------|---------|----------------|
| `createCampaign` | 2,657,538,331,671,666 | 255,926 | ~0.266 |
| `voteAye` | 2,304,998,733,791,666 | 256,716 | ~0.230 |
| `voteNay` | 2,283,167,806,290,833 | 295,604 | ~0.228 |
| `settleClaims` (1 claim) | 7,843,683,326,872,500 | 237,348 | ~0.784 |
| `settleClaims` (5 claims) | ~20,000,000,000,000,000 (est.) | 293,313 | ~2.0 |
| `withdrawPublisher` | 1,471,147,848,773,333 | 32,311 | ~0.147 |

Notes:
- PVM weight and EVM gas are not directly comparable units (weight = picoseconds of RISC-V execution; gas = abstract EVM opcode pricing)
- `settleClaims` EVM scaling: 5 claims = 1.24x of 1 claim (marginal cost ~11k gas/claim). PVM scaling: ~2.5x for 5 claims (cross-contract call overhead dominates)
- Dev chain gasPrice of 1000 is not representative of mainnet; DOT estimates scale linearly with actual gasPrice
- The original 10-claim PVM measurement (4.15×10^16 weight, 5.30x scaling) informed the MAX_CLAIMS_PER_BATCH=5 decision

#### 1.5 — zkProof field in Claim struct
- [x] `bytes zkProof` field in `Claim` struct in `contracts/interfaces/IDatumSettlement.sol`
- [x] `zkProof` field in `Claim` struct in `contracts/DatumSettlement.sol`
- [x] `_validateClaim()` accepts field, does not validate — `// ZK verification: not implemented in MVP`
- [x] `computeClaimHash()` does NOT include `zkProof` in the hash
- [x] All claim-building helpers use `zkProof: "0x"` — all 53 tests pass
- [x] `MockCampaigns.sol` updated

#### Gate G1 checklist ✅ COMPLETE
- [x] `npm run compile:polkavm` exits 0 with resolc optimizer mode `z`
- [x] All PVM contract bytecodes < 48 KB (49,152 bytes) — verified per-contract (2026-02-25)
- [x] Contract split complete: DatumGovernanceVoting + DatumGovernanceRewards, DatumCampaigns + DatumPublishers, DatumSettlement reduced
- [x] `zkProof` field present in `IDatumSettlement.sol` Claim struct
- [x] No test files reference `clearingCpmWei` or `budgetWei` — all planck-denominated
- [x] `npx hardhat test --network substrate` — 44/46 pass, 2 skipped (L7 daily-cap + minReviewerStake) ✅
- [x] `BENCHMARKS.md` exists with all six key function values ✅

#### PVM vs EVM: tradeoff analysis

DATUM targets Polkadot Hub via pallet-revive (PolkaVM / RISC-V), not an EVM-native chain. This is a deliberate architectural choice with significant tradeoffs. The following is informed by concrete benchmarks from Phase 1.

**Why PolkaVM (the case for PVM)**

1. **Native Polkadot security.** Contracts execute on Polkadot Hub directly — shared security from the relay chain, no bridge risk, no separate validator set. An EVM L2 or parachain would require either a bridge (attack surface) or its own security model.

2. **DOT-denominated settlement.** All campaign escrow, governance stakes, and payment splits happen in native DOT. No wrapped tokens, no DEX dependency, no bridge risk on the settlement asset.

3. **XCM interoperability.** Post-MVP features (HydraDX fee routing, cross-chain governance) become native XCM calls rather than bridge transactions. Polkadot Hub is the canonical origin for XCM messages.

4. **Ecosystem alignment.** Polkadot's identity primitives (Proof of Personhood), governance tooling (OpenGov), and treasury funding are directly accessible. An EVM deployment would need to bridge into these.

**What PVM costs (measured tradeoffs)**

1. **Execution overhead.** PVM weight units per function are ~10 billion x larger than EVM gas units. These aren't comparable units (weight = picoseconds, gas = abstract pricing), but the end result is that PVM contract calls are significantly more expensive in real cost than equivalent EVM calls at current dev chain pricing. On the dev chain, `settleClaims` for 1 claim costs ~0.78 DOT — this likely decreases substantially on mainnet where the weight-to-fee conversion is governance-set, but the relative cost between functions stays the same.

2. **Scaling characteristics differ.** On EVM, `settleClaims(5)` costs only 1.24x of `settleClaims(1)` — marginal per-claim cost is ~11k gas after a 237k base. On PVM, it scales ~2.5x for 5 claims because each cross-contract call (`getCampaign`, `deductBudget`) has much higher fixed overhead in RISC-V context switching. This motivated the `MAX_CLAIMS_PER_BATCH = 5` guard and the publisher relay design (Phase 1.6).

3. **Bytecode size constraint (49,152 bytes).** resolc produces 10-20x larger bytecode than solc. This forced: contract splitting (3 → 5+1 contracts), removal of OpenZeppelin Pausable, short error codes, inlining of hash functions, `creditAyeReward` replacing a loop-based distribution, and merging functions (e.g. `pauseCampaign`/`resumeCampaign` → `togglePause`). Phase 2B added `categoryId` + `setMetadata()` which pushed DatumSettlement 356 B over the limit (from struct growth inflating ABI decode codegen in a consumer contract). Fix required introducing `IDatumCampaignsSettlement` slim interface (5 primitives instead of 14-field struct) and removing redundant view functions. Every new feature must budget bytecode. The tightest contract (DatumGovernanceRewards) has 407 bytes to spare.

4. **Compiler maturity.** resolc v0.3.0 has a codegen bug where multiple `transfer()` call sites produce broken RISC-V. The workaround (single `_send()` helper per contract using `.call{value}`) is reliable but constrains code structure. The eth-rpc proxy has a denomination rounding bug rejecting values where `amount % 10^6 >= 500_000`. These are early-ecosystem issues that will improve, but they add development friction today.

5. **Toolchain gaps.** No `evm_mine` or `evm_increaseTime` on substrate (tests that need timestamp manipulation must be skipped). Contract deploys take 60-120 seconds on the dev chain (vs instant on Hardhat). No block explorer with source verification yet.

**Net assessment**

The PVM overhead is real but manageable. The bytecode limit is the hardest constraint — it gates every future feature addition. The gas cost difference is partially a dev chain artifact (mainnet weight-to-fee will be much lower) and partially inherent to RISC-V cross-contract calls. The publisher relay (1.6) mitigates the cost impact on users.

The strategic value of native Polkadot execution (DOT settlement, XCM, shared security, identity primitives) outweighs the development friction — but only if Polkadot Hub pallet-revive matures. If resolc and the eth-rpc proxy don't improve, a fallback to an EVM parachain (Moonbeam, Astar) with bridged DOT remains viable. The contract Solidity source is portable; only the deployment target changes.

#### 1.6 — Publisher relay settlement (gas cost optimization) ✅ COMPLETE

**Problem:** `settleClaims` costs ~0.78 DOT per claim on the dev chain. The user's 37.5% share of a typical settlement may not cover their gas cost, especially for low-CPM campaigns. If only the user can call `settleClaims`, the protocol is uneconomical for most users.

**Solution:** Allow publishers to batch-submit claims on behalf of multiple users in a single transaction. The publisher absorbs the gas cost and recoups it from their take rate (which is typically 50% of total payment — much larger than the user's share).

**Design: `settleClaimsFor()` with EIP-712 signatures**

The current contract enforces `require(msg.sender == batch.user)`. The relay adds a second entry point that accepts a user's off-chain signature instead:

```
function settleClaimsFor(SignedClaimBatch[] calldata batches) external nonReentrant
```

Each `SignedClaimBatch` contains:
- The existing `ClaimBatch` fields (user, campaignId, claims)
- `bytes signature` — EIP-712 typed signature from `batch.user` over the batch hash
- `uint256 deadline` — signature expiry block (prevents replay after a window)

The contract verifies `ecrecover(batchDigest, signature) == batch.user` instead of checking `msg.sender`. The publisher (or any relayer) can then call `settleClaimsFor()` and submit claims for many users in one tx.

**Why EIP-712:** Structured typed data signing is supported by Polkadot.js extension and SubWallet. The user sees a human-readable "Approve settlement of N claims for campaign X" prompt, not an opaque hex blob.

**Economics:** For a publisher with 100 users, settling 5 claims per user at ~0.78 DOT each would cost 100 × 0.78 = 78 DOT in gas if each user submits individually. With publisher relay, 100 batches in ~20 transactions (5 batches per tx) costs ~20 × 4 DOT ≈ 80 DOT total gas — similar total, but the publisher pays it once and recoups from their 50% take. Users pay zero gas and still receive their 37.5% share via pull-payment withdrawal.

At mainnet gas prices (orders of magnitude lower than dev chain), this becomes strongly economical.

**Implementation details (2026-02-27):**

- **Separate contract architecture:** EIP-712 + ecrecover logic lives in `DatumRelay.sol` (33,782 B PVM). DatumSettlement stays under limit (49,102 B) with only a `relayContract` address check added. Inline approach would have put Settlement at 58,438 B (9 KB over limit).
- **DatumSettlement changes:** `settleClaims` now accepts `msg.sender == batch.user || msg.sender == relayContract` (error code E32). `setRelayContract(address)` owner function. `_processBatch` refactored to unpacked fields.
- **DatumRelay contract:** Verifies EIP-712 signature, copies claims to memory, forwards `ClaimBatch[]` to `settlement.settleClaims()`.
- **Simplified batch binding:** The EIP-712 struct hash uses `(user, campaignId, firstNonce, lastNonce, claimCount, deadline)` instead of encoding the full claims array. This is safe because claim nonces are sequential and forward-only (enforced by `_lastNonce + 1` check).
- **Inline ecrecover:** No OZ ECDSA import — raw `ecrecover` with inline assembly to extract `r`, `s`, `v` from calldata signature.
- **Replay protection:** Uses existing nonce-based claim tracking — replay attempts fail on nonce check (claim already settled), no separate nonce mapping needed.
- **New error codes:** E29 (deadline expired), E30 (invalid signature length), E31 (wrong signer/address(0)), E32 (unauthorized caller), E33 (invalid publisher sig length, added in 2.21), E34 (wrong publisher signer, added in 2.21).
- **EIP-712 domain:** Name is `"DatumRelay"`, `verifyingContract` is the relay address. `DOMAIN_SEPARATOR` is a public immutable on the relay contract.
- **Risk:** `ecrecover` precompile (0x01) needs verification on pallet-revive substrate chain. If unsupported, relay feature is EVM-only until pallet-revive adds it.

**PVM bytecode sizes (2026-03-02, all 6 contracts under 49,152 B, post Phase 2B):**
| Contract | Bytes | Margin |
|----------|-------|--------|
| DatumPublishers | 19,247 | 29,905 |
| DatumCampaigns | 48,169 | 983 |
| DatumGovernanceVoting | 47,510 | 1,642 |
| DatumGovernanceRewards | 48,745 | 407 |
| DatumSettlement | 44,893 | 4,259 |
| DatumRelay | 33,782 | 15,370 |

**Tasks:**
- [x] Add `SignedClaimBatch` struct to `IDatumSettlement.sol`
- [x] Add `relayContract` address + `setRelayContract()` to `DatumSettlement.sol`
- [x] Modify `settleClaims` to accept relay as authorized caller (E32)
- [x] Refactor `_processBatch` to accept unpacked fields
- [x] Create `DatumRelay.sol` with EIP-712 domain separator, signature verification, and forwarding
- [x] Write tests: R1 (happy path relay), R2 (expired deadline), R3 (tampered signature), R4 (wrong signer), R5 (replay rejects), R6 (direct settleClaims regression)
- [x] Add integration test F: full flow with EIP-712 signature relay
- [x] Publisher co-signature verification (2.21): R7 (co-signed settle), R8 (wrong publisher signer E34), R9 (invalid sig length E33), R10 (tampered sig E34)
- [x] All 58/58 tests pass on Hardhat EVM
- [x] Verify PVM bytecode size: all 6 contracts under 49,152 bytes
- [ ] Update benchmark script to measure `settleClaimsFor()` gas cost vs `settleClaims()`
- [ ] Verify `ecrecover` precompile works on pallet-revive substrate chain

---

## Phase 2 — Browser Extension

**Gate:** G2
**Estimated duration:** 3–5 weeks
**Prerequisite:** G1 must be passed (contract ABIs are stable before extension is built against them)

### Architecture

```
extension/
├── manifest.json                 MV3 (offscreen permission, DOM_SCRAPING reason)
├── background/
│   ├── index.ts                  Message router, alarms, autoFlushViaOffscreen()
│   ├── campaignPoller.ts         Polls DatumCampaigns for Active campaigns
│   ├── claimBuilder.ts           Builds + maintains hash chain per (user, campaignId)
│   └── claimQueue.ts             Queues claims; mutex; buildBatches(); removeSettled()
├── content/
│   ├── index.ts                  Page classifier; impression recorder
│   ├── adSlot.ts                 Injects ad unit; records impression
│   └── taxonomy.ts               Classifies current page against campaign taxonomy
├── offscreen/
│   ├── offscreen.html            Minimal HTML shell (wallet extensions inject here)
│   └── offscreen.ts              Receives OFFSCREEN_SUBMIT; signs + submits; replies result
├── popup/
│   ├── App.tsx                   Root: wallet connect, 5-tab navigation
│   ├── CampaignList.tsx          Active campaigns + match status
│   ├── ClaimQueue.tsx            Pending claims; submitAll(); signForRelay(); auto-flush result
│   ├── UserPanel.tsx             User balance (DOT) + withdrawUser() button
│   ├── PublisherPanel.tsx        Publisher balance + withdrawPublisher() button
│   └── Settings.tsx              Auto-submit toggle, interval, RPC, contract addresses, danger zone
└── shared/
    ├── abis/                     ABI JSON files copied from poc/artifacts/ by copy-abis.js
    ├── contracts.ts              Typed contract factory functions (ethers.js)
    ├── dot.ts                    parseDOT / formatDOT
    ├── messages.ts               Typed message unions (ContentToBackground, PopupToBackground, etc.)
    ├── networks.ts               NETWORK_CONFIGS + DEFAULT_SETTINGS
    └── types.ts                  Campaign, Claim, SerializedClaimBatch, SettlementResult, etc.
```

### Tasks

#### 2.1 — Extension project setup ✅ COMPLETE
- [x] Create `/home/k/Documents/datum/extension/` directory
- [x] Initialise with `package.json`: `@polkadot/extension-dapp`, `ethers v6`, `react 18`, `webpack 5`, `webpack-target-webextension`, `node-polyfill-webpack-plugin`
- [x] Write `manifest.json`: MV3, `content_scripts` (all URLs), `background.service_worker` (type: module), `action` (popup), permissions: `storage`, `alarms`, `tabs`, `activeTab`
- [x] Set up TypeScript config (strict, JSX react-jsx, bundler moduleResolution) and webpack build pipeline — output to `dist/`
- [x] Build: popup.js 689KB, background.js 261KB, content.js 4KB. `npm run type-check` clean, `npm run build` clean.
- [ ] Verify extension loads in Chrome (`chrome://extensions`, developer mode) with no console errors ← **manual verification needed**

**Implementation notes:**
- Webpack config must use CJS (`require`/`module.exports`) — ts-node invoked by webpack-cli doesn't support ESM imports
- Use `Eip1193Provider` cast for `window.ethereum` typing (not `Parameters<typeof BrowserProvider>[0]`)
- `WebExtensionPlugin` uses `serviceWorkerEntry` (not deprecated `entry`+`manifest`)
- `optimization.splitChunks: false` — content scripts must be single self-contained bundles
- Placeholder PNG icons generated (16/48/128px)

#### 2.2 — Wallet integration ✅ COMPLETE
- [x] `App.tsx`: "Connect Wallet" button using `@polkadot/extension-dapp` `web3Enable("DATUM")` / `web3Accounts()`
- [x] Uses first account from `web3Accounts()` (MVP: no account switcher)
- [x] Wraps connected account via `ethers.BrowserProvider(window.ethereum)` in popup context for signing
- [x] Store selected account address in `chrome.storage.local`; restore on popup open
- [x] Handle wallet not installed: displays error "No Polkadot wallet found. Install Polkadot.js or SubWallet."
- [x] `WALLET_CONNECTED` / `WALLET_DISCONNECTED` messages to background

#### 2.3 — Contract bindings ✅ COMPLETE
- [x] `scripts/copy-abis.js`: copies ABI arrays from `/poc/artifacts/contracts/` to `extension/src/shared/abis/` (6 contracts)
- [x] `contracts.ts`: typed factory functions (`getCampaignsContract`, `getPublishersContract`, `getSettlementContract`, `getRelayContract`, etc.) returning ethers `Contract` instances
- [x] Contract addresses read from `chrome.storage.local` settings (user-configured via Settings panel)
- [x] `networks.ts`: `NETWORK_CONFIGS` with RPC URLs for local/westend/kusama/polkadotHub, `DEFAULT_SETTINGS`

#### 2.4 — Campaign poller ✅ COMPLETE
- [x] `campaignPoller.ts`: polls `campaigns.getCampaign(id)` for IDs 1..1000 on 5-minute `chrome.alarms` schedule
- [x] Stops on 3 consecutive misses (id == 0 or revert). Per-campaign try/catch prevents single failure from aborting poll.
- [x] Filters for `CampaignStatus.Active` only
- [x] Serializes campaigns (bigint→string) to `chrome.storage.local` under `activeCampaigns` key
- [x] Exposes `getCached()` for background message handler; `GET_ACTIVE_CAMPAIGNS` message returns cached list

#### 2.5 — Taxonomy and impression recording ✅ COMPLETE
- [x] `taxonomy.ts`: 10 hardcoded categories (crypto, finance, technology, gaming, news, privacy, open-source, science, environment, health) with keyword + domain matching
- [x] `content/index.ts`: classifies page on load via `classifyPage(document.title, hostname)`, fetches active campaigns, matches first Active campaign
- [x] `adSlot.ts`: fixed-position 280px dark-themed banner (bottom-right, z-index max), dismissible, shows campaign ID + category
- [x] Dedup: per-page-load `Set` + 30-minute `chrome.storage.local` dedup per campaign
- [x] Content script → background: `IMPRESSION_RECORDED { campaignId, url, category, publisherAddress }` message

#### 2.6 — Claim builder ✅ COMPLETE
- [x] `claimBuilder.ts`: per-(userAddress, campaignId) hash chain state stored under `chainState:{user}:{campaignId}` key
- [x] On `IMPRESSION_RECORDED`: builds claim with `impressionCount=1`, `clearingCpmPlanck=bidCpmPlanck`, `nonce=lastNonce+1`, `claimHash=solidityPackedKeccak256(...)`, `zkProof="0x"`
- [x] `syncFromChain()` method for re-syncing after nonce mismatch (clears stale queued claims)
- [x] Claims appended to `claimQueue` storage with correct `userAddress` field
- [x] `claimQueue.ts`: `getState()`, `buildBatches(userAddress)` (groups by campaignId), `removeSettled()`, `clear()`
- [x] **Bug fix (2026-02-27):** `serializeClaim` was hardcoding `userAddress: ""` — fixed to pass actual address. Without this, `getState().byUser` and `buildBatches()` could never match claims.

#### 2.7 — Manual submit mode ✅ COMPLETE
- [x] `ClaimQueue.tsx`: lists pending claims grouped by campaign; shows count per campaign
- [x] "Submit All" and "Sign for Publisher" buttons wired end-to-end
- [x] Background `SUBMIT_CLAIMS` handler returns serialized `ClaimBatch[]` from `buildBatches()`
- [x] **`submitAll()`**: acquires mutex → receives serialized batches from background → deserializes bigints → calls `settlement.settleClaims(batches)` via `BrowserProvider` signer → awaits receipt → parses `ClaimSettled`/`ClaimRejected` events → `REMOVE_SETTLED_CLAIMS` message → releases mutex
- [x] **`signForRelay()`**: fetches batches → builds EIP-712 domain (`"DatumRelay"`, verifyingContract: relay address) + types + per-batch value → `signer.signTypedData()` → stores `SignedClaimBatch[]` in `chrome.storage.local`
- [x] Displays `settledCount`/`rejectedCount` after settlement; shows total paid in DOT
- [x] Nonce mismatch recovery: on E04/E05 revert or all-rejected result, reads on-chain `lastNonce`/`lastClaimHash` → `SYNC_CHAIN_STATE` → `claimBuilder.syncFromChain()` → prompts re-submit
- [x] Shows last auto-flush result (timestamp, settled/rejected counts or error message)
- [x] New message types added to `PopupToBackground`: `REMOVE_SETTLED_CLAIMS`, `SYNC_CHAIN_STATE`, `ACQUIRE_MUTEX`, `RELEASE_MUTEX`
- [x] `SerializedClaim` and `SerializedClaimBatch` types added to `shared/types.ts`

**Note:** Estimated earnings display deferred — requires per-campaign CPM data in popup context. Post-G2 enhancement.

#### 2.8 — Auto submit mode ✅ COMPLETE
- [x] Settings toggle UI: "Auto submit" checkbox + interval input (minutes)
- [x] `chrome.alarms.create(ALARM_FLUSH_CLAIMS)` registered when `autoSubmit=true`
- [x] `SETTINGS_UPDATED` message handler reconfigures alarms on save
- [x] **`autoFlushViaOffscreen()`** implemented in `background/index.ts`: acquires mutex → checks connected address + pending batches → creates offscreen document → sends `OFFSCREEN_SUBMIT` message → receives `OFFSCREEN_SUBMIT_RESULT` → stores to `lastAutoFlushResult` → closes offscreen + releases mutex
- [x] **Offscreen document** (`src/offscreen/offscreen.ts` + `offscreen.html`): checks `window.ethereum` + `eth_accounts` → gets signer for `userAddress` → calls `settlement.settleClaims()` → parses events → sends `REMOVE_SETTLED_CLAIMS` → replies result
- [x] `offscreen` permission added to `manifest.json` with `DOM_SCRAPING` reason
- [x] `offscreen` webpack entry point added; second `HtmlWebpackPlugin` for `offscreen.html` (inject: false)
- [x] `BackgroundToOffscreen` and `OffscreenToBackground` message types added to `shared/messages.ts`
- [x] `claimQueue.autoFlush()` is now a stub; real logic lives in `autoFlushViaOffscreen()` in index.ts
- [x] Last auto-flush result displayed in `ClaimQueue.tsx` popup (timestamp, settled/rejected or error)
- [x] Graceful failure: errors stored to `lastAutoFlushResult` in storage, surfaced in popup

#### 2.9 — Publisher panel ✅ COMPLETE
- [x] `PublisherPanel.tsx`: queries `settlement.publisherBalance(address)` and `publishers.getPublisher(address)` via read-only provider
- [x] Displays withdrawable balance in DOT, registration status (Active/Inactive), take rate, pending take rate + effective block
- [x] "Withdraw" button: creates `BrowserProvider` signer → calls `settlement.withdrawPublisher()` → awaits receipt → refreshes balance
- [x] "Refresh" button to reload data
- [x] Error handling for missing wallet / failed RPC

#### 2.10 — Settings panel ✅ COMPLETE
- [x] Network selector (local / westend / kusama / polkadotHub) — auto-fills RPC URL and contract addresses from `NETWORK_CONFIGS`
- [x] RPC endpoint (text input, saved to storage)
- [x] Per-contract address fields (campaigns, publishers, governanceVoting, governanceRewards, settlement, relay)
- [x] Publisher address override (defaults to connected wallet if blank)
- [x] Auto-submit toggle + interval (minutes)
- [x] Save button persists to `chrome.storage.local` + sends `SETTINGS_UPDATED` to background
- [x] "Clear claim queue" button with confirmation dialog → sends `CLEAR_QUEUE` message
- [x] "Reset chain state" button with confirmation → sends `RESET_CHAIN_STATE` message (background enumerates and removes all `chainState:*` keys + clears queue)
- [x] **Bug fix (2026-02-27):** `resetChainState` was removing non-existent `"claimChainState"` key. Fixed to delegate entirely to background handler which uses correct `chainState:` prefix enumeration.

#### 2.11 — User withdrawal panel ✅ COMPLETE
(Identified as gap D6 in Appendix review — users earn 75% but extension had no withdrawal UI)
- [x] `UserPanel.tsx` popup component created
- [x] Displays `settlement.userBalance(address)` in DOT via read-only provider
- [x] "Withdraw" button: creates `BrowserProvider` signer → calls `settlement.withdrawUser()` → awaits receipt → refreshes balance
- [x] Shows tx confirmation and updated balance post-withdraw
- [x] "Earnings" tab added to `App.tsx` tab bar (between "Claims" and "Publisher")

#### 2.12 — Submission mutex (race condition prevention) ✅ COMPLETE
(Identified as gap D5 in Appendix review)
- [x] `submitting` flag stored in `chrome.storage.local` as `{ since: timestamp }` — set before any submit, cleared on tx confirm/fail/error
- [x] `claimQueue.acquireMutex()`: returns false if lock held and not stale; force-clears after 5-minute staleness timeout
- [x] `claimQueue.releaseMutex()`: removes storage key
- [x] `ACQUIRE_MUTEX` / `RELEASE_MUTEX` message handlers in `background/index.ts`
- [x] Manual submit (`ClaimQueue.tsx` `submitAll()`) calls `ACQUIRE_MUTEX` before starting, `RELEASE_MUTEX` in finally block
- [x] Auto-submit (`autoFlushViaOffscreen()`) calls `acquireMutex()` directly; releases on result or error
- [x] Prevents double-submission of overlapping claim queues that would cause nonce mismatch

#### Gate G2 checklist
- [ ] Extension installs in Chrome with no manifest errors ← **Step E — manual verification needed**
- [ ] Wallet connect works with Polkadot.js extension and SubWallet
- [ ] Campaign list loads from configured RPC
- [ ] Browsing a matching page injects an ad unit and records an impression
- [ ] Manual submit: claim is submitted, `settledCount >= 1`, balance visible in publisher panel
- [ ] Auto submit: submits without user interaction at configured interval
- [ ] Publisher withdraw: balance transfers to wallet
- [ ] User withdraw: balance transfers to wallet
- [ ] Settings persists across popup close/open

#### Phase 2 — Remaining work

~~**Step A — Wire manual claim submission (2.7)**~~ ✅ DONE
~~**Step B — Add user withdrawal (2.11)**~~ ✅ DONE
~~**Step C — Add submission mutex (2.12)**~~ ✅ DONE
~~**Step D — Wire auto-submit (2.8)**~~ ✅ DONE

**Step E — Chrome verification (G2 gate)** ← sole remaining item
1. Load `dist/` as unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked)
2. Connect SubWallet or Polkadot.js wallet
3. Configure Settings: local devchain RPC + deployed contract addresses
4. Browse a page matching campaign taxonomy — verify ad banner appears
5. Open popup → Claims → Submit All — verify settlement result
6. Enable auto-submit in Settings, wait for alarm interval — verify auto-flush result appears
7. Open Earnings tab — verify `userBalance` shows, withdraw succeeds
8. Fix any runtime errors (CSP violations, missing polyfills, service worker lifecycle issues)

**Phase 2A implementation complete. G2 also requires Phase 2B (metadata/creative/SDK) below.**

---

### Phase 2B — Campaign Metadata, Creative Display, and Publisher SDK

**Audit finding (2026-03-01):** The extension records impressions and submits claims correctly, but has no mechanism for campaigns to carry metadata (creative content, description, category targeting). Publishers cannot create campaigns or manage creatives from the extension. The ad slot displays placeholder text. These gaps block meaningful G2 testing.

**PVM bytecode constraint:** DatumCampaigns is at 48,044 bytes (1,108 spare). Adding a `string metadataUri` field to the Campaign struct would push it well over the 49,152 limit (string storage + ABI encoding adds ~4-8 KB of PVM bytecode). Solution: **off-chain metadata via IPFS with an on-chain event anchor.**

**Architecture decision: Off-chain metadata with on-chain event commitment**

Campaigns emit a `CampaignMetadataSet(campaignId, metadataUri)` event at creation time. The `metadataUri` is an IPFS CID pointing to a JSON blob with the campaign's creative, description, and category. The event is not stored on-chain (no storage slot = no PVM bloat), but is indexable by the extension via `queryFilter` or by a future indexer. The publisher SDK uploads metadata to IPFS, then includes the CID in the `createCampaign` call (emitted as event data).

**Why events instead of storage:** An `emit` with a `string` costs ~200-400 bytes of PVM vs ~4-8 KB for string storage + getter. DatumCampaigns has only 1,108 bytes spare — events fit, storage doesn't.

**Metadata JSON schema (hosted on IPFS):**
```json
{
  "title": "Campaign title",
  "description": "Short ad copy (max 140 chars)",
  "category": "crypto",
  "creative": {
    "type": "text",
    "text": "Trade smarter with XYZ — zero fees for your first month",
    "cta": "Learn More",
    "ctaUrl": "https://example.com/landing"
  },
  "version": 1
}
```

Post-MVP, `creative.type` can expand to `"image"` (with `imageUrl` pointing to IPFS-hosted PNG/WebP) or `"video"`.

#### 2.13 — Campaign metadata event (contract change)

Add a `CampaignMetadataSet` event to `IDatumCampaigns.sol` and emit it in `createCampaign()`. No new storage — just calldata → event log. Also add `setMetadata()` for advertiser to update metadata post-creation.

**Contract changes:**

```solidity
// IDatumCampaigns.sol — new event
event CampaignMetadataSet(uint256 indexed campaignId, string metadataUri);

// DatumCampaigns.sol — in createCampaign(), after emit CampaignCreated:
// metadataUri is optional calldata parameter; emit if non-empty
// New function:
function setMetadata(uint256 campaignId, string calldata metadataUri) external;
```

Since `createCampaign` already has 3 parameters and adding a 4th `string` changes the ABI, we add metadata via a separate `setMetadata(campaignId, uri)` call (advertiser-only). This avoids changing the existing `createCampaign` ABI signature and keeps the function's PVM bytecode minimal.

**Tasks:**
- [x] Add `event CampaignMetadataSet(uint256 indexed campaignId, bytes32 metadataHash)` to `IDatumCampaigns.sol` (uses `bytes32` hash instead of `string` CID for PVM size — extension maps hash→CID off-chain)
- [x] Add `setMetadata(uint256 campaignId, bytes32 metadataHash)` to `DatumCampaigns.sol` — requires `msg.sender == campaign.advertiser`, emits `CampaignMetadataSet`
- [x] Verify PVM bytecode stays under 49,152 bytes (required additional size reduction — see 2.14b below)
- [ ] Add test: advertiser can set metadata; non-advertiser reverts
- [x] Update `setup-test-campaign.ts` to call `setMetadata` with a synthetic hash (exercises on-chain event flow)

**Implementation note (2026-03-02):** Changed from `string metadataUri` to `bytes32 metadataHash` to avoid string ABI encoding overhead in PVM. The extension maps `keccak256(ipfsCid) → ipfsCid` locally. This saves ~400 B of PVM bytecode vs a string parameter.

**Files:** `poc/contracts/interfaces/IDatumCampaigns.sol`, `poc/contracts/DatumCampaigns.sol`, `poc/test/campaigns.test.ts`

#### 2.14 — Campaign category field (contract change)

Add a `uint8 categoryId` to the Campaign struct to enable on-chain category filtering. This uses a fixed 1-byte field (not a string) to minimize PVM bytecode impact. Category IDs map to the existing 10-category taxonomy (0=uncategorized, 1=crypto, 2=finance, ..., 10=health).

**Why on-chain:** Per-campaign category targeting is the minimum viable targeting feature. Without it, every campaign matches every page equally. A single `uint8` adds ~100-200 bytes to the PVM bytecode (vs ~4-8 KB for a string taxonomy field).

**Contract changes:**

```solidity
// IDatumCampaigns.sol — Campaign struct addition
uint8 categoryId;    // 0 = uncategorized (matches all), 1-10 = specific category

// IDatumCampaigns.sol — createCampaign parameter addition
function createCampaign(
    address publisher,
    uint256 dailyCapPlanck,
    uint256 bidCpmPlanck,
    uint8 categoryId
) external payable returns (uint256 campaignId);
```

**Tasks:**
- [x] Add `uint8 categoryId` to `Campaign` struct in `IDatumCampaigns.sol`
- [x] Update `createCampaign()` to accept `uint8 categoryId` parameter
- [x] Store `categoryId` in campaign; emit in `CampaignCreated` event
- [x] Verify PVM bytecode stays under 49,152 bytes (required additional size reduction — see 2.14b below)
- [x] Update all test fixtures and helpers for new `createCampaign` signature (all pass `categoryId: 0`)
- [x] Update `setup-test-campaign.ts` with `categoryId = 1` (crypto) — was already in place
- [x] Update extension `types.ts` Campaign interface with `categoryId` field
- [x] Update extension `campaignPoller.ts` to deserialize `categoryId`
- [x] Update extension `content/index.ts` to filter campaigns by category match
- [x] Update extension `CampaignList.tsx` to display category name

**Category ID mapping (matches taxonomy.ts):**
| ID | Category |
|----|----------|
| 0 | Uncategorized (matches all pages) |
| 1 | Crypto |
| 2 | Finance |
| 3 | Technology |
| 4 | Gaming |
| 5 | News |
| 6 | Privacy |
| 7 | Open Source |
| 8 | Science |
| 9 | Environment |
| 10 | Health |

**Files:** `poc/contracts/interfaces/IDatumCampaigns.sol`, `poc/contracts/DatumCampaigns.sol`, `poc/test/campaigns.test.ts`, `poc/test/integration.test.ts`, `poc/test/settlement.test.ts`, `poc/scripts/setup-test-campaign.ts`, `extension/src/shared/types.ts`, `extension/src/background/campaignPoller.ts`, `extension/src/content/index.ts`, `extension/src/popup/CampaignList.tsx`

#### 2.14b — PVM size reduction for Phase 2B changes ✅ COMPLETE (2026-03-02)

**Problem:** Adding `categoryId` to the Campaign struct and `setMetadata()` to DatumCampaigns caused:
- **DatumSettlement:** 49,508 B — **356 bytes OVER** the 49,152 B limit (Settlement itself was not modified — the struct growth inflated ABI decode codegen for `getCampaign()`)
- **DatumCampaigns:** 49,121 B → 49,670 B after adding `getCampaignForSettlement()` — **518 bytes OVER**

**Root cause:** Settlement calls `campaigns.getCampaign(id)` which returns the full 14-field Campaign struct. resolc generates ~400 extra bytes of ABI decode code per additional struct field. Settlement only uses 5 of the 14 fields. Similarly, DatumCampaigns had too many view functions generating redundant PVM bytecode.

**Solution: Slim interface pattern + function merging**

DatumSettlement:
- [x] Created `IDatumCampaignsSettlement` slim interface with `getCampaignForSettlement()` returning 5 primitives `(uint8 status, address publisher, uint256 bidCpmPlanck, uint256 remainingBudget, uint16 snapshotTakeRateBps)` instead of the full Campaign struct
- [x] Settlement uses `IDatumCampaignsSettlement` instead of `IDatumCampaigns` — eliminates full struct from Settlement's PVM bytecode entirely
- [x] Balance/nonce mappings changed from `private` + manual getters to `public` (auto-generated getters are ABI-compatible)
- [x] `MAX_CLAIMS_PER_BATCH` public constant replaced with inlined literal `5`

DatumCampaigns:
- [x] Merged `pauseCampaign()` + `resumeCampaign()` into `togglePause(uint256 campaignId, bool pause)` — one function replaces two
- [x] Removed `version` field from Campaign struct (was always `2`; no longer needed)
- [x] Removed `getCampaignStatus()` and `getCampaignRemainingBudget()` view functions — governance contracts now use `getCampaignForSettlement()` with tuple destructuring
- [x] Added `getCampaignForSettlement()` returning 5 settlement-relevant fields as primitives

Governance:
- [x] `DatumGovernanceVoting` and `DatumGovernanceRewards` updated to use `getCampaignForSettlement()` instead of individual getters
- [x] `IDatumCampaignsMinimal` updated to use `getCampaignForSettlement()` instead of `getCampaignStatus()` + `getCampaignRemainingBudget()`
- [x] Status checks use uint8 literals (0=Pending, 1=Active, 2=Paused, 3=Completed, 4=Terminated)

**PVM bytecode sizes (2026-03-02, all 6 contracts under 49,152 B):**

| Contract | Before | After | Saved | Margin |
|----------|--------|-------|-------|--------|
| DatumPublishers | 19,247 | 19,247 | — | 29,905 |
| DatumCampaigns | 49,670 | 48,169 | 1,501 | **983** |
| DatumGovernanceVoting | 48,196 | 47,510 | 686 | 1,642 |
| DatumGovernanceRewards | 48,308 | 48,745 | +437 | **407** |
| DatumSettlement | 49,508 | 44,893 | **4,615** | 4,259 |
| DatumRelay | 33,782 | 33,782 | — | 15,370 |

**Note:** DatumGovernanceRewards increased by 437 B because it now calls `getCampaignForSettlement()` (tuple return) instead of `getCampaignStatus()` (single return). The new ABI decode for the 5-field tuple costs more PVM bytes than the single-value getter, but Rewards still has 407 B margin.

**API changes (breaking, affects extension and tests):**

| Change | Impact |
|--------|--------|
| `pauseCampaign(id)` / `resumeCampaign(id)` → `togglePause(id, bool)` | Extension must pass `true` to pause, `false` to resume. Tests updated. |
| `getCampaignStatus(id)` removed from DatumCampaigns | Not called by extension (governance-only). MockCampaigns retains it for test convenience. |
| `getCampaignRemainingBudget(id)` removed from DatumCampaigns | Not called by extension. MockCampaigns retains it. |
| `Campaign.version` field removed | Extension and tests no longer reference it. No runtime impact. |
| Balance/nonce mappings now `public` in DatumSettlement | ABI-compatible (auto-generated getters match old manual getters). No consumer changes needed. |
| `MAX_CLAIMS_PER_BATCH` constant removed from DatumSettlement | Limit still enforced (inlined as `5`). Extension doesn't read this constant. |

**Security considerations:**

1. **`togglePause(id, bool)`**: Identical access control to the separate functions (advertiser-only, same error codes E21/E22/E23). No new attack surface. A malicious caller still cannot pause or resume someone else's campaign.

2. **Status checks via uint8 literals**: Governance contracts now compare `status == 0` instead of `status == CampaignStatus.Pending`. These are semantically identical at the EVM level (the enum is stored as uint8). Risk: if the CampaignStatus enum order ever changes, the hardcoded literals would break. Mitigation: the enum is defined in the interface and has been stable since contract creation. Any reorder would break far more than just governance.

3. **Public mappings in Settlement**: The `publisherBalance`, `userBalance`, `protocolBalance`, `lastNonce`, and `lastClaimHash` mappings were already exposed via identical view functions. Making them `public` does not leak any new information. Auto-generated getters have the same function signatures and return types.

4. **Slim interface ABI compatibility**: `IDatumCampaignsSettlement` defines `getCampaignForSettlement()` with the same selector as the function in DatumCampaigns. Solidity guarantees function selectors are computed from the signature string, so the slim interface is guaranteed to match the real contract at the ABI level.

5. **Removed `version` field**: This field was informational only (always `2`), never read by any contract logic. Removing it has no security impact.

**Product considerations:**

1. **`togglePause` UX**: Any dapp or script calling `pauseCampaign`/`resumeCampaign` must update to `togglePause(id, true/false)`. The extension ABI has been updated. Third-party integrations would need ABI updates.

2. **Struct change breaks existing deployments**: The Campaign struct layout has changed (no `version` field, added `categoryId`). This is a storage-layout-breaking change. Existing deployed contracts cannot be upgraded in-place — they must be redeployed. This is acceptable at the PoC/pre-mainnet stage.

3. **DatumGovernanceRewards has only 407 B margin**: Any future addition to DatumCampaigns that changes the `getCampaignForSettlement` return type, or any new cross-contract call in Rewards, risks pushing it over the limit. Monitor closely.

**Files changed:**
- `poc/contracts/DatumSettlement.sol` — slim interface, public mappings, inlined constant
- `poc/contracts/DatumCampaigns.sol` — togglePause, getCampaignForSettlement, removed getters, removed version
- `poc/contracts/DatumGovernanceVoting.sol` — tuple destructuring for status/budget
- `poc/contracts/DatumGovernanceRewards.sol` — tuple destructuring for status
- `poc/contracts/interfaces/IDatumCampaigns.sol` — togglePause, getCampaignForSettlement, removed version
- `poc/contracts/interfaces/IDatumCampaignsMinimal.sol` — getCampaignForSettlement replaces individual getters
- `poc/contracts/interfaces/IDatumCampaignsSettlement.sol` — **new** slim interface for Settlement
- `poc/contracts/interfaces/IDatumSettlement.sol` — unchanged (auto-generated getters match)
- `poc/contracts/mocks/MockCampaigns.sol` — togglePause, getCampaignForSettlement, removed version
- `poc/test/campaigns.test.ts` — togglePause calls, removed version assertion
- `extension/src/shared/abis/DatumCampaigns.json` — updated ABI
- `extension/src/shared/abis/DatumSettlement.json` — updated ABI

#### 2.15 — IPFS metadata fetch in extension

The extension fetches campaign metadata from IPFS when it discovers new campaigns. Metadata is cached in `chrome.storage.local` alongside the campaign data.

**Architecture:**
- `campaignPoller.ts` queries `CampaignMetadataSet` events for each discovered campaign ID
- Fetches JSON from IPFS gateway (e.g. `https://dweb.link/ipfs/{cid}` or configurable gateway)
- Caches metadata per campaign ID in storage: `metadata:{campaignId}` → JSON blob
- `CampaignList.tsx` and `adSlot.ts` render creative content from cached metadata

**Tasks:**
- [x] Add `ipfsGateway` field to `StoredSettings` (default: `https://dweb.link/ipfs/`) — already in types.ts and networks.ts
- [x] Add IPFS gateway URL input to `Settings.tsx` — already present
- [x] Extend `campaignPoller.ts`: query `CampaignMetadataSet` events, decode bytes32→CID→gateway URL via `metadataUrl()` — fixed in Step G
- [x] Fetch metadata JSON from IPFS gateway, validate schema, cache in `chrome.storage.local` — already implemented (fetch + cache)
- [x] Update `CampaignList.tsx` to display title and description from metadata — already rendering `meta.title` and `meta.description`
- [x] Update `adSlot.ts` to render creative text, CTA button, and category from metadata — already implemented with fallback
- [x] Handle missing metadata gracefully (fall back to current placeholder display) — fallback path present
- [ ] Add 1-hour cache TTL for metadata (re-fetch if stale)

**Files:** `extension/src/shared/types.ts`, `extension/src/shared/networks.ts`, `extension/src/popup/Settings.tsx`, `extension/src/background/campaignPoller.ts`, `extension/src/popup/CampaignList.tsx`, `extension/src/content/adSlot.ts`

#### 2.16 — Publisher campaign creation UI

Add campaign creation form to the Publisher tab. Publishers can create campaigns, set metadata, and fund them directly from the extension.

**Tasks:**
- [x] Add "Create Campaign" form to `PublisherPanel.tsx` (section below balance info):
  - Budget (DOT input → converted to planck) ✅
  - Daily cap (DOT input) ✅
  - Bid CPM (DOT input, default 0.01) ✅
  - Category (dropdown, maps to `categoryId` 0-10) ✅
  - Metadata CID (optional IPFS CIDv0 input) ✅ (replaces inline metadata fields — publisher pre-uploads JSON to IPFS)
- [x] On submit: call `campaigns.createCampaign(publisher, dailyCap, bidCpm, categoryId, {value: budget})`
- [x] After campaign creation: encode CID→bytes32 via `cidToBytes32()`, call `campaigns.setMetadata(campaignId, hash)` — fixed in Step G (was passing raw string, now encodes properly; parses campaignId from CampaignCreated event)
- [ ] Display created campaign ID in result message
- [ ] Show pending governance status ("Awaiting governance activation")

**IPFS upload strategy for MVP:**
- Use a public IPFS pinning gateway (e.g. Pinata free tier, nft.storage, or web3.storage)
- Alternative: paste an existing IPFS CID if publisher pre-uploaded metadata
- Extension sends a `POST` to the IPFS HTTP API with JSON metadata
- Returns CID which is emitted via `setMetadata()`

**IPFS upload approach (revised):**

The MVP uses a "paste CID" workflow: the publisher creates metadata JSON (matching `CampaignMetadata` schema), pins it to IPFS via any method (CLI `ipfs add`, Pinata, web3.storage), and pastes the resulting CIDv0 into the extension UI. The `cidToBytes32()` encoding handles the on-chain commitment.

A `poc/scripts/upload-metadata.ts` developer CLI tool validates metadata JSON and sets the hash on-chain. Sample metadata files in `poc/metadata/` provide templates.

Direct IPFS pinning from the extension (Pinata API integration) is deferred to post-MVP — it requires API key management and CSP configuration that adds complexity without blocking E2E testing.

**Files:** `extension/src/popup/PublisherPanel.tsx`, `extension/src/shared/ipfs.ts` (CID↔bytes32 utilities), `poc/scripts/upload-metadata.ts`, `poc/scripts/lib/ipfs.ts`, `poc/metadata/sample-crypto.json`, `poc/metadata/sample-privacy.json`

#### 2.17 — Updated ad slot with creative rendering

Replace the placeholder ad banner with a creative-aware display that shows campaign title, description, and CTA from IPFS metadata.

**Tasks:**
- [x] Update `AdSlotConfig` interface to include metadata fields — `CampaignCreative` interface with title, description, creative, category
- [x] Update `content/index.ts` to pass metadata to `injectAdSlot()` — reads from cached `metadata:{campaignId}` storage
- [x] Update `adSlot.ts` to render:
  - Campaign title (from metadata) ✅
  - Creative text (from metadata.creative.text) ✅
  - CTA button linking to `ctaUrl` ✅
  - Campaign ID + "Privacy-preserving · Polkadot Hub" footer ✅
- [x] Keep dismiss button and dark theme styling ✅
- [x] Graceful fallback: if no metadata, render placeholder with category badge ✅

**Files:** `extension/src/content/adSlot.ts`, `extension/src/content/index.ts`

#### Updated Gate G2 checklist
- [ ] Extension installs in Chrome with no manifest errors ← **Step H (manual)**
- [ ] Wallet connect works with Polkadot.js extension or SubWallet ← **Step H (manual)**
- [ ] Campaign list loads from configured RPC with title/description from IPFS metadata ← **Step H (requires deployed contracts + pinned metadata)**
- [ ] Publisher can create a campaign via extension UI (budget, CPM, category, CID) — *code complete, needs runtime test*
- [ ] Campaign metadata encoded via `cidToBytes32()` and set via `setMetadata()` — *code complete, needs runtime test*
- [ ] Browsing a matching page injects an ad unit with campaign creative (title, description, CTA) — *code complete, needs runtime test*
- [ ] Category targeting: crypto campaign only shows on crypto-classified pages — *code complete, needs runtime test*
- [ ] Manual submit: claim is submitted, `settledCount >= 1`, balance visible ← **Step H**
- [ ] Auto submit: submits without user interaction at configured interval ← **Step H**
- [ ] Publisher withdraw: balance transfers to wallet ← **Step H**
- [ ] User withdraw: balance transfers to wallet ← **Step H**
- [ ] Settings persists across popup close/open ← **Step H**

#### Phase 2B — Remaining work

**Step F — Contract metadata + category changes (2.13, 2.14, 2.14b) ✅ COMPLETE**
1. ~~Add `CampaignMetadataSet` event and `setMetadata()` function~~ ✅
2. ~~Add `categoryId` field to Campaign struct and `createCampaign()`~~ ✅
3. ~~Update all test fixtures for new ABI; verify PVM size~~ ✅ (required 2.14b size reduction)
4. ~~Run full test suite~~ ✅ 58/58 pass

**Step G — CID↔bytes32 encoding + developer metadata workflow ✅ COMPLETE (2026-03-02)**
1. ~~`extension/src/shared/ipfs.ts` — `cidToBytes32()`, `bytes32ToCid()`, `metadataUrl()` utilities~~ ✅
2. ~~`poc/scripts/lib/ipfs.ts` — same utilities for hardhat scripts~~ ✅
3. ~~Fix `campaignPoller.ts` — decode bytes32→CID→gateway URL (was treating bytes32 as URI string)~~ ✅
4. ~~Fix `PublisherPanel.tsx` — CID input + `cidToBytes32()` encoding + event-based campaignId parsing~~ ✅
5. ~~`poc/scripts/upload-metadata.ts` — developer CLI (`--file` validates schema; `--cid`+`--campaign` sets on-chain)~~ ✅
6. ~~`poc/scripts/setup-test-campaign.ts` — now calls `setMetadata` with synthetic hash after activation~~ ✅
7. ~~`poc/metadata/sample-crypto.json` + `sample-privacy.json` — sample metadata files~~ ✅
8. ~~Extension builds cleanly; 58/58 tests pass~~ ✅

**Step H — Local devnet E2E testing** ← NEXT
This is the final step before the G2 gate can be fully evaluated. Requires a running local devnet.

1. Start substrate-contracts-node + eth-rpc adapter (`docker compose up`)
2. Deploy contracts: `npx hardhat run scripts/deploy.ts --network substrate`
3. Run `setup-test-campaign.ts --network substrate` — verify campaign + metadata hash on-chain
4. Load extension in Chrome, configure Settings with local RPC + deployed addresses
5. Browse a crypto-related page → verify ad banner appears with campaign match
6. Submit claims manually → verify settlement success
7. Enable auto-submit → verify auto-flush
8. Test publisher withdraw + user withdraw
9. Fix any runtime issues (CSP, polyfills, service worker lifecycle, wallet integration)

**Current blockers for Step H:**
- Need Docker containers running (`substrate` + `eth-rpc` on ports 9944/8545)
- Need Chrome with SubWallet or Polkadot.js extension installed
- IPFS metadata fetch will fail for synthetic hashes (expected — exercises the fallback path)
- Real IPFS metadata test: pin `poc/metadata/sample-crypto.json` to IPFS, then `upload-metadata.ts --cid <CID> --campaign <ID>`

---

### Phase 2C — Local Interest Model and Campaign Matching

**Prerequisite:** Phase 2B code complete (Steps F+G done, Step H in progress or complete)
**Scope:** Extension-only changes — no contract modifications. Replaces the naive "first matching campaign" selection with a privacy-preserving local interest model. All computation happens on-device; no profile data ever leaves the browser.

**Design principle:** DATUM inverts the traditional adtech model. In conventional programmatic advertising, the ad server profiles users and decides which ad to show. In DATUM, the user's extension runs the ad decision engine. The publisher provides supply (page inventory), the advertiser provides demand (campaign + budget), and the user's device matches them. Only the user knows why a particular ad was selected.

#### 2.18 — Local interest profile (weighted interest vector)

Replace the single per-page category match with a persistent local interest vector that accumulates browsing signals over time.

**Files changed:**
- New: `extension/src/background/interestProfile.ts`
- Modified: `extension/src/content/index.ts` (send category signal to background)
- Modified: `extension/src/background/index.ts` (handle `UPDATE_INTEREST` message)
- Modified: `extension/src/popup/Settings.tsx` (interest profile viewer + reset button)

**Data model:**
```typescript
// Stored in chrome.storage.local — never leaves the device
interface UserInterestProfile {
  weights: Record<string, number>;    // category → 0.0–1.0 (decayed)
  visits: Record<string, number>;     // category → total visit count
  recentVisits: Array<{               // rolling window for decay calculation
    category: string;
    timestamp: number;
  }>;
  lastUpdated: number;
}
```

**Implementation:**
- [x] `interestProfile.ts`: `updateProfile(category)` — appends to `recentVisits`, prunes entries older than 30 days, recomputes `weights` using exponential decay (half-life: 7 days)
- [ ] Weight formula: `weight[cat] = sum(0.5^((now - visitTime) / halfLife))` for all recent visits in that category, normalized so max weight = 1.0
- [ ] `getProfile()` — returns current profile from storage (never exposes outside the extension)
- [ ] `resetProfile()` — clears all interest data (user-initiated from Settings)
- [ ] Content script: after `classifyPage()`, send `{ type: "UPDATE_INTEREST", category }` to background
- [ ] Background handler: call `updateProfile(category)` on receipt
- [ ] Settings panel: "Your Interest Profile" section showing category weights as a horizontal bar chart. "Reset Profile" button clears all data. Explanatory text: "This data never leaves your browser."

#### 2.19 — Interest-weighted campaign matching

Replace `pool[0]` (first match) with scored selection using the interest profile.

**Files changed:**
- Modified: `extension/src/content/index.ts` (request score-based match from background)
- New: `extension/src/background/campaignMatcher.ts`

**Scoring function:**
```typescript
function scoreCampaign(
  campaign: CampaignInfo,
  profile: UserInterestProfile,
  pageCategory: string
): number {
  const catName = CATEGORY_NAME_MAP[campaign.categoryId] ?? "";
  const interestWeight = profile.weights[catName] ?? 0;
  const confidence = Math.min((profile.visits[catName] ?? 0), 20) / 20;
  const pageBoost = catName === pageCategory ? 1.5 : 1.0;
  const bidWeight = Number(campaign.bidCpmPlanck);

  return interestWeight * confidence * pageBoost * bidWeight;
}
```

**Implementation:**
- [ ] `campaignMatcher.ts`: `selectCampaign(campaigns, profile, pageCategory)` — scores all matching campaigns, selects using weighted random (probability proportional to score, not winner-take-all)
- [ ] Weighted random: prevents one high-bid campaign from capturing all impressions. A campaign with 2x the score gets 2x the impressions, not 100%
- [ ] Fallback: if profile is empty (new user, just reset), fall back to contextual-only matching (current `pageCategory` match + random from pool)
- [ ] Content script update: instead of directly picking `pool[0]`, send `{ type: "SELECT_CAMPAIGN", campaigns: pool, pageCategory }` to background, receive the scored selection

#### 2.20 — Enhanced page classification

Improve `classifyPage()` from keyword/domain matching to a multi-signal classifier that produces soft probabilities.

**Files changed:**
- Modified: `extension/src/content/taxonomy.ts`

**Implementation:**
- [ ] `classifyPage()` returns `Record<string, number>` (category → confidence) instead of `string | null`
- [ ] Signal sources (all on-page, no network calls):
  1. Domain match: 0.9 confidence for known domains (existing list)
  2. Title keyword match: 0.6 confidence per keyword hit, max 0.8
  3. Meta description keywords: 0.4 confidence per hit, max 0.6
  4. `<meta name="keywords">` tag: 0.5 confidence per match
  5. Aggregate: take max confidence per category across all signals
- [ ] Return all categories with confidence > 0.3 (a page can match multiple categories)
- [ ] Update interest profile with all matched categories weighted by confidence (a page scoring `{ crypto: 0.8, finance: 0.3 }` updates both categories, crypto 2.7x more than finance)
- [ ] Backward compatible: campaign matching uses the highest-confidence category for primary selection; secondary categories contribute to profile building

#### 2.21 — Publisher co-signature verification in DatumRelay (anti-fraud)

**Rationale:** Impression counts are entirely self-reported. A modified extension can fabricate unlimited claims. Publisher co-signature creates two-party attestation — both the user and publisher must agree an impression occurred. This is the single most important trust-reduction step before mainnet.

**Architecture decision: verify in Relay, not Settlement.** DatumRelay already does `ecrecover` for user signatures and has 15,370 B PVM headroom. DatumSettlement has only 4,259 B spare and should remain focused on settlement math. The Relay becomes the attestation gateway — all signature verification happens there, Settlement stays clean.

For direct user submission (without relay), attestation is not enforced on-chain. This is the "degraded trust mode" — acceptable for MVP but flaggable by indexers/dashboards. Post-MVP: a separate `DatumAttestationVerifier` contract can wrap `settlement.settleClaims()` with publisher sig checks for direct submissions.

**Contract changes:**

*a) `IDatumSettlement.sol` — add `publisherSig` to `SignedClaimBatch`:*
- [x] Add `bytes publisherSig` field to `SignedClaimBatch` struct (publisher's attestation signature for the batch)
- [x] No changes to `Claim` struct or `ClaimBatch` — publisher sig is batch-level, not per-claim (one attestation covers the batch)

*b) `DatumRelay.sol` — verify publisher co-signature:*
- [x] Add `IDatumCampaignsSettlement` immutable reference; constructor takes `(address _settlement, address _campaigns)`
- [x] Define `PUBLISHER_ATTESTATION_TYPEHASH` for EIP-712: `PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,uint256 lastNonce,uint256 claimCount)` (no deadline — publisher attests impression facts, not relay timing)
- [x] In `settleClaimsFor()`, after verifying user signature: recover publisher signer from `publisherSig` using same EIP-712 domain
- [x] Verify recovered address matches campaign's registered publisher via `campaigns.getCampaignForSettlement(campaignId)`
- [x] New error codes: E33 (invalid publisher sig length), E34 (wrong publisher signer)
- [x] If `publisherSig` is empty (length 0): skip verification (degraded trust mode — backward compatible with existing tests until publishers deploy attestation endpoints)
- [x] PVM size impact: estimated ~1,200-1,500 B additional. DatumRelay at 33,782 B has 15,370 B spare — fits easily
- [x] Updated `scripts/deploy.ts`: `Relay(settlement, campaigns)` (was `Relay(settlement)`)
- [x] Updated extension `DatumRelay.json` ABI with new `publisherSig` field and `campaigns` getter
- [x] Updated extension `types.ts`: `SignedClaimBatch` gains `publisherSig: string` field
- [x] Updated extension `ClaimQueue.tsx`: `signForRelay()` passes `publisherSig: "0x"` (degraded trust mode)

*c) Tests:*
- [x] R7: relay with valid publisher co-signature settles normally (settledCount = 1)
- [x] R8: relay with publisher sig from wrong signer reverts E34
- [x] R9: relay with invalid publisher sig length reverts E33
- [x] R10: relay with tampered publisher signature reverts E34
- [x] Existing R1-R6 tests: pass empty `publisherSig: "0x"` — backward compatible
- [x] Integration test F: updated with `publisherSig: "0x"` and new relay constructor
- [x] All 58/58 tests pass on Hardhat EVM

**Extension changes (preparation for publishers who deploy attestation endpoints):**

*d) `extension/src/content/publisherAttestation.ts` (new):*
- [ ] `requestAttestation(campaignId, publisherAddress, userAddress, nonce, deadline)` — POST to `https://<publisher-domain>/.well-known/datum-attest`
- [ ] Publisher endpoint returns `{ signature }` — EIP-712 `PublisherAttestation` signed by publisher's wallet
- [ ] If endpoint returns 404/timeout: return empty bytes (degraded trust mode)
- [ ] Timeout: 3 seconds max — attestation failure must not block impression recording

*e) `extension/src/background/claimBuilder.ts`:*
- [ ] `ClaimData` type gains optional `publisherSig: string` field
- [ ] When building a relay batch (`signForRelay`), include `publisherSig` if available

*f) `extension/src/popup/ClaimQueue.tsx`:*
- [ ] Display attestation status per claim: "Attested" (has publisher sig) vs "Unattested"
- [ ] Tooltip: "Attested claims have been co-signed by the publisher, providing stronger fraud protection"

#### 2.22 — ZK verifier architecture (stub contract + test circuit)

**Rationale:** The `zkProof` field in the Claim struct is reserved but empty. A ZK verifier is too large for any existing contract (~30,000-80,000+ B PVM for a Groth16 verifier). It must be a separate contract. This step deploys a stub verifier and wires it to Settlement, proving the architecture works on PolkaVM without committing to a specific circuit.

**Architecture:** Three-phase approach to ZK integration:
1. **Phase 1 (this step):** Stub verifier contract + Settlement wiring. Proves the cross-contract call pattern works on PolkaVM. Stub always returns true.
2. **Phase 2 (post-MVP P9):** Real Groth16/PLONK verifier for second-price auction clearing proof. Requires P2 (auction mechanism) first.
3. **Phase 3 (research):** ZK impression proof. DOM state hashing in-circuit. Years from practical in-browser proving. Monitor browser TEE developments (Intel SGX in WebAssembly) as alternative.

**Contract changes:**

*a) New: `poc/contracts/DatumZKVerifier.sol` (stub):*
- [ ] Standalone contract, no inheritance
- [ ] `function verify(bytes calldata proof, bytes32 publicInputsHash) external pure returns (bool)` — returns `proof.length > 0` (stub: any non-empty proof passes)
- [ ] Immutable `version` field for future upgrade tracking
- [ ] PVM size: trivial (~2,000-5,000 B) — no size pressure

*b) Modified: `DatumSettlement.sol` — optional verifier call:*
- [ ] Add `address public zkVerifier` storage variable
- [ ] Add `setZKVerifier(address)` owner-only setter
- [ ] In `_validateClaim()`, after existing checks: if `zkVerifier != address(0) && claim.zkProof.length > 0`, call `DatumZKVerifier(zkVerifier).verify(claim.zkProof, claimHash)` — new error code E35 (ZK verification failed)
- [ ] If `zkVerifier == address(0)` or `claim.zkProof` is empty: skip (MVP behavior, backward compatible)
- [ ] PVM size impact: ~300-500 B (one external call + one address comparison + one length check). Settlement at 44,893 B has 4,259 B spare — fits

*c) Tests:*
- [ ] New test: settlement with stub verifier accepts claims with non-empty zkProof
- [ ] New test: settlement with stub verifier accepts claims with empty zkProof (backward compat)
- [ ] New test: settlement without verifier set ignores zkProof field entirely
- [ ] Existing tests: unaffected (zkProof is `"0x"` / empty in all existing claims)

#### Phase 2C gate criteria
- [ ] Interest profile accumulates across page visits and persists across browser restarts
- [ ] Campaign selection uses weighted random proportional to score (not `pool[0]`)
- [ ] Settings panel shows interest profile with category weights; reset clears all data
- [ ] Enhanced classifier assigns multi-category soft probabilities to pages
- [x] Publisher co-signature verified in DatumRelay when provided; empty sig accepted in degraded trust mode ← **contract + tests complete (2026-03-03)**; extension attestation endpoint (d/e/f) still pending
- [ ] Stub ZK verifier deployed and wired to Settlement; existing tests unaffected
- [x] All contract PVM bytecodes remain under 49,152 B limit
- [ ] Extension builds cleanly; publisher attestation failure does not block impression recording
- [ ] No user data leaves the browser at any point in the flow

---

## Phase 3 — Testnet Deployment

**Gate:** G3
**Estimated duration:** 1–2 weeks
**Prerequisite:** G2 must be passed

### Tasks

#### 3.1 — Choose testnet and acquire tokens
- [ ] Select network: Westend Hub (more stable) or Paseo (newer, closer to Polkadot Hub spec) — recommendation: Paseo
- [ ] Acquire testnet DOT via faucet for: deployer wallet, test advertiser wallet, test publisher wallet, test user wallet, test governance voter wallet (min 5 accounts)
- [ ] Verify pallet-revive is active on the chosen testnet (`system.pallets` includes `Contracts`)

#### 3.2 — Contract deployment
- [ ] Set `POLKADOT_HUB_RPC` env var to testnet RPC endpoint
- [ ] Set `DEPLOYER_PRIVATE_KEY` env var
- [ ] Run `npm run deploy:polkavm` — record all five deployed contract addresses
- [ ] Verify deployment: call `campaigns.minimumCpmFloor()`, `voting.activationThreshold()`, `settlement.campaigns()`, `campaigns.governanceContract()`, `campaigns.settlementContract()` — confirm all five contracts are wired correctly

#### 3.3 — Post-deployment configuration
- [ ] Set `activationThreshold` to a low value for testnet (e.g. `parseDOT("0.01")`) — makes governance votes easy during testing
- [ ] Set `terminationThreshold` similarly low
- [ ] Set `minReviewerStake` to `parseDOT("0.001")`
- [ ] Register test publisher account: `publishers.connect(publisher).registerPublisher(5000)`
- [ ] Update extension `contracts.ts` with testnet addresses and add testnet to network selector

#### 3.4 — End-to-end smoke test (scripted)
Write a `scripts/e2e-smoke.ts` script that performs the full flow programmatically:
- [ ] Advertiser creates campaign with `parseDOT("0.1")` budget
- [ ] Governance voter calls `voteAye` → campaign activates → verify status = Active
- [ ] User submits 3 claims via `settleClaims` → verify `settledCount = 3`
- [ ] Verify `settlement.publisherBalance(publisher)` > 0
- [ ] Publisher calls `withdrawPublisher()` → verify balance zeroed and tokens received
- [ ] Script prints pass/fail for each step

#### 3.5 — End-to-end smoke test (extension + real wallets)
- [ ] Install extension, configure to testnet RPC and contract addresses
- [ ] Connect test user wallet
- [ ] Browse to a page that matches campaign taxonomy — verify ad appears
- [ ] Manually submit claims via extension popup — verify result
- [ ] Check publisher panel shows balance — withdraw — verify

#### 3.6 — Fix testnet-specific issues
Common expected issues:
- [ ] Nonce mismatch under real block latency: extension submits, tx is pending, user generates another impression — handle by queuing claims and not rebuilding chain until tx confirms
- [ ] Gas estimation: `ethers` may underestimate gas for PVM contracts — add a fixed gas buffer or `gasLimit` override in `walletBridge.ts`
- [ ] Event indexing: `CampaignCreated` events may not be queryable without an indexer — fall back to polling by ID if `queryFilter` is unreliable on testnet
- [ ] Address encoding: pallet-revive uses SS58 addresses externally but H160 internally — verify wallet address derivation is consistent throughout

#### 3.7 — Hardcode cleanup
- [ ] No testnet-only addresses, private keys, or thresholds in committed code
- [ ] All network-specific values in `extension/shared/networks.ts` and `scripts/networks.ts`
- [ ] `.env.example` documents all required env vars

#### Gate G3 checklist
- [ ] `e2e-smoke.ts` script exits 0 on testnet
- [ ] Full extension E2E works with real wallets on testnet (documented with screenshots or a screen recording)
- [ ] No hardcoded test values in committed code
- [ ] Deployed contract addresses committed to `deployments/testnet.json`
- [ ] All contract owner calls (setters, thresholds) executed and verified on testnet

---

## Phase 4A — Kusama Deployment

**Gate:** G4-K
**Estimated duration:** 1–2 weeks
**Prerequisite:** G3 must be passed; at minimum 2 weeks of testnet stability (no critical failures)

### Tasks

#### 4.1 — Kusama-specific parameters
- [ ] Calculate production block counts (6s/block):
  - `PENDING_TIMEOUT_BLOCKS = 100800` (7 days)
  - `TAKE_RATE_UPDATE_DELAY = 14400` (24h)
  - `BASE_LOCKUP_BLOCKS = 14400` (24h)
  - `MAX_LOCKUP_DURATION = 5256000` (365 days)
- [ ] Set activation/termination thresholds appropriate for Kusama DOT values — start conservative (higher thresholds = harder to activate/terminate campaigns)
- [ ] Set `minimumCpmFloor` to a value that prevents dust campaigns

#### 4.2 — Multisig ownership
- [ ] Create a 2-of-3 multisig wallet using Polkadot.js or a compatible tool
- [ ] Deploy contracts with deployer wallet
- [ ] Transfer contract ownership to multisig for all five contracts: `publishers.transferOwnership(multisig)`, `campaigns.transferOwnership(multisig)`, `voting.transferOwnership(multisig)`, `rewards.transferOwnership(multisig)`, `settlement.transferOwnership(multisig)`
- [ ] Verify: all `onlyOwner` functions now require multisig approval

#### 4.3 — Deployment and verification
- [ ] Deploy to Kusama Hub via `npm run deploy:polkavm` with Kusama RPC
- [ ] Record addresses in `deployments/kusama.json`
- [ ] Run `e2e-smoke.ts` against Kusama — verify basic flow
- [ ] Update extension with Kusama network entry

#### 4.4 — Controlled launch
- [ ] Onboard at least one third-party advertiser (not the deployer) to create a real campaign
- [ ] Advertiser creates campaign; governance votes (at least 2 independent voters)
- [ ] Monitor: watch for unexpected revert patterns, gas exhaustion, claim submission failures
- [ ] Keep deployer wallet funded for emergency owner actions during initial period

#### Gate G4-K checklist
- [ ] Contracts deployed to Kusama Hub, addresses in `deployments/kusama.json`
- [ ] Ownership transferred to multisig — verified by attempting an `onlyOwner` call from deployer (must fail)
- [ ] At least one campaign created, activated, and settled by a third party (not deployer)
- [ ] No critical failures in first 72 hours of live operation

---

## Phase 4B — Polkadot Hub Mainnet

**Gate:** G4-P
**Estimated duration:** 1 week deployment + ongoing
**Prerequisite:** G4-K passed; minimum 2 weeks Kusama stability

### Tasks

#### 5.1 — Polkadot Hub deployment
- [ ] Deploy with same parameters as Kusama (adjust thresholds for Polkadot Hub DOT liquidity)
- [ ] Record addresses in `deployments/polkadot-hub.json`
- [ ] Transfer ownership to multisig (same or separate multisig from Kusama)
- [ ] Run `e2e-smoke.ts` against Polkadot Hub

#### 5.2 — Extension production build
- [ ] Update `networks.ts` with Polkadot Hub RPC and contract addresses
- [ ] Set Polkadot Hub as the default network
- [ ] Increment extension version to `1.0.0`
- [ ] Production build: `npm run build` — verify bundle size is within Chrome Web Store limits (< 10MB)
- [ ] Test production build in Chrome (not dev mode)

#### 5.3 — Chrome Web Store submission
- [ ] Create extension store listing: description, screenshots, privacy policy
- [ ] Privacy policy must address: what data is stored locally, what is submitted on-chain, no PII sent to any server
- [ ] Submit for review — Chrome review typically takes 1–7 days
- [ ] Respond to any review feedback

#### Gate G4-P checklist
- [ ] Contracts deployed to Polkadot Hub mainnet, addresses in `deployments/polkadot-hub.json`
- [ ] Extension version `1.0.0` published to Chrome Web Store
- [ ] `e2e-smoke.ts` passes on Polkadot Hub mainnet
- [ ] All deployment addresses and multisig addresses publicly documented

---

## Post-MVP Upgrade Track

After G4-P, the following items become the next development cycle. Organized into three tiers by criticality: items that must be resolved before the protocol can claim trustlessness (Tier 1), items that significantly improve decentralization (Tier 2), and items that complete the feature set (Tier 3).

### Tier 1 — Trust Assumption Removal (required for trustless operation)

These items address critical gaps where the MVP relies on trust in the extension code or the contract owner. Each is a prerequisite for the protocol to function as a credibly neutral marketplace.

#### P1. Impression attestation — advanced modes (beyond publisher co-signature)

**MVP scope (Phase 2C, step 2.21) — IMPLEMENTED (2026-03-03):** Publisher co-signature verification in DatumRelay. `SignedClaimBatch` carries optional `publisherSig` field. Relay verifies `PublisherAttestation` EIP-712 signature against the campaign's registered publisher (resolved via `campaigns.getCampaignForSettlement()`). Empty sig = degraded trust mode (backward compatible). 4 tests (R7-R10) validate co-signed settle, wrong signer, invalid length, and tampered sig. Remaining extension work: publisher attestation endpoint (`.well-known/datum-attest`), claim builder integration, and attestation status display in popup.

**Post-MVP enhancements:**

1. **Mandatory attestation mode:** Settlement rejects claims without publisher co-signature (no degraded trust mode). Requires all publishers to deploy attestation endpoints. Activate via governance vote.

2. **DatumAttestationVerifier contract:** For direct user submissions (not via relay), a wrapper contract that verifies publisher sigs before calling `settlement.settleClaims()`. Eliminates the direct-submission trust gap.

3. **TEE attestation:** Extension runs in a trusted execution environment (Intel SGX via WebAssembly). Impressions are signed with a hardware-backed key that cannot be extracted or spoofed. Requires browser TEE support to mature.

4. **ZK proof of DOM state:** Extension generates a ZK proof that specific ad content was rendered in a specific viewport at a specific time. Requires:
   - DOM snapshot hashing in-circuit (expensive)
   - CSS layout modeling in-circuit (to prove visibility)
   - In-browser prover: likely 30-120 seconds per proof (research-grade)
   - This is the "holy grail" but years from practical deployment

5. **Random oracle sampling:** A fraction of impressions are spot-checked by an independent oracle network. Oracle requests a screenshot or DOM hash from the extension at random intervals. Failed checks trigger slashing of the user's pending claims. Lower overhead than full ZK but introduces oracle trust.

#### P2. Clearing CPM auction mechanism

**Problem:** `clearingCpmPlanck` is set unilaterally by the claim submitter (extension hardcodes `bidCpmPlanck`). Every impression extracts max price. There is no market mechanism, no competitive pressure, no price discovery.

**Implementation plan:**

1. **Off-chain epoch auction (Phase 1):**
   - Define auction epochs (e.g., 1 hour or 2400 blocks on Polkadot Hub)
   - Within each epoch, the extension collects impressions but does not assign a clearing CPM
   - At epoch end, an off-chain aggregator collects all impression claims for each campaign and computes a clearing CPM using second-price logic: the clearing price is the highest bid that would still fill the available supply
   - The clearing CPM for the epoch is published (e.g., via an on-chain oracle or a signed message from the aggregator)
   - Claims submitted for that epoch must use the published clearing CPM

2. **Contract changes:**
   - Add `uint256 epochId` to the Claim struct
   - Add an oracle/aggregator role that can publish `epochClearingCpm[campaignId][epochId]`
   - `_validateClaim()` verifies `claim.clearingCpmPlanck == epochClearingCpm[campaignId][claim.epochId]`
   - Fallback: if no clearing price is published for an epoch, claims for that epoch use `bidCpmPlanck * discountBps / 10000` (e.g., 70% of bid)

3. **ZK proof of auction integrity (Phase 2):**
   - Custom ZK circuit that proves the clearing CPM was computed correctly from sealed bids
   - In-browser WASM prover generates proof; on-chain verifier validates
   - `zkProof` field in Claim struct (already reserved) carries the proof
   - Proving time target: < 5 seconds per batch in-browser (Groth16 or PLONK)

4. **Testing:**
   - Test: claims with incorrect epoch clearing CPM are rejected
   - Test: claims with correct epoch clearing CPM settle normally
   - Integration test: full epoch cycle with mock aggregator

#### P3. Admin timelock

**Problem:** `setSettlementContract()` and `setGovernanceContract()` on DatumCampaigns are callable by the owner immediately. A compromised owner key can redirect all funds with no warning.

**Implementation plan:**

1. **Contract changes — `DatumCampaigns.sol`:**
   - Add `pendingSettlement`, `pendingGovernance`, `pendingTimestamp` storage variables
   - `proposeSettlementContract(address)` / `proposeGovernanceContract(address)`: owner-only, sets pending + records `block.timestamp`
   - `applySettlementContract()` / `applyGovernanceContract()`: callable by anyone after 48-hour delay, applies the pending change
   - `cancelProposal()`: owner-only, cancels pending change
   - Emit `ContractChangeProposed(role, newAddress, effectiveTimestamp)` and `ContractChangeApplied(role, newAddress)` events
   - PVM size concern: adds ~3 storage slots and 4 small functions. May require removing another function or further size optimization. Consider a generic `proposeChange(uint8 role, address addr)` / `applyChange(uint8 role)` pattern to minimize function count

2. **Contract changes — `DatumSettlement.sol`:**
   - Same pattern for `setRelayContract()`
   - Same 48-hour delay

3. **Extension changes:**
   - `campaignPoller.ts`: monitor for `ContractChangeProposed` events; surface in popup as a warning ("Contract change proposed — funds may be at risk if you disagree")
   - `Settings.tsx`: show active proposals with countdown timer

4. **Testing:**
   - Test: immediate `apply` before delay reverts
   - Test: apply after delay succeeds
   - Test: cancel clears pending state
   - Test: old settlement/governance still works during delay period

#### P4. On-chain aye reward computation

**Problem:** `creditAyeReward()` is owner-only with no on-chain verification. Owner can allocate rewards arbitrarily. Slash rewards are correctly computed on-chain; aye rewards should follow the same pattern.

**Implementation plan:**

1. **Contract changes — `DatumGovernanceRewards.sol`:**
   - Add `distributeAyeRewards(uint256 campaignId)` public payable function (analogous to existing `distributeSlashRewards`)
   - Reads aye voter list from `voting.getAyeVoters(campaignId)`
   - For each aye voter who voted before `terminationBlock` (or all voters if campaign completed normally): compute proportional share weighted by `lockAmount * 2^conviction`
   - Set `_ayeClaimable[campaignId][voter] += share`
   - Remove or deprecate `creditAyeReward()` (keep as owner fallback during transition)
   - PVM size concern: this was originally removed because the voter-loop exceeded the 49,152 B limit. Mitigation options:
     - Batch processing: `distributeAyeRewards(campaignId, startIndex, count)` processes a slice of voters per call
     - Off-chain Merkle proof: compute shares off-chain, publish a Merkle root on-chain, voters claim with proof
     - Wait for resolc improvements / PVM limit increase

2. **Funding source:**
   - Define what funds the aye reward pool: recommend a percentage of `protocolFee` per settled claim, accumulated in a dedicated `ayeRewardPool` mapping per campaign
   - Alternative: the advertiser optionally funds a governance reward pool at campaign creation (separate from budget)

3. **Testing:**
   - Test: `distributeAyeRewards` allocates proportionally by conviction-weighted stake
   - Test: voters after terminationBlock receive nothing
   - Test: batch processing across multiple calls produces correct totals

### Tier 2 — Decentralization Improvements (significant trust reduction)

These items move the protocol from bilateral deals toward an open marketplace and improve user sovereignty.

#### P5. Multi-publisher campaigns

**Problem:** Each campaign is bound to a single publisher at creation. An advertiser wanting reach across N publishers needs N campaigns with N escrows. This is a bilateral deal system, not a permissionless marketplace.

**Implementation plan:**

1. **Contract changes — `DatumCampaigns.sol`:**
   - Remove `publisher` from `Campaign` struct (or make it `address(0)` to indicate "open")
   - Add `mapping(uint256 => mapping(address => bool)) private _campaignPublishers` — approved publisher set per campaign
   - `addPublisher(campaignId, publisher)` / `removePublisher(campaignId, publisher)` — advertiser-only
   - Alternative: open campaigns have no publisher allowlist; any registered publisher can serve them. Campaign specifies only `categoryId` and bid parameters
   - `snapshotTakeRateBps` moves from campaign creation to claim time: each claim's publisher payment uses that publisher's rate at the time of impression (or a snapshot at publisher opt-in)

2. **Contract changes — `DatumSettlement.sol`:**
   - `_validateClaim()`: verify `claim.publisher` is in the campaign's publisher set (or any registered publisher if open)
   - Revenue split uses the serving publisher's take rate, not a campaign-level snapshot
   - `publisherBalance` already per-publisher — no change needed

3. **Extension changes:**
   - `campaignPoller.ts`: campaigns no longer filter by publisher; match by category only
   - `content/adSlot.ts`: the serving publisher is the current page's publisher (detected from domain or meta tag)
   - `claimBuilder.ts`: `claim.publisher` is set to the page's publisher, not the campaign's publisher

4. **Migration:** Existing single-publisher campaigns continue to work (publisher set contains one address). New campaigns can be created as open.

5. **Testing:**
   - Test: open campaign accepts claims from any registered publisher
   - Test: restricted campaign rejects claims from unapproved publisher
   - Test: revenue split uses serving publisher's take rate

#### P6. Claim state portability

**Problem:** Pending claims exist only in `chrome.storage.local`. Clearing browser data destroys unsubmitted claims and the DOT they represent.

**Implementation plan:**

1. **Encrypted export/import (Phase 1):**
   - `ClaimQueue` tab in popup: add "Export Claims" button → encrypts claim queue state with a user-provided password or wallet signature → downloads as `.datum-claims` file
   - "Import Claims" button → decrypts and merges with current state
   - Encryption: AES-256-GCM with key derived from wallet signature of a fixed message (user doesn't need to remember a password)
   - Export format: JSON with `{ version, userAddress, chains: { [campaignId]: ClaimChainState }, queue: ClaimData[], exportTimestamp }`

2. **Deterministic recovery (Phase 2):**
   - Derive claim chain state deterministically from on-chain data + a user-held seed
   - On-chain: `lastNonce[user][campaignId]` is already stored — this is the recovery anchor
   - User seed: a BIP-39 mnemonic (separate from wallet mnemonic) that deterministically generates the hash chain from nonce 1 through lastNonce
   - `syncFromChain` already exists; extend it to reconstruct the full chain state from the seed + on-chain nonce

3. **Testing:**
   - Manual test: export claims, clear browser data, import claims, submit successfully
   - Unit test: export/import round-trip preserves claim chain integrity

#### P7. Contract upgrade path

**Problem:** Settlement holds real user balances with no migration function, no proxy, no emergency withdrawal. A bug or key loss permanently locks funds.

**Implementation plan:**

1. **Emergency withdrawal (Phase 1):**
   - Add `emergencyWithdraw()` to `DatumSettlement.sol`: callable only after a governance-approved timelock (e.g., 7-day delay after proposal)
   - Transfers all balances to a pre-registered recovery address (set at deployment, changeable via timelock)
   - This is a circuit breaker, not an upgrade mechanism

2. **Transparent proxy (Phase 2):**
   - Deploy Settlement behind an ERC-1967 transparent proxy
   - Admin (timelock-gated multisig) can upgrade the implementation contract
   - Storage layout must be carefully managed (append-only, no reordering)
   - PVM compatibility: verify that the proxy pattern works correctly on pallet-revive (delegate calls, storage slots)

3. **State migration (alternative to proxy):**
   - New contract reads balances from old contract via view functions
   - Users call `migrateBalance()` on the new contract, which pulls their balance from the old contract via an approved migration interface
   - Old contract has `approveMigration(newContract)` — owner-only with timelock

4. **Testing:**
   - Test: emergency withdrawal transfers correct balances
   - Test: proxy upgrade preserves storage state
   - Test: migration transfers balances correctly

### Tier 3 — Feature Completion (full marketplace functionality)

#### P8. Advanced governance game theory

**Problem:** MVP uses a simple 10% slash cap. More sophisticated models reduce griefing and improve governance quality.

**Implementation plan:**

1. **Symmetric risk (nay voters lose stake on failure):**
   - If a campaign that received nay votes completes successfully (budget exhausted or advertiser-completed), nay voters forfeit a percentage of their stake to the advertiser
   - Contract change: `resolveFailedNay` already tracks failed nays; extend to slash a portion of `lockAmount`
   - Percentage: governance parameter (e.g., 5% of nay stake on completion)

2. **Time-delayed termination:**
   - When nay threshold is crossed, campaign enters a "termination pending" state for N blocks (e.g., 14,400 = 24 hours)
   - During the delay, additional aye votes can be cast to counter the nay threshold
   - If aye weight exceeds nay weight at delay end, termination is cancelled
   - Contract change: new `CampaignStatus.TerminationPending` enum value; `terminateCampaign` becomes two-step

3. **Dispute bonds:**
   - Nay voters post an additional bond (separate from stake) that is forfeited if the campaign completes successfully
   - Bond amount: proportional to campaign remaining budget (e.g., 1% of remaining budget per nay voter)
   - If termination succeeds: bond returned. If campaign completes: bond distributed to advertiser

4. **Graduated slash:**
   - Slash percentage scales with evidence severity (governance parameter table):
     - Minor violation (content mismatch): 5% slash
     - Moderate violation (misleading claims): 10% slash (current default)
     - Severe violation (malware, illegal content): 25% slash
   - Requires on-chain evidence categorization (governance vote on severity, not just aye/nay)

#### P9. ZK proof of auction outcome

**Problem:** The `zkProof` field in the Claim struct is reserved but empty. Without it, clearing CPM cannot be verified on-chain.

**MVP foundation (Phase 2C, step 2.22):** Stub `DatumZKVerifier` contract deployed and wired to Settlement. Cross-contract `verify()` call pattern proven on PolkaVM. Stub accepts any non-empty proof.

**Post-MVP implementation:**

1. Replace stub with real Groth16/PLONK verifier generated by circom/snarkjs
2. Custom ZK circuit for second-price auction clearing: inputs are sealed bid commitments + revealed bids; output is clearing CPM
3. In-browser WASM prover (target: < 5s proving time per batch of 10-50 bids)
4. Verifier contract size: 3,000-8,000 bytes Solidity → 30,000-80,000+ B PVM. Deployed as standalone contract (already architected in step 2.22)
5. **Prerequisite:** P2 (auction mechanism) must be implemented first — the ZK proof proves integrity of something that must exist

#### P10. Decentralized KYB/KYC identity

T2/T3 identity tiers in settlement; per-advertiser and per-publisher credential verification. Candidate systems:
- **Polkadot Proof of Personhood (Project Individuality)** — Sybil-resistant identity primitive; ZK proofs only (no PII on-chain); good for user verification but may not cover business KYB
- **zkMe** — ZK identity oracles; FATF-compliant KYC/KYB/AML; cross-chain; full KYB with ZK proofs
- **Blockpass** — Web3 compliance suite with reusable on-chain KYC; less decentralized but production-ready
- **Recommendation:** zkMe for advertiser/publisher KYB (business verification); Polkadot PoP for user Sybil resistance (prevents fake impression farms)

#### P11. HydraDX XCM fee routing

Protocol fee accumulation → XCM send → HydraDX swap. Requires:
- XCM retry queue with idempotency keys and bounded retries
- Handling of partial failures (some swaps succeed, some fail)
- Recovery path for tokens stuck in sovereign account

#### P12. Viewability dispute mechanism

7-day challenge window; advertiser bonds 10% of payment; sampling audit via oracle or ZK verification; loser forfeits bond. Requires P1 (impression attestation) as a prerequisite — cannot dispute viewability of an impression that was never attested.

#### P13. Revenue split governance

Make the 75/25 user/protocol split a governance parameter. Requires on-chain governance mechanism (OpenGov integration or custom conviction vote). Change procedure: proposal → 7-day voting period → 48-hour enactment delay.

#### P14. Taxonomy on-chain governance

Conviction referendum for taxonomy changes. 7-day delay before enactment. Must define retroactive effect on active campaigns (campaigns keep their creation-time category; new taxonomy applies only to new campaigns).

#### P15. Campaign selection fairness

**Problem:** Content script always selects the first matching campaign (lowest ID). No rotation or bidding.

**MVP scope (Phase 2C):** Weighted random selection using local interest profile scores (bid CPM × interest weight × confidence). Implemented in steps 2.18–2.19. This eliminates the first-match bias and gives higher-bidding campaigns proportionally more impressions.

**Post-MVP enhancements:**

1. **On-device topic model (Phase 2):** Replace keyword/domain matching with a bundled lightweight topic classifier (quantized DistilBERT or TF-IDF + logistic regression, ~2-5 MB). Produces soft multi-category probabilities per page. Inference in Web Worker, < 50ms per page. Model is bundled (deterministic, auditable), not a remote API
2. **On-chain priority fee:** campaigns declare a priority fee; settlement validates priority fee was paid; extension factors priority into scoring
3. **Budget-aware rotation:** factor `remainingBudget` into scoring so campaigns near exhaustion naturally reduce their impression share

### Implementation order

The tiers define criticality but not strict ordering. Recommended sequencing based on dependencies:

```
P3 (admin timelock)          — no dependencies; smallest change; do first
P6 (claim portability)       — no dependencies; extension-only
P1 (impression attestation)  — foundational for P2, P9, P12
P4 (on-chain aye rewards)    — no dependencies; unlocks trustless governance
P5 (multi-publisher)         — architectural change; do before auction
P2 (clearing CPM auction)    — requires P1 (attestation) for meaningful price discovery
P7 (contract upgrade path)   — required before mainnet (G4-P gate)
P15 (campaign selection)     — extension-only; quick win
P8 (governance game theory)  — can be incremental (one model at a time)
P9 (ZK proof)                — requires P2 (auction) as prerequisite
P10 (KYB identity)           — independent track; external dependency
P11 (XCM fee routing)        — independent track; requires HydraDX integration
P12 (viewability disputes)   — requires P1 (attestation)
P13 (revenue split gov)      — requires governance framework
P14 (taxonomy governance)    — requires governance framework
```

---

## File Structure (end state after all phases)

```
/home/k/Documents/datum/
├── ref/                                   Spec documents
│   ├── DATUM-Architecture-Specification-v0.3.docx
│   └── DATUM-PoC-Compendium-v1.0.docx
├── poc/                                   Contracts + tests
│   ├── contracts/
│   │   ├── DatumCampaigns.sol             Campaign lifecycle + budget
│   │   ├── DatumPublishers.sol            Publisher registry + take rates
│   │   ├── DatumGovernanceVoting.sol      Voting + activation/termination
│   │   ├── DatumGovernanceRewards.sol     Rewards + stake withdrawal
│   │   ├── DatumSettlement.sol            Claim processing + payment split
│   │   ├── DatumRelay.sol                 EIP-712 user + publisher co-sig relay
│   │   ├── interfaces/
│   │   └── mocks/
│   ├── test/
│   ├── scripts/
│   │   ├── deploy.ts
│   │   ├── benchmark-gas.ts
│   │   ├── fund-wallet.ts               Sends DOT from Alith to any target address
│   │   ├── setup-test-campaign.ts       Creates + activates a test campaign
│   │   └── e2e-smoke.ts                 (Phase 3)
│   ├── deployments/                     Per-network deployed contract addresses
│   │   ├── local.json
│   │   └── README.md
│   ├── BENCHMARKS.md
│   └── hardhat.config.ts
├── extension/                             Browser extension (Phase 2)
│   ├── manifest.json                      MV3 manifest
│   ├── README.md                          Build, load, and config instructions
│   ├── package.json                       ethers v6, @polkadot/extension-dapp, webpack 5
│   ├── tsconfig.json                      strict, bundler moduleResolution
│   ├── webpack.config.ts                  4 entry points (background, content, popup, offscreen)
│   ├── scripts/copy-abis.js               Copies ABI JSON from poc/artifacts/
│   ├── icons/                             Placeholder PNGs (16/48/128)
│   ├── dist/                              Build output (gitignored)
│   └── src/
│       ├── background/
│       │   ├── index.ts                   Service worker: alarms, message routing, autoFlush
│       │   ├── campaignPoller.ts           5-min poll + IPFS metadata fetch (2.15)
│       │   ├── claimBuilder.ts            Hash chain state + claim construction
│       │   └── claimQueue.ts              Queue management + batch building
│       ├── content/
│       │   ├── index.ts                   Page classification + category-filtered matching
│       │   ├── taxonomy.ts                10-category keyword+domain classifier
│       │   └── adSlot.ts                  Creative-aware ad banner (2.17)
│       ├── offscreen/
│       │   ├── offscreen.html             Minimal HTML shell (wallet extensions inject here)
│       │   └── offscreen.ts               Auto-submit via offscreen document
│       ├── popup/
│       │   ├── index.html                 360px dark theme popup shell
│       │   ├── index.tsx                  React mount point
│       │   ├── App.tsx                    Tab router + wallet connect (web3Enable)
│       │   ├── CampaignList.tsx           Active campaigns with metadata display
│       │   ├── ClaimQueue.tsx             Pending claims + submit/relay + earnings estimate
│       │   ├── UserPanel.tsx              User balance (DOT) + withdrawUser()
│       │   ├── PublisherPanel.tsx          Balance + withdraw + campaign creation (2.16)
│       │   └── Settings.tsx               Network, RPC, addresses, IPFS gateway, auto-submit
│       └── shared/
│           ├── types.ts                   Claim, Campaign, CampaignMetadata, StoredSettings
│           ├── messages.ts                Typed message unions (Content↔Background↔Popup↔Offscreen)
│           ├── contracts.ts               ethers Contract factory functions (6 contracts)
│           ├── networks.ts                RPC URLs + contract address configs per network
│           ├── dot.ts                     parseDOT / formatDOT (planck denomination)
│           ├── ipfs.ts                    IPFS metadata upload + fetch helpers (2.16)
│           └── abis/                      6 ABI JSON files (copied from poc/artifacts/)
├── REVIEW.md
└── MVP.md                                 (this document)
```

---

## Key Technical Decisions (locked for MVP)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Denomination | Planck (10^10 per DOT) | Native PolkaVM path; no REVM scaling layer |
| Claim hash | `keccak256(abi.encodePacked(...))` — no zkProof in hash | zkProof is a carrier; changing the hash would break all existing chains |
| Wallet signing | User wallet via Polkadot.js/SubWallet + ethers BrowserProvider | Direct submit: `msg.sender == batch.user`; Relay: EIP-712 typed signature verified via `ecrecover` |
| Extension manifest | MV3 | Required for Chrome Web Store; service worker replaces background page |
| Extension bundler | Webpack 5 + webpack-target-webextension | Handles MV3 service worker chunk loading; NodePolyfillPlugin for ethers crypto |
| Extension signing context | Popup only (not service worker) | MV3 service workers have no `window`/DOM — wallet signing requires popup or offscreen document |
| Settlement caller | User direct (`DatumSettlement.settleClaims`) or publisher relay (`DatumRelay.settleClaimsFor` with EIP-712 signature) | Direct: user pays gas; Relay: publisher pays gas, user signs off-chain |
| clearingCpmPlanck | Equals bidCpmPlanck in MVP | No auction in MVP; ZK proof deferred |
| Batch size limit | MAX_CLAIMS_PER_BATCH = 5 | settleClaims scales 5.3x for 10 claims; enforced on-chain (E28) |
| Block time constants | 6s/block (Polkadot Hub) | 24h = 14,400 blocks; 7d = 100,800; 365d = 5,256,000 |
| PVM bytecode limit | < 48 KB per contract (EIP-3860) | resolc mode `z`; contracts split to fit |
| Contract count | 5+1 (was 3) | Split for PVM size: Campaigns, Publishers, GovernanceVoting, GovernanceRewards, Settlement + Relay |
| Settlement withdraw API | `withdrawPublisher()`, `withdrawUser()`, `withdrawProtocol(recipient)` via `_send()` | Single `transfer()` call site to work around resolc codegen bug |
| resolc optimizer | mode `z` (optimize for size) | mode `3` produces 40–47% larger bytecodes |
| Campaign metadata | Off-chain (IPFS CID via event, not storage) | DatumCampaigns has 1,108 B spare; `string` storage would bust PVM limit. Events cost ~200-400 B. |
| Campaign targeting | `uint8 categoryId` field in Campaign struct | Single byte maps to 10-category taxonomy; minimal PVM cost vs string categories |
| Creative hosting | IPFS with configurable gateway URL in extension | Decentralized hosting; no backend server; Pinata/web3.storage for pinning |
| Publisher SDK | Campaign creation + IPFS upload integrated in extension UI | MVP scope is extension-embedded "SDK simulation"; standalone SDK is post-MVP |

---

## Appendix: Failure Points & Missing Requirements Review

**Review date:** 2026-02-24
**Scope:** All contracts, interfaces, mocks, tests, REVIEW.md, and the MVP plan above

---

### A. Contract Bugs (fix before any deployment)

#### A1. `_voterFailedNays` is never incremented — graduated lockup is dead code

**Severity:** P0 — defeats Issue 10
**File:** `DatumGovernance.sol:65,192`

`_voterFailedNays[msg.sender]` is read in `voteNay()` but never written to anywhere in the codebase. The graduated nay lockup formula (`base * 2^conviction + base * 2^min(failedNays, 4)`) always uses `failedNays = 0`, so the graduated penalty term is always `base * 1`. A repeat nay abuser gets the same lockup as a first-time voter.

**Fix:** Define when a nay vote "fails" (campaign completes without termination), then increment `_voterFailedNays[voter]++` at that point. Requires either an explicit `resolveNayOutcome()` call or automatic detection when a campaign reaches Completed status.

#### A2. Zero-payment claims are accepted

**Severity:** P0 — allows hash chain pollution
**File:** `DatumSettlement.sol:_validateClaim()`

`_validateClaim()` does not check `impressionCount > 0` or `totalPayment > 0`. A user can submit claims with `impressionCount = 0` that pass all validation (valid hash chain, valid nonce, valid CPM), settle with `totalPayment = 0`, and advance their nonce indefinitely. This pollutes the hash chain and inflates `settledCount` without economic activity.

**Fix:** Add to `_validateClaim()`:
```solidity
if (claim.impressionCount == 0) return (false, "Zero impressions");
```

#### A3. `_settleSingleClaim` reads campaign twice from storage

**Severity:** P3 — gas waste, not a correctness bug
**File:** `DatumSettlement.sol:174`

`_settleSingleClaim()` calls `campaigns.getCampaign(claim.campaignId)` again even though `_validateClaim()` already read the same campaign. This is a redundant cross-contract call (~2,600 gas each on EVM, potentially more on PVM).

**Fix:** Refactor to pass `Campaign memory c` from `_validateClaim` into `_settleSingleClaim` instead of re-fetching.

#### A4. `ClaimBatch` allows mixed campaignIds within a single batch

**Severity:** P2 — causes silent rejection of legitimate claims
**File:** `IDatumSettlement.sol:22-25`

Each `Claim` carries its own `campaignId`, but `ClaimBatch` has no campaign-level field. A batch spanning multiple campaigns would trigger the stop-on-gap behavior incorrectly: a "gap" in campaign B would cause claims for campaign A to be rejected too.

**Fix:** Either:
- Enforce `require(claim.campaignId == batch.claims[0].campaignId)` for all claims
- Or add a `campaignId` field to `ClaimBatch` and validate consistency

#### A5. `dailyClaimCount` is tracked but never enforced

**Severity:** P2 — dead state costing gas per claim
**File:** `DatumSettlement.sol:54,192`

`_dailyClaimCount[user][campaignId][today]++` is incremented in every `_settleSingleClaim()` call but nothing reads or enforces a limit. This is wasted gas on every settled claim.

**Fix:** Either add a `maxDailyClaimsPerUser` enforcement check, or remove the mapping and the increment entirely.

---

### B. Denomination Residue (leftover ETH/Wei references)

#### B1. IDatumGovernance.sol still says "ETH staked (wei)"

**File:** `IDatumGovernance.sol:21,32`

- Line 21: `lockAmount` comment says `// ETH staked (wei)` — should be `// DOT staked (planck)`
- Line 32: `ayeRewardPool` comment says `// ETH pool accrued for aye rewards` — should be `// DOT (planck) pool accrued for aye rewards`

#### B2. MockCampaigns.sol has three ETH references

**File:** `MockCampaigns.sol:181,184,196`

- Line 181: `// Forward ETH to settlement contract`
- Line 184: `"ETH forward to settlement failed"`
- Line 196: `// Allow receiving ETH`

#### B3. REVIEW.md has 15+ ETH/Wei references

**File:** `REVIEW.md:37,53,57,61,62,88,93,128,133,272-280,295`

The entire "ETH Flow Architecture" section (lines 272–280), the revenue formula code blocks, Issue 2 code blocks, Issue 6 code blocks, and several inline references still use `clearingCpmWei`, `bidCpmWei`, and "ETH". This document should reflect the planck denomination consistently.

---

### C. Missing Contract Features for MVP

#### C1. No campaign metadata (creative URL, taxonomy, description) — **ADDRESSED in Phase 2B (2.13–2.17)**

**Severity:** P2 — blocks extension ad display
**Affects:** Phase 2 tasks 2.4, 2.5

The `Campaign` struct has financial fields only — no `creativeUrl`, `taxonomyId`, `description`, or any metadata the extension needs to decide what ad to show. Phase 2 task 2.5 assumes campaigns have taxonomy/category data, but the contract stores nothing matchable.

**Resolution:** Hybrid approach — `uint8 categoryId` stored on-chain (minimal PVM cost), plus `CampaignMetadataSet` event with IPFS CID for rich metadata (creative text, description, CTA). See Phase 2B tasks 2.13-2.17 for implementation plan. Event-based metadata avoids storage bloat while providing on-chain commitment (event logs are immutable).

#### C2. No upgradeability — contracts are immutable after deployment

**Severity:** P3 — acceptable risk for testnet, significant risk for mainnet

All five contracts are plain `Ownable` with no proxy pattern. Once deployed to Kusama/Polkadot Hub, any bug requires full redeployment plus state migration (all active campaigns, governance votes, and pull-payment balances would be lost or require manual migration).

**Options:**
1. Add UUPS proxy pattern (`OpenZeppelin UUPSUpgradeable`) before testnet deployment
2. Accept the risk — standard for early MVPs, but document it explicitly
3. Use a factory pattern where state is in a separate storage contract

#### C3. No global pause / circuit breaker

**Severity:** P1 — needed before any mainnet deployment

If a critical bug is discovered post-deployment, there is no way to freeze all contract activity. `DatumCampaigns` has per-campaign pause, but nothing stops new campaign creation or new claim settlement on any existing campaign.

**Fix:** Add `Pausable` from OpenZeppelin to all five contracts. Owner (or multisig) can call `pause()` to freeze all state-mutating functions globally. Add `whenNotPaused` modifier to all external mutating functions. **Note:** Pausable was removed during 1.1c PVM size reduction. Restoring it requires ~2-4 KB per contract. May need further size optimization or a separate `DatumPauseRegistry` contract.

#### C4. No efficient campaign discovery mechanism

**Severity:** P2 — affects extension performance
**Affects:** Phase 2 task 2.4

`getCampaign(uint256 id)` requires knowing the ID. The extension plan says "poll IDs 1..N" which is O(N) RPC calls per poll. For 100 campaigns, that's 100 calls every 5 minutes.

**Fix options:**
1. Use `CampaignCreated` event filtering via `queryFilter` as the primary discovery mechanism (already emitted; no contract change needed)
2. Add `getActiveCampaignIds()` view function (gas-expensive for large sets but fine for view calls)
3. Build a minimal indexer (over-engineered for MVP)

The event approach is available today — the plan should explicitly specify it as the primary mechanism, with ID polling as fallback.

#### C5. No on-chain user claim rate limit

**Severity:** P2 — abuse vector

The `dailyClaimCount` mapping (see A5) is tracked but not enforced. A malicious user could submit thousands of 1-impression claims per day up to the daily cap budget limit, inflating gas costs on the campaign's budget deduction path and polluting event logs.

---

### D. MVP Plan Gaps

#### D1. Extension campaign discovery strategy not specified

**Affects:** Phase 2 task 2.4

Task 2.4 says "call `campaigns.getCampaign(id)` for IDs 1..N" but doesn't address how new campaign IDs are discovered or the O(N) cost. The plan should specify `CampaignCreated` event log filtering as the primary mechanism, with `nextCampaignId()` polling as fallback.

#### D2. No campaign metadata delivery mechanism defined — **ADDRESSED in Phase 2B (2.13–2.17)**

**Affects:** Phase 2 tasks 2.4, 2.5

The plan assumes campaigns have taxonomy/category data (task 2.5 matches pages against it) but doesn't define where that data comes from. No contract field, no off-chain service, no IPFS mechanism. This blocks ad display entirely.

**Resolution:** Hybrid approach implemented in Phase 2B:
- `uint8 categoryId` on-chain for targeting (2.14)
- `CampaignMetadataSet` event with IPFS CID for creative metadata (2.13)
- Extension fetches metadata from IPFS gateway and caches locally (2.15)
- Publisher creates campaigns + uploads metadata via extension UI (2.16)
- Ad slot renders creative content from metadata (2.17)

#### D3. Extension wallet bridge assumes EVM-compatible JSON-RPC availability

**Affects:** Phase 2 task 2.2

Task 2.2 says "wrap as `ethers.Signer` using `ethers.BrowserProvider` against pallet-revive EVM-compatible RPC". This only works if the target node exposes `eth_*` RPC methods. For pallet-revive this should be the case, but the plan has no verification step and no fallback to `@polkadot/api` if the EVM RPC is unavailable or incomplete.

#### D4. No plan for populating test campaign data on testnet

**Affects:** Phase 3 tasks 3.4, 3.5

Phase 3 says "register test publisher" and "create campaign", but doesn't address campaign creative content, taxonomy targeting, or how the test user's browsing will match a campaign. The E2E test needs a pre-seeded campaign targeting specific test URLs.

#### D5. Auto-submit / manual-submit race condition

**Affects:** Phase 2 tasks 2.7, 2.8

If the user clicks manual submit while auto-submit is in flight, both will try to submit overlapping claim queues. Two `settleClaims` transactions with the same nonces would cause the second to fail (nonce mismatch), potentially corrupting the local chain state.

**Fix:** Add a submission mutex in the background script — a `submitting: boolean` flag in storage that blocks both manual and auto triggers until the in-flight transaction confirms or fails.

#### D6. No user withdrawal in the extension

**Affects:** Phase 2

The extension has a publisher withdrawal panel (task 2.9) but no user withdrawal panel. Users earn 75% of the remainder via `settlement.userBalance(user)`, but the extension provides no way to claim it. The user would have to use Polkadot.js Apps directly.

**Fix:** Add a `UserPanel.tsx` popup tab showing `settlement.userBalance(address)` and a "Withdraw" button calling `settlement.withdrawUser()`.

#### D7. Phase 1 duration estimate may be too aggressive

**Affects:** Phase 1 schedule

The plan allocates 1–2 weeks for Phase 1, but substrate-contracts-node testing involves more than replacing `hardhat_mine`. The ethers.js provider connecting to a substrate node via EVM RPC has non-trivial integration issues: nonce management, gas estimation differences, transaction receipt format, and potentially different event log behavior. 2–3 weeks is more realistic.

#### D8. Kusama Asset Hub block time should be verified

**Affects:** Phase 4A task 4.1

Task 4.1 uses 6s/block for all calculations. Polkadot Hub uses 6s, but Kusama Asset Hub's parachain block time should be verified independently — it may differ.

#### D9. No monitoring or alerting plan for mainnet

**Affects:** Phase 4A, 4B

Phase 4 says "monitor" but doesn't specify how. At minimum, mainnet deployment needs:
- A script that polls campaign count, settlement balances, governance vote counts on a schedule
- Alerting on unexpected revert patterns (watch for high-frequency `ClaimRejected` events)
- Contract DOT balance reconciliation (expected vs. actual)

#### D10. G4-K "third-party advertiser" gate is unrealistic

**Affects:** Phase 4A gate

Getting a third-party advertiser to use an unaudited, freshly-deployed system with real money is an extremely high bar for a gate criterion. Consider relaxing this to: "at least one campaign fully cycled (create → activate → settle → complete) by a non-deployer test account funded separately."

---

### E. Security Concerns for Mainnet

#### E1. No security audit step in the plan

The plan has no audit between G4-K (Kusama) and G4-P (Polkadot Hub mainnet). For Kusama, this is arguably acceptable ("canary network"). For Polkadot Hub with real money, this is a significant gap.

**Fix:** Add an audit gate between G4-K and G4-P: either a formal third-party audit, or at minimum a documented self-audit using a standard checklist (SWC registry, Slither, Aderyn, manual review).

#### E2. `abi.encodePacked` hash collision safety (verified safe)

`computeClaimHash` uses `abi.encodePacked` which can produce collisions when mixing dynamic types. However, all parameters are fixed-width (`uint256`, `address`, `bytes32`), so collisions are not possible. **Safe as-is**, but should be documented in the code for future maintainers.

#### E3. Single-EOA ownership from deployment through early Kusama

From deployment through all of testnet and into early Kusama, the contract owner (who controls `setSettlementContract`, `setGovernanceContract`, `setMinimumCpmFloor`, etc.) is a single EOA. A compromised owner key can redirect settlement to a malicious contract and drain all escrowed campaign funds.

**Fix:** Transfer to multisig immediately after deployment on Kusama (before any real campaigns), not as a later optional step. Make this a hard requirement in the G4-K gate.

---

### G. PVM Bytecode Size — Contracts Exceed pallet-revive Limits

**Discovered:** 2026-02-24
**Severity:** P0 — blocks all substrate deployment (Phase 1.2 and beyond)
**Reference:** [Polkadot Forum: Bytecode Size Limits & Workarounds](https://forum.polkadot.network/t/lessons-from-building-a-complex-dapp-on-polkadot-asset-hub-with-resolc-bytecode-size-limits-workarounds/17100)

#### G0. Root cause

resolc v0.3.0 compiles Solidity to PolkaVM (RISC-V) bytecode at a 10–20x size ratio vs EVM. Each 256-bit EVM operation (SLOAD, SSTORE, keccak256) expands to 50–80 RISC-V instructions. This is a known property of the compiler, not a bug.

Two limits block deployment:
1. **Client-side:** `micro-eth-signer` (bundled with Hardhat) enforces EIP-3860 `maxInitDataSize = 49,152 bytes`. Deploy transactions with larger initcode are rejected before reaching the chain.
2. **Chain-side:** pallet-revive enforces the same 48 KB initcode limit on-chain.

#### G1. Current bytecode sizes

Measured with resolc v0.3.0 (`@parity/resolc` npm), Solidity 0.8.24, `viaIR: true`:

| Contract | EVM | PVM mode=3 | PVM mode=z | Limit | Over by |
|---|---|---|---|---|---|
| DatumCampaigns | 7.3 KB | 102 KB | **59 KB** | 48 KB | 1.2x |
| DatumGovernance | 8.6 KB | 168 KB | **89 KB** | 48 KB | **1.8x** |
| DatumSettlement | 5.7 KB | 90 KB | **56 KB** | 48 KB | 1.1x |
| MockCampaigns | 4.6 KB | 81 KB | ~48 KB | 48 KB | ~1.0x |

LLVM optimization mode `z` (optimize for size) cuts 40–47% vs mode `3` (optimize for speed). Mode `s` gives negligible improvement. **All contracts still exceed 48 KB even at mode `z`.**

#### G2. Required fix: switch resolc optimizer to mode `z`

**File:** `hardhat.config.ts:25`
**Change:** `parameters: "3"` → `parameters: "z"`

This is a prerequisite for all splits below — it reduces the starting point and may push MockCampaigns under the limit without any code changes.

#### G3. Required fix: split DatumGovernance (89 KB → two contracts < 48 KB each)

**Target:** ~45 KB + ~44 KB

**Split into: `DatumGovernanceVoting` + `DatumGovernanceRewards`**

**DatumGovernanceVoting** (the "hot path" — called during campaign lifecycle):
- `voteAye()` — aye voting, activation trigger
- `voteNay()` — nay voting, termination trigger, calls `_distributeSlashRewards()`
- `_distributeSlashRewards()` — populates nay claimable mappings at termination time
- `_convictionMultiplier()`, `_computeNayLockup()` — pure helpers
- `receive()` — receives slash DOT from DatumCampaigns
- All state: `_voteRecords`, `_campaignVotes`, `_nayVoters`, `_ayeVoters`, `_voterFailedNays`, `_slashPool`, `_nayClaimable` (written during slash distribution)
- Config: `activationThreshold`, `terminationThreshold`, `minReviewerStake`, `baseLockupBlocks`, `maxLockupDuration`
- Admin setters for above config
- Views: `getVoteRecord()`, `getCampaignVote()`, `voterFailedNays()`
- Cross-contract ref: `IDatumCampaigns campaigns`

**DatumGovernanceRewards** (the "withdrawal path" — called after campaigns end):
- `claimAyeReward()` — withdraw aye reward after lockup
- `claimSlashReward()` — withdraw nay slash reward after lockup
- `withdrawStake()` — withdraw principal stake after lockup
- `distributeAyeRewards()` — set up aye reward pool (called post-campaign)
- `resolveFailedNay()` — increment failed nay count
- Cross-contract refs: `IDatumCampaigns campaigns`, `DatumGovernanceVoting voting` (reads VoteRecords, CampaignVote, nayClaimable, ayeVoters)

**Shared state access pattern:**
- VoteRecords are written by Voting, read by Rewards. Two options:
  - **(A) Voting exposes view functions** (`getVoteRecord`, `getNayClaimable`, `getAyeVoters`) and Rewards calls them cross-contract. Simplest; adds cross-contract call overhead per withdrawal but withdrawals are infrequent.
  - **(B) Shared storage contract** holding VoteRecords with write access from Voting and read access from Rewards. More complex; unnecessary for MVP volumes.
- **Recommendation: option A.** Rewards reads VoteRecords via Voting's existing view functions. `_nayClaimable` and `_ayeClaimable` mappings stay in their respective contract (nay claimable in Voting since it's written at slash time; aye claimable in Rewards since it's written in `distributeAyeRewards`).

**Interface change:** Split `IDatumGovernance` into `IDatumGovernanceVoting` and `IDatumGovernanceRewards`. Voting emits vote/activation/termination events. Rewards emits claim/withdraw events.

**Wiring change:** `DatumCampaigns.governanceContract` must point to the Voting contract (it calls `activateCampaign` / `terminateCampaign`). Rewards contract gets a `setVotingContract(address)` setter.

**Test changes:** `governance.test.ts` splits into `governance-voting.test.ts` and `governance-rewards.test.ts`. Integration tests deploy both and wire them.

#### G4. Required fix: split DatumCampaigns (59 KB → two contracts < 48 KB each)

**Target:** ~35 KB + ~24 KB

**Split into: `DatumCampaigns` (core) + `DatumPublishers`**

**DatumPublishers** (publisher registry — independent state):
- `registerPublisher()` — creates publisher record
- `updateTakeRate()` — queues take rate change
- `applyTakeRateUpdate()` — applies after delay
- `getPublisher()` — view
- State: `mapping(address => Publisher) _publishers`
- Config: `takeRateUpdateDelayBlocks`
- Constants: `MIN_TAKE_RATE_BPS`, `MAX_TAKE_RATE_BPS`

**DatumCampaigns** (core — campaign lifecycle + budget):
- `createCampaign()` — reads publisher via `DatumPublishers.getPublisher()` for snapshot
- `activateCampaign()`, `pauseCampaign()`, `resumeCampaign()`, `completeCampaign()`, `terminateCampaign()`, `expirePendingCampaign()`
- `deductBudget()` — settlement calls this
- `getCampaign()`, `nextCampaignId()` — views
- State: `mapping(uint256 => Campaign) _campaigns`, `nextCampaignId`
- Config: `minimumCpmFloor`, `pendingTimeoutBlocks`
- Cross-contract refs: `settlementContract`, `governanceContract`, `DatumPublishers publishers`

**Why this split works:** Publisher management is a fully separate concern. The `_publishers` mapping is never read during settlement or governance — only at `createCampaign()` time (to snapshot the take rate). The cross-contract read (`publishers.getPublisher(addr)`) happens once per campaign creation, which is infrequent.

**Interface change:** Split `IDatumCampaigns` into `IDatumCampaigns` (keeps campaign lifecycle + views) and `IDatumPublishers` (publisher management + views). The `Publisher` struct and publisher events move to `IDatumPublishers`.

**Wiring change:** DatumCampaigns constructor takes `address _publishers`. `createCampaign()` calls `publishers.getPublisher(publisher)` instead of reading from local `_publishers`.

**MockCampaigns update:** MockCampaigns may also need splitting or at minimum the mock publisher logic extracted. Alternatively, MockCampaigns can keep both inline since it's only used in tests — but verify its PVM size stays under 48 KB after the split.

#### G5. Required fix: reduce DatumSettlement (56 KB → under 48 KB)

**Target:** < 48 KB. Only 8 KB over — can likely be achieved without a full split.

**Approach (try in order, stop when under 48 KB):**

1. **Remove `computeClaimHash` from the contract.** It's `public pure` — used for on-chain verification inside `_validateClaim()`, but the same computation can be inlined. The public accessor adds ABI encoding/decoding overhead for 7 parameters. Instead: keep the `keccak256(abi.encodePacked(...))` inline in `_validateClaim()` only; remove the standalone function. Extension and tests compute the hash off-chain using ethers.js `solidityPackedKeccak256`. Saves ~3–5 KB of ABI stub + call encoding bytecode.

2. **Split withdrawals into DatumPayments.** If step 1 is insufficient:
   - **DatumPayments:** `withdrawPublisherPayment()`, `withdrawUserPayment()`, `withdrawProtocolFee()`, `receive()`, balance views. Holds `_publisherBalance`, `_userBalance`, `_protocolBalance` mappings.
   - **DatumSettlement:** `settleClaims()`, `_processBatch()`, `_validateClaim()`, `_settleSingleClaim()`. After computing the 3-way split, calls `DatumPayments.credit(publisher, user, pubAmt, userAmt, protocolAmt)` instead of writing local mappings.
   - This is a larger refactor. Only do it if step 1 + mode `z` is not enough.

3. **If still over:** Convert `string reason` in `ClaimRejected` event to `uint8 reasonCode`. String literals in events are expensive in PVM — each unique string adds ABI encoding overhead. Use an enum: `0=ZeroImpressions, 1=CampaignNotFound, 2=NotActive, 3=PublisherMismatch, 4=CpmExceedsBid, 5=NonceGap, 6=BadGenesisHash, 7=BadPrevHash, 8=BadClaimHash, 9=InsufficientBudget, 10=CampaignIdMismatch, 11=SubsequentToGap`.

#### G6. micro-eth-signer initcode limit bypass

Even after splitting, the `micro-eth-signer` library in Hardhat enforces a client-side 49,152-byte initcode check. If any split contract is still close to 48 KB, this may need patching.

**Options (try in order):**
1. **postinstall patch:** Add a `postinstall` script that patches `node_modules/micro-eth-signer/src/utils.ts` to raise `maxInitDataSize` to 65536 (or remove the check). Use `patch-package` for reproducibility.
2. **Deploy via `@polkadot/api` directly:** Use the substrate `Contracts.instantiateWithCode` extrinsic to deploy PVM blobs, bypassing ethers/micro-eth-signer entirely. Then interact with the deployed contracts via the eth-rpc adapter for tests.
3. **Upgrade Hardhat:** Future Hardhat versions may ship a `micro-eth-signer` that respects pallet-revive's actual limits. Check before implementing options 1–2.

**Note:** Option 1 is only needed if the chain's actual limit differs from EIP-3860. If pallet-revive also enforces 48 KB, there's no point raising the client limit — the contracts must genuinely fit.

---

### F. Priority-Ordered Fix List

Items marked ~~strikethrough~~ are already implemented in the current codebase (58/58 tests pass).

| Priority | Item | Fix Phase | Effort |
|----------|------|-----------|--------|
| **P0** | ~~A1: `_voterFailedNays` never incremented~~ | ~~Pre-G1~~ | ~~Done~~ |
| **P0** | ~~A2: Zero-impression claims accepted~~ | ~~Pre-G1~~ | ~~Done~~ |
| **P0** | G2: Switch resolc optimizer to mode `z` | Pre-G1 | 5 min (config change) |
| **P0** | G3: Split DatumGovernance into Voting + Rewards | Pre-G1 | 4–6 hours (split + interface + rewire + tests) |
| **P0** | G4: Split DatumCampaigns into Campaigns + Publishers | Pre-G1 | 3–4 hours (split + interface + rewire + tests) |
| **P0** | G5: Reduce DatumSettlement under 48 KB | Pre-G1 | 1–3 hours (inline hash, possibly split payments) |
| **P0** | G6: Resolve micro-eth-signer initcode limit if needed | Pre-G1 | 30 min–2 hours |
| **P1** | ~~C3: No global pause / circuit breaker~~ | ~~Pre-G3~~ | ~~Done~~ |
| **P1** | ~~B1–B3: ETH/Wei remnants in contracts~~ | ~~Pre-G1~~ | ~~Done~~ |
| **P1** | D6: Extension missing user withdrawal tab | Phase 2 | 2 hours |
| **P1** | D5: Auto/manual submit race condition | Phase 2 | 1 hour |
| **P2** | C1: No campaign metadata mechanism | Pre-G2 | Design decision + 2–4 hours |
| **P2** | D2: No metadata delivery to extension | Phase 2 | Depends on C1 decision |
| **P2** | C4: Campaign discovery is O(N) polling | Phase 2 | 2 hours (event-based approach) |
| **P2** | ~~A4: Mixed campaignIds in a batch~~ | ~~Pre-G1~~ | ~~Done~~ |
| **P2** | ~~A5: Dead `dailyClaimCount` state~~ | ~~Pre-G1~~ | ~~Done~~ |
| **P2** | D1: Event indexing for campaign discovery | Phase 2 plan update | Plan clarification only |
| **P3** | ~~A3: Redundant `getCampaign` in settlement~~ | ~~Pre-G1~~ | ~~Done~~ |
| **P3** | C2: No upgradeability | Pre-G3 | 4–8 hours (UUPS pattern) |
| **P3** | E1: No audit step before mainnet | Phase 4 plan update | Plan addition only |
| **P3** | D9: No monitoring plan | Phase 4 plan update | Plan addition only |
| **P3** | D10: G4-K third-party gate too ambitious | Plan update | Gate criteria revision only |
| **P3** | D7: Phase 1 duration estimate | Plan update | Estimate revision only |
| **P3** | D8: Kusama block time verification | Phase 4A | Verification task only |
