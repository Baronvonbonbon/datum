# Alpha-Core — Production Benchmark Report

**Generated:** 2026-06-14 · **Updated:** 2026-06-17 (post key-rotation redeploy) · **Author:** automated benchmark + stress harness
**Contract line:** alpha-core (EVM-only, solc 0.8.24, viaIR, optimizer 200)
**Deployment under cost-validation:** Paseo testnet `polkadotTestnet` (chainId 420420417), fresh redeploy `2026-06-17Z` under rotated deployer `0x26194fE2…` (49 core contracts, validation 91/0).

> **2026-06-17 update:** Re-validated on the post-rotation redeploy. **The
> multi-claim batch-settlement blocker below is RESOLVED** — the multiclaim-fan-out
> work (`SettlementLogicB` batched credits + `BudgetLedger` v2) ships in this
> deploy and multi-claim `settleClaims` n=2/5/10 now settle on pallet-revive.
> Full refreshed numbers (per-role, all settlement paths, token plane, the 1→10
> batch cost curve): **`docs/paseo-gas-costs-2026-06-17.md`** + regenerated
> `docs/gas-by-role.md`.

This report consolidates four workstreams into one production-readiness picture:

1. **Local baseline benchmarks** — functional + economic correctness and per-op gas (Hardhat EVM).
2. **Cost-per-role breakdown** — every state-changing op each role performs, with low/med/high projections (`docs/gas-by-role.md`).
3. **Stress tests & thresholds** — settlement batch scaling, campaign volume, governance load, concurrency/contention (`docs/stress-test-report.md`).
4. **Paseo cost truth** — real pallet-revive weight units for live calls (`docs/paseo-gas-costs-2026-06-14.txt`).

Two environments were used, per the agreed plan: **local Hardhat EVM** for stress and threshold discovery (fast, deterministic, scales to huge batches), and **live Paseo** for real-weight cost truth.

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Does the system settle correctly across price points? | **Yes** — 56/56 economic-benchmark assertions pass (3-way split exact at DOT@$2/$5/$10, CPM honoured, ERC-20 sidecar, multi-campaign). |
| What does a settlement cost? | **~31,836 gas/claim** steady-state (EVM) on top of a ~345k per-batch fixed cost. On **live Paseo**, a verified 1-claim settle = **77,592 weight (≈0.078 PAS)** on a full-feature deploy (24,167 warm on a leaner deploy). |
| ✅ Does batch settlement work on Paseo? | **YES — RESOLVED 2026-06-17.** The fix (batch the per-claim vault credits: `SettlementLogicB` batched deduct/transferSettled + `BudgetLedger` v2) shipped. Live re-validation: `settleClaims` n=1/2/5/10 all settle on pallet-revive (78,324 cold / 42,848 / 50,824 / 64,118 weight). Warm marginal ≈ **2,659 weight/claim (≈0.00266 PAS)**; 10-batch ≈ 0.0064 PAS/claim amortized. *(Was: multi-claim n≥2 reverted — OutOfGas storage-deposit exhaustion.)* See `docs/paseo-gas-costs-2026-06-17.md`. |
| What's the settlement batch ceiling? | Governable `maxBatchSize` default **50**, hard ceiling **200** (E28). A single tx could hold ~930 claims at a 30M-gas budget — the protocol cap binds first. |
| Does anything scale O(n) with state? | **No hidden O(n).** createCampaign is flat across 500 campaigns; vote and evaluateCampaign are O(1) regardless of voter count. |
| Is the system live and callable on Paseo? | **Yes** — vote/withdraw/register estimate and execute cleanly; real weights captured below. |
| Cheapest viable user CPM (self-settle)? | **~0.001 DOT / 1,000 imps** at conservative Hub pricing (5 gwei), monthly batching — every role is net-positive on fees above that. |

**Headline cost model (EVM gas):**

