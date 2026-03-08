# DATUM PoC Design Review

**Date:** 2026-02-24 (original review); 2026-03-03 (web3 alignment addendum); 2026-03-08 (extension UI addendum, V2 overhaul, P6/P16/P19 complete)
**Spec versions reviewed:** Architecture Specification v0.3, PoC Compendium v1.0
**Status:** All 11 issues resolved. PoC: 64/64 tests. Alpha (current): 100/100 tests — see ALPHA.md for Governance V2, A1.1-A1.3 changes, and current contract architecture (5+1+1+1+1 contracts). All alpha-scope code COMPLETE — pending local devnet E2E validation (A3.2) and Paseo deployment (A3.3).

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
- `terminateCampaign()` sends 10% of remaining budget to governance (slash pool) and refunds 90% to the advertiser. The 10% cap prevents griefing where competitors vote nay to steal an advertiser's full budget.
- After `terminateCampaign()` transfers the 10% slash to governance, populate `_nayClaimable[campaignId][voter]` mappings proportionally.
- Voters call `claimSlashReward(campaignId)` to withdraw after their lockup expires.
- Same pull pattern for aye rewards via `_ayeClaimable[campaignId][voter]`.
- `ReentrancyGuard` applied to all state-mutating functions in all contracts.

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

## Web3 Philosophy Alignment (2026-03-03 Addendum)

An analysis of the protocol against core web3 principles: trustlessness, permissionlessness, censorship resistance, self-sovereignty, credible neutrality, and verifiability. Items already captured in the deferred table or design gaps above are not repeated here. This section identifies **critical missing steps** not previously documented.

### Critical: Impression attestation is entirely self-reported — PARTIALLY ADDRESSED

The entire revenue flow starts with the extension self-reporting impression counts. The settlement contract verifies the hash chain is internally consistent but has no mechanism to verify that an impression actually occurred. A modified extension or raw contract call can fabricate unlimited impressions at max CPM, draining advertiser escrow.

The deferred "ZK proof of auction outcome" and "viewability dispute mechanism" are adjacent but distinct problems. Neither addresses the fundamental gap: **there is no proof of impression**.

**Minimum viable mitigation — IMPLEMENTED (2026-03-03):** Publisher co-signature verification in DatumRelay. `SignedClaimBatch` carries an optional `bytes publisherSig` field. When present, the relay verifies an EIP-712 `PublisherAttestation(uint256 campaignId, address user, uint256 firstNonce, uint256 lastNonce, uint256 claimCount)` signature against the campaign's registered publisher (resolved via `campaigns.getCampaignForSettlement()`). This creates two-party attestation: the user attests they saw the ad, the publisher attests they served it. When `publisherSig` is empty, the relay operates in degraded trust mode (backward compatible). Error codes: E33 (invalid sig length), E34 (wrong publisher signer). Tests R7-R10 validate the happy path and three failure modes.

**Remaining gaps:** (1) Publisher attestation endpoint (`.well-known/datum-attest`) not yet implemented — publishers cannot yet produce co-signatures in practice. (2) Direct user submission (without relay) has no attestation enforcement; a separate `DatumAttestationVerifier` wrapper is post-MVP. (3) Degraded trust mode means co-signatures are optional, not mandatory.

**Behavioral analytics commitment (P16 — planned):** On-device engagement metrics (dwell time, scroll depth, tab focus, IAB viewability) captured per impression and committed via an append-only behavior hash chain. Each claim includes a `bytes32 behaviorCommit` binding the user's engagement evidence to the claim chain. Raw metrics never leave the device; selective disclosure allows users to prove specific metrics (e.g., "average dwell >5s") during disputes without revealing full browsing data. Natural upgrade path to ZK behavior proofs (prove engagement properties in-circuit without revealing raw data).

**Longer-term paths:** TEE attestation (extension runs in trusted execution environment), ZK proof of DOM state (extension proves it rendered specific content), random sampling with oracle verification, or ZK behavior proofs (prove engagement metrics satisfy thresholds without revealing raw data).

### Critical: No price discovery mechanism

