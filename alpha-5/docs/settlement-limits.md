# Datum Alpha-5 — Settlement Critical-Path Limits & Bottlenecks

Hard contract limits on the **impression → claim → settle → credit** path, the
practical (gas-bound) limits that bite before them, and the **soft limits to set
in role tooling**. Sourced from contract constants + live Paseo config reads.
Companion to [`gas-economics.md`](./gas-economics.md).

> Live values read from the deployed Settlement
> `0xA81766522Ea4e11bd9374Cd2b0A8a66Ac7b98dB8` and friends.

---

## 1. Hard limits on the settlement path

| Limit | Where | Hard value | At the limit | **Recommended soft limit (tooling)** |
|---|---|---|---|---|
| **Batch size** (claims/tx) | `Settlement._maxBatchSize` (ceiling 200) | **50 (live)** — but Paseo **weight-caps at 4** (measured, §2) | `E28` at 51; silent **revert at 5** (weight) | **≤ 4 claims/batch (use 3)** — the 50 cap is unreachable on Paseo |
| **Relay batch** | `DatumRelay.MAX_RELAY_BATCH_CEILING` | 200 | `require E11` on config | mirror the settle cap (10–15) |
| **Per-user events** | `MAX_USER_EVENTS` | **100,000 / user / actionType** (cumulative) | claim skipped (no revert) | warn user at ~90k; it's a lifetime-ish cap |
| **Per-block settlement value** | `_maxSettlementPerBlock` breaker | **0 = DISABLED (live)** | `revert E80` if enabled | **enable it** at a wei value (see §3) — currently no ceiling |
| **Min claim interval** | `_minClaimInterval` | **0 = off (live)** | `reason 18` | leave off, or small (e.g. 1) for anti-spam |
| **User share** | `userShareBps` | **7500 live**, bounded `[5000, 9000]` | `revert` on config | n/a (governance-set) |
| **Per-(user,campaign,window) cap** | advertiser-set `capMax/capWin` | per campaign | claim skipped | expose in CreateCampaign UI |
| **Claim deadline** | `DatumRelay` `deadlineBlock` | block-based | `revert E29` (expired) | sign with ≥ ~100-block (10 min) deadline |
| **Conviction** | `GovernanceV2.MAX_CONVICTION` | 8 | revert | cap slider at 8 |
| **Publisher tags** | `TagSystem.MAX_PUBLISHER_TAGS_CEILING` | 256 | `revert E11` | UI cap ~32 |
| **Campaign tags** | `TagSystem.MAX_CAMPAIGN_TAGS_CEILING` | 64 | `revert E11` | UI cap ~8 |
| **Take rate** | `MIN/MAX_DEFAULT_TAKE_RATE_BPS` | `[3000, 8000]` | `revert E11` | clamp publisher input |
| **Daily cap** | per pot | `0 < dailyCapWei ≤ budgetWei` | `revert E12` | validate in CreateCampaign |
| **Pending timeout** | `PENDING_TIMEOUT_MIN/MAX` | `[100, 5_256_000]` blocks | revert | n/a |
| **PoW difficulty** | `PowEngine.POW_MAX_SHIFT` | 64 (≈ impossible) | proof becomes unfindable | back off settle rate (see §4) |
| **Rate-limiter window** | `MIN_RL_WINDOW_SIZE` | 10 blocks min | revert on config | per-publisher cap is currently unset (no limit) |

---

## 2. The real bottleneck: per-claim gas growth (the binding constraint)

**This is the real story — and it took live Paseo force-send probes to find it, because
both hardhat and `estimateGas` are misleading here.**

Measured on Paseo (`PROBE_SETTLE_LIMIT=1`, explicit `gasLimit`, force-sent):

Measured on Paseo (`PROBE_SETTLE_LIMIT=1` in `role-gas-report.ts` — `eth_call` static
check + force-sent with explicit `gasLimit`):

| Claims/batch | `eth_call` / `estimateGas` | Force-sent on-chain | Real gas |
|---:|---|---|---:|
| 1 | ok | **MINED** | 57,191 |
| 2 | ok | **MINED** | 42,881 |
| 3 | ok | **MINED** | 53,598 |
| **4** | ok | **MINED** | **89,342** |
| **5** | reverts | **REVERTS** | — |
| 6, 7, 8 | reverts | REVERTS | — |
| 10, 25, 50 | reverts | REVERTS | — |

### → The hard ceiling is **4 claims per settle tx.**

This is a pallet-revive **per-tx weight wall** (`ref_time`/`proof_size`), **not** gas —
gas at the n=4 limit is only **89,342 (0.089 PAS)**, nowhere near a gas cap. The
per-claim path fans out into cross-contract reads (validator, budget ledger,
nullifier, rate limiter, PoW, reputation, reward vault); ~4 claims' worth of that
exhausts the single-call resource budget on Paseo's eth-rpc.

Two things to know for tooling:
1. **`estimateGas` is *accurate* here** (it correctly reverts at 5+ — these batches
   genuinely fail). The earlier hardhat "super-linear gas curve" was the misleading
   signal: hardhat lets 50-claim batches through (no weight metering), so it never
   surfaces this wall. Trust live Paseo, not hardhat, for batch limits.
