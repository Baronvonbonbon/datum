# DATUM Alpha-4 Security Audit — Settlement Hot Path

**Date:** 2026-05-08
**Auditor:** Internal manual review (Claude Code, inline)
**Build:** solc 0.8.24, evmVersion `cancun`, viaIR, optimizer 200 runs
**Branch:** `main` @ commit `c814ed8` (post-dual-sig + post-mobile-banner-wrap)

## Scope

Six contracts on the settlement hot path, totalling ~1,776 lines:

| Contract | Lines | Why in scope |
|---|---:|---|
| DatumSettlement.sol | 761 | Hot path; new `settleSignedClaims` dual-sig path; merged-in rate limiter / nullifier / reputation |
| DatumClaimValidator.sol | 207 | Validates every claim before settlement |
| DatumRelay.sol | 231 | EIP-712 user-sig + optional publisher co-sig path |
| DatumPaymentVault.sol | 178 | Holds all DOT (publisher / user / protocol) |
| DatumBudgetLedger.sol | 261 | Per-campaign escrow + daily caps |
| DatumTokenRewardVault.sol | 138 | Non-critical ERC-20 sidecar |

Plus the directly-coupled `DatumCampaignLifecycle.sol` (239 lines) and `DatumChallengeBonds.sol` (returnBond path) where Settlement-driven calls cross into them.

## Out of Scope / Limitations

- Off-chain claim builder (extension `claimBuilder.ts`, relay-bot signature path) — assumed correct against on-chain expectations.
- ZK trusted setup (`circuits/impression.circom`) — assumed sound.
- Governance (V2 / Council / AdminGovernance / Router / Timelock / Parameter / PublisherGovernance) — out of this pass; reviewed only the surfaces called from the hot path.
- Pallet-revive runtime guarantees on Polkadot Hub — treated as standard EVM.
- Prior alpha-3 audit items (`archive/docs/SECURITY-AUDIT-2026-04-20.md`, 30 items) assumed implemented; spot-checked AUDIT-002, AUDIT-006, AUDIT-009, AUDIT-016, AUDIT-018, AUDIT-019 — all confirmed present.

## Executive Summary

No critical findings. The hot path is well-structured, follows CEI consistently, uses OZ `ReentrancyGuard` and `EIP712`/`ECDSA` libraries correctly, and the dual-sig settlement path is mostly sound. The most consequential issues are **push-payment DoS vectors** (a malicious contract advertiser with a reverting fallback can grief campaign completion / bond return / settlement budget-exhaustion) and **an unbounded admin sweep** in `DatumPaymentVault` that could drain user balances under guise of "dust" recovery.

### Severity counts

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 4 |
| Low | 4 |
| Informational | 5 |

### Top 3 to address before mainnet

1. **M-1** — Push-payment refunds (`BudgetLedger.drainToAdvertiser`, `ChallengeBonds.returnBond`) revert when advertiser is a contract with a reverting fallback. Side-effect: settlement of a budget-exhausting batch can be DoS'd, locking other users' earnings.
2. **M-2** — `DatumPaymentVault.sweepPublisherDust` / `sweepUserDust` accept an unbounded `threshold` parameter, letting the owner drain *any* balance (not just dust). Cap the threshold or move to governance-gated sweeps.
3. **M-3** — `DatumSettlement.settleSignedClaims` credits 100 % of `agg.publisherPayment` to `claims[0].publisher` even when later claims in the batch reference different publishers (only possible in open campaigns).

---

## Medium

### M-1: Push refunds DoS-able by reverting advertiser fallback

**Files:**
- `alpha-4/contracts/DatumBudgetLedger.sol:172-174`
- `alpha-4/contracts/DatumChallengeBonds.sol:104-105`
- Triggered indirectly via `DatumCampaignLifecycle.sol:117,122` and `DatumSettlement.sol:644-647`

**Code (BudgetLedger):**
```solidity
// alpha-4/contracts/DatumBudgetLedger.sol:172-174
if (drained > 0) {
    _send(advertiser, drained);
}
```
where
```solidity
// alpha-4/contracts/DatumBudgetLedger.sol:255-258
function _send(address to, uint256 amount) internal {
    (bool ok,) = payable(to).call{value: amount}("");
    require(ok, "E02");
}
```

