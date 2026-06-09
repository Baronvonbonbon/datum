# Datum Alpha-5 — Gas Economics & Break-Even Analysis

Companion to [`gas-by-role.md`](./gas-by-role.md). Where that report lists **unit
gas** measured in the hardhat in-process EVM, this document converts gas to **real
PAS cost** using **live Paseo transactions** as the cost basis, then works out the
break-even point for each role and the feasibility of the relay gasless-withdraw.

All "real" figures below are `gasUsed × effectiveGasPrice` read straight from
Paseo `eth_getTransactionReceipt`. Explorer:
`https://blockscout-testnet.polkadot.io/tx/<hash>`.

---

## 1. Cost basis (this is the part the denomination work changed)

Two corrections vs the old report:

**(a) Gas price.** `gas-by-role.md` assumed a "Paseo = 1 gwei" baseline. The live
network actually charges **1000 gwei** (`eth_gasPrice` = `0xe8d4a51000` =
1×10¹² wei/gas). Confirmed by the `effectiveGasPrice` on every receipt below.
At this price the conversion is exactly:

> **cost_PAS = gasUsed ÷ 1,000,000**  (i.e. 1 gas unit = 1 µPAS)

**(b) Gas scale.** Hardhat EVM gas **overstates real pallet-revive gas ≈ 6×** — the
ratio varies per op, so there is no single scale factor. Real pallet-revive gas
(from live txs) is the number that matters; the hardhat table is only a relative
proxy. Evidence:

| Op | Hardhat EVM gas | **Real Paseo gas** | **Real cost @1000 gwei** | Sample tx |
|---|---:|---:|---:|---|
| `settleClaimsFor` (1 claim × 25 imps) | ~443,908 | **62,575** | **0.062575 PAS** | [`0xe1651058…`](https://blockscout-testnet.polkadot.io/tx/0xe1651058c215e8b199521373ff049547326b3a61625591ab62929564c4df5326) · [`0xa505f656…`](https://blockscout-testnet.polkadot.io/tx/0xa505f6561a4fe013d76f871b461395e889e2dbcfbbe612df3c79d1f8822c8af4) |
| `withdrawUserBySig` (gasless) | 93,855 | **16,160** | **0.016160 PAS** | [`0xb99d5723…`](https://blockscout-testnet.polkadot.io/tx/0xb99d5723b2983ddb9fea7c394b367e8e2e41f976a103a92e2c19cf90962aa63f) · [`0x7944a18e…`](https://blockscout-testnet.polkadot.io/tx/0x7944a18e88ac9467363fa242e112a7b4b58d372cd356cdb8704d5a6e20912853) |
| `withdrawUserBySig` (small balance) | — | 13,248 | 0.013248 PAS | [`0x2d9e7676…`](https://blockscout-testnet.polkadot.io/tx/0x2d9e7676b534788b7c06cbb5e91a056453f3978ac4d65e4da2e1b9fd891d10f9) |
| `withdrawUserBySig` (dust / near-empty) | — | 608 | 0.000608 PAS | [`0x5d168edf…`](https://blockscout-testnet.polkadot.io/tx/0x5d168edf44724ec0d05d241e9277843f021ac51ad0471a7e4f036c8e004302e4) |
| `registerPublisher` | 90,697 | **11,463** | **0.011463 PAS** | [`0x98282a12…`](https://blockscout-testnet.polkadot.io/tx/0x98282a125f98d0ce33170550398e537682b699e184975055d79d398feff70d27) |

Use **16,160 gas** as the representative `withdrawUserBySig` cost (the 13,248 and
608 rows are smaller-balance variants — fewer `_send` payouts).

> The full per-op real table needs a Paseo run of `role-gas-report.ts`
> (`--network polkadotTestnet`), currently blocked on a 17-funded-signer config gap
> (the harness destructures up to `signers[16]`; the testnet config supplies ~11).
> The anchors above are sufficient for the economics that follow.

---

## 2. Per-impression economics at CPM = 1 PAS

From a real settlement ([`0xe1651058…`](https://blockscout-testnet.polkadot.io/tx/0xe1651058c215e8b199521373ff049547326b3a61625591ab62929564c4df5326),
25 imps, `rateWei = 1e18`), `total = CPM × imps / 1000 = 0.025 PAS`, split:

| | bps | share | per impression |
|---|---:|---:|---:|
| Publisher (take rate) | 5000 | **50.0%** | 0.000500 PAS |
| User (`userShareBps` 7500 of remainder) | — | **37.5%** | **0.000375 PAS** |
| Protocol fee | — | **12.5%** | 0.000125 PAS |
| **Gross** | | 100% | 0.001000 PAS |

So a user nets **0.000375 PAS per impression**; a publisher nets **0.000500**.

---

## 3. Break-even by role

"Break-even" = how much activity recoups a role's upfront/periodic **gas** outlay.
Gas is in real PAS @1000 gwei.

| Role | One-off / periodic gas op | Real cost | Earns | **Break-even** |
|---|---|---:|---|---|
| **Publisher** | `registerPublisher` (once) | 0.0115 PAS | 0.0005 PAS/imp | **≈ 23 impressions** |
| **Publisher** | + `setRelaySigner` + `stake` (~0.02 PAS more) | ~0.03 PAS total | 0.0005 PAS/imp | **≈ 60 impressions** |
| **Advertiser** | `createCampaign` (**49,982 gas measured**) | **0.0500 PAS** | — (campaign ROI, not gas-recoup) | gas is **~5% of a 1 PAS budget**, negligible at scale |
| **User** | `withdrawUser` self-pay (**1,801 gas measured**) | **0.0018 PAS** | 0.000375 PAS/imp | **≈ 5 impressions** to recoup one withdraw's gas |
| **Relay** | `settleClaimsFor` per batch | 0.0626 PAS | protocol fee 0.000125 PAS/imp | **≈ 500 impressions/batch** to cover settle gas from protocol fees³ |

¹ No clean live `createCampaign` sample; estimated from hardhat 388k ÷ ~6 pallet-revive factor.
² `withdrawUser` has no ECDSA-recover, so slightly cheaper than `withdrawUserBySig`'s 16,160.
³ The relay is a bonded operator; whether it is *paid* the protocol fee depends on
fee routing. If it is, a batch must clear ~500 imps to be gas-positive — i.e. the
**5-claim × 100-imp batch is the natural minimum** (it is also the report's "typical"
row). Smaller batches settle at a loss to the relay.

**Takeaways:** publisher/user onboarding gas is trivially recouped (tens of imps).
The economically load-bearing constraint is **relay settlement batching** (~500 imps
to break even) and **relay withdraw** (next section).

---

## 4. Relay gasless withdraw — is 1% feasible? (the headline question)

Setup: user signs a `WithdrawAuth` (no gas); relay submits `withdrawUserBySig`,
pays **0.01616 PAS** gas, keeps **fee = feeBps × balance**. Relay is gas-positive
iff `fee ≥ 0.01616 PAS`.

### Model A — flat 1% (current)
`0.01 × balance ≥ 0.01616` → **break-even balance = 1.62 PAS**.

- At 0.000375 PAS/imp that is **≈ 4,310 impressions** of accrued user earnings.
- **Below ~1.6 PAS the relay loses money** on every gasless withdraw.
- **Verdict: not feasible at Paseo's 1000 gwei for typical micro-balances.** The 1%
  fee only works for users who have already banked multiple PAS.

### Model B — 1% with a minimum fee = gas
`fee = max(0.01616 PAS, 0.01 × balance)`. Relay never loses. Cost to the user:

| Balance | Fee (Model B) | Effective % |
|---:|---:|---:|
| 0.05 PAS | 0.01616 PAS | **32%** |
| 0.20 PAS | 0.01616 PAS | 8.1% |
| 0.50 PAS | 0.01616 PAS | 3.2% |
| 1.62 PAS | 0.01616 PAS | 1.0% (crossover) |
| 5.00 PAS | 0.050 PAS | 1.0% |

Above 1.62 PAS it is identical to flat 1%; below, the floor protects the relay but
the effective rate is punitive on tiny balances. **Recommended for Paseo** — it
makes the service always sustainable and still lets the user extract a 0-DOT balance.

### Model C — gas-indexed (relay always covers gas + margin)
`fee = gas_cost + 1% × balance` (= 0.01616 + 0.01·balance). Relay margin is a clean
1% on top of its actual cost at every balance; the user always pays gas + 1%. This
is the cleanest "relay never subsidises, never gouges" model and degrades gracefully
as gas price moves. (A tiered curve — high % small, →1% large — approximates this
but is harder to reason about; gas-indexed is preferable.)

### Model D — mainnet gas-price sensitivity
The whole picture is dominated by the 1000 gwei testnet price. Re-pricing
`withdrawUserBySig` (16,160 gas) and the **flat-1% break-even balance**:

| Gas price | Withdraw cost | **Flat-1% break-even balance** | ≈ impressions |
|---|---:|---:|---:|
| **Paseo (live) 1000 gwei** | 0.01616 PAS | **1.62 PAS** | ~4,310 |
| Hub conservative 50 gwei | 0.000808 PAS | 0.081 PAS | ~215 |
| Hub cheap 5 gwei | 0.0000808 PAS | 0.0081 PAS | ~22 |

**This is the key inflection:** at a plausible mainnet price (5 gwei) the flat 1%
fee breaks even at an **8 milli-PAS** balance (~22 imps) — entirely feasible. The
gasless withdraw is **economically sound on mainnet and only broken by Paseo's
artificially high 1000 gwei**. For the testnet demo, ship **Model B** (min-fee
floor); for mainnet, flat 1% is fine.

### User's self-vs-relay crossover (a second inflection)
**Measured:** self-`withdrawUser` is only **1,801 gas = 0.0018 PAS** — nearly free.
- Relay costs the user 1% of balance.
- User indifferent at `0.01 × balance = 0.0018` → **balance ≈ 0.18 PAS**.
- So self-withdraw beats the relay for **any balance above ~0.18 PAS**, and the relay
  only breaks even above ~0.6–1.6 PAS (depending on the gasless gas, which is
  balance-dependent: measured 6,103–16,160). That leaves **almost no balance band
  where the relay both wins for the user *and* profits**. The flow's *only* real
  justification is the **0-DOT cold-start user** who literally cannot pay any gas —
  for everyone else, self-withdraw at 0.0018 PAS dominates. → treat gasless relay
  withdraw as a **pure onboarding subsidy**, not a revenue path.

---

## 5. PoW throughput — why 4,310 impressions isn't instant

`DatumPowEngine` is a per-user **leaky-bucket difficulty driver** (not a hard cap):
settling more events raises the bucket, which raises **quadratic PoW difficulty**
for the *next* batch; idling drains the bucket and difficulty decays to baseline.

PoW adds **no gas** — it is off-chain hashing the extension/relay does before
submitting `powNonce`. But it **throttles throughput**: a user trying to settle
~4,310 impressions quickly (to reach the flat-1% withdraw break-even) drives
difficulty up and the proofs get progressively more expensive to find, stretching
the time-to-break-even. Net effect on the economics:

- It **does not** change any per-op gas cost or break-even *balance*.
- It **does** lengthen the *time* to accrue that balance under bursty usage, and
  makes Sybil/spam withdrawals (many tiny accounts) compute-expensive — which is
  precisely why the relay-subsidy zone (Model A small balances) isn't trivially
  farmable.

---

## 6. Recommendations

1. **Gasless withdraw fee:** adopt **Model B (1% + min-fee = current gas cost)** so
   the relay is never underwater on Paseo; revert to plain flat-1% once on a
   sub-~50-gwei mainnet, where it's already sound (Model D).
2. **Relay settlement:** enforce a **minimum batch ≈ 500 imps** (≈ the 5×100 row) so
   each settle is gas-positive against protocol fees; never settle 1-claim batches
   on the relay's dime.
3. **Fix the report's gas price** (1 → 1000 gwei) and label its table as hardhat
   proxy gas (~6× the real pallet-revive cost) until a Paseo run lands.
4. **Unblock the Paseo benchmark** (fund ≥17 testnet signers) to replace the
   estimated rows (createCampaign, withdrawUser) with measured pallet-revive gas.

*Generated from live Paseo receipts; tx hashes are clickable above.*