```
settleClaims(n claims)  ≈ 345,015 + 31,836·n        (steady-state, warm)
createCampaign          ≈ 438,751   (flat, O(1))
vote (conviction-0)     ≈ 189,942   (warm; first vote ~333k)
evaluateCampaign        ≈  74,520   (O(1), independent of voter count)
withdraw (user/pub)     ≈  35,000
```

---

## 2. Methodology

| Aspect | Local | Paseo |
|---|---|---|
| Network | Hardhat in-process EVM (chainId 31337) | pallet-revive EVM (chainId 420420417) |
| Unit | EVM gas | pallet-revive **weight** (≠ EVM gas — see §6) |
| Block gas limit | 1e9 (raised for deploy workaround; not a real ceiling) | network-defined; per-tx **weight** cap is the real limit |
| Use | stress / threshold discovery, per-role gas, economic correctness | real per-call fee truth |
| Harness | `test/benchmark.test.ts`, `scripts/role-gas-report.ts`, `scripts/stress-test.ts` | `scripts/gas-costs.ts`, `scripts/benchmark-paseo.ts` |

All harnesses deploy the **same wired surface** (`role-gas-report.ts:deployAll`, now shared with the stress harness via export), so gas numbers are directly comparable across sections. Conversion: `cost_DOT = gas × gas_price_gwei × 1e-9` (EVM); `fee_PAS = weight / 1e6` at Paseo's `1e12 wei/gas` price.

> **Tooling fixes landed in this pass:** `role-gas-report.ts` and the stress harness were updated to the current **SLIM claim wire format** (`{publisher, eventCount, rateWei, actionType, proof[]}` with the nested `ClaimProof[]` sidecar) and the `firstNonce` dual-sig field. Previously every `settleClaims` / `settleSignedClaims` row was **SKIPPED** ("missing component proof"), which had zeroed-out all relay/settlement economics and the break-even-CPM model. Those rows now measure correctly (skips dropped 25 → 13; the remainder are the carved-out token plane).

---

## 3. Local baseline benchmarks (Hardhat EVM)

### 3.1 Economic correctness — `test/benchmark.test.ts` (56 passing)

Revenue split (takeRate 50%): publisher 50% / user 37.5% / protocol 12.5%. Verified exact at DOT@$2/$5/$10 (USD split identical; DOT price only changes planck denomination).

| Benchmark | Gas | Note |
|---|---:|---|
| Full lifecycle settle (create→vote→activate→settle→complete) | — | passes at all 3 price points |
| settle 1 claim (no metadata) | 400,540 | baseline single-claim settle |
| settle 1 claim (+IPFS metadata) | 400,540 | metadata is immutable tag data — no settle-time cost |
| settle 1 claim (+ERC-20 reward credit) | 533,535 | non-critical sidecar credit |
| 3-campaign batch settle | 780,865–886,630 | ~190k per-campaign overhead |
| depositCampaignBudget (ERC-20) | 222,237 | |
| setMetadata | 171,945 | bytes32 CID digest |
| withdraw (user) | 34,953 | |
| ERC-20 reward withdraw | 61,501 | |

### 3.2 Key state-changing op gas (from `role-gas-report.ts:deployAll`)

| Op | Gas | Op | Gas |
|---|---:|---|---:|
| createCampaign | 455,863 | vote (aye, conviction-0) | 350,241 |
| registerPublisher | 117,984 | vote (nay) | 355,360 |
| publisherStake.stake | 114,607 | evaluateCampaign | 74,489 |
| settleClaims (1×100) | 560,882* | council.propose | 338,347 |
| settleClaims (5×100) | 512,296 | council.execute | 132,374 |
| settleClaims (1 CPC click) | 186,392 | curator.blockAddr | 73,034 |
| settleClaims (1 CPA action) | 384,212 | pauseRegistry.pause | 170,543 |
| settleSignedClaims (dual-sig) | 506,849 | zkStake.depositWith | 202,178 |
| withdrawUserBySig (gasless) | 76,654 | reportPage | 118,478 |

\* First settle in a run pays one-time cold-storage init (~184k). See §5.1 for the steady-state per-claim cost.

---

## 4. Cost-per-role breakdown

