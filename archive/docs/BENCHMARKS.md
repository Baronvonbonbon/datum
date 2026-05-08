# DATUM Benchmarks — Gas Costs & Economics

**Last updated:** 2026-04-17  
**Source data:** `alpha-3/benchmark-paseo-results.txt` (2026-04-08, 21 contracts, live Paseo txs) + `alpha-3/BENCHMARKS.md` (batch-scaling runs, 2026-04-03)  
**Network:** Paseo testnet — pallet-revive / PolkaVM, gasPrice = 10¹² wei/gas → `fee_PAS = gas / 1,000,000`  
**Denomination:** 1 DOT = 1 PAS = 10¹⁰ planck = 10¹⁸ wei (eth-rpc). All fees in PAS unless noted.

---

## 1. Transaction Cost Summary

### 1a. Gas by operation (measured 2026-04-08, 21-contract alpha-3)

| Operation | Gas | PAS fee | $5/DOT | $10/DOT |
|---|---:|---:|---:|---:|
| **Campaign lifecycle** | | | | |
| `createCampaign` (open, no publisher) | 254,560 | 0.254560 | $1.27 | $2.55 |
| `createCampaign` (targeted, publisher set) | 361,908 | 0.361908 | $1.81 | $3.62 |
| `createCampaign` (targeted + requireZkProof) | 382,729 | 0.382729 | $1.91 | $3.83 |
| `setMetadata` | 1,806 | 0.001806 | $0.009 | $0.018 |
| `togglePause` | 1,988 | 0.001988 | $0.010 | $0.020 |
| **Settlement (relay pays — not user)** | | | | |
| `settleClaims` — 1-claim batch | 71,634 | 0.071634 | $0.358 | $0.717 |
| `settleClaims` — 3-claim batch | 84,839 | 0.084839 | $0.424 | $0.848 |
| `settleClaims` — 5-claim batch | 98,043 | 0.098043 | $0.490 | $0.980 |
| `settleClaims` — 7-claim batch | 111,248 | 0.111248 | $0.556 | $1.112 |
| *Per-claim marginal cost (5–7 batch)* | *~6,602* | *0.006602* | *$0.033* | *$0.066* |
| **Withdrawals (user/publisher pays)** | | | | |
| `withdrawPublisher` | 1,568 | 0.001568 | $0.008 | $0.016 |
| `withdrawUser` (estimated ≈ publisher) | ~1,568 | ~0.001568 | ~$0.008 | ~$0.016 |
| `withdrawProtocol` | 1,829 | 0.001829 | $0.009 | $0.018 |
| **Publisher/registry** | | | | |
| `setTags` (1 tag) | 26,486 | 0.026486 | $0.132 | $0.265 |
| `setTags` (8 tags, campaign max) | 114,625 | 0.114625 | $0.573 | $1.146 |
| `blockAddress` / `unblockAddress` | 22,347 | 0.022347 | $0.112 | $0.223 |
| `registerSdkVersion` | 22,627 | 0.022627 | $0.113 | $0.226 |
| `setRelaySigner` | 2,078 | 0.002078 | $0.010 | $0.021 |
| `setProfile` | 1,987 | 0.001987 | $0.010 | $0.020 |
| **ZK / reporting / governance** | | | | |
| `ZKVerifier.verify` (real Groth16 proof) | 4,740 | 0.004740 | $0.024 | $0.047 |
| `Reputation.recordSettlement` | 43,834 | 0.043834 | $0.219 | $0.438 |
| `reportPage` | 2,998 | 0.002998 | $0.015 | $0.030 |
| `reportAd` | 2,361 | 0.002361 | $0.012 | $0.024 |
| `Timelock.propose` | 64,177 | 0.064177 | $0.321 | $0.642 |
| `RateLimiter.checkAndIncrement` | 22,346 | 0.022346 | $0.112 | $0.223 |

View functions (read-only calls) are free to callers. RPC latency: 200–700 ms per call.

---

### 1b. Mean & median transaction cost

Computed across all 43 measured state-changing function calls from the 2026-04-08 run:

| Statistic | Gas | PAS fee | $5/DOT | $10/DOT |
|---|---:|---:|---:|---:|
| **Mean (all ops)** | 34,079 | 0.034079 | $0.170 | $0.341 |
| **Median (all ops)** | 1,926 | 0.001926 | $0.010 | $0.019 |
| **Mean (user-facing only)** ¹ | 4,099 | 0.004099 | $0.020 | $0.041 |
| **Mean (relay-facing, per-claim at batch-7)** | 15,893 | 0.015893 | $0.079 | $0.159 |

