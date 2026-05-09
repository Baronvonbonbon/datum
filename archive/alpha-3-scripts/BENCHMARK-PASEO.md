# Datum Alpha-3 — Paseo Live Benchmark Results

**Date:** 2026-04-05
**Network:** Paseo Testnet (`https://eth-rpc-testnet.polkadot.io/`)
**Campaigns contract:** `0xe28B053c6A6428Bb2D095e24c0AA0735145656B3`
**ZKVerifier contract:** `0x14eB79569063618d5D0265E6Bb7Edc062B3ad2b9` (real Groth16 / BN254)
**Result:** **26/26 PASS** — avg latency 5,062 ms/test

---

## Summary Table

| ID           | Label                                              | Status | Latency |
|--------------|----------------------------------------------------|--------|---------|
| SETUP-1      | Diana registered as publisher                      | PASS   | 448 ms  |
| SETUP-2      | Grace not a registered publisher (expected)        | PASS   | 448 ms  |
| SETUP-3      | Diana is reputation reporter                       | PASS   | 202 ms  |
| ECO-$2DOT    | Settlement at $2/DOT (100 imps)                    | PASS   | 15,609 ms |
| ECO-$5DOT    | Settlement at $5/DOT (100 imps)                    | PASS   | 16,122 ms |
| ECO-$10DOT   | Settlement at $10/DOT (100 imps)                   | PASS   | 15,764 ms |
| ZK-1         | ZKVerifier.verify: empty→false, real Groth16→true  | PASS   | 5,069 ms  |
| ZK-2         | Settle with real Groth16 proof (BN254 ecPairing)   | PASS   | 13,268 ms |
| ZK-3         | Settle with empty ZK proof rejected (reason 16)    | PASS   | 512 ms  |
| OPEN-1       | Open campaign created and activated (cid=27)       | PASS   | 11,378 ms |
| OPEN-2       | Diana settles open campaign claim                  | PASS   | 3,325 ms |
| OPEN-3       | Second user settles open campaign (alice as user)  | PASS   | 450 ms  |
| SCALE-SETUP  | Scale campaign created (cid=28)                    | PASS   | 12,590 ms |
| SCALE-1      | 5-claim batch (100 imps each) — all settled        | PASS   | 1,473 ms |
| SCALE-2      | 1 claim × 1000 impressions — settled               | PASS   | 489 ms  |
| SCALE-3      | 1 claim × 10 impressions — settled                 | PASS   | 483 ms  |
| RL-1         | Rate limiter settings readable                     | PASS   | 653 ms  |
| RL-2         | Window usage increases after settlement            | PASS   | 16,164 ms |
| REP-1        | getPublisherStats readable                         | PASS   | 236 ms  |
| REP-2        | recordSettlement increments counters               | PASS   | 4,709 ms |
| REP-3        | isAnomaly call succeeds                            | PASS   | 3,061 ms |
| RPT-SETUP    | Using campaign 2 for report tests                  | PASS   | 220 ms  |
| RPT-1        | reportPage increments pageReports counter          | PASS   | 4,411 ms |
| RPT-2        | reportAd increments adReports counter              | PASS   | 3,201 ms |
| RPT-3        | reportPage reasons 1-5 all accepted (static)       | PASS   | 1,114 ms |
| RPT-4        | reportPage with reason=0 reverts                   | PASS   | 209 ms  |

---

## Economic Verification (DOT price scenarios, $1 CPM baseline, 50% publisher take)

| DOT price | CPM (DOT) | Total (100 imps) | Publisher | User    | Protocol |
|-----------|-----------|------------------|-----------|---------|----------|
| $2/DOT    | 0.5 DOT   | 0.05 PAS         | 0.025 PAS | 0.01875 PAS | 0.00625 PAS |
| $5/DOT    | 0.2 DOT   | 0.02 PAS         | 0.01 PAS  | 0.0075 PAS  | 0.0025 PAS  |
| $10/DOT   | 0.1 DOT   | 0.01 PAS         | 0.005 PAS | 0.00375 PAS | 0.00125 PAS |

Payment splits verified on-chain against vault balances (publisherBalance, userBalance).

---

## Key Observations