2. The **50-claim contract cap (`maxBatchSize`) is unreachable** — the weight wall at
   5 bites first by an order of magnitude.

**Soft limit: cap relay batches at 4 claims/tx (use 3 for headroom).** Throughput on
Paseo is therefore **≤ 4 claims/block/signer (~40 claims/min/signer at 6s blocks)**;
scale beyond that with **concurrent relay signers** (§7), not bigger batches. Mainnet
(Polkadot Hub) has a larger per-tx weight budget — re-run the probe there to lift it.

---

## 3. Per-block circuit breaker is OFF — and is now wei-denominated

`maxSettlementPerBlock = 0` (disabled), so **there is currently no ceiling on total
settlement value per block** — a misconfigured/compromised relay could drain budgets
as fast as it can fill blocks. Recommendation: **enable it**, sized in **wei**
(post-denomination). E.g. a 100-PAS/block ceiling = `100e18`. ⚠️ Do **not** copy an
old planck-era value (e.g. `1e15`) — in wei that's 0.001 PAS/block and would `E80`
on the first real batch.

---

## 4. PoW throughput throttle (soft, self-healing)

`PowEngine` raises per-user PoW difficulty quadratically as a leaky bucket fills with
recent settled events; idle drains it. It adds **no gas**, but a user/relay settling
hard and fast drives difficulty toward `POW_MAX_SHIFT = 64` (proofs become
unfindable), throttling sustained throughput. This is the mechanism that makes the
relay-subsidy zone (small gasless withdrawals) non-farmable. → tooling should **pace
settlements** rather than burst, and surface rising difficulty to the relay operator.

---

## 5. Denomination-stale constants (exposed by the wei migration)

Two campaign constants were sized in **10-dec planck** and were **not** rescaled by the
`*Planck→*Wei` rename (they're `ALL_CAPS_PLANCK` / planck literals, which the rename
deliberately skipped):

| Constant | Value | In wei terms | Problem |
|---|---|---|---|
| `MINIMUM_BUDGET_PLANCK` | `1e9` | 1e-9 PAS | Min budget is now trivially tiny (harmless, but misleading). |
| `CPM_FLOOR_MAX` | `10 * 10^10` (1e11) | 1e-7 PAS | **The settable CPM floor maxes at 1e-7 PAS** — you can no longer enforce a real floor (e.g. 0.5 PAS). |

→ **Rescale both ×1e8** (planck→wei) in a follow-up, or the CPM-floor governance lever
is effectively dead. (Renaming them `*_WEI` at the same time keeps naming consistent.)

---

## 6. Throughput & concurrency (the other three stress dimensions)

- **Batch size:** weight-capped at **4 claims/tx** (§2). The dominant ceiling.
- **Per-block:** `maxSettlementPerBlock` breaker is **OFF** → no contract-level
  per-block cap. Block gas limit is the only ceiling, and at 4-claim batches (~89k
  gas) it's nowhere near. So **settlement throughput scales linearly with concurrent
  signers**: `claims/block ≈ 4 × (relay signers settling in parallel)`.
- **Concurrency:** each relay signer is nonce-serial → **1 settle tx / block / signer**
  (~6s). N signers → N parallel txs/block, no contract contention (breaker off, no
  shared per-block counter active). To do K claims/min you need ≈ `K / 40` signers.
- **Sustained:** per-user **PoW** difficulty ramps under bursty settling (§4),
  self-healing on idle — it throttles *one user's* sustained rate, not aggregate
  cross-user throughput. The relay should pace per-user, not globally.

**Net: Paseo settlement throughput = `4 × signers` claims per 6s block. One relay
signer ≈ 40 claims/min; scale by adding signers, not batch size.**

## 7. Soft-limit cheat-sheet for role tooling

- **Relay:** batch **≤ 4 claims/tx (use 3)** and **set an explicit `gasLimit`** (don't
  rely on `estimateGas` defaults — though it's accurate, an unset gasLimit + a 5-claim
  attempt just reverts); honour `deadlineBlock` ≥ 100; pace per-user to avoid PoW ramp;
  add signers for throughput. The `maxSettlementPerBlock` breaker is off — enable it.
- **Advertiser (CreateCampaign):** `0 < dailyCap ≤ budget`; take rate ∈ [30%, 80%];
  ≤ 8 campaign tags; per-window user cap optional.
- **Publisher:** ≤ 32 tags; one registration; stake top-ups.
- **User:** lifetime settle cap 100k events/actionType; gasless-withdraw economics in
  `gas-economics.md`.
- **Governance/ops:** enable the per-block breaker (wei-sized); rescale the two stale
  planck constants (`CPM_FLOOR_MAX`, `MINIMUM_BUDGET_PLANCK`) ×1e8.

*All §2 numbers are measured real pallet-revive gas/limits from the live Paseo
benchmark + force-send probes (`role-gas-report.ts --network polkadotTestnet`).*
