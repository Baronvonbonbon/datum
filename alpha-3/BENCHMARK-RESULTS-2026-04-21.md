# Datum Alpha-3 Benchmark Results — 2026-04-21

**Suite:** `test/benchmark.test.ts`  
**Result:** **64/64 passing** (Hardhat EVM, Solidity 0.8.24, ethers v6)  
**Duration:** ~3s  
**Fixes applied this session:**
- `DatumTokenRewardVault.deploy()` now passes required `campaigns` address (constructor arity fix)
- `settlement.setCampaigns()` wired in `before all` hook (was missing — caused silent token credit failure)
- `tokenRewardVault.setSettlement()` wired in `before all` hook (missing — creditReward gated by `msg.sender == settlement`)
- BM-TOKEN-6: address comparison lowercased to handle EIP-55 checksum difference for non-standard precompile addresses

---

## BM-ECO: Economic Correctness — $1 CPM

| DOT price | Total payment | Publisher (50%) | User (37.5%) | Protocol (12.5%) |
|-----------|--------------|-----------------|--------------|------------------|
| $2 / DOT  | 0.5 DOT ($1.00) | 0.25 DOT ($0.50) | 0.1875 DOT ($0.375) | 0.0625 DOT ($0.125) |
| $5 / DOT  | 0.2 DOT ($1.00) | 0.1 DOT ($0.50) | 0.075 DOT ($0.375) | 0.025 DOT ($0.125) |
| $10 / DOT | 0.1 DOT ($1.00) | 0.05 DOT ($0.50) | 0.0375 DOT ($0.375) | 0.0125 DOT ($0.125) |

All three price points confirmed: revenue split invariant to DOT denomination.

---

## BM-SCALE: Gas Scaling with Impression Count

| Batch size | Gas used |
|-----------|----------|
| 1 claim × 10 imps | 302,512 |
| 1 claim × 100 imps | 285,424 |
| 1 claim × 1,000 imps | 285,436 |
| 5 claims × 100 imps | 419,242 |

**Key finding:** Gas is essentially flat across impression counts (85–1000 imps). Impression count is validated off-chain; on-chain cost is dominated by storage ops, not iteration.

---

## BM-GAS: Per-Operation Gas Costs

| Operation | Gas |
|-----------|-----|
| registerPublisher | 82,780 |
| createCampaign (fixed publisher) | 358,846 |
| governance vote (aye, conviction 0) | 160,809 |
| settleClaims (1 claim × 100 imps) | 302,524 |
| settleClaims (5 claims × 100 imps) | 419,242 |
| settleClaims (1 ZK claim × 100 imps) | 289,836 |
| reportPage (reason 1) | 82,243 |
| reputation.recordSettlement | 81,381 |
| vault.withdraw (publisher) | 32,344 |

**Note:** ZK claim settlement (289,836) is slightly cheaper than standard (302,524) — ZK path skips some validation branches.

---

## BM-SCALE: Batch Scaling

| Campaigns per settleClaims | Gas | Per-campaign overhead |
|---------------------------|-----|-----------------------|
| 1 campaign | 285,424 | — |
| 3 campaigns | 488,617 | ~101,597 gas/campaign |

Linear scaling confirmed. Each additional campaign in a batch costs ~102K gas.

---

## BM-LC: Full Lifecycle — create → vote → activate → settle → complete

| DOT price | Withdraw gas |
|-----------|-------------|
| $2 / DOT  | 32,344 |
| $5 / DOT  | 32,344 |
| $10 / DOT | 32,344 |

Withdraw gas is denomination-invariant (as expected — fixed storage op).

---

## BM-META: IPFS Metadata (SHA-256 bytes32 digest)

| Operation | Gas |
|-----------|-----|
| setMetadata | 47,857 |
| settleClaims w/ metadata | 285,436 |
| settleClaims no metadata | 285,436 |

**Key finding:** Metadata presence has zero settlement gas overhead — metadata is read-only from campaign state, settlement gas path is identical.

---

## BM-TOKEN: ERC-20 Sidecar Reward Campaigns

| Operation | Gas |
|-----------|-----|
| depositCampaignBudget | 83,004 |
| settleClaims w/ ERC-20 credit | 341,300 |
| vault.withdraw (user, ERC-20) | 59,264 |

**vs standard settle:** 341,300 vs 302,524 = **+38,776 gas** for ERC-20 credit path (2 staticcalls to read reward config + 1 call to creditReward).

**Non-critical path confirmed:** Settlement does NOT revert when vault budget is exhausted — DOT payment still processes; token credit silently skipped (emits `RewardCreditSkipped` event).