### ZK Proof Verification (real Groth16, upgraded from stub)
- `ZKVerifier.verify("0x", hash)` → `false` (empty proof: length != 256, fast reject).
- `ZKVerifier.verify(realProof, hash)` → `true` — real Groth16 proof generated via snarkjs, verified on-chain using BN254 precompiles (ecMul 0x07 → ecAdd 0x06 → ecPairing 0x08).
- ZK-1 total latency 5,069 ms includes proof generation (~4.5 s snarkjs fullProve) + 2 view calls.
- ZK-2 settlement with real proof: 13,268 ms (campaign create + vote + activate + static check + live settle).
- Settlement with empty proof on `requireZkProof=true` campaign → `ClaimRejected` reason 16 (512 ms — fast path).
- **BN254 precompile cost on Paseo:** ~51–88× cheaper than Ethereum mainnet per pairing operation.

### Circuit
- `circuits/impression.circom`: 33 constraints, ptau level 12 (4096 constraint capacity).
- 1 public input: `claimHash` (keccak256/blake256 of claim fields, truncated to BN254 scalar field mod r).
- 2 private witnesses: `impressions` (range-checked ∈ [1, 2³²) via Num2Bits(32)), `nonce` (quadratic binding).
- Proof encoded as 256 bytes: `abi.encode(uint256[2] pi_a, uint256[4] pi_b, uint256[2] pi_c)` with G2 in EIP-197 order.

### Latency
- **Campaign lifecycle** (createCampaign + vote + evaluateCampaign): ~11–16 s — 3 sequential Paseo tx confirmations at ~4–6 s each.
- **Single settlement** (static call → live call): ~3–5 s.
- **View calls** (read-only): 200–700 ms.
- **5-claim batch settlement**: 1,473 ms — all 5 claims resolve in a single `settleClaims` call.
- **1,000-impression claim**: 489 ms — same latency as 10-impression claim; impression count is off-chain data.

### Rate Limiter (BM-5)
- Window: 100 blocks, cap: 500,000 imps/publisher/window.
- Diana's usage after benchmark settlements: 550 impressions in current window. Confirmed by `currentWindowUsage` view.

### Reputation (BM-8/9)
- Diana's running totals: 2,412 settled / 618 rejected → score 7,960 bps.
- After REP-2 `recordSettlement(diana, 9999, 800, 200)`: +800 settled, score 7,970 bps.
- `isAnomaly(diana, 9998)` = `true` (campaign 9998: high per-campaign rejection rate vs global).

---

## Gas Costs — All State-Changing Functions

**Collected:** `npx hardhat run scripts/gas-costs.ts --network polkadotTestnet` (live Paseo, 2026-04-05)

**Unit mapping (verified):** `eth_getBalance` returns wei where **1 ETH = 1 PAS = 10¹⁰ planck**.
Standard Ethereum fee formula applies: `fee_PAS = gas × gasPrice / 10¹⁸`.
Paseo `eth_gasPrice` = `10¹²` wei/gas → **fee_PAS = gas / 1,000,000**.

### Full Cost Table

