# Datum Alpha-3 Security Audit
**Date:** 2026-04-20  
**Scope:** All 26 production contracts, alpha-3 v8 (Paseo deployment)  
**Status:** Internal — pre-external-audit working document  

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 4 |
| HIGH | 9 |
| MEDIUM | 7 |
| LOW | 5 |
| INFO | 5 |
| **Total** | **30** |

**Key risk areas:**
1. Governance attacks — re-vote conviction downgrade, last-minute vote flips
2. Nullifier/replay race condition between registration and claim finalization
3. Arbitrary calldata execution via ParameterGovernance
4. Unbounded bonding curve — DOS via impression count inflation
5. Precision loss in proportional share and bond calculations
6. Silent failures on bond returns and token reward credits

---

## Critical Findings

---

### AUDIT-001 — Re-vote Conviction Downgrade Attack
**Severity:** CRITICAL  
**Contract:** DatumGovernanceV2  
**Location:** `vote()` ~line 192–222

**Description:**  
A voter who previously voted with high conviction (e.g., conviction 8, 21× weight, 365-day lockup) can re-vote on the same campaign at a lower conviction after their lockup expires. The old lock refund is issued and the voter's influence drops, but there is no requirement that re-votes maintain or exceed prior conviction. This allows an attacker to acquire cheap governance influence: vote high, wait for lockup to expire naturally, re-vote low with no additional skin-in-the-game. Governance weight can thus be manipulated over time without economic cost.

**Recommendation:**  
Disallow re-votes that lower conviction. Require `newConviction >= oldConviction`, or enforce a cooldown period before a lower-conviction re-vote is permitted. Alternatively, prohibit re-voting entirely and require explicit `withdrawVote()` before re-voting.

---

### AUDIT-002 — Nullifier Registration / Claim Finalization Race
**Severity:** CRITICAL  
**Contract:** DatumSettlement  
**Location:** `_processBatch()` ~line 401–450

**Description:**  
The nullifier registry check (`submitNullifier()`) occurs before payment deduction, but the actual nullifier registration happens after. If the transaction reverts after the nullifier is written but before full settlement state is updated (e.g., in a downstream call to reputation, stake, or token reward vault), the nullifier is orphaned — the claim is blocked for replay while the settlement never completed. Conversely, if the nullifier write is not atomic with the claim hash advancement, a partially reverted batch may leave the system in an inconsistent state where a claim is blocked by a nullifier but the nonce chain hasn't advanced.

**Recommendation:**  
Move nullifier registration to immediately after claim validation and before any payment operations. Ensure the nullifier write and nonce chain advancement are in the same atomic block. Add a separate "pending nullifiers" set if full atomicity cannot be guaranteed.

---

### AUDIT-003 — Low-Level Call Silent Failure Patterns
**Severity:** CRITICAL  
**Contract:** DatumPaymentVault  
**Location:** `_send()` ~line 140–143

**Description:**  
`_send()` uses `.call{value: ...}("")` and requires the boolean return (`require(ok, "E02")`), which is correct — but several callers across the system (CampaignLifecycle's bond returns at ~line 137 and 195, and TokenRewardVault's credit path) wrap similar calls without requiring success, explicitly treating failure as non-critical. If the downstream contract (ChallengeBonds, TokenRewardVault) is paused or in a broken state, bond funds and reward credits are silently orphaned with no recovery path for affected users.

**Recommendation:**  
Either require all fund-transfer calls to succeed (fail-fast), or implement an explicit recovery queue that allows users to reclaim orphaned funds via a separate function. The current "non-critical" designation for reward credits is acceptable by design, but bond return failures should always be required.

---

### AUDIT-004 — Arbitrary Calldata Execution via ParameterGovernance
**Severity:** CRITICAL  
**Contract:** DatumParameterGovernance  
**Location:** `execute()` ~line 178–197