`clearingCpmPlanck` is chosen unilaterally by the claim submitter (the extension hardcodes it to `bidCpmPlanck`). The only constraint is `clearingCpm <= bidCpm`. Every impression extracts the maximum possible amount. There is no auction, no second-price logic, no competitive pressure. This is a fixed-price payment system, not an exchange.

The deferred "ZK proof of auction outcome" assumes an auction exists. It does not. An auction mechanism must be designed before a ZK proof of its integrity has meaning.

**Minimum viable mitigation:** Off-chain batch auction per campaign per epoch. Multiple users submit sealed bids (or the extension submits at a system-determined clearing rate). The clearing CPM for the epoch is the second-highest bid or a supply/demand equilibrium. The clearing rate is published and verifiable.

### Critical: Owner can redirect settlement and governance without timelock

`DatumCampaigns.setSettlementContract()` and `setGovernanceContract()` are callable by the owner at any time with no timelock, no multisig, no event that would alert users. An owner who calls `setSettlementContract(malicious)` can drain all campaign escrows via `deductBudget`. An owner who calls `setGovernanceContract(malicious)` can terminate any campaign and extract the 10% slash.

The deferred "contract ownership transfer" addresses who holds the key, not what the key can do. Even with a multisig, unilateral contract-reference changes without a timelock are incompatible with censorship resistance.

**Minimum viable mitigation:** Timelock on all admin setters (e.g., 48-hour delay with on-chain event). Users can exit (withdraw, complete campaigns) during the delay if they disagree with the change. Post-MVP: governance approval required for contract reference changes.

### Critical: Aye reward distribution is owner-computed off-chain

`creditAyeReward()` is `onlyOwner` with no on-chain verification of proportional correctness. The owner can allocate 100% of rewards to a single address. This undermines the economic incentive for honest governance review. Slash rewards (`distributeSlashRewards`) are correctly computed on-chain; aye rewards should follow the same pattern.

**Current reason:** PVM bytecode size limits prevent an on-chain voter-loop. As resolc/PVM matures and bytecode limits relax, this should move on-chain. Until then, document the trust assumption explicitly and publish the off-chain computation for independent verification.

### High: Campaign-publisher binding prevents open marketplace

Each campaign is bound to a single publisher at creation. An advertiser wanting reach across 100 publishers must create 100 separate campaigns with 100 separate escrows. This is a bilateral deal system, not a permissionless marketplace.

**Post-MVP path:** Campaign creation specifies category and bid parameters without a fixed publisher. Any registered publisher matching the category can serve the campaign. Payment flows to whichever publisher actually served the impression (identified in the claim).

### High: Claim chain state is non-portable

The user's pending (unsubmitted) claims exist only in `chrome.storage.local`. Clearing browser data, reinstalling the extension, or switching devices permanently destroys unsubmitted claims. The `syncFromChain` function can recover the last settled nonce, but all queued claims are lost.

**Minimum viable mitigation:** Encrypted export/import of claim queue state. Longer-term: deterministic claim derivation from on-chain state plus a user-held seed.

### Medium: Campaign selection favors lowest ID

The content script's matching algorithm always selects the first campaign in the list (lowest ID) when multiple campaigns match a category. There is no randomization, auction, or rotation. The first advertiser in a category captures all traffic until their budget is depleted.

**Post-MVP path:** Weighted random selection proportional to bid CPM, or a per-impression micro-auction.

### Medium: No contract upgrade or migration path

The Settlement contract holds real user balances but has no proxy pattern, no migration function, and no emergency withdrawal. If the owner key is lost, `protocolBalance` is permanently locked. There is no path to move state to a new contract version.

### Summary: Trust Assumptions in Current MVP

