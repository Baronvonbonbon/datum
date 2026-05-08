# DATUM — Full System Review & Mainnet Readiness Assessment

**Date:** 2026-04-20  
**Phase:** Alpha-3 v8 (26 contracts live on Paseo)  
**Web App:** https://datum.javcon.io  
**Testnet:** Paseo Asset Hub (Chain ID 420420417)

---

## Overview

DATUM is a decentralized ad exchange running on Polkadot Hub (PolkaVM). Advertisers
create campaigns with per-impression CPM bids. Users run a browser extension that tracks
viewership and submits cryptographically-attested claim chains. Publishers co-sign
attestations. Settlement is on-chain: DOT splits three ways (publisher / user / protocol)
per impression, with optional ERC-20 token rewards alongside. Governance is conviction-
weighted staking. All settlement is non-custodial pull-payment.

This document reviews every contract and supporting system, assesses mainnet readiness,
and enumerates gaps that remain.

---

## Smart Contracts (26 total)

All 26 contracts are live on Paseo (v8, 2026-04-20). Solidity 0.8.24, compiled via
resolc 1.0.0 (PVM) and standard solc (EVM). OpenZeppelin 5.0. Optimizer mode `z`.

### Infrastructure Layer (5 contracts)

---

#### DatumPauseRegistry

Emergency pause: 2-of-3 guardian multisig proposes → approves → executes pause.
Owner (intended: governance timelock) can unpause immediately.

**Functions:**
- `propose()` — Guardian opens a pause proposal (one active at a time)
- `approve()` — Second guardian approves (3-bit bitmask, prevents self-approval)
- `execute()` — Triggers system pause once 2-of-3 approvals are set
- `unpause()` — Owner-only immediate resume
- `setGuardian(idx, addr)` — Owner configures 3 guardians

**Access:** Owner unpause only. Guardians control pause. All other contracts staticcall
`paused()` and gate their state-changing functions.

**Status:** Complete. H-1 fix applied (single-proposal guard prevents overwrite).
Guardian count hardcoded at 3 (immutable).

**Mainnet note:** Guardians must be configured post-deploy (3 trusted addresses).
Owner must be transferred to Timelock before go-live.

---

#### DatumTimelock

48-hour delay on sensitive owner operations. Single pending proposal; reverts on
concurrent queue attempt. Executes arbitrary calldata via `target.call(payload)`.

**Functions:**
- `propose(target, payload)` — Queues proposal with 48h delay
- `execute(id)` — Executes once delay elapsed
- `cancel()` — Owner-only abort

**Access:** Owner-only propose/cancel. Anyone can execute after delay.

**Status:** Complete. T1 fix applied (`data.length >= 4` guard prevents empty calldata).
Delay is 172,800 blocks (48h at 6s/block), immutable at deployment.

**Mainnet note:** Owner of Timelock is the deployer key. On mainnet this should itself
be a multisig (Polkadot governance or Safe-equivalent).

---

#### DatumZKVerifier

Groth16/BN254 on-chain proof verification. Calls EVM precompiles 0x06 (BN add),
0x07 (BN mul), 0x08 (BN pairing). Verifying key is post-deployment owner-set;
contract returns false (not revert) if VK not yet set.

**Functions:**
- `setVerifyingKey(...)` — Owner-only one-time VK configuration (7 arrays)
- `verify(proof, claimHash, nullifier) → bool` — Groth16 proof check
- `getVK()` — View VK
- Two-step ownership (transferOwnership / acceptOwnership)

**Circuit:** `impression.circom` — 2 public inputs (claimHash, nullifier), 2 private
witnesses (impressions range-checked via Num2Bits(32), nonce quadratic binding).
nullifier = Poseidon(userSecret, campaignId, windowId). 33 constraints.

**Status:** Complete. Real Groth16 verifier live on Paseo. VK set via `scripts/setup-zk.mjs`.
Trusted setup is single-party (testnet only — mainnet requires MPC ceremony).

**Mainnet gaps:**
- MPC ceremony required before mainnet (currently single-party trusted setup)
- VK update mechanism does not exist — new verifier requires contract replacement
- Circuit has no formal verification; relies on off-chain setup correctness

---

#### DatumPaymentVault

Pull-payment escrow for DOT settlement. Holds three distinct balance pools:
publisher, user, protocol. All credited by Settlement; all withdrawn by respective parties.
ReentrancyGuard on all withdrawal paths. No receive() fallback.

**Functions:**
- `creditSettlement(publisher, user, pubAmt, userAmt, protoAmt)` — Settlement-only credit
- `withdrawPublisher(amount)` — Pull withdrawal for publishers
- `withdrawUser(amount)` — Pull withdrawal for users
- `withdrawProtocol(amount)` — Pull withdrawal for protocol treasury

**Status:** Complete. No known gaps.

**Mainnet note:** Protocol withdrawal address must be set to a treasury multisig, not the
deployer EOA.

---

#### DatumTokenRewardVault

Pull-payment ERC-20 vault for optional per-impression sidecar token rewards. Separate
from DOT settlement. Settlement credits non-critically (skips silently if budget exhausted).
Advertisers deposit; users withdraw. Advertisers can reclaim expired campaign budgets.

**Functions:**
- `depositCampaignBudget(token, campaignId, amount)` — Advertiser deposits after ERC-20 approve
- `creditReward(token, user, campaignId, amount)` — Settlement-only (non-critical)
- `withdraw(token, amount)` / `withdrawTo(token, to, amount)` — User pull withdrawal
- `reclaimExpiredBudget(token, campaignId)` — Advertiser reclaim for terminal campaigns