Full report with low/medium/high projections, monthly + yearly DOT totals at 1000/5/50 gwei, and a per-contract coverage matrix: **`docs/gas-by-role.md`** (28 measured ops, + `docs/gas-by-role.csv`). Summary at the **Medium** tier, **5 gwei (Hub conservative)**:

| Role | Representative ops | Gas/yr | DOT/yr @ 5 gwei |
|---|---|---:|---:|
| User | zkStake onboarding, monthly report + withdraw | 328,566 | 0.0016 |
| Publisher | register, monthly stake/profile, weekly withdraw | 3,220,667 | 0.0161 |
| Advertiser | weekly campaign + self-vote + bond | 42,032,566 | 0.2102 |
| Relay | hourly 5-claim settle batches | 4,487,712,960 | 22.44 |
| Voter | weekly conviction vote | 25,578,540 | 0.1279 |
| Reporter V2 | hourly propose/approve/finalize stake-root | 4,968,898,286 | 24.84 |
| Council | monthly propose, bi-weekly vote | 7,787,765 | 0.0389 |
| Admin | ~2 pauses/yr | 872,090 | 0.0044 |

**Combined network fee burn (5 gwei, baseline tier):**

| Network | Users | Pubs | Advs | Relays | Reporters | **Total DOT/yr** |
|---|---:|---:|---:|---:|---:|---:|
| Small (community) | 100 | 10 | 5 | 1 | 2 | **71.8** |
| Medium (growth) | 10,000 | 200 | 50 | 2 | 8 | **361.2** |
| Large (at-scale) | 1,000,000 | 2,000 | 500 | 10 | 25 | **12,008.6** |

The hot path (relays + stake-root reporters) dominates aggregate spend; user/publisher/advertiser per-actor fees are rounding error. Reporter cadence (hourly stake-root epochs) is the single biggest tunable cost lever.

> **Caveat on the break-even-CPM section of `gas-by-role.md`:** its linear gas fit currently uses the n=1 and n=5 points, which are skewed by the first-settle cold-storage cost (yielding a spurious negative slope). The **authoritative per-claim cost is the steady-state fit in §5.1 (~31,836 gas/claim)**. The qualitative conclusion is unchanged — the user-side minimum CPM is ~0.001 DOT/1k imps at 5 gwei.

---

## 5. Stress tests & thresholds

Full trace: **`docs/stress-test-report.md`** (`scripts/stress-test.ts`).

### 5.1 Settlement batch scaling (`settleClaims`)

| Claims/batch | Gas used | Gas/claim | % of 30M block |
|---:|---:|---:|---:|
| 1 | 560,882 | 560,882 | 1.9% |
| 5 | 512,296 | 102,459 | 1.7% |
| 25 | 1,147,260 | 45,890 | 3.8% |
| 50 (default cap) | 1,941,117 | 38,822 | 6.5% |
| 100 | 3,530,076 | 35,300 | 11.8% |
| 200 (hard ceiling) | 6,712,287 | 33,561 | 22.4% |

- **Steady-state fit (warm):** `gas(n) ≈ 345,015 + 31,836·n`. First settle in a fresh run carries ≈184k one-time cold-storage init (so the n=1/n=5 marginals read low).
- **Thresholds:** `maxBatchSize` default **50** → `setMaxBatchSize` governable up to **`MAX_BATCH_SIZE_CEILING` = 200**. `n=51` at cap-50 and any `n>200` revert **E28**. At a 30M-gas budget a settle tx tops out near **931 claims**, so the 200-claim contract cap binds first on an EVM chain; on Polkadot Hub the per-tx weight cap is the real ceiling (§6).

### 5.2 `settleClaimsMulti` scaling (users × campaigns / tx)

| Users | Campaigns/user | Total claims | Gas | % of 30M |
|---:|---:|---:|---:|---:|
| 1 | 10 | 10 | 2,542,414 | 8.5% |
| 3 | 5 | 15 | 3,781,575 | 12.6% |
| 5 | 5 | 25 | 6,372,484 | 21.2% |