**Code (ChallengeBonds):**
```solidity
// alpha-4/contracts/DatumChallengeBonds.sol:104-105
(bool ok,) = advertiser.call{value: amount}("");
require(ok, "E02");
```

**Settlement auto-trigger:**
```solidity
// alpha-4/contracts/DatumSettlement.sol:644-647
// Auto-complete campaign if budget exhausted
if (agg.exhausted) {
    lifecycle.completeCampaign(agg.campaignIdExhausted);
}
```

**Impact:**
A campaign whose advertiser is a contract with a `receive`/`fallback` that reverts can cause:
1. **`completeCampaign` / `expirePendingCampaign` / `expireInactiveCampaign`** to always revert at either the budget drain or the bond return.
2. **Settlement of the budget-exhausting batch** to revert (the auto-complete path is unconditional). Subsequent claims for that campaign that *don't* exhaust the budget still settle, but the *exact* claim that drains the last drop of budget can never succeed — so a small residual budget is permanently un-settleable.
3. **`terminateCampaign`** (governance-only) to revert at `drainFraction` / `drainToAdvertiser`.

Even though the advertiser is "hurting themselves," users lose the ability to settle the final batch, and the campaign's terminal-status transitions are blocked.

**Recommendation:**
Convert advertiser refunds + bond returns to **pull-pattern**:
- `BudgetLedger` records a `pendingRefund[campaignId]` instead of pushing on drain; advertiser calls `claimRefund(campaignId)` to withdraw.
- `ChallengeBonds.returnBond` records an unlocked balance the advertiser pulls.
- Settlement's auto-complete path becomes safe even when the advertiser is malicious.

**Severity:** Medium. Requires a deliberately-malicious contract advertiser; the protocol mostly assumes EOA advertisers. Low likelihood, but the user-harm consequence (final claim un-settleable) is real.

---

### M-2: `sweepPublisherDust` / `sweepUserDust` accept unbounded threshold

**File:** `alpha-4/contracts/DatumPaymentVault.sol:128-161`

**Code:**
```solidity
// alpha-4/contracts/DatumPaymentVault.sol:128-143
function sweepPublisherDust(
    address[] calldata accounts,
    uint256 threshold,
    address treasury
) external onlyOwner nonReentrant {
    require(treasury != address(0), "E00");
    uint256 total;
    for (uint256 i = 0; i < accounts.length; i++) {
        uint256 bal = publisherBalance[accounts[i]];
        if (bal > 0 && bal < threshold) {
            total += bal;
            publisherBalance[accounts[i]] = 0;
        }
    }
    if (total > 0) _send(treasury, total);
}
```

`sweepUserDust` (lines 146-161) is identical for `userBalance`.

**Impact:**
The function name implies dust (sub-existential-deposit) sweeping, but `threshold` has no upper bound. An owner — or a compromised owner key — can call:

```solidity
sweepUserDust(allKnownUserAddresses, type(uint256).max, ownerWallet);
```

…and drain *every* user balance, not just dust. The same applies to publisher balances. This is a strictly larger trust assumption on the owner than the rest of the contract advertises.

**Recommendation:**
- Hard-cap `threshold` at a small constant (e.g. `MAX_DUST_THRESHOLD = 1e16` planck = 0.001 DOT, comfortably below existential deposit).
- Or require sweeps to go through `Timelock` so users have a 48 h window to withdraw before a malicious sweep clears.
- Or split into two funcs: `setDustThreshold(uint256)` (timelocked) + `sweepDust(accounts, treasury)` reading the stored cap.

**Severity:** Medium. Owner is currently expected to be the Timelock + Governance ladder, which limits exploitability — but the contract should fail safe even with a misbehaving owner.

---

### M-3: dual-sig path attributes all publisher payment to `claims[0].publisher`

**File:** `alpha-4/contracts/DatumSettlement.sol:355-359`, `:577`, `:614-619`