**Description:**  
The `execute()` function calls `.call(payload)` on an arbitrary `target` address with arbitrary `payload`. While guarded by governance quorum and a timelock, there is no validation that `payload` is a valid function selector, no whitelist of permitted targets, and no restriction on the function being called. A malicious governance proposal could call any function on any contract — including functions that transfer ownership, drain funds, or brick the protocol. The timelock delay provides a window to react but not a structural guarantee.

**Recommendation:**  
Restrict `target` to a whitelist of known protocol contracts. Restrict `payload` to a whitelist of permitted function selectors per target (e.g., only `setParam(bytes32, uint256)` on registered target contracts). Alternatively, replace the generic execute mechanism with typed setter functions that explicitly enumerate the parameters ParameterGovernance can change.

---

## High Findings

---

### AUDIT-005 — Allowlist State Not Snapshotted at Campaign Creation
**Severity:** HIGH  
**Contract:** DatumClaimValidator  
**Location:** `validateClaim()` ~line 104–107

**Description:**  
For open campaigns (`publisher == address(0)`), the claim validator checks the claiming publisher's live `allowlistEnabled` flag. If a publisher enables their allowlist after an open campaign was created, they are retroactively excluded from that campaign. If they later disable it, they are re-included. This creates non-deterministic claim eligibility over a campaign's lifetime. A publisher who was eligible at campaign creation can be griefed into ineligibility by temporarily enabling their allowlist.

**Recommendation:**  
Snapshot `allowlistEnabled` for each publisher at campaign creation in a per-campaign mapping, analogous to how relay signer is currently snapshotted. Use the snapshotted value during claim validation.

---

### AUDIT-006 — Missing `v` Validation in Relay Signature Parsing
**Severity:** HIGH  
**Contract:** DatumRelay  
**Location:** `settleClaimsFor()` ~line 91–103

**Description:**  
Inline assembly extracts `r`, `s`, `v` from the 65-byte signature. The code validates `s` against the curve half-order (malleability guard) but does not validate that `v` is 27 or 28. `ecrecover()` with an invalid `v` returns `address(0)`, which is caught by the subsequent non-zero check — so this is not an exploitable vulnerability today. However, it is a fragile pattern: if the zero-address check is ever loosened or refactored, the invalid-v path becomes exploitable.

**Recommendation:**  
Add explicit `require(v == 27 || v == 28, "E30")` immediately after extracting `v` from assembly.

---

### AUDIT-007 — Re-vote Stake Overwrite in PublisherGovernance
**Severity:** HIGH  
**Contract:** DatumPublisherGovernance  
**Location:** `vote()` ~line 167–210

**Description:**  
A voter who re-votes (after their prior lockup expires) has their old `lockAmount` returned inline within the vote call. If the voter re-votes with a higher amount, the new lock overwrites the old record. The old stake is refunded, but there is no event indicating the refund amount, and the voter may not realize the old position was merged into the new one. More critically, a voter whose lockup just expired can re-vote with a tiny amount (1 planck) to reset their lock record, then withdraw immediately — effectively un-staking without going through the formal `withdrawVote()` path.

**Recommendation:**  
Disallow re-voting while any prior vote is locked: `require(v.lockAmount == 0 || block.number >= v.lockedUntilBlock, "E42")`. Require explicit `withdrawVote()` before casting a new vote. Emit a `VoteRefunded(voter, amount)` event on any implicit refund.

---

### AUDIT-008 — Tag Registry Fail-Open When Unset
**Severity:** HIGH  
**Contract:** DatumCampaignValidator  
**Location:** `validateCreation()` ~line 85–87

**Description:**  
If `targetingRegistry` is `address(0)`, the call to `hasAllTags()` is skipped and tag requirements are not enforced. A campaign created with `requiredTags` while the registry is unset will silently allow any publisher — the tags are stored but never enforced. An admin who inadvertently sets the registry to zero (or deploys without wiring it) creates a silent compliance gap.

**Recommendation:**  
If `requiredTags.length > 0` and `targetingRegistry == address(0)`, revert with a clear error rather than silently pass. Treat the registry as required when tags are specified.

---