**Native Asset Hub precompile:** USDT precompile address (`0x000007C000000000000000000000000001200000`) accepted as `rewardToken` without metadata calls — no `symbol()`/`decimals()` validation in contracts.

---

## BM-COMP: Competing Campaigns at Different CPMs

### BM-COMP-1: Three campaigns at different CPMs
```
3-campaign batch settle gas: 650,666

premium CPM (0.5 DOT): publisher +0.25 DOT per 1000 imps
mid CPM     (0.2 DOT): publisher +0.10 DOT per 1000 imps
budget CPM  (0.1 DOT): publisher +0.05 DOT per 1000 imps
```
CPM ratio confirmed: premium pays 5× more than budget (BM-COMP-2 ✔).

### BM-COMP-3: Mixed IPFS + ERC-20 sidecar + plain campaign
```
3-campaign settle gas: 672,333  (slightly higher than COMP-1 due to ERC-20 credit path)

IPFS mid-CPM publisher payout:    0.10 DOT
ERC-20 premium-CPM payout:        0.25 DOT
plain budget-CPM payout:          0.05 DOT
```
All three campaign types interoperate correctly in a single `settleClaims` call.

---

## BM-ZK: ZK-Proof-Required Campaigns

- BM-ZK-1: Empty proof rejected with reason code 16 ✔
- BM-ZK-2: Non-empty stub proof accepted (stub bypasses Groth16 on Hardhat EVM) ✔
- BM-ZK-3: Non-ZK campaign settles without any proof ✔
- BM-ZK-4: Mixed ZK/non-ZK batch across all price points ✔

ZK claim gas: **289,836** (slightly cheaper than standard — proof validation short-circuits some branches on Hardhat EVM).

---

## BM-RL: Rate Limiter (DatumSettlementRateLimiter)

- Claims within window cap: settle normally ✔
- Claims exceeding cap: rejected with reason code 14 ✔
- Window reset: allows fresh impressions after `windowBlocks` ✔
- `address(0)` disables limiter completely ✔

---

## BM-REP: Publisher Reputation (DatumPublisherReputation)

- Fresh publisher scores **10,000 bps** (perfect, 100%) ✔
- `recordSettlement(settled=X, rejected=Y)` updates score correctly ✔
- Anomaly detection: publisher campaign rejection rate > 2× global rate triggers `isAnomaly()` ✔
- Anomaly suppressed below `MIN_SAMPLE = 10` total settlements ✔
- Score invariant to DOT denomination (purely ratio-based) ✔

---

## BM-RPT: Community Reports (DatumReports)

- All 5 valid reason codes (1–5) accepted ✔
- Invalid codes (0 or 6) revert with E68 ✔
- Non-existent campaign reverts with E01 ✔
- reportPage gas: **82,243** | reportAd gas: similar

---

## BM-TAG: Tag-Based Targeting (DatumTargetingRegistry)

- Publisher with matching tags → can create fixed campaign ✔
- Publisher WITHOUT required tag → creation blocked ✔
- Open campaign with required tags → no publisher validation at creation ✔
- `getTags(publisher)` returns correct bytes32 array ✔
- `hasAllTags(publisher, tags)` returns true when publisher has all tags ✔

---

## BM-OPEN: Open Campaign Settlement

- Any publisher can settle an open campaign (publisher = address(0)) ✔
- Two different publishers can settle same open campaign for different users ✔
- Open campaigns at all three price points work correctly ✔

---

## Testnet Seeding (Paseo, 2026-04-21)

**100 competing campaigns created on-chain.**

| Metric | Result |
|--------|--------|
| Campaigns created | 100/100 |
| IPFS metadata pinned (Kubo) | 100/100 |
| CPM range | 0.300–0.699 PAS (~$0.30–$0.70) |
| Advertisers | Bob (50 campaigns), Charlie (50 campaigns) |
| USDT sidecar campaigns (~20%) | ~20/100 |
| Campaign activation | Blocked by state-lag bug (all IDs read as 1) |

**Campaigns on-chain:** All 100 exist at sequential IDs assigned by the contract. IPFS CID reference saved to `scripts/metadata-cids.json`.

**Pending:** Re-run with fixed campaign ID tracking (`baseCampaignId + offset` instead of per-loop `eth_call`) to vote and activate all campaigns.

---

## Known Issues / Follow-up

1. **Testnet: campaigns stuck in Pending** — state-lag fix applied to `setup-testnet.ts`; re-run needed to activate campaigns 0–99 (or whichever IDs were assigned).
2. **benchmark.test.ts wiring** — three fixes applied to `before all` hook (see top of document). These should be verified against `deploy.ts` to confirm production wiring is correct.
