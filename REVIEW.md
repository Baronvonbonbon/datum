# DATUM PoC Design Review

**Date:** 2026-02-24
**Spec versions reviewed:** Architecture Specification v0.3, PoC Compendium v1.0
**Status:** All 11 issues resolved. 40/40 tests pass.

---

## Executive Summary

Two specification documents were reviewed: the Architecture Specification v0.3 and the PoC Compendium v1.0. The PoC Compendium references "arch spec v0.4" which does not exist — this is an immediate consistency problem that must be resolved before the full 16-week build begins.

The PoC itself has five **blocking issues** (Issues 1–5) that would produce incorrect payment amounts, enable manipulation, or introduce reentrancy vulnerabilities. Six additional issues (6–11) are less severe but would undermine correctness, security, or operability of the PoC. All 11 have been resolved in the implemented contracts.

The three PoC hypotheses have been validated by the test suite:

| Hypothesis | Test group | Result |
|---|---|---|
| Economic model correct | S1–S8, Integration A, B, E | ✅ Pass — exact formula, daily cap, snapshot respected |
| Conviction governance correct | G1–G8, Integration A, B | ✅ Pass — multipliers, thresholds, lockup cap, pull payments |
| State machine correct | L1–L8, Integration A–E | ✅ Pass — all transitions valid; expiry, pause/resume, auto-complete |

---

## Blocking Issues (Issues 1–5)

### Issue 1: Revenue Split Version Mismatch

**Spec (v0.3):** Fixed 55/30/10/5 split (publisher/user/protocol/analytics).
**PoC:** Configurable `takeRateBps` (30–80%) with 75/25 user/protocol of remainder.

**Problem:** The two formulas produce different outcomes at identical publisher rates. With a 55% publisher take in v0.3, the user receives 30% of total payment; with the PoC formula at 55%, the user receives (1–0.55) × 0.75 = 33.75%. The analytics reserve (5%) disappears in the PoC. There is no single canonical formula.

**Fix adopted:** The PoC formula is canonical. The analytics reserve is eliminated as a separate line. Revenue split is:

```
totalPayment     = (clearingCpmPlanck × impressionCount) / 1000
publisherPayment = totalPayment × snapshotTakeRateBps / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder × 7500 / 10000   // 75%
protocolFee      = remainder - userPayment     // 25%
```

The publisher take rate is configurable at registration (30%–80%) and snapshotted at campaign creation. The 75/25 user/protocol split is a governance parameter in the full build.

**Before:** Two incompatible formulas with no canonical resolution.
**After:** Single formula in `DatumSettlement._settleSingleClaim()` (line ~145); validated by S1 and Integration A/E.

---

### Issue 2: Solo-Match Clearing CPM Not Verifiable On-Chain

**Problem:** `clearingCpmPlanck` is submitted by an EOA without an on-chain auction. Any submitter could set clearing CPM to any value up to the 70% floor specified in the PoC, over-extracting from advertisers' bids. The 70% floor cannot be verified without a ZK proof of actual auction outcome.

**Fix adopted:** Remove the solo-match discount from the PoC entirely. The validation becomes:
```solidity
require(clearingCpmPlanck <= campaign.bidCpmPlanck, "CPM exceeds bid");
```
No floor. Document that the 70% floor requires ZK proof of auction outcome; the claim struct must include a ZK proof field from day one (empty in MVP) to avoid a breaking schema change later.

**Before:** `clearingCpmPlanck >= bidCpmPlanck * 70 / 100` — floor unenforced and manipulable.
**After:** `clearingCpmPlanck <= bidCpmPlanck` — ceiling only, validated in `_validateClaim()`.

---

### Issue 3: Hash Chain Gap Behavior Unspecified

**Problem:** The spec says gaps "trigger a flag" but three semantically different interpretations are all consistent with that language:
1. Reject only the gap claim; continue processing later nonces.
2. Stop processing; reject gap and all subsequent claims in the batch.
3. Accept all claims before the gap; reject the gap; accept claims after the gap if their own hash chain is consistent.

Interpretations 1 and 3 allow partial replay attacks. Interpretation 2 is the only safe option.

**Fix adopted:** Stop-on-first-gap. Process nonces in strictly sequential order. Reject the gap claim and all subsequent claims in the batch. Update `lastNonce[user]` to the last accepted nonce. `settleClaims()` returns both `settledCount` and `rejectedCount`.

**Before:** Undefined — any implementation would be spec-compliant.
**After:** Explicit stop-on-gap in `_processBatch()` (line ~80). Validated by Integration D (gap at claim 5 of 10 → exactly 4 settle, 6 rejected).

---

### Issue 4: Reentrancy in Governance Termination Path