| Component | Trust assumption | Path to trustlessness |
|-----------|-----------------|----------------------|
| Impression count | Trust extension code (partially mitigated: publisher co-sig in DatumRelay, 2026-03-03) | Publisher attestation endpoint; mandatory attestation mode; then ZK/TEE |
| Engagement quality | On-device behavior hash chain (P16 implemented 2026-03-08) — IAB metrics captured, committed via behaviorCommit | Selective disclosure; ZK behavior proofs (P9) |
| Clearing CPM | On-device Vickrey auction (P19 implemented 2026-03-08) — deterministic from inputs | ZK proof of auction outcome (P9) |
| Aye reward amounts | Symmetric slash replaces V1 aye rewards (GovernanceV2 2026-03-07) — slash pool distribution on-chain via GovernanceSlash | Fully trustless |
| Contract references | 48h admin timelock (DatumTimelock, A1.2 2026-03-06) | Governance approval for reference changes |
| Claim state persistence | Trust browser storage | Encrypted export/import (P6 complete — AES-256-GCM, HKDF from wallet sig, merge on import); deterministic derivation post-alpha |
| Campaign-publisher match | Trust extension code (improved: user preferences filter, P19 auction) | On-chain category matching; open publisher pool |

The MVP is honest about being a PoC. The trust assumptions above are acceptable for testnet validation but each must have a concrete remediation plan before mainnet deployment.

---

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

### 3. KYB Identity Integration — High Risk
Any external identity service introduces:
- Revocation of credentials mid-campaign (what happens to Active campaigns?)
- Jurisdiction coverage gaps (provider may not cover all required jurisdictions)
- Latency in credential verification (per-claim overhead)

Recommend: treat identity verification as a one-time onboarding check, not per-claim. Cache credential status with a TTL; revocation marks advertiser as suspended, not retroactively invalid.

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
4. **Identity tier requirements in settlement** — Tier 1 base rate = allowlist in PoC. Full identity tiers (T2/T3 KYB) must be defined before the Substrate build.
5. **Campaign creation deposit vs. full budget escrow** — Current implementation escrows full budget at creation. Clarify if a smaller deposit with a top-up mechanism is intended.
6. **Quality score in settlement math** — Explicitly out of scope for PoC. Document where it inserts in the full build formula.
7. **Aye reward pool funding source** — Undefined. Recommend documenting that a percentage of protocol fees fund the pool.
8. **ZK proof field in claim struct** — Must be present (even if empty) from the first Substrate deployment to avoid a breaking storage migration later.

---

## Implementation Notes

### DOT Flow Architecture
The alpha uses a nine-contract DOT flow (5+1+1+1+1):
1. Advertiser deposits full budget into `DatumCampaigns` at `createCampaign()`. Campaign creation, activation, termination check `DatumPauseRegistry.paused()`.
2. At `deductBudget()`, `DatumCampaigns` forwards the deducted amount to `DatumSettlement`.
3. `DatumSettlement` maintains pull-payment balances (`publisherBalance`, `userBalance`, `protocolBalance`). Optional ZK verification via `DatumZKVerifier`.
4. At termination, `DatumCampaigns` sends 10% of remaining escrow to `DatumGovernanceV2` (slash pool) and refunds 90% to the advertiser.
5. `DatumGovernanceV2` holds staked DOT; evaluateCampaign() transitions state; symmetric slash deducted inline on withdraw(). `DatumGovernanceSlash` manages slash pool finalization and winner claims.
6. `DatumRelay` accepts EIP-712 signed batches from publishers, verifies user signatures and optional publisher co-signatures, and forwards to `DatumSettlement` (gasless user settlement). Checks pause registry.
7. `DatumTimelock` provides 48h admin delay. Campaigns + Settlement ownership transferred to Timelock post-deploy. Admin changes: `propose(target, calldata)` → 48h → `execute()`.
8. `DatumPauseRegistry` provides global emergency pause circuit breaker. Owner-only `pause()`/`unpause()`.

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
│   ├── DatumPublishers.sol         Publisher registry + take-rate management
│   ├── DatumCampaigns.sol          Campaign lifecycle; budget escrow; 10% slash / 90% refund
│   ├── DatumGovernanceVoting.sol   Conviction voting; activation/termination; stake + slash custody
│   ├── DatumGovernanceRewards.sol  Reward claims; stake withdrawal; aye reward crediting
│   ├── DatumSettlement.sol         Hash-chain validation; claim processing; 3-way payment split
│   ├── DatumRelay.sol              EIP-712 user + publisher co-signature verification; relayed settlement
│   ├── interfaces/
│   │   ├── IDatumCampaigns.sol
│   │   ├── IDatumCampaignsMinimal.sol
│   │   ├── IDatumCampaignsSettlement.sol
│   │   ├── IDatumGovernanceVoting.sol
│   │   ├── IDatumPublishers.sol
│   │   └── IDatumSettlement.sol
│   └── mocks/
│       └── MockCampaigns.sol       Test double for isolated governance/settlement tests
├── test/
│   ├── campaigns.test.ts           L1–L8 + snapshot + publisher validation + CPM floor
│   ├── settlement.test.ts          S1–S8 + gap + genesis + snapshot + hash + relay R1–R6 + co-sig R7–R10
│   ├── governance.test.ts          G1–G8 + lockup cap + reviewer stake + issue 9 + A1
│   └── integration.test.ts         Scenarios A–F (full six-contract integration)
├── scripts/
│   ├── deploy.ts                   Production deployment script
│   └── upload-metadata.ts          IPFS metadata validation + on-chain CID setter
├── metadata/                       Sample campaign metadata JSON files
└── hardhat.config.ts

