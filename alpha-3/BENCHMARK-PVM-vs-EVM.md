# DATUM Alpha-3 — PVM vs EVM Benchmark Comparison

**Date:** 2026-05-03
**Chain:** Paseo Testnet (Chain ID 420420417)
**RPC:** `https://eth-rpc-testnet.polkadot.io/`
**Contracts:** 29 (identical Solidity source, different compilation targets)

## Compilation Targets

| Property | PVM | EVM |
|---|---|---|
| Compiler | resolc 1.1.0 | solc 0.8.24 |
| Target | PolkaVM bytecode | EVM bytecode |
| Hardhat config | `hardhat.config.ts` | `hardhat.config.evm.ts` |
| Optimizer | `z` (size) | 200 runs + viaIR |
| Claim hashing | Blake2-256 (0x900 precompile) | keccak256 (forceKeccak=true) |

## Benchmark Results

| Metric | PVM (resolc 1.1.0) | EVM (solc 0.8.24) |
|---|---|---|
| **Tests passed** | **43/43** | **44/44** |
| **Average latency** | **3,513 ms** | **3,670 ms** |
| **Max batch size** | 3 claims/TX | **4+ claims/TX** |
| Total bytecode | 1,060,911 bytes | 124,074 bytes |
| Bytecode ratio | 8.6x larger | 1x (baseline) |

## Per-Test Latency Comparison

| Test | PVM (ms) | EVM (ms) | Delta |
|---|---|---|---|
| SETUP-1 | 632 | 476 | -156 |
| SETUP-2 | 632 | 476 | -156 |
| SETUP-3 | 154 | 178 | +24 |
| SETUP-4 | 314 | 353 | +39 |
| ECO-$2DOT | 11,436 | 10,944 | -492 |
| ECO-$5DOT | 10,256 | 10,108 | -148 |
| ECO-$10DOT | 10,156 | 9,934 | -222 |
| ZK-1 | 4,696 | 3,951 | -745 |
| ZK-2 | 9,344 | 9,869 | +525 |
| ZK-3 | 3,781 | 3,893 | +112 |
| OPEN-1 | 5,776 | 7,493 | +1,717 |
| OPEN-2 | 3,809 | 3,918 | +109 |
| OPEN-3 | 3,790 | 3,946 | +156 |
| SCALE-SETUP | 4,646 | 6,501 | +1,855 |
| SCALE-1 (3-claim) | 4,144 | 3,984 | -160 |
| SCALE-1b (4-claim) | N/A (PVM limit) | 3,962 | EVM only |
| SCALE-2 | 3,827 | 3,891 | +64 |
| SCALE-3 | 3,807 | 3,924 | +117 |
| RL-1 | 435 | 516 | +81 |
| RL-2 | 9,838 | 9,328 | -510 |
| REP-1 | 147 | 177 | +30 |
| REP-2 | 153 | 173 | +20 |
| REP-3 | 10,003 | 12,375 | +2,372 |
| REP-4 | 144 | 166 | +22 |
| RPT-SETUP | 6,949 | 5,123 | -1,826 |
| RPT-1 | 2,513 | 3,913 | +1,400 |
| RPT-2 | 3,608 | 3,883 | +275 |
| RPT-3 | 743 | 853 | +110 |
| RPT-4 | 155 | 179 | +24 |
| STAKE-1 | 435 | 515 | +80 |
| STAKE-2 | 586 | 676 | +90 |
| NULLIFIER-1 | 144 | 170 | +26 |
| NULLIFIER-2 | 143 | 172 | +29 |
| VAULT-1 | 308 | 345 | +37 |
| GOVROUTER-1 | 292 | 345 | +53 |
| GOVROUTER-2 | 5,793 | 5,080 | -713 |
| PARAMGOV-1 | 754 | 864 | +110 |
| MULTI-1 | 8,924 | 9,361 | +437 |
| PAUSE-1 | 595 | 684 | +89 |
| PAUSE-2 | 3,314 | 2,606 | -708 |
| PAUSE-3 | 3,893 | 4,277 | +384 |
| PAUSE-4 | 3,770 | 3,926 | +156 |
| PAUSE-5 | 2,167 | 3,587 | +1,420 |
| PAUSE-6 | 4,032 | 4,403 | +371 |

## Bytecode Size Comparison (29 Production Contracts)