**Status:** Complete. Supports both deployed ERC-20 contracts and native Asset Hub asset
precompile addresses (USDT/USDC via pallet_assets ERC-20 precompile).

**Known limitation:** Native asset precompiles do not implement `name()`, `symbol()`, or
`decimals()`. The `assetRegistry.ts` in both web and extension provides metadata fallback
for known assets (USDT/USDC). Unknown native assets will display without symbol/decimals
until manually registered.

---

### Campaign Layer (5 contracts)

---

#### DatumBudgetLedger

Campaign escrow and spend accounting. Tracks total budget, remaining budget, daily cap,
daily spend. Pull-model: Settlement calls `spendBudget()` which may return false if cap
reached. Drains handled by Lifecycle (complete/terminate/expire).

**Functions:**
- `depositBudget(campaignId, amount)` — Advertiser deposits DOT (payable, via Campaigns)
- `spendBudget(campaignId, amount) → bool` — Settlement: deduct or return false
- `drainFraction(campaignId, recipient, bps)` — Governance/lifecycle: partial drain
- `drainToAdvertiser(campaignId, advertiser)` — Lifecycle: full refund
- `sweepDust(campaignId)` — Permissionless: terminal campaign dust → treasury

**Status:** Complete. S6 fix applied (ceiling division on `drainFraction`). Daily cap
resets on Unix day boundary (timestamp / 86400) — manipulable by miner in PoA but
accepted PoC risk. Treasury immutable at deployment.

---

#### DatumTargetingRegistry

Tag-based publisher targeting using bytes32 hashes (topic:crypto, locale:en, etc.).
AND-logic matching: campaign required tags must all be present in publisher tag set.
O(1) lookup via mapping. O(n) write on setTags (replace entire array).

**Functions:**
- `setTags(bytes32[] tags)` — Publisher self-service tag update (whenNotPaused)
- `hasAllTags(publisher, required[]) → bool` — Campaign validator lookup
- `getTags(publisher) → bytes32[]` — View

**Limits:** MAX_PUBLISHER_TAGS = 32, MAX_CAMPAIGN_TAGS = 8.

**Status:** Complete. TX-1 design. Tag dictionary defined in `shared/tags.ts`.

**Gap:** No tag deprecation mechanism. Tags cannot be individually removed; only full
replacement via setTags. Low risk for now but worth revisiting at scale.

---

#### DatumCampaignValidator

Creation-time validation satellite. Validates publisher eligibility, tag matching,
CPM floor, and computes take rate snapshot. Extracted from Campaigns to fit within
PolkaVM bytecode headroom.

**Functions:**
- `validateCreation(advertiser, publisher, requiredTags) → (valid, takeRateBps)` — On creation
- Config setters: `setCampaigns`, `setPublishers`, `setTargetingRegistry`, `setPauseRegistry`

**Status:** Complete. SE-3 design.

---

#### DatumCampaigns

Core campaign storage. Holds Campaign structs with status, advertiser, publisher, bid CPM,
take rate snapshot, ZK requirement flag, tag snapshots, relay signer snapshot, token reward
config. Status machine: Pending → Active ↔ Paused → Completed/Terminated/Expired.

**Functions:**
- `createCampaign(publisher, dailyCap, bidCpm, requiredTags, requireZkProof, rewardToken, rewardPerImpression, bondAmount) → uint256`
  — Creates campaign, delegates validation to DatumCampaignValidator, optionally locks challenge bond
- `getCampaign*(id)` — 15+ view functions for all campaign fields
- `setCampaignStatus(id, status)` — Lifecycle-only
- `setMetadataHash(id, hash)` — Advertiser-only
- Config setters for validator, lifecycle, bonds, governance