- Multi-campaign settling costs **~252k gas per (user, campaign) cell** warm — each cell runs a full validation/budget/lifecycle cycle, so the per-claim amortization of a single-campaign batch (§5.1) does **not** apply across campaigns.
- **Access-control threshold (E32):** `settleClaims`/`settleClaimsMulti` only accept a caller equal to the claim's `user` (self-settle), the registered relay contract, the attestation verifier, or the publisher's `relaySigner`. **Third-party multi-user batch settlement is relay-gated by design** — a random EOA cannot settle other users' claims.

### 5.3 Campaign volume (storage growth)

`createCampaign` gas is **flat at 438,751** across campaigns #1, #50, #100, #250, #500 (registry grown to 574). ⇒ **O(1) creation** — no unbounded per-campaign loop or rehash. The campaign registry scales without per-creation cost drift.

### 5.4 Governance load (voters per campaign)

| Voter # | vote() gas |
|---:|---:|
| 1 | 333,153 (cold) |
| 2–40 | 189,942 (flat) |

- **vote()** is **O(1)** per voter (constant after the first). **evaluateCampaign** after 40 voters = **74,520 gas** — O(1) tally on running aye/nay totals, **no per-voter loop**. Governance does not degrade with participation; a campaign with thousands of voters evaluates as cheaply as one with two.

### 5.5 Concurrency & contention

| Mechanism | Behaviour | Verdict |
|---|---|---|
| Per-block settle cap (`maxSettlementPerBlock`, **E80**) | cap 0.001 DOT, settle 0.02 DOT in one block → reverts **E80** | ✅ throttles total DOT/block across all relays (default 0 = disabled) |
| Per-campaign daily cap (**E26**) | cap 0.01 DOT, submit 0.06 DOT → **hard revert E26** | ✅ fail-closed — the whole over-budget batch rejects, not partial |
| Plain-CPM replay | re-submitting an identical plain batch settles again | ⚠️ **by design** — see note |