**Code (helper):**
```solidity
// alpha-4/contracts/DatumSettlement.sol:355-359
/// @dev Extract the publisher address from the first claim in a batch.
function _batchPublisher(Claim[] calldata claims) internal pure returns (address) {
    if (claims.length == 0) return address(0);
    return claims[0].publisher;
}
```

**Code (aggregate):**
```solidity
// alpha-4/contracts/DatumSettlement.sol:577
if (agg.publisher == address(0)) agg.publisher = claim.publisher;
```

**Code (credit):**
```solidity
// alpha-4/contracts/DatumSettlement.sol:614-619
// Aggregate paymentVault credit
if (agg.total > 0) {
    paymentVault.creditSettlement(
        agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee
    );
}
```

**Impact:**
In `settleSignedClaims`, the publisher signature is verified against `_batchPublisher(claims)` = `claims[0].publisher` (Settlement.sol:319-333). The `_processBatch` aggregator then sets `agg.publisher` to the first claim's publisher and credits 100 % of `agg.publisherPayment` there.

`DatumClaimValidator` allows open campaigns (`cPublisher == address(0)`) to settle claims with *any* non-zero publisher (line 105). So in a dual-sig batch against an open campaign, claims `[1..n]` can specify publishers different from `claims[0].publisher`, but the aggregate credit still goes to `claims[0].publisher` only.

The `DatumRelay` path explicitly guards against this with an SM-1 check that all claims target the same publisher:

```solidity
// alpha-4/contracts/DatumRelay.sol:179-184
expectedPub = sb.claims[0].publisher;
// SM-1: Verify all claims target the same publisher for open campaigns
for (uint256 i = 1; i < sb.claims.length; i++) {
    require(sb.claims[i].publisher == expectedPub, "E34");
}
```

The dual-sig path (`DatumSettlement.settleSignedClaims`) has **no equivalent check**.

This isn't directly exploitable for theft (the user's claim hash chain still binds each claim's publisher field, and chain continuity is per-actionType, not per-publisher), but it does mean the signing publisher implicitly takes credit for events nominally attributed to other publishers in the same batch.

**Recommendation:**
Either (a) add the same SM-1 same-publisher check to `_batchPublisher`/`settleSignedClaims`, mirroring the relay path, or (b) iterate `_processBatch` per distinct publisher and credit each one separately.

**Severity:** Medium. No direct fund loss, but the dual-sig path's authorization model is meaningfully looser than the relay path's, with no explicit reason for the asymmetry.

---

### M-4: ZK enforcement soft-fails on `getCampaignRequiresZkProof` revert

**File:** `alpha-4/contracts/DatumClaimValidator.sol:155-169`

**Code:**
```solidity
// alpha-4/contracts/DatumClaimValidator.sol:155-169
// Check 9: ZK proof (view claims only, if campaign requires it)
if (claim.actionType == 0 && address(zkVerifier) != address(0)) {
    try campaigns.getCampaignRequiresZkProof(claim.campaignId) returns (bool reqZk) {
        if (reqZk) {
            bool proofPresent = false;
            for (uint256 i = 0; i < 8; i++) { if (claim.zkProof[i] != bytes32(0)) { proofPresent = true; break; } }
            if (!proofPresent) return (false, 16, 0, bytes32(0));
            try zkVerifier.verify(abi.encodePacked(claim.zkProof), computedHash, claim.nullifier, claim.eventCount) returns (bool valid) {
                if (!valid) return (false, 16, 0, bytes32(0));
            } catch {
                return (false, 16, 0, bytes32(0));
            }
        }
    } catch {}
}
```

**Impact:**
The outer `try campaigns.getCampaignRequiresZkProof(claim.campaignId)` has an empty `catch {}`. If `campaigns` reverts (e.g., upgraded to an incompatible interface, paused with a check that throws, or otherwise unresponsive), the catch swallows the error and ZK enforcement is silently skipped — the claim proceeds as if the campaign did not require a proof.

The inner `try zkVerifier.verify(...)` correctly fails closed (rejects with reason 16). The mismatch is in the outer try.

**Recommendation:**
Fail closed on the outer call as well:
```solidity
try campaigns.getCampaignRequiresZkProof(claim.campaignId) returns (bool reqZk) {
    if (reqZk) { /* ... */ }
} catch {
    return (false, 16, 0, bytes32(0)); // treat unreadable campaign as "ZK required, can't verify"
}
```

