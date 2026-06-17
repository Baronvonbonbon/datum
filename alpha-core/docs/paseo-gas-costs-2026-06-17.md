# DATUM Alpha-Core — Gas & Cost Analysis (2026-06-17 redeploy)

**Deploy under test:** Paseo `polkadotTestnet` (chainId 420420417), fresh redeploy
`deployedAt 2026-06-17Z` under the rotated deployer `0x26194fE2…` (49 core
contracts, validation 91/0). EVM numbers: Hardhat in-process (solc 0.8.24, viaIR,
optimizer 200).

**Unit mapping (confirmed via `eth_getBalance`):** 1 PAS = 10¹⁰ planck;
Paseo `gasPrice` = 10¹² wei/gas ⇒ **fee_PAS = weight / 1,000,000**. EVM "gas" ≠
pallet-revive "weight" — they are reported separately and must not be cross-mapped
(settle is ~7× lower weight on Paseo than EVM gas; see §1).

---

## 0. Headline — the multi-claim batch blocker is RESOLVED

The prior report (`ALPHA-CORE-BENCHMARKS.md`, 2026-06-14) flagged a hard blocker:
*multi-claim `settleClaims` (n≥2) reverted on pallet-revive* — `OutOfGas` in
`PaymentVault.creditSettlement` from N per-claim value transfers (storage-deposit
exhaustion). The **multiclaim-fan-out** work (`DatumSettlementLogicB` batched
deduct/transferSettled, `DatumBudgetLedger` v2) was the fix. **Validated live on
the fresh deploy:**

| n claims | settled | real weight | fee (PAS) | status |
|---:|---:|---:|---:|:--|
| 1  | 1/1  | 78,324 *(cold)* | 0.078324 | ✅ |
| 2  | 2/2  | 42,848 | 0.042848 | ✅ |
| 5  | 5/5  | 50,824 | 0.050824 | ✅ |
| 10 | 10/10 | 64,118 | 0.064118 | ✅ |

`scripts/capture-settle-weight-paseo.ts` (`N_LIST=1,2,5,10`), real on-chain
settles by a seeded user on a fresh campaign per batch size. n=1 is a cold first
settle (pays singleton-slot init); n≥2 are warm.

**Warm Paseo cost model** (fit on n=2/5/10, ignoring the cold n=1):
```
weight(n) ≈ 37,530 + 2,659·n     (pallet-revive weight)
```
- **Marginal ≈ 2,659 weight/claim ≈ 0.00266 PAS/claim.**
- A full 10-claim batch = 64,118 weight = **0.0064 PAS/claim amortized** — vs. the
  old report's single-claim-only **77,592/claim**. ~12× cheaper per claim at n=10.

---

## 1. Settlement paths (all exercised)

| Path | Env | gas / weight | Notes |
|---|---|---:|---|
| `settleClaims` 1 view-claim | Paseo | 78,324 wt (cold) | real on-chain |
| `settleClaims` 2 / 5 / 10 | Paseo | 42,848 / 50,824 / 64,118 wt | fan-out batch (warm) |
| `settleClaims` 1 (EVM) | EVM | 566,985 gas (cold) | warm marginal ≈ 15,175 gas/claim |
| `settleClaims` 5 / 10 / 25 / 50 | EVM | 451,971 / 527,668 / 755,124 / 1,134,853 gas | batch cap = 50 |
| `settleClaims` 1 CPC click | EVM | 197,587 gas | actionType=1 |
| `settleClaims` 1 CPA action | EVM | 390,305 gas | actionType=2 (ECDSA actionSig) |
| `settleSignedClaims` (dual-sig) | EVM | 512,952 gas | publisher+advertiser EIP-712 cosigned |
| `withdrawUserBySig` (gasless) | EVM | 76,654 gas | relay-submitted, user pays nothing |
| `settleClaimsMulti` (multi-user) | model | ≈ Σ batches + ~per-user ClaimBatch overhead | same per-claim spine as settleClaims |
| ZK-gated settle | partial | base settle + BN254 pairing verify | `ZKVerifier.verify` live-callable (empty→false, malformed→false); BN254 ecPairing ~51–88× cheaper than Eth mainnet |
| PoW-gated settle | supported | base settle + on-chain `keccak(claimHash‖powNonce)` target check | `capture-settle-weight-paseo.ts` mines a powNonce per claim when `enforcePow` |
| ERC-20 reward sidecar | functional | non-critical `creditReward` alongside DOT | `e2e-token-rewards.ts`; asset-gated (allowlist) |