> **Replay / double-spend model (SLIM #2):** the per-claim nonce no longer travels on the claim — it is *derived* on-chain (`_lastNonce[user][campaign][actionType] + 1`). A plain CPM view-claim therefore has **no per-claim replay binding**: the on-chain backstop is **economic** (budget exhaustion, daily cap E26, per-block cap E80, optional rate limiter). Cryptographic per-impression anti-replay comes from the **proof sidecar**, forced by AssuranceLevel:
> - **ZK** → `nullifier` (DatumNullifierRegistry, **E73** on reuse — covered by `nullifier-registry.test.ts`)
> - **CPC** → `clickSessionHash` (DatumClickRegistry `markClaimed`)
> - **CPA** → `actionSig` (off-chain verifier EOA signature)
>
> Net: the permissionless plain-CPM path trusts the relay/claim-builder for impression uniqueness; campaigns needing cryptographic anti-replay set an AssuranceLevel that forces the sidecar.

---

## 6. Paseo cost truth (real pallet-revive weight)

Captured today via `eth_estimateGas` against the live `2026-06-11` deploy (`docs/paseo-gas-costs-2026-06-14.txt`). Paseo `gasPrice = 1e12 wei/gas` ⇒ `fee_PAS = weight / 1e6`.

| Function | Weight | Fee (PAS) | @ $5/DOT | @ $10/DOT |
|---|---:|---:|---:|---:|
| GovernanceV2.vote | 40,153 | 0.040153 | $0.20 | $0.40 |
| Publishers.registerSdkVersion | 4,444 | 0.004444 | $0.022 | $0.044 |
| PaymentVault.withdrawProtocol | 1,759 | 0.001759 | $0.0088 | $0.018 |
| PaymentVault.withdrawPublisher | 1,598 | 0.001598 | $0.0080 | $0.016 |

**Settlement weight — fresh live measurement (`scripts/capture-settle-weight-paseo.ts`, 2026-06-15):**

A fresh CPM campaign was created (publisher Diana, budget 1 DOT, rate = the live `minimumCpmFloor` 0.001 DOT), admin-activated, PoW disabled, then a **real self-settle** was sent and **verified by the `lastNonce` advancing 0 → 1** (proves the claim took the full payment path, not a soft-reject):

| Settle case | Weight (real `gasUsed`) | Fee (PAS) | State |
|---|---:|---:|---|
| 1 claim × 100 imps | **42,826** | 0.0428 | cold — settler's first-ever settle |
| 1 claim × 100 imps | **24,167** | 0.0242 | warm — settler's global slots already written |

The cold/warm gap (~18.7k weight) is the first-settle storage-init cost, mirroring the local EVM cold-start effect (§5.1).

> **Root-cause correction:** the existing `scripts/benchmark-paseo.ts` reports `—`/rejected for every settle **not** because of drained budget — it encodes the **stale flat claim format** (13 inline fields, no nested `proof[]` sidecar), so its calldata is ABI-incompatible with the live SLIM `Claim`. The new `capture-settle-weight-paseo.ts` uses the correct nested format and settles cleanly. (`benchmark-paseo.ts` needs the same SLIM fix that landed in `role-gas-report.ts` this pass.)

### Key finding — pallet-revive weight ≠ EVM gas

The two cost models are **not** a constant multiple of each other:

| Op | Local EVM gas | Paseo weight | Ratio (EVM ÷ Paseo) |
|---|---:|---:|---:|
| vote | 189,942 | 40,153 | ~4.7× |
| settle 1×100 (warm) | ~376,900 | 24,167 | ~15.6× |
| settle 1×100 (cold) | 560,882 | 42,826 | ~13.1× |
| withdrawPublisher | 34,953 | 1,598 | ~22× |

pallet-revive prices storage and execution differently from the EVM (storage-light ops are dramatically cheaper in weight terms). **Local EVM gas is therefore a conservative upper-bound proxy** for relative comparison and EVM-chain costs, while the Paseo weight numbers are the production fee truth. Real per-call fees on Hub are tiny: a settle is **~0.024–0.043 PAS**, a vote ~0.04 PAS, a withdraw ~0.0016 PAS.

### 🔴 HEADLINE FINDING — multi-claim settlement reverts on Paseo (pallet-revive bug)

**A multi-claim `settleClaims` batch (n ≥ 2) hard-reverts on Paseo, while a single claim settles.** This was confirmed by a **full fresh redeploy** (2026-06-15, `deploy.ts`, 49 contracts) followed by a clean capture as a properly-staked publisher with PoW disabled:

| Batch (fresh deploy, diana staked, PoW off) | Result | Real `gasUsed` |
|---|---|---:|
| 1 claim × 100 imps | **settled ✅** (`lastNonce` 0→1) | **77,592** (0.0776 PAS) |
| 5 claims × 100 imps | **reverted** (`status=0`, empty `0x`, 0 logs) | 44,354 (revert-path) |
| 10 claims × 100 imps | **reverted** (`status=0`, empty `0x`, 0 logs) | 49,974 (revert-path) |

**The "deploy-state" hypothesis is refuted.** A brand-new deploy with the publisher adequately staked, PoW disabled, and a fresh campaign **still reverts on n ≥ 2** — yet:
- the **identical multi-claim batches settle cleanly in the local EVM** (the stress test in §5.1 settles 1 → 200 claims), and
- single-claim settles fine on the same Paseo path with the same claim format.

⇒ This is a **pallet-revive-specific divergence in the multi-claim settle path**.

#### Root cause (traced 2026-06-15 via `debug_traceTransaction` on the live failing Paseo tx)

`debug_traceTransaction` (callTracer) **is supported on Paseo's eth-rpc** and pinpointed the exact site. The failing n=5 tx call tree:

```
CALL  Settlement                              ⛔ execution reverted
 DELEGATECALL Settlement→LogicA               ⛔ reverted
  DELEGATECALL Settlement→LogicB              ⛔ reverted
   …per-claim validation STATICCALLs…
   CALL BudgetLedger.deductAndTransfer (0x115feb58)  ×5  ── per claim
     └ CALL PaymentVault  (empty selector = native DOT transfer)  ×5
   CALL PaymentVault.creditSettlement (0xdb96c4a4)   ⛔ ERROR = OutOfGas
```

**The revert is `OutOfGas` on the final `PaymentVault.creditSettlement(...)` call — with ~499 M gas still available at that frame (only 726 consumed).** "OutOfGas with abundant gas remaining" is the signature of **pallet-revive's storage-deposit metering** — a balance-reserve resource the EVM does not charge. The per-claim path makes **N separate native value transfers** into the vault (`BudgetLedger.deductAndTransfer` → vault), each reserving a storage deposit; for N ≥ 2 the cumulative deposit exhausts the tx's storage-deposit allowance, so the final `creditSettlement` SSTORE can't reserve its deposit and fails. Single-claim stays under the allowance.

**Why it eludes the obvious suspects (confirmed):**
- The local pallet-revive node (kitchensink, `paritypr/substrate:master-a209e590`) settles n=5 cleanly — both the bare core spine **and** with all five per-claim satellites (PublisherStake/PowEngine/Reputation/Nullifier/RateLimiter) wired (`scripts/repro-multiclaim.ts`). So the bug is **not** in the `LogicA→LogicB` delegatecall/loop or those satellites — that older dev image doesn't enforce storage deposits (or sets a high limit), matching hardhat.
- raising the tx `gasLimit` is not a usable workaround: pallet-revive rejects gasLimits above a few ×10⁹ (`code 1010`), capping the achievable storage-deposit allowance.

**Fix — IMPLEMENTED 2026-06-15 (pending Paseo validation):** the N per-claim `deductAndTransfer` value moves were collapsed into one aggregate transfer + one `creditSettlement` per batch — `BudgetLedger.deduct` (state-only, per claim) + `BudgetLedger.transferSettled` (one transfer), wired through `LogicB.processBatch`. A 5-claim batch now has a 1-claim batch's storage-deposit/transfer footprint. New unit test `test/batched-vault-credit.test.ts` + full suite **1706 passing**. ⚠️ The definitive OOG-fix proof needs a Paseo redeploy (hardhat/old-image don't enforce storage deposits). Full trace, fix, and test status in `docs/multiclaim-revert-rootcause-2026-06-15.md`.