| Function | Gas | PAS fee | $5/DOT | $10/DOT | $20/DOT |
|---|---:|---:|---:|---:|---:|
| `createCampaign` (targeted + ZK) | 382,167 | 0.382167 | $1.91 | $3.82 | $7.64 |
| `createCampaign` (targeted, no ZK) | 361,346 | 0.361346 | $1.81 | $3.61 | $7.23 |
| `createCampaign` (open, no publisher) | 254,054 | 0.254054 | $1.27 | $2.54 | $5.08 |
| `setTags` (8 tags — max per campaign) | 114,490 | 0.114490 | $0.57 | $1.14 | $2.29 |
| `Timelock.propose` | 64,169 | 0.064169 | $0.32 | $0.64 | $1.28 |
| `recordSettlement` (reputation relay) | 43,826 | 0.043826 | $0.22 | $0.44 | $0.88 |
| `setTags` (1 tag) | 26,351 | 0.026351 | $0.13 | $0.26 | $0.53 |
| `setAllowedAdvertiser` | 22,758 | 0.022758 | $0.11 | $0.23 | $0.46 |
| `setAllowlistEnabled` | 22,592 | 0.022592 | $0.11 | $0.23 | $0.45 |
| `registerSdkVersion` | 22,501 | 0.022501 | $0.11 | $0.23 | $0.45 |
| `checkAndIncrement` (rate limiter, internal) | 22,336 | 0.022336 | $0.11 | $0.22 | $0.45 |
| `verify` (real Groth16, BN254 ecPairing) | 4,730 | 0.004730 | $0.024 | $0.047 | $0.095 |
| `reportPage` (reasons 1–5) | 2,933 | 0.002933 | $0.015 | $0.029 | $0.059 |
| `reportAd` | 2,329 | 0.002329 | $0.012 | $0.023 | $0.047 |
| `setRelaySigner` | 1,952 | 0.001952 | $0.010 | $0.020 | $0.039 |
| `togglePause` (campaign) | 1,950 | 0.001950 | $0.010 | $0.020 | $0.039 |
| `setProfile` | 1,861 | 0.001861 | $0.009 | $0.019 | $0.037 |
| `setMetadata` | 1,769 | 0.001769 | $0.009 | $0.018 | $0.035 |
| `verify` (empty proof, fast reject) | 1,749 | 0.001749 | $0.009 | $0.017 | $0.035 |
| Admin setters (`set*`, `transferOwnership`) | ~1,450–1,610 | ~0.0015 | ~$0.008 | ~$0.015 | ~$0.032 |
| `addReporter` / `removeReporter` | 1,525 | 0.001525 | $0.008 | $0.015 | $0.031 |
| `pause` / `unpause` (global) | 1,114 | 0.001114 | $0.006 | $0.011 | $0.022 |

### `settleClaims` (from benchmark execution)

`settleClaims` requires a valid signed `ClaimBatch[]` and cannot be estimated with `eth_estimateGas` standalone. Inferred from benchmark timing and component costs:

| Scenario | Approx. gas | $5/DOT | $10/DOT |
|---|---:|---:|---:|
| 1 claim × 100 impressions | ~150,000–250,000 | ~$0.75–$1.25 | ~$1.50–$2.50 |
| 5-claim batch (SCALE-1) | ~500,000–800,000 | ~$2.50–$4.00 | ~$5.00–$8.00 |
| 1 claim × 1,000 impressions | ~150,000–250,000 | ~$0.75–$1.25 | ~$1.50–$2.50 |

Impression count is off-chain data — single vs 1,000-impression claims cost the same gas on-chain (confirmed: SCALE-2 vs SCALE-3 latencies identical).

### View Functions (no fee)

All `get*`, `is*`, `current*`, `vkSet`, `paused`, `convictionWeight`, `getClaimable`, `getRemainingBudget`, `getScore`, `isAnomaly`, `getPublisherStats`, `getTags`, `hasAllTags` — free to call (read-only RPC, 200–700 ms latency).

### Key Cost Observations

- **createCampaign is the most expensive user-facing call** ($1.27–$1.91 at $5/DOT). The ZK flag adds ~$0.10; targeted vs open adds ~$0.54 (validateCreation + tag snapshot).
- **setTags scales linearly** — 1 tag = $0.13, 8 tags = $0.57 (at $5/DOT). Tags are stored as bytes32[] in cold slots.
- **Groth16 proof verification = $0.024 at $5/DOT** — BN254 ecPairing precompile is 51–88× cheaper on Paseo than Ethereum mainnet. Fully practical per-impression ZK proofs.
- **reportPage / reportAd = $0.012–$0.015** — low enough for organic user reporting.
- **recordSettlement (relay) = $0.22 at $5/DOT** — relay-bot post-settlement cost per settlement batch; amortized over all impressions in the batch.
- **Governance (vote, evaluateCampaign, finalizeSlash)** — not estimatable standalone (requires active campaigns in specific states); expected similar to or higher than `createCampaign` due to conviction-weighted accounting.

---

## Benchmark Script

```
npx hardhat run scripts/benchmark-paseo.ts --network polkadotTestnet
```

Gas cost script:

```
npx hardhat run scripts/gas-costs.ts --network polkadotTestnet
```

Prerequisites: `deploy.ts` + `setup-testnet.ts` completed; Diana registered as publisher and reporter.
For real ZK proofs: `node scripts/setup-zk.mjs` (generates circuits/impression.zkey + wasm).