**Severity:** Medium. Requires a misbehaving `campaigns` contract to be exploitable; the in-tree implementation does not revert on this view. But the asymmetry between inner (fails closed) and outer (fails open) is a hardening regression.

---

## Low

### L-1: `DatumRelay.DOMAIN_SEPARATOR` is immutable, no chain-fork rebuild

**File:** `alpha-4/contracts/DatumRelay.sol:32, 67-73`

**Code:**
```solidity
// alpha-4/contracts/DatumRelay.sol:32
bytes32 public immutable DOMAIN_SEPARATOR;

// alpha-4/contracts/DatumRelay.sol:67-73
DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("DatumRelay"),
    keccak256("1"),
    block.chainid,
    address(this)
));
```

`DatumSettlement` uses OZ `EIP712` (line 40, line 115) which rebuilds the domain separator if `block.chainid` changes — `DatumRelay` does not. On a chain-fork, signatures from one fork could be replayed on the other if the verifying contract is at the same address.

**Recommendation:** mirror the OZ `EIP712` pattern (cache + rebuild-on-chainid-mismatch), or document that mainnet deploys must re-deploy `DatumRelay` if a fork occurs.

**Severity:** Low. Standard EVM concern; rare in practice.

---

### L-2: `abi.encodePacked` for claim hash — currently safe, future-fragile

**File:** `alpha-4/contracts/DatumClaimValidator.sol:142-152`

**Code:**
```solidity
// alpha-4/contracts/DatumClaimValidator.sol:142-152
bytes32 computedHash = keccak256(abi.encodePacked(
    claim.campaignId,
    claim.publisher,
    user,
    claim.eventCount,
    claim.ratePlanck,
    claim.actionType,
    claim.clickSessionHash,
    claim.nonce,
    claim.previousClaimHash
));
```

All nine fields are fixed-size, so the packing is unambiguous *today*. But `abi.encodePacked` allows ambiguous concatenations across mixed types and is a known footgun if the schema is later extended (e.g. adding a `bytes32` adjacent to a `uint8` could collide with a `bytes33`-equivalent). The off-chain claim builder must mirror this byte-for-byte.

**Recommendation:** switch both sides to `abi.encode(...)` (with the same field set) for unambiguous, schema-stable encoding. Coordinate the change with the SDK's `claimBuilder.ts`.

**Severity:** Low. No exploitability today; preventative hardening.

---

### L-3: `BudgetLedger.drainFraction` rounding uses raw multiplication for remainder

**File:** `alpha-4/contracts/DatumBudgetLedger.sol:189-192`

**Code:**
```solidity
// alpha-4/contracts/DatumBudgetLedger.sol:189-192
// AUDIT-009: Use Math.mulDiv for overflow-safe precision; ceiling via +1 if remainder > 0
uint256 floor = Math.mulDiv(remaining, bps, 10000);
uint256 rem = (remaining * bps) % 10000;
uint256 potAmount = rem > 0 ? floor + 1 : floor;
```

The audit comment claims `Math.mulDiv` for overflow safety, but the `(remaining * bps) % 10000` calculation reverts to raw multiplication. With `bps ≤ 10000` and `remaining` bounded by realistic DOT-in-planck amounts (≤ 2¹⁶⁰), this never overflows in practice — but the inconsistency undercuts the AUDIT-009 fix's intent.

**Recommendation:** use `Math.mulDiv(remaining, bps, 10000, Math.Rounding.Ceil)` (OZ 5.0 supports the rounding parameter) and drop the manual remainder calculation.

**Severity:** Low. Not exploitable with realistic inputs.

---

### L-4: `Settlement` swallows token-reward credit failures silently

**File:** `alpha-4/contracts/DatumSettlement.sol:621-624`

**Code:**
```solidity
// alpha-4/contracts/DatumSettlement.sol:621-624
// Aggregate token reward credit (view claims only, non-critical)
if (agg.tokenReward > 0) {
    try tokenRewardVault.creditReward(campaignId, agg.rewardToken, user, agg.tokenReward) {} catch {}
}
```