> The 44,354 / 49,974 `gasUsed` are **revert-path cost, not settle cost** — not reported as settle weights.

**Verified single-claim Paseo settle weight (full-feature deploy):** **77,592 weight ≈ 0.078 PAS** (all satellite gates active: publisher-stake, reputation, nullifier, rate-limiter). On the older/leaner live deploy the same op measured 24,167 (warm) / 42,826 (cold) — the difference is the additional per-settle gate reads now wired in.

**Multi-claim cost (proxy):** since Paseo can't execute it, the **local EVM scaling stands** (§5.1): `settleClaims` 5-claim = 512,296 gas, 10-claim = 670,989 gas, ~31,836 gas/claim steady-state.

Other live-deploy thresholds surfaced while probing (full log in `docs/paseo-settle-weight-2026-06-15.txt`):
- **Reason 15 = publisher under-staked** — a freshly-registered publisher must `stake()` `baseStakeWei` (1 DOT) before any settle succeeds.
- `minimumCpmFloor = 1e15 wei` (0.001 DOT) — `createCampaign` below it reverts **E27** (`0xce1ffe13`).
- **BM-10 `_minClaimInterval`** — a 2nd settle by the same `(user, campaign)` in-window rejects (reason 18); use a fresh campaign per measurement.
- Transient `code 1010 Invalid Transaction` / "could not coalesce" gateway errors require tx retries (added to the capture + hit mid-deploy; `deploy.ts` is idempotent so re-running resumes).

---

## 7. Consolidated limits & thresholds reference

