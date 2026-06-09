# Claim settlement gas — A/B prototypes

Harness: `test/gas-ab.test.ts` — settles an N-claim single-campaign view batch via
`settleClaims`, reads `gasUsed` from the receipt. Warmup settle first so persistent
singleton slots are non-zero (keeps rows monotonic). Same setup as `settlement.test.ts`.

Marginal per-claim = (total(20) − total(10)) / 10. Fixed per-batch = total(1) − marginal.

## Baseline (branch point `f617f17`, unmodified)

| N  | total gas | per-claim (total/N) |
|----|-----------|---------------------|
| 1  |   353,004 | 353,004 |
| 5  |   531,274 | 106,254 |
| 10 |   754,067 |  75,406 |
| 20 | 1,199,867 |  59,993 |

- **Marginal per-claim ≈ 44,570 gas**
- **Fixed per-batch ≈ 308,400 gas**

The marginal is dominated by `DatumClaimValidator.validateClaim` running ~8
campaign/publisher-invariant external staticcalls **per claim** (getCampaignForSettlement,
getCampaignPot, isBlocked, allowlist count/gate/take-rate, activationBonds.isMuted,
requiresZk), plus per-claim cold SSTOREs to the nonce/hash/settled chain slots.

## #1 Hoist (campaign-invariant reads → once per batch)

`DatumClaimValidator.validateClaim` split into `resolveBatchContext` (all
campaign/publisher-invariant reads + gates, once per batch) + `validateClaimWithContext`
(per-claim-varying checks only). `DatumSettlementLogicB` resolves the context once before
the loop and hoists the S12 + CB1 publisher blocklist gates (publisher invariant via E34).
Single-actionType enforced per-claim (reason 21) so the hoisted pot read stays valid.
Back-compat `validateClaim` retained (composes the two) for direct callers/tests.

| N  | total gas | per-claim | Δ vs baseline |
|----|-----------|-----------|---------------|
| 1  |   356,215 | 356,215 | +3,211 |
| 5  |   483,749 |  96,749 | −47,525 |
| 10 |   643,120 |  64,312 | −110,947 |
| 20 |   962,065 |  48,103 | −237,802 (−19.8%) |

- **Marginal per-claim ≈ 31,880 gas** (was 44,570 → **−28.5%**)
- **Fixed per-batch ≈ 324,300 gas** (up ~16k: context now resolved once per batch)
- **≈1.40× more claims per batch** at the same gas ceiling (large-N regime).
- N=1 pays a ~3k penalty (two validator calls instead of one) — immaterial for the
  large relay batches this targets.
- 114/114 settlement + validator tests green; split is behaviour-neutral (back-compat
  wrapper), only the rejection-reason *precedence* shifts for pathological double-failure
  claims (e.g. eventCount==0 on an inactive campaign now reports the campaign reason first).

### Further per-claim levers (not done here)
- `budgetLedger.deductAndTransfer` still runs **per claim** (external call + SSTORE + DOT
  transfer). The batch already accumulates `agg.total`/`agg.publisherPayment`; debiting once
  per batch would cut another external call per claim — but it moves the budget-exhaustion
  boundary to batch granularity, so it needs its own correctness pass.
- `validateClaimWithContext` is still an external CALL per claim; inlining into LogicB
  would save the call overhead at the cost of LogicB bytecode (EIP-170 budget).

## #2 Slim wire format (replace in place)

## #2 Slim wire format (replace in place)

_pending_