### AUDIT-009 — Rounding and Overflow Risk in BudgetLedger
**Severity:** HIGH  
**Contract:** DatumBudgetLedger  
**Location:** `deductAndTransfer()` ~line 131–158, `drainFraction()` ~line 188

**Description:**  
`drainFraction()` uses ceiling division: `(remaining * bps + 9999) / 10000`. If `remaining` is near `type(uint256).max` and `bps` is even 2, the multiplication `remaining * bps` will overflow before the addition, silently wrapping to a small value and resulting in an incorrect (too small) drain. The guard `require(bps <= 10000)` protects against extreme `bps` values but not against large `remaining` values in combination with moderate `bps` values. The `remaining` here is a contract ETH balance which is bounded by what's deposited, so in practice this is unlikely — but the pattern is unsafe.

**Recommendation:**  
Use checked arithmetic (`unchecked` block is not present, so overflow should revert in Solidity 0.8.x — verify this assumption holds). Alternatively, use OpenZeppelin's `Math.mulDiv()` for safe fixed-point multiplication.

---

### AUDIT-010 — Gas Exhaustion DOS in Settlement Batch
**Severity:** HIGH  
**Contract:** DatumSettlement  
**Location:** `settleClaims()`, `settleClaimsMulti()`, `_processBatch()` ~line 172–466

**Description:**  
A batch of 50 claims × downstream calls (rate limiter, publisher stake, nullifier registry, reputation, token reward, lifecycle) can consume significant gas per claim. On Paseo (and eventually Polkadot Hub), block gas limits differ from Ethereum mainnet. If a batch exhausts gas mid-processing, all state changes in the transaction revert (including nullifiers already written in the same TX — see AUDIT-002). Legitimate relay operators cannot predict safe batch sizes without empirical calibration per deployment.

**Recommendation:**  
(1) Reduce maximum batch size to 10 claims while gas characteristics are unknown.  
(2) Add a `gasleft()` check before each claim: revert with partial-batch error if remaining gas < configurable minimum.  
(3) Document empirical gas costs on Paseo after live testing.

---

### AUDIT-011 — Last-Minute Vote Flip in GovernanceV2
**Severity:** HIGH  
**Contract:** DatumGovernanceV2  
**Location:** `evaluateCampaign()` ~line 281–296

**Description:**  
Resolution is triggered whenever `ayeWeighted * 10000 > total * 5000` (simple majority). A well-funded attacker watching mempool can submit a high-conviction aye vote in the final block before evaluation, flipping the outcome. The grace period mechanism only delays termination after nay crosses a threshold, not after aye crosses the threshold — so a late aye vote cannot be countered by nay before the campaign survives evaluation. This asymmetry means aye can win with a single last-moment whale vote.

**Recommendation:**  
Apply a symmetric grace period: if a decisive vote arrives within the final N blocks before evaluation, extend the voting window by N blocks (for both aye and nay). Alternatively, take a time-weighted average of conviction votes rather than a spot-in-time snapshot.

---

### AUDIT-012 — Unbounded Bonding Curve in PublisherStake
**Severity:** HIGH  
**Contract:** DatumPublisherStake  
**Location:** `requiredStake()` ~line 170–172

**Description:**  
Required stake grows as: `baseStakePlanck + cumulativeImpressions * planckPerImpression`. There is no cap. Over a long deployment with `planckPerImpression > 0`, a high-volume publisher's required stake will monotonically increase without bound. At some point it will exceed any practical stake amount, permanently blocking the publisher from withdrawing (they must always maintain `stake >= requiredStake`). An attacker who can artificially inflate a publisher's impression count (e.g., via sybil claims or governance) can trap the publisher's capital indefinitely.

**Recommendation:**  
Add `MAX_REQUIRED_STAKE` cap: `min(base + impressions * rate, MAX_REQUIRED_STAKE)`. Add an admin (governance-timelocked) function to reset cumulative impressions for a publisher. Consider impression count decay for impressions older than a rolling window.

---