| Limit | Value | Enforced by | Lever |
|---|---|---|---|
| Settle batch size (soft) | 50 claims | E28 | `setMaxBatchSize` (owner) |
| Settle batch size (hard ceiling) | 200 claims | E28 / `MAX_BATCH_SIZE_CEILING` | immutable |
| EVM-budget batch ceiling | ~930 claims @ 30M gas | block gas | n/a (cap binds first) |
| Per-block settlement value | configurable (0 = off) | E80 | `setMaxSettlementPerBlock` |
| Per-campaign daily spend | per-campaign `dailyCap` | E26 (hard revert) | set at `createCampaign` |
| Min campaign budget | 0.1 DOT (1e17 wei) | E11 | immutable |
| Settle caller auth | self / relay / attestor / publisher-relay | E32 | publisher `setRelaySigner` |
| Plain-CPM replay protection | economic only (no nonce binding) | budget/cap | AssuranceLevel → nullifier/click/action |
| ZK nullifier replay | per (user, campaign, window) | E73 | nullifier window blocks |
| Governance per-vote / tally cost | O(1) | — | conviction model |
| createCampaign cost vs volume | O(1) (flat) | — | — |

---

## 8. Known gaps / deferred

- **Token plane not in alpha-core surface.** `DatumWrapper`, `DatumVesting`, `DatumBootstrapPool`, `DatumFeeShare`, `DatumMintAuthority` have been **carved out** of the alpha-core contract set (only `DatumEmissionEngine` + `DatumMintCoordinator` remain). The TokenHolder/Vesting/Bootstrap roles in `gas-by-role.md` therefore show as skipped — they are not deployable here.
- **Live Paseo settle weight** — ✅ single-claim captured & verified (§6: 77,592 full-feature / 24,167 warm leaner). **🔴 Multi-claim (n ≥ 2) reverts on Paseo** — confirmed a **pallet-revive runtime bug** via a full fresh redeploy (not deploy-state; local EVM settles fine). This blocks on-chain claim aggregation and needs a contract/runtime root-cause pass (DELEGATECALL chain / precompile / weight metering on the per-claim loop). Direct 5/10-claim Paseo weights are therefore unobtainable until the bug is fixed; local EVM scaling (512,296 / 670,989 gas) is the proxy.
- **`benchmark-paseo.ts` is stale** — uses the old flat claim format, so its settle rows all reject. Needs the same SLIM fix applied to `role-gas-report.ts` this pass.
- **PoW gate weight on Paseo** — not exercised (PoW disabled for the capture); the per-claim `keccak256(claimHash‖powNonce)` preimage cost is excluded from the Paseo settle figures.
- **EmissionEngine ops** (`adjustRate`, `rollEpoch`) — not measured; `rollEpoch` is time-gated (7-year epochs) and not exercisable in-process.

---

## 9. How to reproduce

```bash
cd alpha-core

# Local economic correctness (56 assertions)
npx hardhat test test/benchmark.test.ts

# Cost-per-role report → docs/gas-by-role.md + .csv
npx hardhat run scripts/role-gas-report.ts

# Stress / threshold report → docs/stress-test-report.md
npx hardhat run scripts/stress-test.ts

# Paseo real-weight cost truth (live deploy, no redeploy)
npx hardhat run scripts/gas-costs.ts                  --network polkadotTestnet   # per-function weights
npx hardhat run scripts/capture-settle-weight-paseo.ts --network polkadotTestnet  # verified live settle weight (SLIM-correct)
```

**Artifacts produced this pass:**
- `ALPHA-CORE-BENCHMARKS.md` (this report)
- `docs/gas-by-role.md` + `docs/gas-by-role.csv` (cost-per-role, settlement rows now populated)
- `docs/stress-test-report.md` (4-dimension thresholds)
- `docs/paseo-gas-costs-2026-06-14.txt` (live Paseo per-function weights)
- `docs/paseo-settle-weight-2026-06-15.txt` (verified live settle weight + multi-claim revert findings)
- `scripts/stress-test.ts` (new stress harness)
- `scripts/capture-settle-weight-paseo.ts` (new SLIM-correct live settle-weight capture + reject-reason decode)