**Problem:** `voteNay()` triggered termination which transferred slashed escrow to governance, which distributed to nay voters inline. Any voter who was a contract could reenter `voteNay()` or another governance function before the distribution state was updated.

**Fix adopted:** Pull payment pattern for all reward distribution. At termination time:
- Read `campaign.remainingBudget` before calling `campaigns.terminateCampaign()` (which zeroes it).
- After `terminateCampaign()` transfers DOT to governance, populate `_nayClaimable[campaignId][voter]` mappings proportionally.
- Voters call `claimSlashReward(campaignId)` to withdraw after their lockup expires.
- Same pull pattern for aye rewards via `_ayeClaimable[campaignId][voter]`.
- `ReentrancyGuard` applied to all state-mutating functions in all three contracts.

**Before:** Inline DOT transfer during `voteNay()` — reentrancy possible.
**After:** Two-step: populate mapping → separate `claimSlashReward()` call. Validated by G7 (lockup-gated claim) and Integration B.

---

### Issue 5: Publisher Take Rate Not Locked at Campaign Creation

**Problem:** Publisher registers at 30%, campaigns are created and activated under those terms. Publisher queues an update to 80%. After the 24h delay, existing Active campaigns settle at 80%, paying the publisher 2.67× more than the advertiser agreed to.

**Fix adopted:** Snapshot `takeRateBps` into `campaign.snapshotTakeRateBps` at `createCampaign()` time. Settlement always reads from the snapshot. Rate updates only affect campaigns created after the update is applied.

```solidity
// DatumCampaigns.createCampaign():
uint16 snapshot = _publishers[publisher].takeRateBps;
// stored in Campaign struct as snapshotTakeRateBps

// DatumSettlement._settleSingleClaim():
uint256 publisherPayment = (totalPayment * c.snapshotTakeRateBps) / 10000;
```

**Before:** Settlement reads live `publisher.takeRateBps` — rate updates retroactively affect settled campaigns.
**After:** Settlement reads `campaign.snapshotTakeRateBps`. Validated by Integration E (register 30%, update to 80%, settle → 30% used).

---

## Additional Issues (6–11)

### Issue 6: claimHash Formula Unspecified

**Problem:** The PoC did not define the canonical claim hash formula, leaving the extension-side implementation and on-chain verification disconnected.

**Fix adopted:** `DatumSettlement.computeClaimHash()` is a `public pure` function with a canonical formula:
```solidity
function computeClaimHash(
    uint256 campaignId, address publisher, address user,
    uint256 impressionCount, uint256 clearingCpmPlanck,
    uint256 nonce, bytes32 previousClaimHash
) public pure returns (bytes32) {
    return keccak256(abi.encodePacked(
        campaignId, publisher, user,
        impressionCount, clearingCpmPlanck, nonce, previousClaimHash
    ));
}
```
Genesis claim (nonce=1) must have `previousClaimHash == bytes32(0)`. Validated by S6, S7, and the `computeClaimHash matches off-chain calculation` test.

---

### Issue 7: Settlement Caller Should Be the Claim Owner

**Problem:** Nothing prevented one user from submitting another user's claims, enabling frontrunning of payment or disruption of hash chains.

**Fix adopted:**
```solidity
require(msg.sender == batch.user, "Caller must be claim owner");
```
Applied per-batch at the start of `settleClaims()`. Validated by S3.

---

### Issue 8: No Pending Campaign Timeout

**Problem:** A campaign could remain Pending indefinitely, locking the advertiser's budget with no recourse if governance ignored it.

**Fix adopted:** `campaign.pendingExpiryBlock = block.number + pendingTimeoutBlocks` set at creation. `expirePendingCampaign(campaignId)` is callable by anyone once the block is passed; it transitions Pending → Expired and returns the full budget to the advertiser. Validated by L6 (too-early call reverts; post-timeout succeeds with full refund) and Integration C.

---

### Issue 9: Aye Reward Pool Fate on Termination Undefined

**Problem:** If a campaign is terminated after some aye voters voted, the aye reward pool fate was unspecified. Awarding rewards to all aye voters regardless of whether they voted before or after termination creates an incentive to vote aye on a campaign known to be in distress, extracting rewards without reviewing the campaign.

**Fix adopted:** On termination, only aye voters who voted before `terminationBlock` receive a proportional share of the reward pool (weighted by `lockAmount × 2^conviction`). Aye voters at or after `terminationBlock` receive nothing. Distribution is pull payment via `_ayeClaimable`. Validated by Issue9 test (voter after termination cannot vote; voter before termination receives 100% of pool).

---

### Issue 10: Graduated Nay Lockup Compound Can Produce Extreme Values

**Problem:** Conviction 6 (64× base) × failed nays 4+ (16× base) = 80× base lockup. At a 12s/block with a 24h base (7200 blocks), this is 80 × 7200 = 576,000 blocks ≈ 80 years. Extreme lockup periods make the protocol unusable and may constitute a protocol-level griefing vector.