### AUDIT-013 — Precision Loss in ChallengeBonds Bonus Calculation
**Severity:** HIGH  
**Contract:** DatumChallengeBonds  
**Location:** `claimBonus()` ~line 136–168

**Description:**  
The bonus share is calculated as `share = (bondAmt * pool) / total`. If `bondAmt` is small relative to `total`, this rounds to zero, and the advertiser receives nothing despite having a valid claim. This is pure precision loss — there's no minimum, no accumulator, no carry-over. In a system with many small bond holders, the largest bonds will capture a disproportionate share due to truncation, and small holders will receive exactly zero.

**Recommendation:**  
Use `Math.mulDiv(bondAmt, pool, total)` (OZ 4.9+) to avoid overflow while preserving precision. Add a minimum bonus floor. Consider accumulating precision remainders and distributing them to the last claimant.

---

## Medium Findings

---

### AUDIT-014 — Slash Reward Double-Claim Guard Insufficient
**Severity:** MEDIUM  
**Contract:** DatumGovernanceSlash  
**Location:** `claimSlashReward()` ~line 65–89

**Description:**  
The `claimed[campaignId][msg.sender]` guard prevents double-claims on the same campaign. However, it doesn't verify the campaign's final status has not been reset. While the current design makes campaign status terminal once resolved, the guard relies on external state that is not owned by GovernanceSlash. A future upgrade that allows campaign status to reset would silently break the double-claim protection.

**Recommendation:**  
Add an explicit status check within `claimSlashReward()`: require the campaign status is `TERMINATED` (4) or the appropriate final status code. Don't rely solely on the `claimed` mapping.

---

### AUDIT-015 — Silent Bond Return Failure in CampaignLifecycle
**Severity:** MEDIUM  
**Contract:** DatumCampaignLifecycle  
**Location:** `completeCampaign()` ~line 137, `expireInactiveCampaign()` ~line 195

**Description:**  
Bond return calls to ChallengeBonds use `.call(...)` without requiring success. The comment labels this "non-critical," but a failed bond return means advertiser funds are permanently stranded in ChallengeBonds with no recovery mechanism. If ChallengeBonds is paused or has a bug, campaigns can be completed/expired while advertisers lose their bonds silently.

**Recommendation:**  
Either require bond return success (`require(ok, "E02")`), or implement a `pendingBondReturn[campaignId]` mapping that advertisers can claim manually if the automatic return fails.

---

### AUDIT-016 — Take Rate Update Race Condition
**Severity:** MEDIUM  
**Contract:** DatumPublishers  
**Location:** `updateTakeRate()` ~line 76–103

**Description:**  
A publisher can call `updateTakeRate()` multiple times before the pending update is applied, silently overwriting the queued value. No event is emitted on `applyTakeRateUpdate()`. Off-chain indexers cannot reliably track which pending value was actually applied. Additionally, there's no prevention of a publisher toggling between two rates rapidly to confuse advertisers who rely on the displayed rate.

**Recommendation:**  
(1) Revert if a pending update already exists: `require(pub.pendingTakeRateBps == 0 || block.number >= pub.pendingTakeRateAppliesAt, "E15")`.  
(2) Emit `TakeRateApplied(address publisher, uint16 newRate)` on `applyTakeRateUpdate()`.

---

### AUDIT-017 — NullifierRegistry Accepts Nullifiers for Non-Existent Campaigns
**Severity:** MEDIUM  
**Contract:** DatumNullifierRegistry  
**Location:** `submitNullifier()` ~line 92–97

**Description:**  
The registry registers nullifiers for arbitrary campaign IDs without verifying the campaign exists. If Settlement is compromised or mis-wired, an attacker with Settlement's role could pre-register nullifiers for future campaign IDs, blocking legitimate claims before those campaigns are created.

**Recommendation:**  
Add a campaign existence check via a static call to the Campaigns contract before registering a nullifier. Alternatively, reject nullifiers for campaign IDs above the current campaign counter.

---