The `catch {}` is empty. AUDIT-019 added a `RewardCreditSkipped` event inside `DatumTokenRewardVault.creditReward` (verified at TokenRewardVault.sol:74), so the budget-exhausted path *does* emit. But if `creditReward` reverts for an unanticipated reason (e.g. `user == address(0)` — currently impossible from the caller, but a defensive concern), the revert is swallowed with no on-chain trace.

**Recommendation:** emit a `Settlement`-side `RewardCreditFailed(campaignId, user, reward)` event in the catch arm so off-chain monitors can flag mis-wired reward configs.

**Severity:** Low. Currently the vault's own logic prevents the unhandled paths; this is defence-in-depth.

---

## Informational

### I-1: `PaymentVault` and `BudgetLedger` `receive()` accept arbitrary native deposits

**Files:**
- `alpha-4/contracts/DatumPaymentVault.sol:177` — `receive() external payable {}`
- `alpha-4/contracts/DatumBudgetLedger.sol:260` — `receive() external payable {}`

DOT sent directly (not via the documented entry points) is unaccounted for and unwithdrawable. There is no admin recovery function. `DatumChallengeBonds.sol:67` and `DatumTokenRewardVault.sol:137` both explicitly `revert("E03")` on stray native transfers — the pattern should be consistent unless the open `receive()` is required (e.g. for `BudgetLedger`'s `initializeBudget` path). Inspection shows `BudgetLedger.initializeBudget` is `payable` and uses `msg.value` directly, so the `receive()` is *not* required for normal operation. Same for `PaymentVault` (DOT arrives via `BudgetLedger.deductAndTransfer` calling `_send`, which uses `.call{value:...}("")` and that *does* trigger `receive()`).

So `PaymentVault.receive()` is required (BudgetLedger pushes via `.call`); `BudgetLedger.receive()` may not be (no internal call pushes DOT into it). Worth confirming and tightening `BudgetLedger.receive()` to revert.

### I-2: Daily-cap day index susceptible to validator timestamp skew

**File:** `alpha-4/contracts/DatumBudgetLedger.sol:132-138`

```solidity
uint256 today = block.timestamp / 86400;
if (today != b.lastSpendDay) {
    b.dailySpent = 0;
    b.lastSpendDay = today;
}
```

EVM validators can shift `block.timestamp` by ~12 s. At a day boundary this can roll the daily counter early, allowing a small over-spend across the boundary. Standard concern; bounded impact.

### I-3: Empty batch in `settleSignedClaims` is harmless but signed

**File:** `alpha-4/contracts/DatumSettlement.sol:347-353`

`_hashClaims([])` returns `keccak256("")` = a deterministic constant. Both signers can sign an empty batch; settlement does no work and emits no events. Not exploitable, but worth flagging for off-chain hygiene (relay should reject empty batches before forwarding).

### I-4: Dual-sig collapses to single-sig when `publisher == advertiser`

**File:** `alpha-4/contracts/DatumSettlement.sol:330-339`

If a campaign's advertiser registers as a publisher and serves their own campaign, `expectedPublisher == expectedAdvertiser` and a single signature satisfies both checks. Not a bug — just a property of the design — but should be documented so off-chain UX makes the implication clear.

### I-5: Demoted-then-orphaned campaigns are permanently locked

**File:** `alpha-4/contracts/DatumCampaignLifecycle.sol:189-205`

```solidity
campaigns.setPendingExpiryBlock(campaignId, type(uint256).max);
campaigns.setCampaignStatus(campaignId, IDatumCampaigns.CampaignStatus.Pending);
```

`demoteCampaign` sets `expiryBlock = max` to prevent `expirePendingCampaign` from racing the governance termination path. If governance is then bricked or never re-evaluates, the campaign sits in Pending forever and its budget cannot be drained. The governance ladder + Timelock mitigates this in normal operation, but it's a tail risk worth documenting.

---

## Areas Reviewed With No Findings

- **Reentrancy** — every external write (vault credits, drain, withdraw, bond return, token transfers) sits behind OZ `nonReentrant` and follows CEI ordering. The hot path is consistent.
- **EIP-712 domain construction** — `DatumSettlement` uses OZ `EIP712("DatumSettlement","1")`; `DatumRelay` builds its own with a different name (`DatumRelay`). Domain separators cannot collide; cross-path replay impossible.
- **EIP-712 typehash hygiene** — both schemas (`ClaimBatch(...)` in Settlement; `ClaimBatch(...)` and `PublisherAttestation(...)` in Relay) match standard encoding rules; `keccak256(abi.encode(typehash, ...primitive fields))` for the struct hash; `_hashTypedDataV4(structHash)` for the digest.
- **ECDSA recovery** — Settlement uses OZ `ECDSA.recover` (rejects malleable s, validates v, reverts on invalid sigs). Relay does manual `ecrecover` but with explicit `v ∈ {27,28}` check (AUDIT-006) and the canonical-s upper-bound check at lines 169-170 — equivalent to OZ behaviour.
- **Nonce + chain continuity** — `lastNonce` and `lastClaimHash` are triple-keyed `(user, campaignId, actionType)`, mutated post-validation, and the validator's expected-nonce / expected-prevHash arguments are derived from the same triple. Replay-protection inside a chain is sound.
- **Push-down access control** — `creditSettlement`, `creditReward`, `deductAndTransfer`, `drainToAdvertiser`, `drainFraction`, `lockBond`, `returnBond`, `addToPool` all gate on `msg.sender ==` the expected wiring address, set via owner-only setters with non-zero requires.
- **Payment math** — `(ratePlanck × eventCount) / 1000` for views, `ratePlanck × eventCount` for clicks/actions, `× takeRateBps / 10000` for split, `× 7500 / 10000` for user share, `remainder - userPayment` for protocol fee. Rounding direction is consistent (floor on each multiplication-then-divide). Snapshot-locked take rate confirmed at `ClaimValidator.sol:85-86` (campaigns returns the snapshotted `cTakeRate`).
- **Rate limiter** (merged into Settlement) — windowed counter, view-claims-only gate, per-publisher key. Standard.
- **Nullifier registry** (merged) — checked-then-set inside `_processBatch`; redundant `require` after the flag flip is belt-and-suspenders, not a bug.
- **Reputation** (merged) — bookkeeping only; no fund-flow effect; reporter-gated external entry uses `authorizedReporters[msg.sender]`.
- **Zero-event claims** rejected at `ClaimValidator.sol:81` (AUDIT-002 still in place).
- **Same-actionType per chain** enforced implicitly by triple-keyed `lastNonce`.

---

## AUDIT-XXX Items Spot-Checked from Prior Audit

| Item | Status | Where |
|---|---|---|
| AUDIT-002 (zero-event claim rejection) | ✅ Present | ClaimValidator.sol:81 |
| AUDIT-006 (v sanity in ecrecover) | ✅ Present | DatumRelay.sol:169-170 |
| AUDIT-009 (mulDiv in drainFraction) | ⚠️ Partial — see L-3 | BudgetLedger.sol:190 |
| AUDIT-016 (pending-take-rate guard) | ✅ Present | Publishers.sol:134 (out-of-scope file but verified) |
| AUDIT-018 (VerifyingKeySet event) | ✅ Present | ZKVerifier.sol:64,95 |
| AUDIT-019 (RewardCreditSkipped event) | ✅ Present | TokenRewardVault.sol:74 |

---

## Next Steps

1. **M-1** is the highest-impact mainnet blocker — convert advertiser refunds + bond returns to pull-pattern.
2. **M-2** is straightforward: cap the dust threshold or move it behind Timelock.
3. **M-3** can be a one-line `for` loop in `_batchPublisher` mirroring the Relay's SM-1 check.
4. **M-4** is a one-character fix (catch returns false instead of swallowing).
5. After fixes, re-run all 532 alpha-4 tests + add explicit tests for:
   - dual-sig batch with mismatched publishers across claims (open campaign)
   - completeCampaign / returnBond with a contract advertiser whose fallback reverts
   - sweepDust threshold cap
6. External professional audit before Kusama / Polkadot Hub mainnet deployment.
