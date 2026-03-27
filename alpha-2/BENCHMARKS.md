# DATUM Alpha-2 — Gas Benchmarks

Measured 2026-03-26 on local devchain. 13-contract architecture, resolc 1.0.0.

---

## Environment

| Item | Value |
|------|-------|
| Contracts | 13 (PauseRegistry, Timelock, ZKVerifier, Publishers, BudgetLedger, PaymentVault, Campaigns, CampaignLifecycle, Settlement, GovernanceV2, GovernanceSlash, Relay, AttestationVerifier) |
| Compiler | resolc 1.0.0, optimizer `z` |
| Hardhat | 2.22, Solidity 0.8.24 |

### PVM (pallet-revive devchain)

| Item | Value |
|------|-------|
| Chain | pallet-revive local dev node |
| chainId | 420420420 |
| gasPrice | 1,000 planck/weight-unit |
| Claim hash | **keccak256 fallback** — 0x900 precompile not deployed on local devchain. Production (Paseo/mainnet) uses Blake2-256 via `ISystem(0x900).hashBlake256()` which adds per-claim overhead (precompile staticcall). |

### EVM (Hardhat)

| Item | Value |
|------|-------|
| Chain | Hardhat EVM |
| chainId | 31337 |
| gasPrice | 1,875,000,000 |
| Claim hash | keccak256 |

---

## Main Operations

### PVM

| Function | gasUsed (weight) | Est. DOT |
|----------|-----------------|----------|
| `createCampaign` | 3,030,696,337,012,500 | ~0.303 |
| `vote (aye)` | 2,651,044,910,986,666 | ~0.265 |
| `vote (nay)` | 2,651,265,398,433,333 | ~0.265 |
| `settleClaims (1 claim)` | 7,852,761,168,640,000 | ~0.785 |
| `settleClaims (5 claims)` | 22,827,464,703,137,500 | ~2.283 |
| `withdrawUser` | 1,459,600,050,506,666 | ~0.146 |
| `withdrawPublisher` | 1,459,600,783,190,833 | ~0.146 |

1 DOT = 10^10 planck. Est. DOT = gasUsed × gasPrice / 10^10.

### EVM

| Function | gasUsed |
|----------|--------|
| `createCampaign` | 266,756 |
| `vote (aye)` | 128,332 |
| `vote (nay)` | 150,576 |
| `settleClaims (1 claim)` | 262,474 |
| `settleClaims (5 claims)` | 328,769 |
| `withdrawUser` | 35,090 |
| `withdrawPublisher` | 34,958 |

---

## Batch Scaling — settleClaims (1-50 claims)

Tested with `MAX_CLAIMS_PER_BATCH` temporarily raised from 5 to 50. Each batch size uses a fresh campaign + nonce chain. Budget set high enough to avoid exhaustion at all sizes.

### PVM

| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 | Est. DOT |
|------------|----------|---------------|--------------|----------|
| 1 | 7,852,697,142,467,500 | 7,852,697,142,467,500 | 1.00x | ~0.785 |
| 5 | 22,827,375,689,849,166 | 4,565,475,137,969,833 | 2.91x | ~2.283 |
| 10 | 41,547,109,665,135,833 | 4,154,710,966,513,583 | 5.29x | ~4.155 |
| 15 | 60,244,652,722,418,333 | 4,016,310,181,494,555 | 7.67x | ~6.024 |
| 20 | 78,986,574,459,294,166 | 3,949,328,722,964,708 | 10.06x | ~7.899 |
| 25 | 97,692,449,069,000,000 | 3,907,697,962,760,000 | 12.44x | ~9.769 |
| 30 | 116,389,989,714,935,000 | 3,879,666,323,831,166 | 14.82x | ~11.639 |
| 40 | 153,873,827,721,711,666 | 3,846,845,693,042,791 | 19.60x | ~15.387 |
| 50 | 191,268,907,969,190,000 | 3,825,378,159,383,800 | 24.36x | ~19.127 |

**PVM scaling analysis:**
- Fixed overhead per tx: ~4.11 × 10^15 (~52% of single-claim cost)
- Marginal cost per additional claim: ~3.74 × 10^15
- Per-claim cost converges toward ~3.83 × 10^15 at high batch sizes
- Efficiency gain at batch 5: **41.9% per-claim savings**
- Efficiency gain at batch 20: **49.7% per-claim savings**
- Efficiency gain at batch 50: **51.3% per-claim savings**
- **Scaling is strongly sub-linear and nearly perfectly linear in the marginal region** — each additional claim adds a near-constant ~3.74 × 10^15 weight

### EVM

| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 |
|------------|----------|---------------|--------------|
| 1 | 245,362 | 245,362 | 1.00x |
| 5 | 328,793 | 65,758 | 1.34x |
| 10 | 475,942 | 47,594 | 1.94x |
| 15 | 623,198 | 41,546 | 2.54x |
| 20 | 770,611 | 38,530 | 3.14x |
| 25 | 918,095 | 36,723 | 3.74x |
| 30 | 1,065,698 | 35,523 | 4.34x |
| 40 | 1,361,300 | 34,032 | 5.55x |
| 50 | 1,657,309 | 33,146 | 6.75x |

**EVM scaling analysis:**
- Fixed overhead per tx: ~216,547 (~88% of single-claim cost)
- Marginal cost per additional claim: ~28,815
- Efficiency gain at batch 50: **86.5% per-claim savings**
- EVM is even more sub-linear than PVM due to lower relative per-claim cost (no cross-contract call overhead)

---

## Comparison: Alpha (9 contracts) vs Alpha-2 (13 contracts)

| Operation | Alpha PVM (9c) | Alpha-2 PVM (13c) | Delta |
|-----------|---------------|-------------------|-------|
| `createCampaign` | 2.66 × 10^15 | 3.03 × 10^15 | +14% |
| `vote (aye)` | 2.30 × 10^15 | 2.65 × 10^15 | +15% |
| `settleClaims (1)` | 7.84 × 10^15 | 7.85 × 10^15 | ~0% |
| `settleClaims (10)` | 4.15 × 10^16 | 4.15 × 10^16 | ~0% |
| Scaling (5/1) | — | 2.91x | — |
| Scaling (10/1) | 5.30x | 5.29x | ~0% |
| `withdrawPublisher` | 1.47 × 10^15 | 1.46 × 10^15 | ~0% |

**Notes:**
- `createCampaign` is 14% more expensive in alpha-2 due to cross-contract `BudgetLedger.initializeBudget{value}` call.
- `vote` is 15% more expensive, likely from additional contract state lookups post-restructuring.
- `settleClaims` per-claim cost is **nearly identical** despite alpha-2 adding 4 cross-contract calls per claim (BudgetLedger, PaymentVault, Publishers blocklist, campaign lookup). The lighter Settlement bytecode (satellites extracted) offsets the call overhead.
- Batch scaling pattern is identical: 10 claims at 5.29x (alpha-2) vs 5.30x (alpha). The satellite architecture does not degrade scaling.
- Withdrawals unchanged — PaymentVault is a simple storage read + native transfer.

---

## Findings & Recommendations

### 1. Sub-linear scaling confirmed to 50 claims

Scaling is strongly sub-linear on both PVM and EVM, with diminishing returns above ~20 claims. The per-claim cost curve flattens:

| Batch Size | PVM Per-Claim (× 10^15) | Savings vs 1 |
|------------|------------------------|--------------|
| 1 | 7.85 | — |
| 5 | 4.57 | 41.9% |
| 10 | 4.15 | 47.1% |
| 20 | 3.95 | 49.7% |
| 50 | 3.83 | 51.3% |

The curve asymptotes near **3.74 × 10^15** (the marginal cost). Going from 20→50 saves only 3.1% more per claim.

### 2. Batch cap set to 50

`MAX_CLAIMS_PER_BATCH` raised from 5 to 50 for Paseo deployment.
- **50 claims = ~19.1 DOT on devchain.** Well under block gas limit (~0.37% of ~5.2 × 10^19 block capacity).
- **51.3% per-claim savings** — maximum achievable with current architecture.
- Marginal cost nearly flat above 20 claims — users can batch as many as practical.
- Extension and relay can submit smaller batches if desired (1-50 range fully supported).

### 3. Blake2-256 precompile (confirmed on Paseo)

The Paseo benchmarks (see section below) confirm real-world costs with the Blake2-256 precompile. Per-claim marginal cost on Paseo: **~6,070 gas** vs devchain's **~3.74 × 10^15 weight** (different unit scales due to gasPrice differences between devchain and Paseo eth-rpc adapter).

### 4. PVM vs EVM cost ratio

| Operation | PVM/EVM Ratio |
|-----------|--------------|
| `createCampaign` | 11,362x |
| `settleClaims (1)` | 29,918x |
| `withdrawPublisher` | 41,744x |

PVM weight units and EVM gas are not directly comparable (1 PVM weight ≈ 1 picosecond of computation), but the ratios show PVM's cross-contract call overhead is proportionally much larger than EVM's CALL opcode.

---

## Paseo Testnet Benchmarks

Measured 2026-03-27 on Paseo (Chain ID 420420417). 13 deployed contracts, resolc 1.0.0, Blake2-256 claim hashing via `ISystem(0x900).hashBlake256()` precompile.

### Environment

| Item | Value |
|------|-------|
| Chain | Paseo testnet |
| chainId | 420420417 |
| gasPrice | 1,000,000,000,000 (eth-rpc 18-decimal) |
| Claim hash | **Blake2-256** via ISystem(0x900) precompile |
| Cost formula | DOT = gas × gasPrice / 10^18 |