**Fix adopted:** Absolute cap applied:
```solidity
uint256 total = convictionPart + graduatedPart;
return total > maxLockupDuration ? maxLockupDuration : total;
```
where `maxLockupDuration` defaults to 365 days in blocks (~2,628,000 blocks at 12s). Constructor-configurable, owner-adjustable, and subject to governance in the full build. Validated by G6 (conviction 6 → would be 650 blocks in test env, capped to 100).

---

### Issue 11: Minimum Reviewer Stake Not Enforced

**Problem:** `uniqueReviewers` was incremented for every aye voter regardless of stake size. An adversary could create 5 wallets staking dust amounts to satisfy minimum reviewer thresholds, gaming activation without meaningful economic commitment.

**Fix adopted:** `uniqueReviewers` is only incremented when `msg.value >= minReviewerStake`:
```solidity
if (msg.value >= minReviewerStake) {
    cv.uniqueReviewers++;
}
```
`minReviewerStake` defaults to 10 DOT equivalent (constructor-set, owner-adjustable). Validated by G3 and the `minReviewerStake: update threshold respected` test.

---

## Design Gaps (Not Blocking PoC — Decisions Required Before Full Build)

| Gap | Recommendation |
|-----|----------------|
| **Viewability dispute mechanism** | 7-day challenge window; advertiser bonds 10% of payment; sampling audit via oracle or ZK verification; loser forfeits bond |
| **Publisher SDK integrity** | SDK version hash registry on-chain, analogous to extension version hash registry; settlements reject claims from unregistered SDK versions |
| **Taxonomy governance** | Conviction referendum required for taxonomy changes; 7-day delay before enactment; retroactive effect on active campaigns undefined |
| **Revenue split governability** | 75/25 user/protocol split should be a governance parameter, not a hardcoded constant; define change procedure |
| **Minimum CPM floor** | `minimumCpmFloor` should be a governance parameter; current implementation is owner-settable (acceptable for PoC) |
| **KYB cost responsibility** | Include KYB as a one-time onboarding deposit in `createCampaign()`; waived on repeat campaigns from same advertiser |
| **GDPR right to erasure** | Legal analysis required; technical mitigation: store hash-of-hash on-chain, keep PII off-chain; erasure = delete off-chain source only |
| **Pending campaign timeout** | 30-day default (180,000 blocks); `expirePendingCampaign()` implemented and callable by anyone |
| **Aye reward pool source** | Not specified: who funds it, at what rate? Recommend: small percentage of `protocolFee` per settled claim, accumulated in `ayeRewardPool` |
| **Min reviewer stake in governance** | Confirm 10 DOT equivalent is the right default; should be inflation-adjusted or pegged to USD value in the full build |

---

## Full Build Risk Assessment (Highest to Lowest)

### 1. ZK Proof of Auction Outcome — Extreme Risk
The solo-match 70% floor (Issue 2) requires a ZK proof that the clearing CPM reflects a real auction outcome. This demands:
- Custom ZK circuit for auction clearing
- In-browser WASM prover
- Claim struct with ZK proof field from day one

Proving time in-browser for a Groth16 or PLONK circuit is likely 5–30 seconds per claim batch. This may exceed practical browser limits. **Must prototype before week 4.**

### 2. XCM Retry Queue for Failed HydraDX Swaps — High Risk
When settlement distributes protocol fees to HydraDX via XCM, a dropped message or partial failure leaves the escrow in an inconsistent state. Scenarios include:
- XCM message delivered, HydraDX swap fails (tokens stuck in sovereign account)
- XCM message dropped at relay chain (no delivery receipt)
- Partial batch where some swaps succeed and some fail

Each scenario requires a different recovery path. An XCM retry queue with idempotency keys and bounded retries is essential.

### 3. KILT KYB Integration — High Risk
KILT is a live service with potential:
- Revocation of credentials mid-campaign (what happens to Active campaigns?)
- Jurisdiction coverage gaps (KILT may not cover all required jurisdictions)
- Latency in credential verification (per-claim overhead)

Recommend: treat KILT verification as a one-time onboarding check, not per-claim. Cache credential status with a TTL; revocation marks advertiser as suspended, not retroactively invalid.

### 4. Extension Version Hash Update Coordination — Medium Risk
The gap between an extension release and the corresponding version hash being registered on-chain causes claim rejections for users on the new version. This creates user-visible failures with no clear error message.

Recommend: explicit ops process — hash registration must precede extension release by at least 2 blocks. Staging environment hash registry for pre-validation.

### 5. Publisher Quality Scoring Oracle — Medium Risk
The viewability component of quality scoring requires a trusted oracle until ZK proof is available. Any oracle introduces a centralization risk and a single point of manipulation. Consider a multi-oracle median with a dispute window.