¹ User-facing: `withdrawUser`, `withdrawPublisher`, `reportPage`, `reportAd`, `setProfile`, `setRelaySigner`.

The mean is pulled up by `createCampaign` (254K–383K gas). The median reflects typical day-to-day operations (config setters: ~1,500–2,000 gas). **The withdrawal cost is at the low end of the distribution — ~1,568 gas — making it cheap to claim rewards.**

---

## 2. Settlement Economics

Split at **50% publisher take rate** (5,000 bps). Tested live on Paseo, 100 impressions per claim:

| DOT price assumption | Bid CPM (PAS/1000) | Per 100-imp gross | Publisher (50%) | User (37.5%) | Protocol (12.5%) |
|---|---:|---:|---:|---:|---:|
| $2/DOT | 0.500 | 0.0500 PAS | 0.02500 PAS | 0.01875 PAS | 0.00625 PAS |
| $5/DOT | 0.200 | 0.0200 PAS | 0.01000 PAS | 0.00750 PAS | 0.00250 PAS |
| $10/DOT | 0.100 | 0.0100 PAS | 0.00500 PAS | 0.00375 PAS | 0.00125 PAS |

All three ECO tests settled at ~$1.00 USD CPM (the bid CPM was adjusted to maintain constant USD value). Relay confirmation: 11–14 s per settlement (1–2 blocks).

**Split formula (50% take rate):**

```
gross         = bidCpmPlanck × impressions / 1000
publisher     = gross × takeRate        (50%)
remainder     = gross × (1 - takeRate)  (50%)
user          = remainder × 75%         → 37.5% of gross
protocol      = remainder × 25%         → 12.5% of gross
```

---

## 3. Break-Even Analysis

### 3a. User withdrawal break-even

The user only pays gas once — to call `withdrawUser` and claim their accumulated balance.

```
withdrawUser cost ≈ 0.001568 PAS

Minimum impressions for net-positive withdrawal:
  impressions_min = (0.001568 × 1000) / (0.375 × CPM_PAS)
                  = 4.181 / CPM_PAS
```

| CPM (PAS/1000) | USD @ $5/DOT | USD @ $10/DOT | Min impressions to net positive |
|---:|---:|---:|---:|
| 0.050 | $0.25 | $0.50 | 84 |
| 0.100 | $0.50 | $1.00 | 42 |
| 0.200 | $1.00 | $2.00 | 21 |
| 0.500 | $2.50 | $5.00 | 9 |
| 1.000 | $5.00 | $10.00 | 5 |

**The withdrawal gas is negligible vs any realistic CPM.** A user who receives even a single batch of 42 impressions at $0.50 CPM covers their withdrawal cost. In practice, balances are swept far less frequently — break-even happens after the first active session at any standard CPM.

### 3b. Relay (publisher) break-even

The relay bot pays `settleClaims` gas. The publisher receives 50% of the bid CPM.

```
relay_gas_per_impression = settleClaims_gas / (batch_claims × imps_per_claim)
publisher_share_per_impression = 0.5 × CPM_PAS / 1000

Break-even: publisher_share_per_impression > relay_gas_per_impression
  CPM_min = relay_gas_per_impression × 1000 / 0.5
          = relay_gas_per_impression × 2000
```

| Batch config | Relay gas/impression | Break-even CPM (PAS) | Break-even CPM @ $5/DOT | Break-even CPM @ $10/DOT |
|---|---:|---:|---:|---:|
| 1 claim × 100 imps | 0.000716 PAS | 1.433 PAS/1000 | $7.17 | $14.33 |
| 7 claims × 100 imps | 0.000159 PAS | 0.318 PAS/1000 | $1.59 | $3.18 |
| 1 claim × 1000 imps | 0.0000716 PAS | 0.143 PAS/1000 | $0.72 | $1.43 |
| 7 claims × 1000 imps | 0.0000159 PAS | 0.032 PAS/1000 | $0.16 | $0.32 |

**Key insight:** the relay MUST batch aggressively. Settling 1 claim of 100 impressions is not economical below ~$7 CPM. At 7 claims × 1000 impressions per batch (7,000 impressions/tx), break-even drops to $0.16–0.32 CPM — well below standard display rates.

