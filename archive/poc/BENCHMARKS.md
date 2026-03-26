# DATUM PoC — Gas Benchmarks

Measured 2026-02-27 on pallet-revive dev chain (chainId 420420420).

## Environment

| Item | Value |
|------|-------|
| Chain | pallet-revive local dev node |
| chainId | 420420420 |
| resolc | 0.3.0 (optimizer: `z`) |
| gasPrice | 1,000 planck/weight-unit |
| Block gasLimit | ~5.2 × 10¹⁹ |

## Results

| Function | gasUsed (weight units) | Est. cost (planck) | Est. cost (DOT) |
|----------|------------------------|-------------------|-----------------|
| `createCampaign` | 2,657,538,331,671,666 | 2.66 × 10¹⁸ | ~0.266 DOT |
| `voteAye` | 2,304,998,733,791,666 | 2.30 × 10¹⁸ | ~0.230 DOT |
| `voteNay` | 2,283,167,806,290,833 | 2.28 × 10¹⁸ | ~0.228 DOT |
| `settleClaims` (1 claim) | 7,843,683,326,872,500 | 7.84 × 10¹⁸ | ~0.784 DOT |
| `settleClaims` (10 claims) | 41,545,711,111,520,000 | 4.15 × 10¹⁹ | ~4.155 DOT |
| `withdrawPublisher` | 1,471,147,848,773,333 | 1.47 × 10¹⁸ | ~0.147 DOT |

1 DOT = 10¹⁰ planck.

## Scaling Analysis

```
settleClaims scale: 10-claim / 1-claim = 5.30x
```

The 10-claim batch costs 5.30× the single-claim batch. This indicates roughly linear scaling (expected base overhead + per-claim cost), but exceeds a 5× threshold. A `MAX_CLAIMS_PER_BATCH` guard is recommended.

**Recommendation:** cap batch size at 5 claims to keep single-tx cost under ~4 DOT on dev chain.

## Notes

- Weight units on pallet-revive are not EVM gas. 1 weight unit ≈ 1 picosecond of computation.
- The `gasPrice` of 1,000 is the dev chain value; Polkadot Hub mainnet values will differ.
- Estimated costs scale linearly with gasPrice.
- `settleClaims` dominates cost due to cross-contract calls (`getCampaign`, `deductBudget`) and payment distribution logic.
- `withdrawPublisher` is cheapest: single storage read + native transfer.

## Reproducing

```bash
npx hardhat run scripts/benchmark-gas.ts --network substrate
```

Requires a running pallet-revive dev node (`substrate` + `eth-rpc` containers on ports 9944/8545).