### 6. Conviction Governance Attack Surfaces — Medium Risk
The minimum reviewer requirement (Issue 11) can be gamed by a patient adversary with 5 accounts meeting the stake threshold. Additional mitigations in the full build:
- Time-weighted voting (require vote to be held for N blocks before counting)
- Reviewer reputation scoring based on historical accuracy (past aye votes on terminated campaigns reduce future weight)
- Quadratic reviewer threshold (reviewer count must scale sub-linearly with total aye weight)

---

## Spec Version Alignment Required (v0.4 Document)

The following items must be resolved and documented in a v0.4 architecture specification before the full 16-week build begins:

1. **Revenue split formula** — PoC formula is canonical. Confirm and document with test vectors.
2. **PoC Compendium forward reference** — PoC Compendium v1.0 references "arch spec v0.4" which does not exist. Either update the reference or publish v0.4.
3. **Graduated nay lockup absolute cap** — 365 days in blocks (2,628,000 at 12s/block). Document the conversion assumption.
4. **Identity tier requirements in settlement** — Tier 1 base rate = allowlist in PoC. Full tiers (T2 KILT Basic, T3 KYB) must be defined before the Substrate build.
5. **Campaign creation deposit vs. full budget escrow** — Current implementation escrows full budget at creation. Clarify if a smaller deposit with a top-up mechanism is intended.
6. **Quality score in settlement math** — Explicitly out of scope for PoC. Document where it inserts in the full build formula.
7. **Aye reward pool funding source** — Undefined. Recommend documenting that a percentage of protocol fees fund the pool.
8. **ZK proof field in claim struct** — Must be present (even if empty) from the first Substrate deployment to avoid a breaking storage migration later.

---

## Implementation Notes

### DOT Flow Architecture
The PoC uses a three-contract DOT flow:
1. Advertiser deposits full budget into `DatumCampaigns` at `createCampaign()`.
2. At `deductBudget()`, `DatumCampaigns` forwards the deducted amount to `DatumSettlement`.
3. `DatumSettlement` maintains pull-payment balances (`publisherBalance`, `userBalance`, `protocolBalance`).
4. At termination, `DatumCampaigns` forwards remaining escrow to `DatumGovernance`.
5. `DatumGovernance` maintains `_nayClaimable` and `_ayeClaimable` pull-payment mappings.

All DOT exits the system via explicit withdrawal calls, never inline transfers after state-changing operations.

### Gas Cost Observations (local EVM)
Measured during test suite execution:
- `createCampaign()`: ~180k gas
- `voteAye()` / `voteNay()`: ~100–130k gas
- `settleClaims(1 batch, 5 claims)`: ~200k gas; linear scaling suggests ~500k for 12–15 claims
- `withdrawPublisherPayment()`: ~30k gas

The 50-batch target in the plan spec (~500–800k gas) should be achievable. PolkaVM gas metering differs from EVM; benchmark on `substrate-contracts-node` before setting batch size limits.

### PolkaVM Compatibility Notes
- `abi.encodePacked` in `computeClaimHash()` produces deterministic bytes across EVM and PolkaVM.
- `block.timestamp` and `block.number` are available in PolkaVM but manipulation risks differ from EVM (Polkadot has 6s slot times, not 12s — adjust `takeRateUpdateDelayBlocks` and `pendingTimeoutBlocks` accordingly).
- `ReentrancyGuard` from OpenZeppelin is a storage-lock pattern — compatible with PolkaVM.
- The `receive()` fallback is required on `DatumSettlement` and `DatumGovernance` to accept DOT forwarded from `DatumCampaigns`. PolkaVM supports `receive()`.

---

## File Map

```
poc/
├── contracts/
│   ├── DatumCampaigns.sol          Campaign lifecycle; publisher registry; budget escrow
│   ├── DatumGovernance.sol         Conviction voting; slash/reward pull payments
│   ├── DatumSettlement.sol         Claim validation; hash chain; revenue split
│   ├── interfaces/
│   │   ├── IDatumCampaigns.sol
│   │   ├── IDatumGovernance.sol
│   │   └── IDatumSettlement.sol
│   └── mocks/
│       └── MockCampaigns.sol       Test double for isolated governance/settlement tests
├── test/
│   ├── campaigns.test.ts           L1–L8 + snapshot + publisher validation
│   ├── settlement.test.ts          S1–S8 + gap + genesis + snapshot + hash
│   ├── governance.test.ts          G1–G8 + lockup cap + reviewer stake + issue 9
│   └── integration.test.ts         Scenarios A–E (full three-contract integration)
├── scripts/
│   └── deploy.ts                   Production deployment script
└── hardhat.config.ts
```

**Test results: 40/40 pass.**