| Contract | PVM (bytes) | EVM (bytes) | Ratio |
|---|---|---|---|
| DatumSettlement | 97,008 | 11,870 | 8.2x |
| DatumCampaigns | 76,000 | 9,552 | 8.0x |
| DatumCouncil | 70,254 | 7,144 | 9.8x |
| DatumGovernanceV2 | 59,851 | 6,907 | 8.7x |
| DatumRelay | 55,855 | 5,769 | 9.7x |
| DatumParameterGovernance | 50,592 | 6,770 | 7.5x |
| DatumCampaignLifecycle | 49,808 | 6,223 | 8.0x |
| DatumPublishers | 45,834 | 6,366 | 7.2x |
| DatumZKVerifier | 44,309 | 4,140 | 10.7x |
| DatumBudgetLedger | 43,782 | 4,328 | 10.1x |
| DatumPublisherGovernance | 42,843 | 4,975 | 8.6x |
| DatumAttestationVerifier | 38,879 | 3,997 | 9.7x |
| DatumTargetingRegistry | 37,797 | 3,984 | 9.5x |
| DatumGovernanceSlash | 36,180 | 4,081 | 8.9x |
| DatumClaimValidator | 31,997 | 4,766 | 6.7x |
| DatumTimelock | 29,611 | 3,366 | 8.8x |
| DatumTokenRewardVault | 29,314 | 3,312 | 8.9x |
| DatumPublisherStake | 28,549 | 3,437 | 8.3x |
| DatumChallengeBonds | 26,873 | 2,970 | 9.0x |
| DatumCampaignValidator | 26,559 | 3,410 | 7.8x |
| DatumPaymentVault | 22,894 | 2,997 | 7.6x |
| DatumPublisherReputation | 22,318 | 2,498 | 8.9x |
| DatumPauseRegistry | 17,188 | 2,068 | 8.3x |
| DatumGovernanceRouter | 17,171 | 2,351 | 7.3x |
| DatumSettlementRateLimiter | 15,539 | 1,613 | 9.6x |
| DatumReports | 13,693 | 1,488 | 9.2x |
| DatumNullifierRegistry | 12,809 | 1,584 | 8.1x |
| DatumAdminGovernance | 9,586 | 1,188 | 8.1x |
| DatumGovernanceHelper | 7,818 | 920 | 8.5x |
| **TOTAL** | **1,060,911** | **124,074** | **8.6x** |

## Key Findings

### 1. Batch Settlement Limits
- **PVM:** Capped at 3 claims per TX (4 claims = all rejected due to per-TX weight limit from cumulative cross-contract staticcalls)
- **EVM:** 4-claim batch passed (SCALE-1b). Smaller bytecode = lower weight per cross-contract call, allowing more claims per TX

### 2. Latency
- Average latency is comparable: PVM 3,513ms vs EVM 3,670ms (+4.5%)
- Latency is dominated by block time (6s) and RPC round-trips, not execution
- Individual test variance is high (network jitter) — no consistent winner

### 3. Bytecode Size
- PVM bytecodes are **6.7x–10.7x larger** than EVM equivalents (avg 8.6x)
- Total deployment: PVM 1.04 MB vs EVM 121 KB
- Largest contract (DatumSettlement): 97 KB PVM vs 12 KB EVM

### 4. Hash Function Compatibility
- The 0x900 system precompile (Blake2-256) has a stub at the chain level regardless of contract compilation target
- `SYSTEM_ADDR.code.length > 0` returns true for both PVM and EVM contracts
- EVM contracts cannot actually call the precompile (returns zeros)
- **Fix:** Added `forceKeccak` flag to DatumClaimValidator — set to `true` for EVM deployments

### 5. Functional Parity
- All 43 shared tests pass on both targets
- Settlement economics identical ($2/$5/$10 DOT scenarios produce same payouts)
- ZK proof verification (Groth16/BN254 ecPairing) works on both targets
- Governance, pause, reporting, staking — all functionally equivalent

## Deployment Addresses

### PVM (resolc 1.1.0) — v9, 2026-05-02
- Campaigns: `0x03fb899C613331869c80786eFcB07E5122C87994`
- Settlement: `0x84082Ad951DBa20e545d13a0489A14E53ADF1af0`
- ClaimValidator: `0x43e0e05d87e15932F5e51aBf4b27E3e3ede80B07`

### EVM (solc 0.8.24) — 2026-05-03
- Campaigns: `0x223E87164BED8802dC9Ea11fC7de660996Ecc7D1`
- Settlement: `0x7FC1e4faf2f665db2eEBBC04f42c92f84DD17679`
- ClaimValidator: `0xE08c3CEeeFd3D6637a62205666718001Fc7573bF` (forceKeccak=true)

## Conclusion

Both PVM and EVM targets are fully functional on Paseo. PVM bytecode is 8.6x larger but latency is network-bound and comparable. The main practical difference is **batch capacity**: EVM can fit 4+ claims per TX while PVM is capped at 3 due to per-TX weight limits from larger cross-contract call overhead. For mainnet, the choice depends on whether Polkadot Hub will run pallet-revive with PVM-only or dual-target support.