### AUDIT-018 — No Verifying Key Integrity Hash
**Severity:** MEDIUM  
**Contract:** DatumZKVerifier  
**Location:** `setVerifyingKey()` ~line 78–97

**Description:**  
The verifying key (VK) is set once by the owner and cannot be verified on-chain against a known checksum. A compromised owner key could set a malicious VK that accepts fabricated proofs. There is no event emitting a hash of the VK that validators could verify off-chain. Mainnet requires an MPC ceremony VK — without a hash commitment, there is no trustless way to confirm the correct VK was set.

**Recommendation:**  
Emit a `VerifyingKeySet(bytes32 vkHash)` event containing `keccak256(abi.encode(alpha1, beta2, gamma2, delta2, IC))`. Publish the expected hash derived from the MPC ceremony output. Require VK updates to go through a governance timelock.

---

### AUDIT-019 — Silent Budget Exhaustion in TokenRewardVault
**Severity:** MEDIUM  
**Contract:** DatumTokenRewardVault  
**Location:** `creditReward()` ~line 85–101

**Description:**  
When the token budget is exhausted mid-batch, subsequent claims receive zero reward with only a contract-level event (not a per-user event). Users cannot distinguish between "settlement succeeded with reward" and "settlement succeeded but reward was silently dropped." In a 50-claim batch where the budget runs out after claim 10, claims 11–50 receive nothing but appear successful.

**Recommendation:**  
Emit a per-user event `RewardCreditSkipped(campaignId, token, user, amount)` when a credit is dropped. Consider surfacing this in the relay bot output so operators can identify exhausted campaigns.

---

### AUDIT-020 — Auto-Completion Triggered Mid-Batch
**Severity:** MEDIUM  
**Contract:** DatumSettlement  
**Location:** `_processBatch()` ~line 510–515

**Description:**  
When a claim exhausts campaign budget, `lifecycle.completeCampaign()` is called immediately within the per-claim loop. Subsequent claims in the same batch will then fail validation (campaign is `Completed`, not `Active`) and are silently skipped. The batch result looks successful but several claims were not settled. If the relay bot doesn't check per-claim results, these users are not credited and must resubmit.

**Recommendation:**  
Defer auto-completion to after the full batch loop. Set a flag (`campaignExhausted = true`) and call `lifecycle.completeCampaign()` once at the end of the batch, after all claims have been attempted.

---

## Low Findings

---

### AUDIT-021 — Executed Proposals Deleted From PauseRegistry State
**Severity:** LOW  
**Contract:** DatumPauseRegistry  
**Location:** `execute()` ~line 112–114

**Description:**  
Proposals are deleted after execution, leaving no on-chain record of what was proposed, who voted, when, and what action was taken. Only events provide history, and events are not available via `eth_call` (only via logs). Forensic analysis of past governance actions requires a full node with log access.

**Recommendation:**  
Mark proposals as `executed` rather than deleting them: set `proposal.executedBlock = block.number`. Keep the storage slot for auditability.

---

### AUDIT-022 — Campaign Creation Allows Dust Budget
**Severity:** LOW  
**Contract:** DatumCampaigns  
**Location:** `createCampaign()` ~line 176–177

**Description:**  
The check `require(msg.value > bondAmount)` allows campaigns to be created with 1 planck of budget. Such campaigns cannot serve any realistic impressions (CPM floor will reject them) but consume state. An attacker could spam campaign creation with minimal budget to inflate campaign counters and storage.

**Recommendation:**  
Add `require(msg.value - bondAmount >= MINIMUM_BUDGET_PLANCK)` with a reasonable floor (e.g., 10^12 planck = 100 mDOT).

---

### AUDIT-023 — No Per-Address Deduplication on Reports
**Severity:** LOW  
**Contract:** DatumReports  
**Location:** `reportPage()`, `reportAd()` ~line 30–52

**Description:**  
The same address can submit unlimited reports on the same campaign, inflating report counts. While reports are advisory and don't trigger on-chain enforcement, inflated counts could mislead governance participants who use report counts as a signal.

