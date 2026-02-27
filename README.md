# DATUM

A privacy-preserving programmatic advertising protocol built on Polkadot Hub (pallet-revive / PolkaVM).

DATUM connects advertisers, publishers, and users through on-chain campaign management, governance-gated activation, and verifiable claim settlement — without a centralized ad server.

---

## Overview

| Contract | Role |
|----------|------|
| `DatumPublishers` | Publisher registry and take-rate management |
| `DatumCampaigns` | Campaign lifecycle: creation, activation, pausing, termination, expiry |
| `DatumGovernanceVoting` | Stake-weighted aye/nay voting; activates or terminates campaigns |
| `DatumGovernanceRewards` | Reward claims for governance reviewers |
| `DatumSettlement` | Claim batch processing, hash-chain validation, 3-way payment distribution |

### Revenue split

```
totalPayment     = (clearingCpm × impressions) / 1000
publisherPayment = totalPayment × snapshotTakeRate / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder × 75%
protocolFee      = remainder × 25%
```

All amounts are in planck (1 DOT = 10¹⁰ planck).

---

## Repository layout

```
poc/
  contracts/        Solidity source (5 contracts + interfaces + mocks)
  test/             Hardhat test suite (46 tests)
  scripts/          Deployment and benchmark scripts
  BENCHMARKS.md     Gas measurements on pallet-revive dev chain
MVP.md              Phased implementation plan
REVIEW.md           Design review and issue log
```

---

## Getting started

### Prerequisites

- Node.js 18+
- Docker (for the local substrate node)

### Install

```bash
cd poc
npm install
```

### Run tests (Hardhat EVM)

```bash
npm test
```

### Compile for PolkaVM

```bash
npm run compile:polkavm
```

Requires `@parity/resolc`. Optimizer mode `z` is set automatically in `hardhat.config.ts`.

### Run tests on substrate

Start the local pallet-revive node first (two Docker containers: `substrate` on port 9944, `eth-rpc` on port 8545), then:

```bash
npx hardhat test --network substrate
```

Expected: 44/46 pass, 2 skipped (daily-cap test requires `evm_mine` not available on substrate; `minReviewerStake` deploys 3 contract sets and times out).

### Gas benchmarks

```bash
npx hardhat run scripts/benchmark-gas.ts --network substrate
```

See [`poc/BENCHMARKS.md`](poc/BENCHMARKS.md) for recorded results.

---

## Gas benchmarks (pallet-revive dev chain)

| Function | Weight units | Est. cost |
|----------|-------------|-----------|
| `createCampaign` | 2.66 × 10¹⁵ | ~0.27 DOT |
| `voteAye` | 2.30 × 10¹⁵ | ~0.23 DOT |
| `voteNay` | 2.28 × 10¹⁵ | ~0.23 DOT |
| `settleClaims` (1 claim) | 7.84 × 10¹⁵ | ~0.78 DOT |
| `settleClaims` (5 claims) | ~3.9 × 10¹⁶ | ~3.9 DOT |
| `withdrawPublisher` | 1.47 × 10¹⁵ | ~0.15 DOT |

Max batch size: 5 claims per `settleClaims` call.

---

## Status

- [x] Phase 1 — Local substrate validation (Gate G1 complete)
  - 46/46 tests on Hardhat EVM
  - 44/46 tests on pallet-revive (2 skipped by design)
  - All 5 contracts under 49,152-byte PVM initcode limit
  - Gas benchmarks recorded
- [ ] Phase 2 — Browser extension
- [ ] Phase 3 — Testnet deployment
- [ ] Phase 4 — Mainnet (Kusama → Polkadot Hub)

---

## License

MIT — see [LICENSE](LICENSE).