---

## 4. Recommended Base CPM

Based on the analysis above, targeting net-positive economics for all parties:

| Scenario | Recommended CPM (PAS/1000) | USD @ $5/DOT | USD @ $10/DOT | Notes |
|---|---:|---:|---:|---|
| **Minimum floor** | 0.100 | $0.50 | $1.00 | Relay must batch ≥5 claims × 1000 imps to break even |
| **Recommended default** | 0.500 | $2.50 | $5.00 | Comfortable margin at 7-claim × 100-imp batches |
| **Competitive display** | 0.200–0.400 | $1.00–$2.00 | $2.00–$4.00 | Matches programmatic display CPM benchmarks |
| **Premium / ZK-required** | 1.000+ | $5.00+ | $10.00+ | ZK proof overhead (~0.005 PAS) absorbed at this range |

### Payout per impression (at recommended 0.500 PAS/1000 CPM, 50% take rate)

| Recipient | Per 1000 impressions | Per 100 impressions | Per impression |
|---|---:|---:|---:|
| Publisher | 0.250 PAS | 0.0250 PAS | 0.00025 PAS |
| **User** | **0.1875 PAS** | **0.01875 PAS** | **0.0001875 PAS** |
| Protocol | 0.0625 PAS | 0.00625 PAS | 0.0000625 PAS |
| **Gross** | **0.500 PAS** | **0.0500 PAS** | **0.000500 PAS** |

USD equivalent (0.500 PAS/1000 CPM):
- @ $5/DOT: user earns **$0.9375 per 1000 impressions** ($0.00094/imp)
- @ $10/DOT: user earns **$1.875 per 1000 impressions** ($0.00188/imp)

### Minimum CPM for relay profitability (recommended config: 7 claims × 100 imps)

```
CPM_min_relay = 0.318 PAS/1000 ≈ 0.32 PAS/1000
```

At the recommended 0.500 PAS/1000 CPM with this config, relay earns:
```
publisher_share  = 0.5 × 0.500 / 1000 × 100 imps   = 0.025 PAS per batch
relay_gas        = 111,248 gas / 1e6                 = 0.111 PAS per 7-claim batch

Net relay margin (per batch of 7 × 100 = 700 imps):
  publisher_share × 7 - relay_gas = 0.175 - 0.111 = +0.064 PAS per tx
```

**The relay is profitable at 0.500 PAS/1000 CPM with 7-claim × 100-imp batches.**  
Higher impression counts per claim or larger batch sizes improve margin linearly.

---

## 5. Batch Scaling Reference (Paseo, alpha-3)

100 impressions per claim. Gas measured via `eth_estimateGas`.

| Batch size | Total gas | Per-claim gas | Per-claim PAS | vs single |
|---:|---:|---:|---:|---:|
| 1 | 71,634 | 71,634 | 0.07163 | 1.00× |
| 2 | 78,236 | 39,118 | 0.03912 | 0.55× |
| 3 | 84,839 | 28,280 | 0.02828 | 0.39× |
| 4 | 91,441 | 22,860 | 0.02286 | 0.32× |
| 5 | 98,043 | 19,609 | 0.01961 | 0.27× |
| 6 | 104,645 | 17,441 | 0.01744 | 0.24× |
| 7 | 111,248 | 15,893 | 0.01589 | 0.22× |

- Fixed overhead: ~65,032 gas (tx + first claim validation)
- Marginal cost per additional claim: ~6,602 gas (0.006602 PAS)
- Per-claim savings at batch-7 vs single: **77.8%**

---

## 6. Notes

- `settleClaims` gas cannot be estimated via `eth_estimateGas` without a live signed batch; values above are from live test-tx observations
- `withdrawUser` gas not directly measured (E58 dust guard prevented test collection); assumed equal to `withdrawPublisher` (1,568 gas) — same code path
- Paseo gas price is fixed at 10¹² wei/gas (hardcoded in eth-rpc proxy). Polkadot Hub mainnet gas price may differ
- BN254 ecPairing (ZK verify) is ~51–88× cheaper on PolkaVM vs Ethereum mainnet
- `reputation.recordSettlement` (43,834 gas) is called by the relay after each settlement — this relay-side cost should be factored into relay profitability calculations: adds 0.0438 PAS per settlement tx
- DOT price assumptions ($5, $10) are illustrative; update analysis to current market price for production planning