EVM warm settle model: `gas(n) ≈ 376,096 + 15,175·n` (100 imps/claim). The marginal
is far below the old `GAS-AB.md` baseline (44,570) — reflects the validateClaim
context-hoist + batched vault credits.

---

## 2. Cost per role

Full table: `docs/gas-by-role.md` (regenerated 2026-06-17, 40 measured ops, EVM
in-process). Selected per-role headline ops:

| Role | Operation | gas (EVM) |
|---|---|---:|
| **Advertiser** | createCampaign | 455,882 |
| | vote (own campaign) | 350,241 |
| **Publisher** | registerPublisher | 117,984 |
| | setRelaySigner | 80,712 |
| | publisherStake.stake | 114,607 |
| | vault.withdrawPublisher | 34,953 |
| **Relay** | settleClaims (1×100 imp) | 566,985 |
| | settleClaims (10) | 527,668 |
| | settleClaims (50, cap) | 1,134,853 |
| | settleSignedClaims (dual-sig) | 512,952 |
| | withdrawUserBySig (gasless) | 76,654 |
| **User** | zkStake.depositWith | 202,178 |
| | reportPage | 118,478 |
| | setUserMinAssurance | 48,416 |
| | vault.withdrawUser | 35,689 |
| **Voter** | governance.vote (aye / nay) | 333,141 / 355,360 |
| | evaluateCampaign | 74,489 |
| | *(Paseo real vote)* | *40,153 wt (0.040 PAS)* |
| **Reporter V1** | commitStakeRoot (threshold 1) | 235,939 |
| **Reporter V2** | joinReporters / proposeRoot / finalizeRoot | 164,966 / 251,216 / 212,646 |
| **Council** | propose / vote / execute | 338,347 / 79,039 / 132,374 |
| **Curator** | blockAddr / unblockAddr | 73,034 / 30,500 |
| **Challenger** | registerCommitment | 172,346 |
| **Admin** | pause / proposeCategoryUnpause / approve | 170,543 / 142,517 / 117,012 |
| **TokenHolder** | wrapper.wrap / unwrap | 116,169 / 58,197 |
| | feeShare.stake / claim(+fees) / unstake | 115,794 / 86,146 / 51,874 |

---

## 3. DATUM token plane

Exercised in-process (`scripts/token-gas-probe.ts`): MintAuthority + Wrapper +
FeeShare + Vesting on the `AssetHubPrecompileMock`.

| Op | gas | Notes |
|---|---:|---|
| precompile.approve | 46,753 | canonical DATUM allowance for wrap |
| wrapper.wrap (canonical→WDATUM) | 116,169 | atomic transferFrom + mint 1:1 |
| wrapper.unwrap (WDATUM→canonical) | 58,197 | burn + release (devnet shim) |
| feeShare.stake | 115,794 | stake WDATUM |
| feeShare.claim (no fees / with fees) | 33,124 / 86,146 | DOT dividend payout |
| feeShare.unstake | 51,874 | |
| vesting.release | — | reverts pre-cliff (1y cliff / 4y) — expected |

**Live-Paseo token deploy deferred:** `deploy-token.ts` is a devnet/mock stack
(`AssetHubPrecompileMock`) and uses `.wait()`, incompatible with the Paseo eth-rpc
receipt bug; a real Paseo/mainnet deploy needs the XCM-aware Wrapper variant
(`PRE-MAINNET-CHECKLIST.md §L3`). The fresh core deploy does not wire a token
plane (dormant), so nothing in the rotated system depends on the old token-plane
contracts.

---

## 4. Method & caveats

- **EVM ≠ Paseo weight.** EVM gas (Hardhat) is deterministic and used for the
  per-role + path matrix and large-N scaling; live Paseo weight is the cost truth
  for settlement. The two diverge most on settle (EVM 1-claim 566k gas vs Paseo
  78k weight) because pallet-revive prices storage/calls differently.
- **Stale harnesses:** `benchmark-gas.ts` and `benchmark-testnet.ts` build the
  pre-fan-out *flat* claim and no longer encode against the nested-proof ABI
  (`Claim{publisher,eventCount,rateWei,actionType,proof[]}`) — both error on
  `settleClaims`. Current settle harnesses: `role-gas-report.ts` (EVM) and
  `capture-settle-weight-paseo.ts` (Paseo). `gas-costs.ts` mostly reverts
  post-rotation (setters are Timelock-owned ⇒ E18 as the deployer).
- **Cold vs warm:** the first settle on a fresh deploy pays singleton-slot
  initialization (cold). Steady-state cost is the warm marginal.