extension/
├── src/
│   ├── background/                 Campaign poller, claim builder, claim queue, auto-submit
│   ├── content/                    Page classification, ad slot injection
│   ├── popup/                      React UI: campaigns, claims, publisher panel, settings
│   ├── offscreen/                  Offscreen document for auto-submit signing
│   └── shared/                     Types, ABIs, contract factories, CID encoding, networks
└── webpack.config.js
```

**Test results: 64/64 pass.**

---

## Extension UI Addendum (2026-03-08, updated for V2 overhaul)

### V2 Extension Architecture (7 tabs, 559 KB popup.js)

The alpha extension was overhauled to full V2 feature parity across all roles: user, publisher, advertiser, and governance participant.

**Key changes from V1:**
- ABIs sourced from `alpha/artifacts/` (9 contracts), V1 ABIs removed
- ContractAddresses: 9 keys (governanceV2/governanceSlash replace governanceVoting/governanceRewards, added pauseRegistry/timelock/zkVerifier)
- Campaign struct: `id` and `budget` fields removed (A1.3), tracked externally
- 7 tabs (added "My Ads" for advertiser controls)

### Governance V2 — GovernancePanel.tsx

Completely rewritten for V2 API:

- **Voting:** `v2.vote(campaignId, aye, conviction, { value })` — both Aye and Nay allowed on Pending AND Active campaigns
- **Conviction 0-6:** Weight = lockAmount × 2^conviction, lockup = baseLockupBlocks × 2^conviction (capped at maxLockupBlocks). Conviction 0 = no lockup multiplier.
- **Vote status:** `v2.ayeWeighted(cid)` + `v2.nayWeighted(cid)` + `v2.resolved(cid)` + `v2.getVote(cid, addr)` returns (direction, lockAmount, conviction, lockedUntilBlock)
- **Majority progress:** Aye% vs Nay% bars (replaces threshold progress bars). Quorum bar shows totalWeighted vs quorumWeighted.
- **Evaluate Campaign:** `v2.evaluateCampaign(cid)` — Pending→Active (aye>50% + quorum met), Active→Terminated (nay≥50%), Completed/Terminated→resolved. Button shown contextually on campaign rows.
- **Slash warning:** "Losing side pays {slashBps/100}% of stake"
- **Withdrawal:** `v2.withdraw(cid)` — parses VoteWithdrawn event for returned/slashed amounts
- **Slash finalization:** `slash.finalizeSlash(cid)` — snapshots winning side weight after resolution
- **Slash reward claiming:** `slash.claimSlashReward(cid)` — winner claims proportional share of slashCollected. Shows claimable amount from `slash.getClaimable(cid, address)`.

### Advertiser Controls — AdvertiserPanel.tsx (NEW)

Campaign owner controls:

- **My Campaigns:** Scans `nextCampaignId` range, filters by `getCampaignAdvertiser(id) == address`
- **Pause/Resume:** `campaigns.togglePause(campaignId, true/false)` — Active ↔ Paused
- **Complete:** `campaigns.completeCampaign(campaignId)` — Active/Paused → Completed (refunds remaining budget). Confirmation dialog.
- **Expire:** `campaigns.expirePendingCampaign(campaignId)` — Pending → Expired (after timeout)
- **Campaign creation:** Moved from PublisherPanel. Creates campaign with IPFS CID, category, bid CPM, daily cap.

### User Ad Controls — CampaignList.tsx + userPreferences.ts (NEW)

- **Block/Unblock:** Per-campaign block button, blocked campaigns collapsible section
- **Category filter:** Dropdown to filter campaign list by category
- **Campaign info:** Expandable details (advertiser, publisher, budget, take rate, status, category)
- **Silenced categories:** Toggle categories user doesn't want to see ads from
- **Rate limiting:** Max ads per hour (1-30, default 12)
- **Minimum CPM:** Floor CPM user will accept

### Second-Price Auction — auction.ts (NEW, P19)

Vickrey second-price auction integrated into campaign selection:

- `effectiveBid = bidCpmPlanck × interestWeight` (interestWeight from exponential-decay profile, floor 0.1)
- Solo campaign: clearing CPM = bidCpm × 70%
- 2+ campaigns: clearing CPM = secondEffectiveBid / winnerInterestWeight, clamped to [30%, 100%] of bidCpm
- Floor: clearing CPM >= bidCpm × 30%
- Result includes: winner, clearingCpmPlanck, participants, mechanism ('second-price' | 'solo' | 'floor')
- Falls back to legacy campaignMatcher.ts when auction has insufficient data

### Behavioral Analytics — engagement.ts + behaviorChain.ts (NEW, P16)

On-device engagement capture per impression:

- **IntersectionObserver** (50% threshold) for viewport tracking → `viewableMs`, `iabViewable` (≥50% visible ≥1s)
- **document.visibilitychange** for tab focus → `tabFocusMs`
- **window.scroll** for scroll depth → `scrollDepthPct`
- **Minimum 500ms tracking duration** (ignore accidental closes)
- **Behavior hash chain:** per-(userAddress, campaignId) append-only keccak256 chain. Storage key: `behaviorChain:{user}:{campaign}`
- **Behavior commitment:** single bytes32 = keccak256(headHash, eventCount, avgDwell, avgViewable, viewabilityRate, campaignId)
- **ZK proof stub:** `0x01` + commitment (satisfies DatumZKVerifier stub). Real Groth16 in P9.
- **UserPanel engagement stats:** Total impressions, avg dwell, avg viewable, IAB viewability rate, per-campaign breakdown, chain head hash

### Publisher Relay Submit — PublisherPanel.tsx

Unchanged from V1. Campaign creation moved to AdvertiserPanel.

### Extension Build Size

popup.js: 559 KB | background.js: 363 KB | content.js: 9.5 KB (post-V2 overhaul)

### Trust Assumptions Updated

| Component | Status |
|-----------|--------|
| Governance voting | On-chain via DatumGovernanceV2 — trustless (vote with conviction 0-6, evaluateCampaign for state transitions, symmetric slash) |
| Slash distribution | On-chain via DatumGovernanceSlash — trustless (finalizeSlash, claimSlashReward proportional to weighted stake) |
| Relay submission | Publisher submits EIP-712 signed batches via DatumRelay — user signs off-chain, publisher pays gas |
| Clearing CPM | On-device Vickrey auction (P19) — deterministic from inputs, not hardcoded to bidCpm. ZK proof of outcome deferred to P9. |
| Engagement quality | On-device behavior hash chain (P16) — IAB-standard metrics captured, committed via behaviorCommit, ZK proof deferred to P9 |
| Ad delivery control | User preferences — block campaigns, silence categories, rate limit, minimum CPM. All client-side. |
| Campaign management | Advertiser controls — pause/resume/complete/expire via DatumCampaigns contract calls |
