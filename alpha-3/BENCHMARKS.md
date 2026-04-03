# DATUM Alpha-3 Gas Benchmarks

Measured 2026-04-03. Alpha-3: 17 contracts, Solidity 0.8.24, resolc 1.0.0.

Two environments:
- **Hardhat EVM** — local, keccak256 claim hashing, gas in EVM units
- **Paseo testnet** — pallet-revive (PolkaVM), Blake2-256 claim hashing, gas in weight units

---

## Hardhat EVM

gasPrice: 1,875,000,000 (default Hardhat)

### Main Operations

| Function | Gas Used | gasPrice | Est. cost (planck) |
|----------|----------|----------|--------------------|
| `createCampaign` | 273,335 | 1,875,000,000 | 512,503,125,000,000 |
| `vote (aye)` | 136,101 | 1,875,000,000 | 255,189,375,000,000 |
| `vote (nay)` | 158,345 | 1,875,000,000 | 296,896,875,000,000 |
| `settleClaims (1 claim)` | 292,232 | 1,875,000,000 | 547,935,000,000,000 |
| `settleClaims (5 claims)` | 371,372 | 1,875,000,000 | 696,322,500,000,000 |
| `withdrawUser` | 35,090 | 1,875,000,000 | 65,793,750,000,000 |
| `withdrawPublisher` | 34,958 | 1,875,000,000 | 65,546,250,000,000 |

**Settlement split** (50% take rate, 1,000 impressions @ 0.016 DOT CPM = 0.16 DOT gross):
- Publisher: 80,000,000 planck (50%)
- User reward: 60,000,000 planck (37.5%)
- Protocol fee: 20,000,000 planck (12.5%)

### Batch Scaling (settleClaims)

| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 |
|------------|----------|---------------|--------------|
| 1 | 275,120 | 275,120 | 1.00x |
| 2 | 273,540 | 136,770 | 0.99x |
| 3 | 306,161 | 102,053 | 1.11x |
| 4 | 338,784 | 84,696 | 1.23x |
| 5 | 371,372 | 74,274 | 1.35x |
| 6 | 404,021 | 67,336 | 1.47x |
| 7 | 436,647 | 62,378 | 1.59x |
| 8 | 469,263 | 58,657 | 1.71x |
| 9 | 501,892 | 55,765 | 1.82x |
| 10 | 534,510 | 53,451 | 1.94x |

**Scaling analysis:**
- Fixed overhead (tx + 1st claim): ~275,120 gas
- Marginal cost per additional claim: ~28,821 gas
- Estimated fixed overhead: ~246,299 gas
- Per-claim savings at batch 10 vs single: **80.6%**

### Settlement scaling: 10-claim vs 1-claim
- 10-claim batch: 534,510 gas total / 53,451 per-claim
- Single claim: 292,232 gas
- Ratio: **1.94x** total gas for 10x claims

---

## Paseo Testnet

Measured 2026-04-03 on Paseo (Chain ID 420420417). gasPrice: 1,000,000,000,000 (eth-rpc 18-decimal wei).
Alpha-3: 17 contracts, resolc 1.0.0, Blake2-256 claim hashing.
Gas measured via `eth_estimateGas` against live contract state (Paseo `eth_getTransactionReceipt` unavailable).

Paseo differences vs Hardhat EVM:
- Gas units are pallet-revive weight (~1.5×10¹⁵ per block)
- Claim hashing: Blake2-256 via ISystem(0x900) precompile
- `value` denominations: eth-rpc 18-decimal (1 DOT = 10¹⁸ wei in eth-rpc, 10¹⁰ planck on-chain)
- Cost (DOT) = gas × gasPrice / 10¹⁸

### Main Operations

| Function | Gas (weight) | Cost (DOT) | Cost (USD @$5) |
|----------|-------------|------------|---------------|
| `createCampaign` | 234,952 | 0.234952 | $1.1748 |
| `vote (aye)` | 106,869 | 0.106869 | $0.5343 |
| `evaluateCampaign (activate)` | 4,172 | 0.004172 | $0.0209 |
| `settleClaims (1 claim)` | 133,552 | 0.133552 | $0.6678 |
| `settleClaims (5 claims)` | 98,043 | 0.098043 | $0.4902 |

`withdrawUser` / `withdrawPublisher` — not measured (E58 dust guard: test CPM too low to accumulate sufficient balance).

**Settlement scale:** 5-claim / 1-claim = **0.73x** total gas. Per-claim cost in 5-batch: 0.019609 DOT vs single: 0.133552 DOT.

### Batch Scaling (settleClaims)

_100 impressions per claim, fresh campaign per batch._

| Batch Size | Gas (weight) | Per-Claim Gas | Scaling vs 1 | Cost (DOT) | Per-Claim DOT |
|------------|-------------|--------------|--------------|------------|--------------|
| 1 | 71,634 | 71,634 | 1.00x | 0.071634 | 0.071634 |
| 2 | 78,236 | 39,118 | 1.09x | 0.078236 | 0.039118 |
| 3 | 84,839 | 28,279 | 1.18x | 0.084839 | 0.028280 |
| 4 | 91,441 | 22,860 | 1.28x | 0.091441 | 0.022860 |
| 5 | 98,043 | 19,608 | 1.37x | 0.098043 | 0.019609 |
| 6 | 104,645 | 17,440 | 1.46x | 0.104645 | 0.017441 |
| 7 | 111,248 | 15,892 | 1.55x | 0.111248 | 0.015893 |

Batches 8–10: `estimateGas` reverted without reason data (PolkaVM-specific; contract inner cap is 50 claims/batch).

**Scaling analysis:**
- Fixed overhead (tx + 1st claim): ~71,634 gas
- Marginal cost per additional claim: ~6,602 gas
- Estimated fixed overhead: ~65,032 gas
- Per-claim savings at batch 7 vs single: **77.8%**

Run command:

```
DEPLOYER_PRIVATE_KEY="0x..." \
TESTNET_ACCOUNTS="bob_key,diana_key,frank_key,hank_key" \
npx hardhat run scripts/benchmark-testnet.ts --network polkadotTestnet
```

---

## Methodology

**Scripts:**
- `scripts/benchmark-gas.ts` — local Hardhat EVM, deploys fresh 17-contract stack
- `scripts/benchmark-testnet.ts` — Paseo testnet, attaches to `deployed-addresses.json`; gas via `eth_estimateGas`, state changes via nonce polling

**Campaign setup (EVM):**
- Budget: 50 DOT, daily cap: 50 DOT, bid CPM: 0.016 DOT
- Publisher take rate: 50%
- Governance quorum: 1 DOT (conviction-weighted)

**Campaign setup (Paseo):**
- Budget: 10 DOT, daily cap: 10 DOT, bid CPM: 0.016 DOT
- Governance quorum: 1 DOT conviction-weighted (quorum = 100 DOT on deployed contracts; stake = quorum)
- Batch scaling: 500 DOT budget, 100 impressions/claim

**Claim chain:** Each batch is a linked chain — nonce N's `previousClaimHash` = hash of nonce N-1. First claim uses `ZeroHash`.

**Batch limits:** Settlement: outer 10 batches/tx, inner 50 claims/batch. EVM benchmark tested 1–10; Paseo tested 1–7 (8+ reverted without reason).

**Contracts (17, alpha-3):**
PauseRegistry · Timelock · ZKVerifier · Publishers · TargetingRegistry · BudgetLedger · PaymentVault · CampaignValidator · Campaigns · ClaimValidator · GovernanceHelper · CampaignLifecycle · Settlement · GovernanceV2 · GovernanceSlash · Relay · AttestationVerifier