### Main Operations

| Function | Gas (weight) | Cost (DOT) | Cost (USD @$5) |
|----------|-------------|-----------|---------------|
| `createCampaign` | 234,197 | 0.234197 | $1.17 |
| `vote (aye)` | 106,479 | 0.106479 | $0.53 |
| `evaluateCampaign (activate)` | 3,740 | 0.003740 | $0.02 |
| `settleClaims (1 claim)` | 50,461 | 0.050461 | $0.25 |
| `settleClaims (5 claims)` | 74,745 | 0.074745 | $0.37 |

Settlement scale: 5-claim / 1-claim = 1.48x. Per-claim cost in 5-batch: 0.015 DOT vs single: 0.050 DOT.

**Note:** `withdrawUser` and `withdrawPublisher` hit E58 (dust guard) at test-scale earnings (~0.003 DOT per 5-claim batch). The existential deposit on Paseo requires a minimum withdrawal balance. Withdraw benchmarks require higher CPM or more accumulated claims.

### Batch Scaling (settleClaims)

| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 | Cost (DOT) | Per-Claim DOT |
|------------|----------|---------------|--------------|------------|---------------|
| 1 | 50,461 | 50,461 | 1.00x | 0.050461 | 0.050461 |
| 2 | 56,531 | 28,265 | 1.12x | 0.056531 | 0.028265 |
| 3 | 62,601 | 20,867 | 1.24x | 0.062601 | 0.020867 |
| 5 | 74,745 | 14,949 | 1.48x | 0.074745 | 0.014949 |
| 10 | 105,094 | 10,509 | 2.08x | 0.105094 | 0.010509 |
| 15+ | FAILED | — | — | — | proof_size limit |

**Scaling analysis:**
- Fixed overhead (tx + 1st claim): ~50,461 gas
- Marginal cost per additional claim: ~6,070 gas
- Estimated fixed overhead: ~44,391 gas
- Efficiency gain at batch 10: **79.2% per-claim savings**

**Paseo proof_size limit:**
Batches ≥15 fail with `proof_size` exceeding the per-transaction limit (7,549,747 bytes). Each claim adds ~507,551 bytes of proof_size. The practical cap on Paseo is **10-12 claims per batch**, not the contract's 50-claim limit. This is a runtime constraint, not a contract limitation — it may change as pallet-revive evolves.

| Batch Size | proof_size (needed) | proof_size (allowed) | Status |
|------------|-------------------|---------------------|--------|
| 10 | ~5,069,551 | 7,549,747 | OK |
| 15 | 7,752,461 | 7,549,747 | FAIL (+202,714 over) |
| 20 | 10,287,011 | 7,549,747 | FAIL |
| 50 | 25,494,311 | 7,549,747 | FAIL |

### Paseo vs Devchain Comparison

| Operation | Devchain PVM (gas) | Paseo (gas) | Notes |
|-----------|-------------------|-------------|-------|
| `createCampaign` | 3.03 × 10^15 | 234,197 | Different gasPrice scales |
| `vote (aye)` | 2.65 × 10^15 | 106,479 | |
| `settleClaims (1)` | 7.85 × 10^15 | 50,461 | Paseo uses Blake2-256 |
| `settleClaims (10)` | 4.15 × 10^16 | 105,094 | |
| Scaling (5/1) | 2.91x | 1.48x | Paseo more efficient |
| Scaling (10/1) | 5.29x | 2.08x | Paseo more efficient |
| Marginal/claim | 3.74 × 10^15 | ~6,070 | |
| Batch cap (practical) | 50 | ~10-12 | proof_size constraint |

**Key differences:**
- Paseo's gas numbers are much smaller due to the eth-rpc adapter's gasPrice conversion (devchain: gasPrice=1000, Paseo: gasPrice=10^12).
- Batch scaling is more efficient on Paseo (1.48x for 5-batch vs 2.91x on devchain) — the Blake2 precompile appears lighter than expected.
- **The practical batch limit on Paseo is 10-12 claims** due to proof_size constraints, not the 50-claim contract cap. The relay and extension should limit batches accordingly.

---

## Reproducing

```bash
cd alpha-2

# Hardhat EVM (fast, ~30s)
npx hardhat run scripts/benchmark-gas.ts

# PVM devchain (slow, ~25 min for full 1-50 scaling)
# Requires running substrate + eth-rpc Docker containers on ports 9944/8545
npx hardhat run scripts/benchmark-gas.ts --network substrate

# Paseo testnet (uses deployed contracts, ~5 min)
# Requires funded test accounts (Alice + Bob + Diana + Frank + Hank)
DEPLOYER_PRIVATE_KEY="0x..." \
TESTNET_ACCOUNTS="bob_key,diana_key,frank_key,hank_key" \
npx hardhat run scripts/benchmark-testnet.ts --network polkadotTestnet
```
