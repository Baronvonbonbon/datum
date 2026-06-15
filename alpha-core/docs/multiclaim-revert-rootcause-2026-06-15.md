# Multi-claim settle revert on Paseo — root cause (2026-06-15)

## Symptom
`settleClaims` with a batch of n ≥ 2 claims **hard-reverts** on Paseo (pallet-revive), while
n = 1 settles. The same multi-claim batches settle cleanly on the hardhat in-process EVM
(the stress test settles 1→200 claims). Confirmed on both the original live deploy and a
full fresh redeploy with the publisher adequately staked and PoW disabled.

## Investigation path
1. **Hardhat EVM (control):** core settle spine settles n=1 and n=5 — ✅ (`scripts/repro-multiclaim.ts`).
2. **Local pallet-revive node** (kitchensink Docker: `paritypr/substrate:master-a209e590` +
   `paritypr/eth-rpc:master-87a8fb03`, eth-rpc on :8545): core spine settles n=5 — ✅;
   with **all five per-claim satellites** wired (PublisherStake/PowEngine/Reputation/
   NullifierRegistry/RateLimiter) it **still settles n=5** — ✅. ⇒ the bug is NOT in the
   `LogicA→LogicB` delegatecall/loop nor those satellites. (This older dev image doesn't
   enforce storage deposits, so it behaves like the EVM.)
3. **`debug_traceTransaction` on the real failing Paseo tx** (callTracer is supported on
   Paseo eth-rpc) — this gave the exact revert site.

## Root cause
Trace of the failing n=5 tx (`0xdf7da663…`, Settlement `0xa4f6312b…`):

```
CALL  Settlement                                   ⛔ execution reverted   (gasUsed 44,354)
 DELEGATECALL Settlement→LogicA                     ⛔ reverted
  DELEGATECALL Settlement→LogicB                    ⛔ reverted
   …per-claim validation STATICCALLs (Campaigns, Publishers, ClaimValidator, …)…
   CALL BudgetLedger.deductAndTransfer (0x115feb58)  ×5   ← one per claim
     └ CALL PaymentVault  (empty selector = native DOT transfer)  ×5
   CALL PowEngine (consumeFor)
   CALL PaymentVault.creditSettlement (0xdb96c4a4)   ⛔ ERROR = OutOfGas
```

- `0x115feb58` = `DatumBudgetLedger.deductAndTransfer(uint256,uint8,uint256,address)` — per claim.
- `0xdb96c4a4` = `DatumPaymentVault.creditSettlement(address,uint256,address,uint256,uint256)` — final aggregate credit.

The revert is **`OutOfGas` on `PaymentVault.creditSettlement`** — but ~499,943,173 gas was
available at that call frame and only 726 was consumed before the OOG. "OutOfGas with
abundant gas remaining" is the hallmark of **pallet-revive storage-deposit metering**: a
balance-reserve resource (per new storage entry) that the EVM does not charge.

The per-claim path performs **N separate native value transfers** into the PaymentVault
(`deductAndTransfer` → vault), each reserving a storage deposit. For N ≥ 2 the cumulative
storage deposit exhausts the tx's storage-deposit allowance (derived from the gasLimit), so
the final `creditSettlement` SSTORE can no longer reserve its deposit → OutOfGas → the whole
batch reverts. N = 1 stays under the allowance.

This is why it reproduces on Paseo (enforces storage deposits) but NOT on hardhat (no such
resource) nor the older local pallet-revive dev image (deposits disabled / high limit).

## Why gasLimit isn't a workaround
Raising the eth `gasLimit` (→ a higher storage-deposit allowance) is not viable: pallet-revive
rejects gasLimits above ~a few ×10⁹ with `code 1010 Invalid Transaction` (10 ×10⁹ rejected;
500 M / 2 B accepted). The achievable allowance is capped below what an N-claim batch needs.

## Fix (contract-side, definitive) — IMPLEMENTED 2026-06-15
Collapse the **N per-claim `deductAndTransfer` value moves into a single aggregate native
transfer + a single `creditSettlement`** at batch end, so an N-claim batch has the
storage-deposit / transfer footprint of a 1-claim batch.

Implemented as a split:
- `DatumBudgetLedger.deduct(campaignId, actionType, amount) → exhausted` — state-only pot
  accounting (same E16/E26/daily-cap/exhaustion as `deductAndTransfer`, **no transfer**).
- `DatumBudgetLedger.transferSettled(recipient, amount)` — one settlement-only native transfer.
- `DatumSettlementLogicB.processBatch` — per claim calls `deduct(...)`; after the loop, in the
  `agg.total > 0` block, calls `transferSettled(vault, agg.total)` once, then the unchanged
  `creditSettlement(...)`. (`deductAndTransfer` retained, marked deprecated, for compat.)

**Test status:**
- `test/batched-vault-credit.test.ts` (new) — proves `deduct` transfers nothing and
  `transferSettled` moves the aggregate in one transfer; gates + exhaustion preserved. ✅
- Full suite **1706 passing / 0 failing** (incl. settlement multi-claim S2, settleClaimsMulti
  SM4, stake-gate SM14/15, and the Settlement/LogicA/LogicB storage-layout invariant). ✅
- ⚠️ **Definitive OOG-fix validation still pending:** hardhat and the old local kitchensink
  image don't enforce storage deposits, so they confirm functional equivalence but not the
  deposit reduction. Must be validated by a **Paseo redeploy + re-run of the multi-claim
  capture** (expect n=5/n=10 to settle), or a revive-dev-node matching Paseo's runtime version.

## Reproduce
```
# local pallet-revive node
docker run -d --name substrate -p 9944:9944 paritypr/substrate:master-a209e590 --dev --rpc-external --rpc-cors=all
docker run -d --name eth-rpc --network host paritypr/eth-rpc:master-87a8fb03 --rpc-port 8545 --node-rpc-url ws://127.0.0.1:9944
# (note: this old image does NOT enforce storage deposits, so it does NOT reproduce — it
#  exonerates the core path. A node matching Paseo's runtime version is needed to repro locally.)
npx hardhat run scripts/repro-multiclaim.ts                 # hardhat control
SATS=all npx hardhat run scripts/repro-multiclaim.ts --network substrate

# trace the real failing Paseo tx:
curl -s -d '{"id":1,"jsonrpc":"2.0","method":"debug_traceTransaction","params":["<txhash>",{"tracer":"callTracer"}]}' https://eth-rpc-testnet.polkadot.io/
```