**Recommendation:**  
Add `mapping(uint256 => mapping(address => bool)) public hasReported` and enforce one report per address per campaign.

---

### AUDIT-024 — System Precompile Availability Rechecked on Every Call
**Severity:** LOW  
**Contract:** DatumGovernanceHelper  
**Location:** `checkMinBalance()` ~line 47–52

**Description:**  
Every invocation of `checkMinBalance()` checks `SYSTEM_ADDR.code.length > 0`. This is a cold storage read on every call and is unnecessary — precompile availability doesn't change after deploy.

**Recommendation:**  
Cache the result in a `bool immutable systemPrecompileAvailable` set in the constructor. This also makes the behavior explicit and auditable.

---

### AUDIT-025 — Targeting Registry Cleared Without Event
**Severity:** LOW  
**Contract:** DatumCampaignValidator  
**Location:** `setTargetingRegistry()` ~line 41–45

**Description:**  
Setting `targetingRegistry` to `address(0)` silently disables tag enforcement. No distinct event is emitted for this case. Off-chain monitors cannot easily detect when tag enforcement is disabled.

**Recommendation:**  
Emit a distinct event `TargetingRegistryCleared()` when set to `address(0)`, separate from the normal `TargetingRegistrySet(address)` event.

---

## Info / Minor Findings

---

### AUDIT-026 — Raw Function Selectors Without Documentation
**Severity:** INFO  
**Contract:** DatumSettlement  
**Location:** Throughout `_processBatch()`

**Description:**  
Multiple static calls use hardcoded 4-byte selectors (e.g., `bytes4(0xfbac3951)`) without comments documenting the function they correspond to. This makes future audits and selector verification error-prone.

**Recommendation:**  
Add inline comments: `bytes4(0xfbac3951) // isBlocked(address)`. Consider defining them as named constants at the top of the file.

---

### AUDIT-027 — Nullifier Registration Comment Is Misleading
**Severity:** INFO  
**Contract:** DatumSettlement  
**Location:** `_processBatch()` ~line 446–450

**Description:**  
The comment "Register nullifier after successful settlement" is inaccurate — the nullifier is registered after payment deduction but before downstream integrations (reputation, stake, token rewards). If downstream calls revert, the nullifier was registered but the full settlement may not be complete.

**Recommendation:**  
Update comment to: "Register nullifier after payment deduction. Downstream integrations (reputation, stake, rewards) follow — if these revert, the nullifier is orphaned. See AUDIT-002."

---

### AUDIT-028 — Zero-Impression Publisher Has Perfect Reputation Score
**Severity:** INFO  
**Contract:** DatumPublisherReputation  
**Location:** `getScore()` ~line 113–119

**Description:**  
A publisher with zero impressions returns score 10000 (perfect). This means new publishers start with the highest possible reputation, which could be exploited if reputation score gates anything (it currently does not gate Settlement, but it may in future).

**Recommendation:**  
Document clearly: new publishers start at 10000 (perfect). If score is used as a gate in future, consider returning a neutral sentinel value (e.g., 5000) for zero-impression publishers instead.

---

### AUDIT-029 — Timelock Blocked by Stuck Proposal
**Severity:** INFO  
**Contract:** DatumTimelock  
**Location:** `propose()` ~line 34

**Description:**  
If a pending proposal exists and `execute()` consistently fails (e.g., target contract reverts), the timelock is permanently blocked — no new proposals can be submitted until the old one is cancelled. The cancel function (`cancel()`) is owner-only, so a single stuck proposal requires admin intervention.

**Recommendation:**  
Add a proposal timeout: if the pending proposal is older than `PROPOSAL_TIMEOUT` blocks, allow it to be overwritten. Alternatively, allow any guardian to cancel a timed-out proposal.

---

### AUDIT-030 — Window Boundary Behavior Undocumented in RateLimiter
**Severity:** INFO  
**Contract:** DatumSettlementRateLimiter  
**Location:** `checkAndIncrement()` ~line 77–85