**Immutable snapshots at creation:**
- Publisher take rate (so advertisers can't be changed on mid-campaign)
- Publisher tags (targeting locked in)
- Relay signer (publisher's designated settlement co-signer)
- ZK requirement (requireZkProof, immutable for campaign lifetime)

**Status:** Complete. Optional challenge bond locking integrated (FP-2). Open campaigns
(publisher=address(0)) supported throughout.

---

#### DatumCampaignLifecycle

All campaign state transitions except `setCampaignStatus()` itself. Each transition drains
budget appropriately and optionally returns challenge bonds.

**Functions:**
- `completeCampaign(id)` — Advertiser or settlement; drains remaining to advertiser
- `terminateCampaign(id)` — Governance-only; 10% slash to governance pool, 90% refund
- `expirePendingCampaign(id)` — Permissionless post-pendingExpiryBlock; full refund
- `expireInactiveCampaign(id)` — Permissionless P20 timeout (432k blocks ≈ 30 days); full refund
- `demoteCampaign(id)` — Governance-only; Active/Paused → Pending (SM-4)

**Status:** Complete. P20 (inactivity timeout), SM-4 (demotion), FP-2 (challenge bond return
non-critical) all implemented. `whenNotPaused` on expireInactiveCampaign (SL-* fix).

---

### Settlement Layer (5 contracts)

---

#### DatumClaimValidator

9-step claim validation satellite. Returns (valid, reasonCode, takeRate, claimHash) to
Settlement. Called on every claim.

**Validation steps:**
1. Campaign exists and is Active
2. Publisher matches campaign (or open campaign)
3. Impressions > 0 and ≤ MAX_CLAIM_IMPRESSIONS (100,000)
4. clearingCpm ≤ campaign bidCpm
5. Nonce continuity (nonce == 0 or nonce == prevNonce + 1 — actually first claim check)
6. Hash chain: claimHash = hash(campaignId, publisher, user, nonce, impressions, prevHash)
7. Blocklist check (S12 staticcall; failure → blocked, fail-safe)
8. Allowlist check (BM-7; open campaigns can't accept from allowlist-enabled publishers)
9. ZK proof verification (if campaign.requireZkProof and zkVerifier set)

**Reason codes:** 0=ok, 2=zero impressions, 3=inactive, 4=not found, 5=publisher mismatch,
6=cpm over, 7=nonce mismatch, 8/9=hash chain fail, 10=claim hash fail, 11=blocklist,
13=user impression cap, 14=rate limit, 15=allowlist violation, 16=zk fail, 17=overflow.

**Status:** Complete. BM-2 (impression cap), BM-5 (rate limiter), BM-7 (allowlist), S12
(blocklist fail-safe), ZK-2 (proof size limit), H-2 (staticcall return length check) all
applied.

---

#### DatumSettlement

Main settlement entry point. Accepts claim batches, calls ClaimValidator, records
impressions to rate limiter and publisher stake, credits PaymentVault (3-way DOT split),
and non-critically credits TokenRewardVault. Also implements BM-10 (minClaimInterval).

**Revenue formula:**
- `totalPayment = (clearingCpm * impressionCount) / 1000`
- `publisherShare = totalPayment * takeRateBps / 10000`
- `remainder = totalPayment - publisherShare`
- `userShare = remainder * 75 / 100`
- `protocolShare = remainder - userShare`

**Functions:**
- `settleClaims(ClaimBatch[])` — Standard multi-claim batch per user
- `settleClaimsMulti(UserClaimBatch[])` — Cross-campaign batching (up to 10 users × 10 campaigns)
- Internal credit path → PaymentVault + TokenRewardVault (non-critical)
- `setRateLimiter(addr)`, `setPublishers(addr)`, `setPublisherStake(addr)`, `setTokenRewardVault(addr)` — Config

**Caller eligibility:** User self-submit, relay contract, attestation verifier, or
publisher relay signer (via snapshot).

**Status:** Complete. ReentrancyGuard on all paths. BM-10 wired. Non-critical token credit
path will not revert if vault budget exhausted.

---

#### DatumSettlementRateLimiter

Window-based per-publisher impression cap. Prevents one publisher from absorbing
disproportionate budget in a single window. BM-5.

**Functions:**
- `checkAndIncrement(publisher, count, limit) → bool` — Returns false if window limit hit
- `getWindowId(blockNumber) → uint256` — blockNumber / windowBlocks

**Default window:** 14,400 blocks (≈ 24h at 6s/block), configurable at deployment.

**Status:** Complete. O(1) bucketing. Window rollover is free (new bucket starts at 0).

---

#### DatumAttestationVerifier

Direct settlement path requiring mandatory EIP-712 publisher co-signature. Higher trust
than relay path. Used by publishers who want to self-host settlement.

**Functions:**
- `settleClaimsAttested(AttestedBatch[])` — Validates publisher EIP-712 sig, routes to Settlement
- `verifyPublisherSignature(batch, sig) → bool` — Offline verification helper

**Domain separator:** "DatumAttestationVerifier" (distinct from "DatumRelay").

**Open campaign trust:** For campaigns with publisher=0x0, signer identity comes from
`claims[0].publisher`. Defense-in-depth provided downstream by ClaimValidator (publisher
registration check). This is a documented medium-severity gap: a determined attacker could
impersonate a publisher on open campaigns if they can get a valid claim chain. Fixing
requires adding a publishers contract reference to AttestationVerifier (redeployment).

**Status:** Complete except for the open-campaign attestation gap above.

---

#### DatumRelay

Gasless relay path. Publisher collects signed user claim batches and submits them on-chain.
EIP-712 dual-signature (user + optional publisher co-sig). PoW challenge gate in relay-bot.

**Functions:**
- `relayClaimsBatch(AttestedBatch, userSig, publisherSig) → bool` — EIP-712 batch verification
- `verify(batch, userSig, publisherSig) → bool` — Offline verification

**Security:** M-4 fix applied (s-value canonicalization check prevents signature malleability).
SM-1 enforced by ClaimValidator downstream (all open-campaign claims must target same publisher).

**Status:** Complete.

---

### Publisher Layer (3 contracts)

---

#### DatumPublishers

Publisher registry. Stores take rates, blocklist, per-publisher allowlist, relay signer
and profile hash. Take rate changes are delayed (prevent front-running).

**Functions:**
- `registerPublisher(enableAllowlist)` — Self-register with optional allowlist
- `updateTakeRate(newBps)` — Queue take rate change (pending, delayed)
- `applyTakeRateUpdate()` — Apply queued change once delay elapsed
- `setAllowlistEnabled(bool)` / `setAllowedAdvertiser(addr, bool)` — S12 per-publisher allowlist
- `blockAddress(addr)` / `unblockAddress(addr)` / `isBlocked(addr)` — S12 global blocklist (owner/timelock)
- `setRelaySigner(addr)` / `setProfile(hash)` — Publisher config
- `getTakeRate(publisher) → uint16` — Current effective take rate

**Take rate bounds:** MIN = 3000 bps (30%), MAX = 8000 bps (80%), DEFAULT = 5000 bps (50%).

**S12 status:** Global blocklist owner-gated via Timelock (48h delay). Per-publisher
advertiser allowlist is self-service. The hybrid governance model (admin emergency-block +
governance override to unblock) is not yet implemented — needs a contract change to add
a conviction-vote unblocklist path. Currently only the owner can unblock.

**Status:** Mostly complete. The governance-override-unblock path is an open gap.

---

#### DatumPublisherStake (FP-1 / FP-4)

Publisher economic stake with bonding curve. Required stake grows with cumulative
impressions served. Publishers must maintain adequate stake for Settlement to accept claims
(code 15 rejection if understaked). Slashable by PublisherGovernance on fraud.

**Bonding curve:** `requiredStake = baseStakePlanck + cumulativeImpressions * planckPerImpression`

**Functions:**
- `stake() payable` — Publisher deposits DOT
- `requestUnstake(amount)` — Queue unstake (subject to delay; reverts if drops below required)
- `unstake()` — Post-delay withdrawal
- `recordImpressions(publisher, count)` — Settlement callback; advances bonding curve
- `slash(publisher, amount, recipient)` — Governance-only
- `requiredStake(publisher) → uint256` / `isAdequatelyStaked(publisher) → bool` — View

**Status:** Complete. FP-1 + FP-4 implemented. Unstake queue is single-pending (no
concurrent requests). Parameters (baseStakePlanck, planckPerImpression, unstakeDelayBlocks)
are immutable at deployment — chosen values should reflect realistic mainnet economics.

**Mainnet note:** The bonding curve constants need economic calibration. Current testnet
values (1 PAS base, ~0 per impression) are effectively free. Mainnet requires meaningful
values that create real economic skin-in-the-game without being prohibitive.

---

#### DatumPublisherReputation (BM-8 / BM-9)

Per-publisher settlement acceptance rate tracking. Reporter pattern: only the designated
reporter EOA (typically the relay bot operator) can call `recordSettlement()`. Tracks
settled/rejected counts per publisher; computes score in basis points. BM-9 anomaly
detection compares per-publisher rejection rate against global average.

**Functions:**
- `recordSettlement(publisher, campaignId, settled, rejected)` — Reporter-only
- `score(publisher) → uint16` — Basis points (10000 = 100% acceptance)
- `isAnomaly(publisher) → bool` — True if per-publisher rejection rate > 2× global, with MIN_SAMPLE=10
- `setReporter(addr)` — Owner-only

**Status:** Complete. Informational only — score and anomaly flag are not yet wired to
any enforcement gate. A future governance upgrade could slash or demote publishers based
on anomaly detection.

**Gap:** No on-chain enforcement from reputation score. Relay bots may choose to stop
serving understaked or low-reputation publishers off-chain, but no protocol-level gate exists.

---

### Governance Layer (5 contracts)

---

#### DatumGovernanceV2

Conviction-weighted campaign quality governance. Voters lock DOT with conviction level
0–8 to vote aye or nay on campaigns. Campaigns activated by sufficient aye weight.
Nay threshold triggers demotion or termination. Losers' locked DOT is partially slashed;
winners share the slash pool.

**Conviction table:**
| Level | Weight | Lockup |
|-------|--------|--------|
| 0 | 1× | 0 days |
| 1 | 2× | 1 day |
| 2 | 3× | 3 days |
| 3 | 4× | 7 days |
| 4 | 6× | 21 days |
| 5 | 9× | 90 days |
| 6 | 14× | 180 days |
| 7 | 18× | 270 days |
| 8 | 21× | 365 days |

**Functions:**
- `vote(campaignId, aye, conviction) payable` — Lock DOT, cast weighted vote
- `evaluateCampaign(campaignId)` — Resolve if quorum met; demote/terminate if nay
- `withdrawVote(campaignId)` — Recover stake post-lockup
- `convictionWeight(n)` / `convictionLockup(n)` — Lookup tables

**Security:** C-2 fix (reentrancy guard on vote), SM-5 fix (winningWeight snapshot at
resolution, not at finalization — prevents retroactive dilution).

**Status:** Complete.

---

#### DatumGovernanceHelper

Read-only satellite for slash computation and dust guards. Pure functions only. Exists
to free bytecode headroom from GovernanceV2 (SE-2).

**Functions:**
- `computeSlash(status, voteDirection, lockAmount, slashBps) → uint256`
- `checkMinBalance(address) → bool` — PolkaVM existential deposit guard

**Status:** Complete. STATUS_COMPLETED=3, STATUS_TERMINATED=4, VOTE_AYE=1, VOTE_NAY=2
hardcoded (S4 fix to avoid enum ABI encoding mismatch).

---

#### DatumGovernanceSlash

Slash pool management. Tracks slash collected per campaign. Winners claim proportional
shares post-finalization. Unclaimed pools can be swept to treasury after 365 days.

**Functions:**
- `finalizeSlash(campaignId)` — Snapshot winningWeight; start claim window
- `claimSlashReward(campaignId)` — Winner claims proportional share
- `sweepSlashPool(campaignId)` — Permissionless post-365-day sweep to treasury

**Security:** C-1 fix (totalClaimed tracking prevents double-claim). SM-5 fix (uses
resolvedWinningWeight snapshot). ReentrancyGuard on claim and sweep.

**Status:** Complete.

---

#### DatumPublisherGovernance (FP-3)

Fraud governance targeting specific publishers. Operates separately from campaign
governance. Fraud upheld → slash publisher stake → portion to ChallengeBonds pool
(advertiser bonus), remainder stays in governance as protocol revenue.

**Functions:**
- `propose(publisher, evidenceHash)` — Permissionless fraud proposal
- `vote(proposalId, aye, conviction) payable` — Conviction-weighted
- `withdrawVote(proposalId)` — Post-lockup recovery
- `resolve(proposalId)` — Fraud upheld if ayeWeighted ≥ quorum AND > nayWeighted, after minGraceBlocks from first nay

**Grace period:** minGraceBlocks after first nay before resolution allowed. Prevents
hasty or uncontested fraud resolution.

**Note:** Losing voters are NOT slashed (unlike GovernanceV2 campaign governance). They
simply wait out their lockup. Only publishers are slashed on fraud upheld.

**Status:** Complete. FP-3 implemented.

---

#### DatumParameterGovernance (T1-B)

On-chain protocol parameter governance. Proposers post a bond; voters conviction-vote;
passed proposals execute via timelock. Rejected proposals slash proposer bond.
Provides a governance path for changing contract parameters without deployer key.

**Functions:**
- `propose(target, payload, description) payable` — Post bond, queue for voting
- `vote(proposalId, aye, conviction) payable` — Conviction-weighted
- `withdrawVote(proposalId)` — Post-lockup recovery
- `resolve(proposalId)` — Mark Passed or Rejected
- `execute(proposalId)` — Post-timelock execution, bond refunded on success
- `cancel(proposalId)` — Owner-only abort (returns bond to owner)
- `setParams(...)` — Owner bootstrap

**Status:** Complete. Single pending proposal per cycle by design.

**Gap:** No path for emergencies or fast-track. A malicious parameter proposal blocked
by nay voters cannot be resolved until voting period ends. Owner cancel exists but that
requires deployer key (which should itself be protected by multisig on mainnet).

---

### Satellite / Utility Layer (3 contracts)

---

#### DatumReports

Community reporting. Permissionless — any address can report a page or ad on any
campaign. No on-chain dedup (same address can report multiple times, tracked
off-chain). Informational only; no enforcement.

**Functions:**
- `reportPage(campaignId, reason)` — Report page context issue
- `reportAd(campaignId, reason)` — Report ad content issue

**Reason codes:** 1=spam, 2=misleading, 3=inappropriate, 4=broken, 5=other.

**Status:** Complete. No pause gate (reports should function during protocol pause).

**Gap:** No deduplication. No enforcement path from reports to action. Currently purely
informational. A future upgrade could wire report thresholds to governance proposals.

---

#### DatumNullifierRegistry (FP-5)

Per-user per-campaign per-window ZK nullifier replay prevention. Prevents the same ZK
proof from being replayed across windows. nullifier = Poseidon(userSecret, campaignId,
windowId) — each window produces a different nullifier so no garbage collection needed.

**Functions:**
- `submitNullifier(nullifier, campaignId)` — Settlement-only; reverts E73 on duplicate
- `isUsed(campaignId, nullifier) → bool` — View

**Window:** 14,400 blocks (≈ 24h) by default. Separate from RateLimiter window.

**Status:** Complete. FP-5 implemented.

---

#### DatumChallengeBonds (FP-2)

Optional advertiser challenge bonds. Advertisers may lock DOT at campaign creation as
skin-in-the-game. Bonds are returned on normal campaign completion. On publisher fraud
upheld (PublisherGovernance), a bonus pool is created and advertisers who had bonds
with that publisher claim a proportional bonus.

**Functions:**
- `lockBond(campaignId, advertiser, publisher) payable` — Campaigns-only
- `returnBond(campaignId)` — Lifecycle-only; returns bond to advertiser
- `addToPool(publisher) payable` — PublisherGovernance-only; fund bonus pool from slash
- `claimBonus(campaignId)` — Advertiser-only; proportional bonus from fraud pool

**Status:** Complete. FP-2 implemented. Bond is burned on bonus claim (advertiser keeps
bonus only, not original bond). ReentrancyGuard on return and claim. Optional — campaigns
without bonds are fully supported.

---

## Security Status

### Fixed Findings

All CRITICAL and HIGH findings from the alpha-2 audit (conducted 2026-03-28) are fixed:

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| C-1 | Critical | GovernanceSlash double-claim | `totalClaimed` tracking per campaign |
| C-2 | Critical | GovernanceV2 reentrancy on vote | Manual `_locked` guard |
| H-1 | High | PauseRegistry proposal overwrite | `readyForExecution` flag |
| H-2 | High | Settlement staticcall return unchecked | `require(cOk && cRet.length >= 128)` |
| H-3 | High | GovernanceV2 missing pauseRegistry param | Added as constructor arg |
| S4 | Medium | GovernanceHelper status enum values | Hardcoded constants |
| S6 | Medium | BudgetLedger precision loss | Ceiling division `(n + 9999) / 10000` |
| T1 | Medium | Timelock empty calldata | `require(data.length >= 4)` |
| SM-5 | Medium | GovernanceSlash winningWeight dilution | Snapshot at resolution |
| M-4 | Medium | EIP-712 signature malleability | s-value canonicalization check |
| BM-2 | Medium | No impression count upper bound | MAX_CLAIM_IMPRESSIONS = 100,000 |
| ZK-2 | Medium | No ZK proof size limit | MAX_ZK_PROOF_SIZE = 1,024 |

### Open / Accepted Gaps

| ID | Severity | Issue | Decision |
|----|----------|-------|----------|
| M-7 | Medium | AttestationVerifier open-campaign trust | Documented; needs contract change + redeployment to fix |
| M-2 | Low | Daily cap based on Unix timestamp | Accepted PoC risk; miner manipulability on PoA |
| — | Low | TargetingRegistry tag deletion is O(n) | Gas optimization, not critical |
| — | Info | DatumReports has no deduplication | By design; off-chain dedup |
| — | Info | Reputation score has no enforcement gate | Informational only at this stage |

---

## Supporting Systems

### Browser Extension (alpha-3)

v0.2.0. Manifest V3, Chrome/Chromium. 203 / 203 Jest tests passing. 4-tab popup:
Claims, Earnings, Settings, Filters.

**Key capabilities:**
- Event-driven campaign polling (CampaignCreated events, incremental, O(1) Map index)
- Batch-parallel RPC (20 concurrent status refreshes, 5 concurrent IPFS fetches)
- Blake2-256 claim hashing (`@noble/hashes/blake2.js` — matches PolkaVM Settlement)
- P1 attestation path (`AttestationVerifier.settleClaimsAttested()` with EIP-712 co-sig)
- Vickrey second-price auction (interest-weighted effective bids, solo/floor/second-price)
- Filters tab: allow/block topics, silenced campaigns
- In-ad dismiss: ✕ button, reason picker (hide ad / hide topic / not interested)
- Report overlay: ⚑ button, reason picker (spam, misleading, inappropriate, broken, other)
- Publisher profile section in Settings (relay signer, profile hash)
- Native asset precompile metadata fallback (assetRegistry.ts, KNOWN_ASSETS: USDT/USDC)
- ZK proof generation via snarkjs.groth16.fullProve() (when proving key available)
- Auto-submit, claim export (P6), timelock monitor (H2)
- AES-256-GCM multi-account wallet, phishing list, content safety
- Shadow DOM ad injection, IPFS multi-gateway (5 fallbacks)

**Gap — Extension approval flow:** Currently signs automatically for any valid campaign.
For mainnet, users should explicitly approve settlement per session or campaign (popup
approval flow). The CRITICAL audit finding (1.1) was partially fixed (isExtensionOrigin
check) but full popup approval is deferred.

**Gap — ZK proving key distribution:** The extension needs access to `impression.zkey`
and `impression.wasm` to generate ZK proofs locally. Currently these are bundled only
in the alpha-3 repo. A distribution mechanism (IPFS-pinned proving key, extension bundle,
or server-provided) is needed for mainnet.

**Gap — Firefox support:** Extension is Chromium/MV3 only. No Firefox path exists.

---

### Web App (`web/`)

v0.3.0. React 18 + Vite 6 + TypeScript + ethers v6. 0 build errors. 33 pages.

**Explorer:** Overview, Campaigns, CampaignDetail, Publishers, PublisherProfile, HowItWorks, Philosophy  
**Advertiser:** Dashboard, CreateCampaign, CampaignDetail, SetMetadata, Analytics, AdvertiserProfile  
**Publisher:** Dashboard, Register, TakeRate, Categories, Allowlist, Earnings, SDKSetup, Profile  
**Governance:** Dashboard, Vote, MyVotes, Parameters  
**Admin:** Timelock, PauseRegistry, Blocklist, ProtocolFees, RateLimiter, Reputation, ParameterGovernance, PublisherStake, PublisherGovernance, ChallengeBonds, NullifierRegistry  
**Root:** Demo, Settings  

**Status:** All 26 contracts supported. Native asset sidecar (USDT/USDC precompile) in
CreateCampaign with asset type toggle. Challenge bond display in CampaignDetail. All FP
admin pages wired.

**Gap:** No wallet connect modal for hardware wallets (Ledger/Polkadot.js). Currently
relies on MetaMask or injected EIP-1193 provider. Polkadot Hub mainnet users may expect
the Polkadot.js extension wallet flow.

**Gap:** No mobile/responsive layout. All pages optimized for desktop sidebar layout only.

**Gap:** No indexed data. Campaign and publisher pages use direct RPC calls. At scale,
an indexer (Subsquid or The Graph) is needed for performant historical queries.

---

### Publisher SDK (`sdk/`)

Lightweight tag (~3 KB). Drop-in `<script data-publisher="0x...">` with `<div id="datum-ad-slot">`.
Challenge-response handshake with browser extension for two-party attestation.

**Status:** Functional for alpha. No NPM package. No CDN distribution.

**Gap:** No NPM publish. No versioning beyond manual file copy. No SDK documentation
beyond the web app SDKSetup page. Publisher onboarding requires manual steps.

---

### Publisher Relay (`relay-bot/`, gitignored)

Live systemd service (Diana test publisher, localhost:3400). Co-signs attestations via
EIP-712. Blake2-256 claim hashing. PoW challenge gate (SHA-256, configurable difficulty).
After each batch: parses ClaimSettled/ClaimRejected events per (publisher, campaignId),
calls `DatumPublisherReputation.recordSettlement()`.

**Status:** Working for single publisher testnet. Not production-hardened.

**Gaps:**
- Single-process, single-publisher. No multi-publisher support.
- No HTTPS / TLS configuration (assumes nginx reverse proxy).
- No rate limiting on relay endpoint beyond PoW.
- No monitoring / alerting (no structured logs, no metrics endpoint).
- No automatic key rotation.
- Restart must be manual on server; not included in git (gitignored).

---

### Pine RPC (`pine/`)

smoldot-based EIP-1193 provider that speaks Substrate `ReviveApi_*` and `chainHead_v1_*`
instead of routing through a centralized RPC node. Eliminates one centralized dependency.

**Supported:** `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`,
`eth_getStorageAt`, `eth_getTransactionCount`, `eth_sendRawTransaction`, `eth_blockNumber`,
`eth_chainId`

**Partial:** `eth_getLogs` (rolling 10,000-block in-memory window), `eth_getTransactionReceipt`
(session-scoped TxPool; fixes Paseo null-receipt bug), `eth_getBlockBy*` (tracked window only)

**Not supported:** `eth_subscribe`, filter subscriptions, `eth_accounts`, debug/trace,
EIP-1559 fee market, historical logs beyond window

**Status:** Alpha. Auto-reconnect with exponential backoff. Not used in production web
app yet (web app uses standard RPC URL). No Firefox/Safari wasm compatibility testing.

---

## Test Coverage Summary

| Component | Tests | Status |
|-----------|-------|--------|
| Alpha-3 contracts (26) | 472 / 472 | Passing |
| Extension (alpha-3) | 203 / 203 | Passing |
| **Total** | **675 / 675** | All passing |

**Test files (contracts):**
benchmark, blocklist, bot-mitigation, budget-ledger, campaigns, challenge-bonds,
governance, helpers, integration, lifecycle, nullifier-registry, parameter-governance,
pause, payment-vault, publisher-governance, publisher-stake, rate-limiter, reports,
reputation, settlement-multi, settlement, targeting, timelock, token-reward-vault

**Gaps in test coverage:**
- No fuzz testing (random input corpus)
- No formal invariant verification
- No simulation of concurrent settlement under high load
- Integration tests cover the happy path well; adversarial multi-actor paths only
  partially covered
- No tests for Pine RPC provider (only manual testing against Paseo)

---

## Mainnet Readiness Assessment

### Hard Blockers (must fix before mainnet)

**1. External Security Audit**  
No professional manual audit has been conducted. The alpha-2 automated audit found 2 critical
and 3 high severity issues. An external audit by a firm specializing in PolkaVM/Solidity is
required. Conservative estimate: 4–8 weeks. Budget accordingly.

**2. ZK Trusted Setup MPC Ceremony**  
The current Groth16 trusted setup is single-party (testnet only). For mainnet, a multi-party
computation ceremony is required so no single party holds the toxic waste. Without this, the
ZK system's privacy guarantees are not meaningful. Ceremony coordination (Powers of Tau,
participant collection) is 2–4 weeks of logistics.

**3. Governance Multisig Ownership**  
All contract owners are the deployer EOA. Before mainnet, ownership must transfer to:
- DatumTimelock → owned by a governance multisig (Polkadot governance or Safe)
- DatumParameterGovernance → owned by the above multisig
- DatumPauseRegistry guardians → 3 trusted, distributed addresses

**4. AttestationVerifier Open-Campaign Gap**  
For open campaigns, the attestation verifier trusts `claims[0].publisher` as signer identity.
A publisher could impersonate another on open campaigns. Requires adding a publishers contract
reference to AttestationVerifier and redeploying. Low complexity fix, but requires a redeploy
cycle before open campaigns are safe for real money.

**5. Extension User Approval Flow**  
Users must see and approve what the extension is signing on their behalf. The current
auto-sign flow is suitable for alpha (consent happens at extension install) but not for
mainnet where real DOT is at stake. A per-session or per-campaign approval popup is needed.

---

### Significant Gaps (address before wide launch)

**Publisher Stake Economic Calibration**  
The bonding curve constants (baseStakePlanck, planckPerImpression) need calibration to
real economics. If too low, the staking system provides no meaningful Sybil resistance.
If too high, legitimate publisher onboarding is too expensive.

**S12 Governance-Override Unblock Path**  
Currently only the owner (Timelock gated) can unblock addresses. A governance conviction-
vote path to unblock is needed to prevent censorship concerns at mainnet scale. Requires
a contract change to Publishers.

**Relay Bot Production Hardening**  
The relay bot is a single-publisher testnet service. For mainnet:
- Multi-publisher support
- HTTPS termination
- Structured logging + metrics (Prometheus endpoint)
- Automatic error recovery and alerting
- Key management (HSM or encrypted keystore)
- Rate limiting and abuse prevention beyond PoW

**ZK Proving Key Distribution**  
The extension needs to generate ZK proofs locally, which requires `impression.zkey` (~24 KB)
and `impression.wasm`. Distribution mechanism needed: IPFS pinning with content-addressed
retrieval, or bundle with extension (increases extension size).

**Indexer / Subgraph**  
At any meaningful user count, direct RPC calls to list campaigns, publishers, and
historical settlement will be too slow. A Subsquid or The Graph subgraph for DATUM events
is needed before the web app can scale.

**Native Asset Precompile Verification**  
USDT (asset 1984) and USDC (asset 1337) precompile addresses are registered in
`assetRegistry.ts`. These need live verification on Polkadot Hub mainnet (not just Paseo).
The `verify-native-asset.ts` script exists; must be run against mainnet before launch.

---

### Nice-to-Haves (post-launch or parallel)

**Cross-Campaign Claim Batching in Settlement**  
`settleClaimsMulti` exists, but within a single user-campaign pair. True cross-campaign
batching (one TX settles user across N campaigns) would reduce gas by ~39% vs separate
TXs. Requires contract change to Settlement.

**Viewability Dispute (BM-6)**  
Challenge mechanism for publishers to dispute ad viewability claims by users. Currently
deferred; needs governance design and new contract.

**Reputation Score Enforcement Gate**  
Wire `isAnomaly()` from PublisherReputation into ClaimValidator as reason code 18 or
into Lifecycle as an automatic demotion trigger. Currently reputation is purely informational.

**Reports → Governance Pipeline**  
Threshold-based auto-proposal: if reportAd() count for a campaign exceeds N within a
window, auto-propose a termination governance vote. Currently reports have no path to
action.

**Variable Take Rate Market**  
Publishers currently set fixed take rates within [30%, 80%]. A dynamic auction-based
take rate (publishers compete for campaign inventory) would improve market efficiency.

**Firefox Extension**  
MV3 extension ported to Firefox. Requires separate manifest and testing, but expands
reach significantly.

**Mobile Companion App**  
The extension is desktop Chrome only. A mobile native app or lightweight PWA that
performs the same viewership tracking and claim submission would open the mobile ad
market.

**Hardware Wallet Support in Web App**  
Ledger support and Polkadot.js native account support in the web app. Currently requires
MetaMask or equivalent EIP-1193 injected provider.

**Publisher Analytics Dashboard**  
Detailed per-campaign settlement analytics for publishers: impressions over time,
rejection rate, CPM distribution, user geography (from opt-in targeting tags).

**Advertiser Fraud Reports Dashboard**  
Dedicated admin or advertiser view showing fraud proposals on their publishers, challenge
bond status, and historical resolution outcomes.

**SDK NPM Package + Versioning**  
Publish `datum-sdk.js` to NPM with semver versioning. Enables publishers to pin versions,
receive update notifications, and integrate via standard dependency management.

**eth_subscribe in Pine RPC**  
WebSocket push subscription support in the Pine smoldot provider. Required for real-time
block feeds and event listeners without polling.

**Formal Invariants**  
State invariants worth formalizing:
- `sum(publisherBalance) + sum(userBalance) + sum(protocolBalance) == PaymentVault.balance`
- `sum(campaignTokenBudget) + sum(userTokenBalance) <= ERC20.balanceOf(vault)` per token
- `GovernanceSlash.claimedPool[id] <= GovernanceSlash.initialPool[id]`
- `publisherStake.staked[p] >= publisherStake.requiredStake(p)` for any non-rejected claim

---

## Deployment Checklist

### Pre-Deploy

- [ ] External audit complete, all findings resolved
- [ ] MPC ceremony complete, new verifying key generated
- [ ] Mainnet chain ID confirmed (Polkadot Hub: 420420416)
- [ ] Deployer wallet funded with sufficient DOT for 26 contracts + wiring ops
- [ ] Governance multisig created and tested
- [ ] 3 pause guardian addresses identified and confirmed

### Deploy Sequence

1. PauseRegistry → configure guardians
2. Timelock (48h delay)
3. ZKVerifier → setVerifyingKey (MPC ceremony output)
4. Publishers, BudgetLedger, PaymentVault, TokenRewardVault
5. TargetingRegistry, CampaignValidator
6. Campaigns, CampaignLifecycle, ClaimValidator
7. SettlementRateLimiter, NullifierRegistry
8. Settlement → wire all references
9. AttestationVerifier, Relay
10. GovernanceV2, GovernanceHelper, GovernanceSlash
11. PublisherStake, PublisherGovernance, ChallengeBonds
12. ParameterGovernance
13. Reports, PublisherReputation
14. Wire all cross-contract references (deploy.ts handles this)
15. Transfer ownership of Campaigns, Settlement, Publishers → Timelock
16. Transfer Timelock ownership → governance multisig

### Post-Deploy Verification

- [ ] All 26 contract addresses recorded
- [ ] VK set on ZKVerifier
- [ ] PauseRegistry guardians set and tested
- [ ] Settlement rate limiter window confirmed
- [ ] Publisher stake bonding curve constants confirmed
- [ ] Native asset precompile addresses verified on mainnet
- [ ] AttestationVerifier and Relay domain separators confirmed
- [ ] Setup script run (setup-testnet.ts or mainnet equivalent)
- [ ] At least one end-to-end settlement verified on mainnet
- [ ] Web app config updated to mainnet RPC and addresses
- [ ] Extension ABIs and addresses updated to mainnet

---

## Economics Reference

At 0.500 DOT/1000 CPM ($2.50 @ $5/DOT), 50% publisher take rate:

| Party | Per 1,000 impressions |
|-------|----------------------|
| Publisher | 0.250 DOT ($1.25) |
| User | 0.1875 DOT ($0.94) |
| Protocol | 0.0625 DOT ($0.31) |

User withdrawal break-even: ~9 impressions at recommended CPM.
Relay profitable at 7-claim × 100-impression batches (gas offset by publisher share).

At scale (10,000 DOT/day ad spend): ~$500/day to users, ~$125/day protocol revenue,
~$1,250/day to publishers.

---

## Summary Assessment

The protocol architecture is sound and largely complete. 26 contracts covering the full
lifecycle from campaign creation through settlement, governance, fraud prevention, and
staking are deployed and tested. The design has been through one automated audit cycle
with all critical and high findings resolved.

**What's production-ready:**
- Core settlement logic (campaign → claim chain → attestation → payment vault)
- Governance (conviction voting, slash, parameter governance)
- Bot mitigation (rate limiter, reputation, nullifier registry, publisher stake)
- Token reward sidecar (native asset precompile support)
- Web app (full 26-contract coverage)
- Extension (automated claim, filter, report, withdraw flows)

**What needs work before mainnet:**
- External professional audit (non-negotiable)
- ZK MPC ceremony (non-negotiable for privacy claims)
- Governance multisig ownership transition
- AttestationVerifier open-campaign fix (low-effort, high-value)
- Extension user approval flow
- Relay bot production hardening
- Economic calibration of staking parameters

**Estimated mainnet readiness:** 2–3 months if audit and MPC ceremony start immediately.
The code is at a state where initiating both in parallel is appropriate.