**Description:**  
Two claims submitted in the same block that straddle a window boundary (one at block 99, one at block 100 of a 100-block window) are charged to different windows. This is correct but may surprise operators who expect a publisher to consume their full window quota in a single batch. With very small window sizes, this creates edge cases in batch processing.

**Recommendation:**  
Document minimum recommended window size (>= 100 blocks). Add a `windowSize >= MIN_WINDOW_SIZE` check in the constructor or `setRateLimit()`.

---

## Findings by Contract

| Contract | Critical | High | Medium | Low | Info |
|---|---|---|---|---|---|
| DatumGovernanceV2 | 1 (001) | 1 (011) | — | — | — |
| DatumSettlement | 1 (002) | 1 (010) | 1 (020) | — | 2 (026, 027) |
| DatumPaymentVault | 1 (003) | — | — | — | — |
| DatumParameterGovernance | 1 (004) | — | — | — | — |
| DatumClaimValidator | — | 1 (005) | — | — | — |
| DatumRelay | — | 1 (006) | — | — | — |
| DatumPublisherGovernance | — | 1 (007) | — | — | — |
| DatumCampaignValidator | — | 1 (008) | — | 1 (025) | — |
| DatumBudgetLedger | — | 1 (009) | — | — | — |
| DatumPublisherStake | — | 1 (012) | — | — | — |
| DatumChallengeBonds | — | 1 (013) | — | — | — |
| DatumGovernanceSlash | — | — | 1 (014) | — | — |
| DatumCampaignLifecycle | — | — | 1 (015) | — | — |
| DatumPublishers | — | — | 1 (016) | — | — |
| DatumNullifierRegistry | — | — | 1 (017) | — | — |
| DatumZKVerifier | — | — | 1 (018) | — | — |
| DatumTokenRewardVault | — | — | 1 (019) | — | — |
| DatumPauseRegistry | — | — | — | 1 (021) | — |
| DatumCampaigns | — | — | — | 1 (022) | — |
| DatumReports | — | — | — | 1 (023) | — |
| DatumGovernanceHelper | — | — | — | 1 (024) | — |
| DatumPublisherReputation | — | — | — | — | 1 (028) |
| DatumTimelock | — | — | — | — | 1 (029) |
| DatumSettlementRateLimiter | — | — | — | — | 1 (030) |
| DatumTargetingRegistry | — | — | — | — | — |
| DatumAttestationVerifier | — | — | — | — | — |

---

## Priority Fix List

**Must fix before any external audit submission:**

| ID | Severity | Title |
|---|---|---|
| AUDIT-001 | CRITICAL | Re-vote conviction downgrade — implement conviction floor |
| AUDIT-002 | CRITICAL | Nullifier race condition — register before payment ops |
| AUDIT-003 | CRITICAL | Silent bond return failures — require success or recovery queue |
| AUDIT-004 | CRITICAL | Arbitrary ParameterGovernance execution — whitelist targets + selectors |
| AUDIT-010 | HIGH | Settlement batch gas exhaustion — reduce batch limit, add gasleft check |
| AUDIT-012 | HIGH | Unbounded bonding curve — add MAX_REQUIRED_STAKE cap |
| AUDIT-020 | MEDIUM | Auto-completion mid-batch — defer to after loop |
| AUDIT-015 | MEDIUM | Silent bond return failure in Lifecycle — add recovery path |

**Fix before mainnet:**

| ID | Severity | Title |
|---|---|---|
| AUDIT-005 | HIGH | Allowlist state not snapshotted — snapshot at campaign creation |
| AUDIT-011 | HIGH | Last-minute vote flip — symmetric grace period |
| AUDIT-013 | HIGH | Precision loss in bonus calc — use mulDiv |
| AUDIT-018 | MEDIUM | No VK integrity hash — emit keccak of VK |
| AUDIT-019 | MEDIUM | Silent reward drops — emit per-user skip event |
| AUDIT-007 | HIGH | Re-vote stake overwrite — require explicit withdraw first |

---

*This document is internal and untracked. Do not commit without redacting sensitive deployment details.*
