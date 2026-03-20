# DATUM Protocol — Complete System Analysis

**Version:** 1.0
**Date:** 2026-03-20
**Scope:** Full analysis of the 9 Solidity contracts deployed on Paseo testnet (Chain ID 420420417), their interfaces, data flows, trust model, and current state.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Contract Dependency Graph](#2-contract-dependency-graph)
3. [Deployment and Wiring](#3-deployment-and-wiring)
4. [Contract-by-Contract Analysis](#4-contract-by-contract-analysis)
   - 4.1 [DatumPauseRegistry](#41-datumpauseregistry)
   - 4.2 [DatumTimelock](#42-datumtimelock)
   - 4.3 [DatumPublishers](#43-datumpublishers)
   - 4.4 [DatumCampaigns](#44-datumcampaigns)
   - 4.5 [DatumGovernanceV2](#45-datumgovernancev2)
   - 4.6 [DatumGovernanceSlash](#46-datumgovernanceslash)
   - 4.7 [DatumSettlement](#47-datumsettlement)
   - 4.8 [DatumRelay](#48-datumrelay)
   - 4.9 [DatumZKVerifier](#49-datumzkverifier)
5. [Complete Data Flow](#5-complete-data-flow)
   - 5.1 [Campaign Lifecycle](#51-campaign-lifecycle)
   - 5.2 [Claim Settlement Flow](#52-claim-settlement-flow)
   - 5.3 [Governance Flow](#53-governance-flow)
   - 5.4 [Revenue Distribution](#54-revenue-distribution)
6. [Error Code Reference](#6-error-code-reference)
7. [Trust Model and Security Analysis](#7-trust-model-and-security-analysis)
8. [PVM Size Budget](#8-pvm-size-budget)
9. [Known Limitations](#9-known-limitations)
10. [Test Coverage](#10-test-coverage)

---

## 1. System Overview

DATUM is a decentralized advertising protocol where:
- **Advertisers** deposit DOT into escrow campaigns with a CPM bid and category
- **Community governance** votes to activate or reject campaigns (conviction-weighted)
- **Users** browse publisher pages with the DATUM browser extension, which tracks impressions locally and builds a cryptographic claim hash chain
- **Publishers** operate relay endpoints that co-sign claim batches and submit them on-chain
- **Settlement** verifies hash chains on-chain and splits revenue three ways: publisher (take rate), user (75% of remainder), protocol (25%)

All contracts target Solidity 0.8.24, compiled with `resolc` v0.3.0 for PVM (PolkaVM) bytecode. Each must fit under the 49,152-byte PVM contract size limit.

### Denomination

- 1 DOT = 10^10 planck
- All on-chain values are in planck
- Polkadot Hub block time: 6 seconds (14,400 blocks/day, 5,256,000 blocks/year)

### Actors

| Actor | On-chain Identity | Actions |
|-------|------------------|---------|
| Deployer/Admin | EOA (Alice on testnet) | Deploy, wire contracts, transfer ownership to Timelock |
| Advertiser | Any EOA | createCampaign (payable), setMetadata, togglePause, completeCampaign |
| Publisher | Registered in DatumPublishers | registerPublisher, updateTakeRate, setCategories, withdrawPublisher |
| User/Viewer | Any EOA | Browse pages, accumulate claims off-chain, settleClaims or sign for relay |
| Voter | Any EOA | vote (payable), evaluateCampaign, withdraw, claimSlashReward |
| Publisher Relay | Off-chain endpoint (Diana) | Calls DatumRelay.settleClaimsFor() with user-signed batches |

---

## 2. Contract Dependency Graph

```
DatumPauseRegistry (standalone)
    ↑ read by: Campaigns, Settlement, Relay

DatumTimelock (standalone)
    ↓ owns: Campaigns, Settlement (post-deploy ownership transfer)

DatumPublishers (standalone, OZ Ownable+ReentrancyGuard+Pausable)
    ↑ read by: Campaigns (at campaign creation for take rate snapshot)

DatumCampaigns
    ← reads: PauseRegistry, Publishers
    ← called by: GovernanceV2 (activate/terminate), Settlement (deductBudget)
    → sends DOT: to Settlement (deductBudget), to GovernanceV2 (termination slash), to advertiser (refunds)

DatumGovernanceV2
    ← reads: Campaigns (status via getCampaignForSettlement)
    ← called by: GovernanceSlash (slashAction)
    → calls: Campaigns.activateCampaign(), Campaigns.terminateCampaign()
    → sends DOT: to voters (withdraw), to slash claimants (slashAction)

DatumGovernanceSlash
    ← reads: GovernanceV2 (resolved, ayeWeighted, nayWeighted, slashCollected, getVote)
    ← reads: Campaigns (status via getCampaignForSettlement)
    → calls: GovernanceV2.slashAction() to transfer rewards

DatumSettlement (OZ Ownable+ReentrancyGuard)
    ← reads: PauseRegistry, Campaigns (getCampaignForSettlement)
    ← called by: Relay (settleClaims on behalf of users)
    → calls: Campaigns.deductBudget()
    → receives DOT: from Campaigns.deductBudget() forwarding
    → sends DOT: to publishers, users, protocol (withdrawals)

DatumRelay
    ← reads: PauseRegistry, Campaigns (getCampaignForSettlement for publisher co-sig)
    → calls: Settlement.settleClaims()

DatumZKVerifier (standalone)
    ← called by: Settlement (optional staticcall during claim validation)
```

---

## 3. Deployment and Wiring

### Deploy Order (from `alpha/scripts/deploy.ts`)

1. **DatumPauseRegistry** — no dependencies
2. **DatumTimelock** — no dependencies
3. **DatumPublishers**(takeRateUpdateDelayBlocks=14400) — no dependencies
4. **DatumCampaigns**(minimumCpmFloor, pendingTimeoutBlocks=28800, publishers, pauseRegistry)
5. **DatumGovernanceV2**(campaigns, quorum=100 DOT, slashBps=1000, baseLockup=14400, maxLockup=5256000, terminationQuorum=100 DOT, terminationGraceBlocks=14400)
6. **DatumGovernanceSlash**(voting=GovernanceV2, campaigns)
7. **DatumSettlement**(campaigns, pauseRegistry)
8. **DatumRelay**(settlement, campaigns, pauseRegistry)
9. **DatumZKVerifier** — no dependencies

### Post-Deploy Wiring

```
campaigns.setGovernanceContract(governanceV2)
campaigns.setSettlementContract(settlement)
settlement.setRelayContract(relay)
settlement.setZKVerifier(zkVerifier)
governanceV2.setSlashContract(governanceSlash)   // one-shot, irreversible
campaigns.transferOwnership(timelock)
settlement.transferOwnership(timelock)
```

After wiring, the admin (Alice) cannot directly modify Campaigns or Settlement parameters — all changes must go through the 48-hour Timelock.

---

## 4. Contract-by-Contract Analysis

### 4.1 DatumPauseRegistry

**Purpose:** Global emergency circuit breaker. A single `bool paused` checked by Campaigns, Settlement, and Relay before critical operations.

**PVM Size:** 4,047 bytes (45,105 spare)

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Can pause/unpause |
| `paused` | bool | Global pause flag |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `pause()` | owner only (E18) | Set `paused = true` |
| `unpause()` | owner only (E18) | Set `paused = false` |

**Events:** `Paused(address by)`, `Unpaused(address by)`

**Notes:**
- No timelock protection — intentional for emergency use. Owner can pause instantly.
- GovernanceV2 and GovernanceSlash do NOT check pause — by design. Sub-threshold votes are harmless, and pause is enforced at the Campaigns level (activate/terminate check pause). This is defense-in-depth: governance can still accumulate votes during a pause, but the outcome can't execute until unpause.

---

### 4.2 DatumTimelock

**Purpose:** 48-hour delay on admin operations. Campaigns and Settlement ownership is transferred to this contract post-deploy, so any admin change (setGovernanceContract, setSettlementContract, etc.) requires a 48h propose-wait-execute cycle.

**PVM Size:** 18,342 bytes (30,810 spare)

**Constants:**
| Constant | Value | Description |
|----------|-------|-------------|
| `TIMELOCK_DELAY` | 172,800 | 48 hours in seconds |

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Can propose and cancel |
| `pendingTarget` | address | Target contract for pending call |
| `pendingData` | bytes | Calldata for pending call |
| `pendingTimestamp` | uint256 | Timestamp when proposed |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `propose(target, data)` | owner only | Queue a delayed call. Overwrites any existing pending proposal. |
| `execute()` | anyone | Execute pending call if 48h has elapsed. Clears pending state before external call (CEI pattern). |
| `cancel()` | owner only | Cancel pending proposal. Reverts if nothing pending (E35). |
| `transferOwnership(newOwner)` | owner only | Transfer timelock ownership. |

**Events:** `ChangeProposed(target, data, effectiveTime)`, `ChangeExecuted(target, data)`, `ChangeCancelled(target)`

**Design Notes:**
- Only one pending proposal at a time. A new `propose()` overwrites the previous one.
- `execute()` is callable by anyone — this prevents the owner from indefinitely delaying execution. Once 48h passes, the community can force execution.
- State cleared before external call (line 48-50 of DatumTimelock.sol) — reentrancy protection via CEI.

---

### 4.3 DatumPublishers

**Purpose:** Publisher registry. Publishers register with a take rate (30-80%), can queue rate updates with a block delay, and declare category bitmasks for ad matching.

**PVM Size:** 22,614 bytes (26,538 spare)

**Inherits:** OZ ReentrancyGuard, Ownable, Pausable

**Constants:**
| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_TAKE_RATE_BPS` | 3000 | 30% minimum |
| `MAX_TAKE_RATE_BPS` | 8000 | 80% maximum |
| `DEFAULT_TAKE_RATE_BPS` | 5000 | 50% — used for open campaigns (publisher=address(0)) |

**Constructor:**
```solidity
constructor(uint256 _takeRateUpdateDelayBlocks)
```
- `_takeRateUpdateDelayBlocks`: Block delay before queued take rate becomes effective (14,400 = ~24h on Polkadot Hub)

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `_publishers` | mapping(address => Publisher) | Private publisher registry |
| `takeRateUpdateDelayBlocks` | uint256 | Configurable delay for rate updates |

**Publisher Struct:**
```solidity
struct Publisher {
    address addr;
    uint16 takeRateBps;              // Current rate (3000-8000)
    uint16 pendingTakeRateBps;       // Queued update (0 = none)
    uint256 takeRateEffectiveBlock;  // Block when pending becomes current
    uint256 categoryBitmask;         // Bits 1-26 for ad categories
    bool registered;
}
```

**Functions:**
| Function | Access | Inputs | Description |
|----------|--------|--------|-------------|
| `registerPublisher(takeRateBps)` | anyone, nonReentrant, whenNotPaused | uint16 takeRateBps (3000-8000) | Register msg.sender as publisher |
| `updateTakeRate(newTakeRateBps)` | registered publisher, nonReentrant, whenNotPaused | uint16 newTakeRateBps (3000-8000) | Queue rate update with delay |
| `applyTakeRateUpdate()` | registered publisher, nonReentrant, whenNotPaused | (none) | Apply queued update if delay elapsed |
| `setCategories(bitmask)` | registered publisher, whenNotPaused | uint256 bitmask | Set category bitmask (bits 1-26) |
| `getPublisher(publisher)` | view | address | Returns full Publisher struct |
| `getCategories(publisher)` | view | address | Returns categoryBitmask |
| `isRegisteredWithRate(publisher)` | view | address | Returns (bool registered, uint16 takeRateBps) — slim getter |
| `pause()` / `unpause()` | owner only | (none) | Admin pause/unpause |

**Events:** `PublisherRegistered`, `PublisherTakeRateQueued`, `PublisherTakeRateApplied`, `CategoriesUpdated`

**Notes:**
- `isRegisteredWithRate()` is a slim getter that avoids full struct ABI decode in PVM — saves bytecode in callers.
- Category bitmask: bit N corresponds to category ID N (1-26). Extension matches campaigns by `(campaign.categoryId & publisher.categoryBitmask) != 0`.

---

### 4.4 DatumCampaigns

**Purpose:** Campaign lifecycle management. Handles creation (with DOT escrow), activation by governance, pausing by advertiser, completion, termination (with 10% slash), and expiry. Also manages budget deduction for settlement.

**PVM Size:** 48,662 bytes (490 spare — tightest of all contracts)

**Constructor:**
```solidity
constructor(
    uint256 _minimumCpmFloor,       // Minimum bid CPM (e.g. 10^7 = 0.001 DOT)
    uint256 _pendingTimeoutBlocks,  // Blocks before Pending → Expired (28800 = ~48h)
    address _publishers,            // DatumPublishers address
    address _pauseRegistry          // DatumPauseRegistry address
)
```

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Admin (transferred to Timelock post-deploy) |
| `_locked` | bool | Manual reentrancy guard (OZ ReentrancyGuard too large for PVM budget) |
| `nextCampaignId` | uint256 | Auto-incrementing campaign counter (starts at 1) |
| `_campaigns` | mapping(uint256 => Campaign) | Campaign storage |
| `minimumCpmFloor` | uint256 immutable | Minimum bid CPM |
| `pendingTimeoutBlocks` | uint256 immutable | Pending expiry duration |
| `settlementContract` | address | Authorized settlement caller |
| `governanceContract` | address | Authorized governance caller |
| `publishers` | IDatumPublishers | Publisher registry reference |
| `pauseRegistry` | IDatumPauseRegistry | Pause registry reference |

**Campaign Struct:**
```solidity
struct Campaign {
    address advertiser;
    address publisher;           // address(0) = open campaign (any publisher)
    uint256 remainingBudget;     // Planck remaining
    uint256 dailyCapPlanck;      // Max spend per day
    uint256 bidCpmPlanck;        // Max CPM per 1000 impressions
    uint256 dailySpent;          // Spent today
    uint256 lastSpendDay;        // block.timestamp / 86400
    uint256 pendingExpiryBlock;  // Auto-expire after this block
    uint256 terminationBlock;    // Block of governance termination (0 = not terminated)
    uint16 snapshotTakeRateBps;  // Publisher take rate locked at creation
    CampaignStatus status;       // Enum: Pending/Active/Paused/Completed/Terminated/Expired
    uint8 categoryId;            // 0=uncategorized, 1-26 taxonomy
}
```

**Campaign Status State Machine:**
```
                     evaluateCampaign()           completeCampaign()
    Pending ──────────────────────→ Active ──────────────────────→ Completed
       │                              │  ↑
       │ expirePendingCampaign()      │  │ togglePause()
       ↓                              │  │
    Expired                        Paused
                                      │
                        terminateCampaign()
                                      ↓
                                 Terminated
```

**Functions:**
| Function | Access | Payable | Description |
|----------|--------|---------|-------------|
| `createCampaign(publisher, dailyCapPlanck, bidCpmPlanck, categoryId)` | anyone | yes (msg.value = budget) | Create campaign. Snapshots publisher take rate. If publisher=address(0), uses DEFAULT_TAKE_RATE_BPS (5000). Returns campaignId. |
| `setMetadata(campaignId, metadataHash)` | advertiser only | no | Emit CampaignMetadataSet event with IPFS CID hash. Metadata stored off-chain. |
| `activateCampaign(campaignId)` | governance only (E19), Pending only (E20), not paused | no | Pending → Active |
| `togglePause(campaignId, pause)` | advertiser only (E21) | no | Active ↔ Paused |
| `completeCampaign(campaignId)` | advertiser or settlement (E13), Active/Paused (E14) | no | Refund remaining budget, set Completed. Manual reentrancy guard. |
| `terminateCampaign(campaignId)` | governance only (E19), Active/Paused (E14), not paused | no | 10% slash to governance, 90% refund to advertiser, set Terminated. |
| `expirePendingCampaign(campaignId)` | anyone, Pending only (E20), block.number > pendingExpiryBlock (E24) | no | Full refund to advertiser, set Expired. |
| `deductBudget(campaignId, amount)` | settlement only (E25), Active only (E15) | no | Deduct from budget, enforce daily cap, auto-complete if budget=0, forward DOT to settlement. |
| `getCampaignForSettlement(campaignId)` | view | — | Returns (status, publisher, bidCpmPlanck, remainingBudget, snapshotTakeRateBps). Slim 5-field tuple to minimize PVM ABI decode overhead. |
| `setSettlementContract(addr)` | owner only | no | Set authorized settlement caller |
| `setGovernanceContract(addr)` | owner only | no | Set authorized governance caller |
| `transferOwnership(newOwner)` | owner only | no | Transfer admin ownership |

**Events:** `CampaignCreated`, `CampaignMetadataSet`, `CampaignActivated`, `CampaignPaused`, `CampaignResumed`, `CampaignCompleted`, `CampaignTerminated`, `CampaignExpired`, `BudgetDeducted`

**Critical Design Notes:**

1. **Take rate snapshot:** At campaign creation, the publisher's current `takeRateBps` is copied into `snapshotTakeRateBps`. Settlement always uses this snapshot, never the live rate. This prevents a publisher from increasing their take rate after a campaign starts.

2. **Open campaigns:** When `publisher=address(0)`, any registered publisher can serve the ad. The snapshot take rate defaults to 5000 (50%). The extension resolves the publisher at runtime.

3. **Manual reentrancy guard:** Uses `_locked` bool instead of OZ `ReentrancyGuard` modifier. OZ modifiers compile smaller in PVM than inline require patterns, but DatumCampaigns is at 48,662 bytes (490 spare) — there wasn't room for the OZ import. Every state-mutating function that transfers DOT checks `require(!_locked, "E57")` and sets `_locked = true/false`.

4. **Single transfer site:** All native transfers go through `_send(address, uint256)` to avoid a resolc codegen bug where multiple `transfer()` sites produce broken RISC-V code.

5. **Daily cap:** Uses `block.timestamp / 86400` as the day index. Validator timestamp manipulation is an accepted PoC risk (±15s on 86400s = <0.02%).

6. **Termination economics:** On termination, 10% of remaining budget is sent to `governanceContract` (held in GovernanceV2 for nay voter slash rewards). 90% is refunded to the advertiser.

---

### 4.5 DatumGovernanceV2

**Purpose:** Conviction-weighted voting for campaign activation and termination, with symmetric slash for the losing side. Replaces V1 threshold model with majority+quorum.

**PVM Size:** 39,693 bytes (9,459 spare)

**Constructor:**
```solidity
constructor(
    address _campaigns,
    uint256 _quorum,                  // 100 DOT (10^12 planck)
    uint256 _slashBps,                // 1000 (10%)
    uint256 _baseLockup,              // 14400 blocks (~24h)
    uint256 _maxLockup,               // 5256000 blocks (~365d)
    uint256 _terminationQuorum,       // 100 DOT
    uint256 _terminationGraceBlocks   // 14400 blocks (~24h)
)
```

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Admin (can set slashContract) |
| `campaigns` | address | DatumCampaigns reference |
| `slashContract` | address | DatumGovernanceSlash (set once, irreversible) |
| `ayeWeighted[campaignId]` | uint256 | Sum of conviction-weighted aye stakes |
| `nayWeighted[campaignId]` | uint256 | Sum of conviction-weighted nay stakes |
| `resolved[campaignId]` | bool | Whether campaign governance is resolved (enables slash) |
| `slashCollected[campaignId]` | uint256 | Total slash DOT collected from losing-side withdrawals |
| `firstNayBlock[campaignId]` | uint256 | Block of first nay vote (for grace period) |
| `_votes[campaignId][voter]` | Vote struct | Per-voter vote state |

**Vote Struct:**
```solidity
struct Vote {
    uint8 direction;          // 0=none, 1=aye, 2=nay
    uint256 lockAmount;       // Raw planck staked
    uint8 conviction;         // 0-6
    uint256 lockedUntilBlock; // Can't withdraw until this block
}
```

**Conviction Mechanics:**
| Conviction | Weight Multiplier | Lockup Duration |
|------------|------------------|-----------------|
| 0 | 1x | baseLockup (14,400 blocks, ~24h) |
| 1 | 2x | baseLockup × 2 (28,800 blocks, ~48h) |
| 2 | 4x | baseLockup × 4 |
| 3 | 8x | baseLockup × 8 |
| 4 | 16x | baseLockup × 16 |
| 5 | 32x | baseLockup × 32 |
| 6 | 64x | maxLockup (5,256,000 blocks, ~365d, capped) |

Formula: `weight = lockAmount * (1 << conviction)`, `lockup = min(baseLockup * (1 << conviction), maxLockup)`

**Functions:**
| Function | Access | Payable | Description |
|----------|--------|---------|-------------|
| `vote(campaignId, aye, conviction)` | anyone, campaign Pending/Active | yes (stake) | Cast conviction-weighted vote. One vote per (campaign, voter). Records `firstNayBlock` on first nay. |
| `withdraw(campaignId)` | voter, after lockup | no | Return stake minus slash (if on losing side of resolved campaign). Zeroes vote (allows re-voting if campaign still active). Uses system precompile for dust prevention (E58). |
| `evaluateCampaign(campaignId)` | anyone | no | Evaluate campaign state transition based on vote tallies. See evaluation logic below. |
| `slashAction(action, campaignId, target, value)` | slashContract only | no | Transfer DOT to `target` (action=0). Used by GovernanceSlash to pay winners. Dust prevention via system precompile (E58). |
| `setSlashContract(_slash)` | owner, one-shot (E51 if already set) | no | Set GovernanceSlash address. Irreversible. |
| `getVote(campaignId, voter)` | view | — | Returns (direction, lockAmount, conviction, lockedUntilBlock) |

**Evaluation Logic (evaluateCampaign):**

| Campaign Status | Condition | Action | Result Code |
|----------------|-----------|--------|-------------|
| Pending (0) | total >= quorum AND aye > 50% | activateCampaign() | 1 |
| Pending (0) | total >= quorum AND aye ≤ 50% | Revert E47 (aye majority required) | — |
| Active (1) / Paused (2) | nay ≥ 50% AND nay ≥ terminationQuorum AND grace elapsed | terminateCampaign(), set resolved | 4 |
| Completed (3) | not yet resolved | Set resolved (enables slash) | 3 |
| Terminated (4) | not yet resolved | Set resolved | 4 |
| Other | — | Revert E50 | — |

**Anti-Grief Termination Protection:**
Three guards prevent a single low-stake nay vote from terminating an active campaign:
1. **terminationQuorum** (E52): Nay-side weighted total must be ≥ 100 DOT
2. **terminationGraceBlocks** (E53): Must wait 14,400 blocks (~24h) after the first nay vote before termination can be evaluated
3. **firstNayBlock tracking**: Block of first nay vote is recorded; grace timer starts from there

**Symmetric Slash:**
- When a campaign resolves (Completed or Terminated), the losing side gets `slashBps` (10%) deducted from their stake on withdrawal
- Completed → nay voters lose (they bet the campaign would fail, but it succeeded)
- Terminated → aye voters lose (they bet the campaign would succeed, but governance killed it)
- Deducted amount accumulates in `slashCollected[campaignId]`
- Winners claim their share via DatumGovernanceSlash

**System Precompile (ISystem at 0x900):**
- GovernanceV2 uses `ISystem.minimumBalance()` in `withdraw()` and `slashAction()` to prevent dust transfers below the existential deposit
- Guarded by `SYSTEM_ADDR.code.length > 0` — on Hardhat EVM the precompile doesn't exist, so the dust check is skipped gracefully

---

### 4.6 DatumGovernanceSlash

**Purpose:** Distributes slash pool rewards to winning-side voters. Two-step: finalize (snapshot winning weight), then each winner claims their proportional share.

**PVM Size:** 30,298 bytes (18,854 spare)

**Constructor:**
```solidity
constructor(address _voting, address _campaigns)
```

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `voting` | address | DatumGovernanceV2 |
| `campaigns` | address | DatumCampaigns |
| `winningWeight[campaignId]` | uint256 | Snapshot of winning side's total weighted votes |
| `finalized[campaignId]` | bool | Whether slash has been finalized |
| `claimed[campaignId][voter]` | bool | Whether voter has claimed their slash reward |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `finalizeSlash(campaignId)` | anyone, not yet finalized (E52), must be resolved (E53) | Snapshot the winning side's total weight. Completed → aye weight. Terminated → nay weight. |
| `claimSlashReward(campaignId)` | winner, finalized (E54), not yet claimed (E55), lockup expired (E45) | Calculate `share = pool * voterWeight / winningWeight`, transfer via V2.slashAction(). |
| `getClaimable(campaignId, voter)` | view | Returns claimable amount (0 if not winner, already claimed, or not finalized) |

**Slash Distribution Formula:**
```
voterWeight = lockAmount * (1 << conviction)
pool = slashCollected[campaignId]     // accumulated from losing-side withdrawals
share = pool * voterWeight / winningWeight
```

**Flow:**
1. Campaign resolves (Completed or Terminated)
2. Losing-side voters withdraw → slashBps (10%) deducted → `slashCollected` accumulates
3. Anyone calls `finalizeSlash(campaignId)` → snapshots winning weight
4. Each winner calls `claimSlashReward(campaignId)` → receives proportional share
5. DOT transfers from GovernanceV2 balance via `slashAction(0, campaignId, winner, amount)`

**Important:** Finalization should happen *after* all losing-side voters have withdrawn, to maximize the slash pool. If finalized early, rewards are based on whatever has been collected so far.

---

### 4.7 DatumSettlement

**Purpose:** Core settlement engine. Validates claim hash chains, processes batches, deducts campaign budgets, and accumulates pull-payment balances for publishers, users, and protocol.

**PVM Size:** 48,820 bytes (332 spare — second tightest)

**Inherits:** OZ ReentrancyGuard, Ownable

**Constructor:**
```solidity
constructor(address _campaigns, address _pauseRegistry)
```

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `campaigns` | IDatumCampaignsSettlement | Campaigns contract reference |
| `relayContract` | address | Authorized DatumRelay caller |
| `zkVerifier` | address | Optional ZK verifier (address(0) = skip) |
| `pauseRegistry` | IDatumPauseRegistry | Pause registry reference |
| `publisherBalance[address]` | uint256 | Accumulated publisher earnings (pull pattern) |
| `userBalance[address]` | uint256 | Accumulated user earnings (pull pattern) |
| `protocolBalance` | uint256 | Accumulated protocol fees |
| `lastNonce[user][campaignId]` | uint256 | Last settled nonce per (user, campaign) |
| `lastClaimHash[user][campaignId]` | bytes32 | Last settled claim hash per (user, campaign) |

**Claim Struct:**
```solidity
struct Claim {
    uint256 campaignId;
    address publisher;
    uint256 impressionCount;
    uint256 clearingCpmPlanck;   // Must be <= campaign bidCpmPlanck
    uint256 nonce;               // Sequential per (user, campaign)
    bytes32 previousClaimHash;   // Link to prior claim (bytes32(0) for genesis)
    bytes32 claimHash;           // Verified against canonical formula
    bytes zkProof;               // Reserved for future ZK verification
}
```

**Claim Hash Formula (must match extension):**
```solidity
keccak256(abi.encodePacked(
    claim.campaignId,
    claim.publisher,
    user,
    claim.impressionCount,
    claim.clearingCpmPlanck,
    claim.nonce,
    claim.previousClaimHash
))
```

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `settleClaims(batches)` | user or relay (E32), nonReentrant, not paused | Process claim batches. Each batch has a user, campaignId, and array of claims. |
| `withdrawPublisher()` | publisher, nonReentrant | Withdraw accumulated publisher balance |
| `withdrawUser()` | user, nonReentrant | Withdraw accumulated user balance |
| `withdrawProtocol(recipient)` | owner, nonReentrant | Withdraw protocol fees to specified address |
| `setRelayContract(addr)` | owner | Set authorized relay caller |
| `setZKVerifier(addr)` | owner | Set ZK verifier contract |

**Claim Validation Pipeline (_validateClaim):**

Each claim goes through these checks in order. First failure returns the reason code:

| Step | Check | Reason Code | Description |
|------|-------|-------------|-------------|
| 1 | `claim.campaignId != batch.campaignId` | 0 | All claims in batch must share campaignId |
| 2 | Gap found in previous claim | 1 | Stop-on-first-gap: once a nonce gap is found, reject all remaining |
| 3 | `impressionCount == 0` | 2 | Zero impressions produce zero payment |
| 4 | `cBidCpm == 0` | 3 | Campaign doesn't exist (sentinel: real campaigns have bidCpm >= minimumCpmFloor) |
| 5 | `status != 1` (Active) | 4 | Campaign not active |
| 6 | Publisher mismatch | 5 | Fixed campaign: claim.publisher must match. Open campaign: claim.publisher must be non-zero. |
| 7 | `clearingCpmPlanck > cBidCpm` | 6 | CPM exceeds campaign's max bid |
| 8 | `nonce != lastNonce + 1` | 7 | Nonce must be exactly sequential |
| 9 | Genesis: `previousClaimHash != 0` | 8 | First claim (nonce=1) must have zero previous hash |
| 10 | Non-genesis: `previousClaimHash != lastClaimHash` | 9 | Hash chain broken |
| 11 | `claimHash != expectedHash` | 10 | Computed hash doesn't match |
| 12 | `totalPayment > remainingBudget` | 11 | Insufficient campaign budget |
| 13 | ZK verification failed | 12 | Optional, only if verifier set and proof non-empty |

**Revenue Split (_settleSingleClaim):**
```
totalPayment     = (clearingCpmPlanck * impressionCount) / 1000
publisherPayment = totalPayment * snapshotTakeRateBps / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder * 7500 / 10000   (75%)
protocolFee      = remainder - userPayment     (25%)
```

**Example (50% take rate, 0.016 DOT CPM, 1000 impressions):**
```
totalPayment     = 0.016 DOT = 160,000,000 planck
publisherPayment = 80,000,000 planck (50%)
remainder        = 80,000,000 planck
userPayment      = 60,000,000 planck (75% of remainder = 37.5% of total)
protocolFee      = 20,000,000 planck (25% of remainder = 12.5% of total)
```

**Events:** `ClaimSettled` (with full payment breakdown), `ClaimRejected` (with reason code), `PublisherWithdrawal`, `UserWithdrawal`, `ProtocolWithdrawal`

**Batch Size Limit:** `MAX_CLAIMS_PER_BATCH = 5` (enforced on-chain, E28)

**Design Notes:**
- Pull payment pattern: balances accumulate in mappings, parties withdraw explicitly. This avoids push-payment reentrancy risks and allows batching.
- Settlement receives DOT from `Campaigns.deductBudget()` which calls `_send(settlementContract, amount)`. The `receive()` function accepts this.
- `_send()` uses `.call{value}` instead of `.transfer()` to avoid resolc codegen bugs with multiple transfer sites.

---

### 4.8 DatumRelay

**Purpose:** Gasless settlement via EIP-712 signatures. Users sign claim batches off-chain, publishers (via their relay endpoints) collect signatures and submit them on-chain, paying gas. The relay contract verifies user signatures and optional publisher co-signatures before forwarding to Settlement.

**PVM Size:** 46,180 bytes (2,972 spare)

**Constructor:**
```solidity
constructor(address _settlement, address _campaigns, address _pauseRegistry)
```

Computes `DOMAIN_SEPARATOR` at deploy time:
```solidity
DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("DatumRelay"),
    keccak256("1"),
    block.chainid,
    address(this)
))
```

**EIP-712 Type Hashes:**

```
ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,uint256 lastNonce,uint256 claimCount,uint256 deadline)

PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,uint256 lastNonce,uint256 claimCount)
```

**SignedClaimBatch Struct:**
```solidity
struct SignedClaimBatch {
    address user;
    uint256 campaignId;
    Claim[] claims;
    uint256 deadline;       // Block number expiry
    bytes signature;        // 65-byte EIP-712 from user
    bytes publisherSig;     // 65-byte EIP-712 from publisher (empty = degraded trust)
}
```

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `settleClaimsFor(batches)` | anyone (typically publisher relay), not paused | Verify signatures, forward to settlement.settleClaims() |

**settleClaimsFor Flow:**

For each `SignedClaimBatch`:

1. **Deadline check:** `block.number <= deadline` (E29)
2. **User signature verification:**
   - Compute EIP-712 struct hash from (user, campaignId, firstNonce, lastNonce, claimCount, deadline)
   - Compute digest = `keccak256("\x19\x01" || DOMAIN_SEPARATOR || structHash)`
   - Inline `ecrecover(digest, v, r, s)` (no OZ ECDSA — saves bytecode)
   - Verify `signer == batch.user` (E31)
3. **Publisher co-signature verification (optional):**
   - If `publisherSig.length > 0`:
     - Look up campaign's publisher address
     - If `cPublisher == address(0)` (open campaign): skip co-sig verification
     - Otherwise: compute PublisherAttestation EIP-712 digest, ecrecover, verify `signer == cPublisher` (E34)
   - If `publisherSig` is empty: degraded trust mode (no co-signature)
4. **Copy claims to memory** (calldata → memory for cross-contract call)
5. **Forward to `settlement.settleClaims()`** as a single call with all verified batches

**Design Notes:**
- The relay contract is authorized as a caller in DatumSettlement (`relayContract`). Settlement trusts it because Relay has verified the user's EIP-712 signature.
- Publisher co-signature is optional for trust graduation. Missing co-sig = degraded trust (settlement still processes, but the claim has weaker provenance).
- Open campaigns skip publisher co-sig verification entirely — there's no fixed publisher to verify against.
- Inline assembly for ecrecover keeps bytecode small. Standard `ECDSA.recover()` from OZ would add ~4 KB PVM.

---

### 4.9 DatumZKVerifier

**Purpose:** Stub ZK proof verifier. In the MVP, any non-empty proof passes. Post-alpha, this will be replaced with a real Groth16/PLONK verifier that proves the second-price auction outcome was computed correctly.

**PVM Size:** 1,409 bytes (47,743 spare)

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `verify(proof, publicInputsHash)` | pure | Returns `proof.length > 0` |

**Integration:** Settlement calls this via `staticcall` if `zkVerifier != address(0)` and `claim.zkProof.length > 0`. Currently the extension sends `zkProof = "0x"` (empty), so verification is always skipped.

---

## 5. Complete Data Flow

### 5.1 Campaign Lifecycle

```
Advertiser                     Campaigns              GovernanceV2         Settlement
    │                              │                       │                    │
    │── createCampaign{value} ────→│ Store campaign         │                    │
    │   (publisher, dailyCap,      │ snapshotTakeRate       │                    │
    │    bidCpm, categoryId)       │ status=Pending         │                    │
    │                              │ pendingExpiryBlock     │                    │
    │                              │                        │                    │
    │                              │                        │                    │
Voter ─── vote{value}(cId,aye) ──────────────────────────→│ Record vote          │
    │                              │                        │ ayeWeighted +=      │
    │                              │                        │                    │
Anyone── evaluateCampaign(cId) ───────────────────────────→│ Check majority      │
    │                              │←── activateCampaign ───│ + quorum            │
    │                              │    status=Active        │                    │
    │                              │                        │                    │
    │── setMetadata(cId,hash) ────→│ Emit event             │                    │
    │                              │                        │                    │
    │── togglePause(cId,true) ────→│ Active→Paused          │                    │
    │── togglePause(cId,false) ───→│ Paused→Active          │                    │
    │                              │                        │                    │
    │── completeCampaign(cId) ────→│ Refund remaining       │                    │
    │                              │ status=Completed       │                    │
    │                              │ DOT→advertiser          │                    │
```

### 5.2 Claim Settlement Flow

```
User (browser extension)       Publisher Relay          DatumRelay         Settlement         Campaigns
    │                                 │                       │                  │                  │
    │ Build claims locally            │                       │                  │                  │
    │ (hash chain, nonces,            │                       │                  │                  │
    │  quality scoring)               │                       │                  │                  │
    │                                 │                       │                  │                  │
    │── EIP-712 sign ClaimBatch ─────→│                       │                  │                  │
    │   (user, campaignId,            │                       │                  │                  │
    │    firstNonce, lastNonce,       │                       │                  │                  │
    │    claimCount, deadline)        │                       │                  │                  │
    │                                 │                       │                  │                  │
    │← publisher attestation req ────│                       │                  │                  │
    │  (POST /.well-known/datum-attest)                      │                  │                  │
    │── EIP-712 PublisherAttestation →│                       │                  │                  │
    │                                 │                       │                  │                  │
    │                                 │── settleClaimsFor ───→│ Verify user sig  │                  │
    │                                 │   (SignedClaimBatch[]) │ Verify pub sig  │                  │
    │                                 │                       │ Copy to memory   │                  │
    │                                 │                       │── settleClaims ─→│ Validate claims  │
    │                                 │                       │   (ClaimBatch[]) │ For each claim:  │
    │                                 │                       │                  │  - Check status  │
    │                                 │                       │                  │  - Check nonce   │
    │                                 │                       │                  │  - Verify hash   │
    │                                 │                       │                  │  - Check budget  │
    │                                 │                       │                  │── deductBudget ─→│ Deduct + daily cap
    │                                 │                       │                  │←── DOT ─────────│ Forward DOT
    │                                 │                       │                  │ Accumulate:      │
    │                                 │                       │                  │  publisherBal += │
    │                                 │                       │                  │  userBal +=      │
    │                                 │                       │                  │  protocolBal +=  │
    │                                 │                       │                  │                  │
    │                                 │                       │                  │                  │

LATER:
Publisher ── withdrawPublisher() ─────────────────────────────────────────→│ Pull DOT
User ── withdrawUser() ──────────────────────────────────────────────────→│ Pull DOT
Owner ── withdrawProtocol(recipient) ────────────────────────────────────→│ Pull DOT
```

### 5.3 Governance Flow

```
                   VOTING                    RESOLUTION                   SLASH

Voter1 ── vote(cId, aye, 100 DOT, conv=0) ──→ ayeWeighted += 100
Voter2 ── vote(cId, nay, 50 DOT, conv=1) ───→ nayWeighted += 100       firstNayBlock = N

[24h grace period elapses]

Anyone ── evaluateCampaign(cId) ──→ aye > 50%? → activateCampaign()
                                    nay ≥ 50%? → terminateCampaign()
                                    → resolved[cId] = true

[Campaign resolves as Completed or Terminated]

Loser ── withdraw(cId) ──→ stake - 10% slash → slashCollected +=

Anyone ── finalizeSlash(cId) ──→ snapshot winningWeight

Winner ── claimSlashReward(cId) ──→ share = pool * weight / totalWeight
                                    → V2.slashAction(0, cId, winner, share)
```

### 5.4 Revenue Distribution

For a campaign with 50% publisher take rate (snapshotTakeRateBps = 5000):

```
Campaign Budget (escrowed DOT)
    │
    │ deductBudget(totalPayment)
    ↓
Settlement receives DOT
    │
    ├── 50% → publisherBalance[publisher]   ← Publisher take rate
    │
    └── 50% remainder
         │
         ├── 75% → userBalance[user]        ← 37.5% of total
         │
         └── 25% → protocolBalance          ← 12.5% of total
```

**Pull payments:** Each party calls `withdrawPublisher()`, `withdrawUser()`, or `withdrawProtocol(recipient)` to receive their accumulated balance.

---

## 6. Error Code Reference

| Code | Contract(s) | Meaning |
|------|------------|---------|
| E00 | All | Zero address provided |
| E01 | Campaigns | Campaign not found (advertiser == address(0)) |
| E02 | Campaigns, Settlement, GovernanceV2 | Native transfer failed |
| E03 | Settlement, GovernanceSlash | Zero balance / zero share |
| E11 | Campaigns | Zero budget (msg.value == 0) |
| E12 | Campaigns | Invalid daily cap (0 or > budget) |
| E13 | Campaigns | Not advertiser or settlement (completeCampaign) |
| E14 | Campaigns | Campaign not Active or Paused (complete/terminate) |
| E15 | Campaigns | Campaign not Active (deductBudget) |
| E16 | Campaigns | Insufficient remaining budget |
| E17 | Campaigns | Publisher not registered |
| E18 | All | Not owner |
| E19 | Campaigns, GovernanceV2 | Not governance/slash contract |
| E20 | Campaigns | Campaign not Pending |
| E21 | Campaigns | Not advertiser |
| E22 | Campaigns | Campaign not Active (for pause) |
| E23 | Campaigns | Campaign not Paused (for resume) |
| E24 | Campaigns | Pending timeout not reached |
| E25 | Campaigns | Not settlement contract |
| E26 | Campaigns | Daily cap exceeded |
| E27 | Campaigns | Bid below minimum CPM floor |
| E28 | Settlement | Batch too large (> 5 claims) |
| E29 | Relay | Deadline expired (block > deadline) |
| E30 | Relay | Invalid signature length (not 65 bytes) |
| E31 | Relay | User signature verification failed |
| E32 | Settlement | Caller not user or relay |
| E33 | Relay | Publisher signature length invalid |
| E34 | Relay | Publisher signature verification failed |
| E35 | Timelock | No pending proposal to cancel |
| E36 | Timelock | No pending proposal to execute |
| E37 | Timelock | Timelock delay not elapsed |
| E40 | GovernanceV2 | Conviction > 6 |
| E41 | GovernanceV2 | Zero vote stake |
| E42 | GovernanceV2 | Already voted on this campaign |
| E43 | GovernanceV2 | Campaign not Pending or Active |
| E44 | GovernanceV2/Slash | No vote found |
| E45 | GovernanceV2/Slash | Lockup not expired |
| E46 | GovernanceV2 | Quorum not met |
| E47 | GovernanceV2 | Aye majority required (Pending → Active) |
| E48 | GovernanceV2 | Nay majority required (Active → Terminated) |
| E49 | GovernanceV2 | Already resolved |
| E50 | GovernanceV2 | Invalid campaign status for evaluation |
| E51 | GovernanceV2 | Slash contract already set / zero votes on termination eval |
| E52 | GovernanceV2/Slash | Nay below termination quorum / slash already finalized |
| E53 | GovernanceV2/Slash | Grace period not elapsed / campaign not resolved |
| E54 | GovernanceSlash | Slash not finalized |
| E55 | GovernanceSlash | Already claimed |
| E56 | GovernanceSlash | Not on winning side |
| E57 | Campaigns | Reentrancy |
| E58 | GovernanceV2 | Refund below existential deposit (dust prevention) |
| P | Campaigns, Settlement, Relay | System paused |

**Settlement Rejection Reason Codes (in ClaimRejected event):**

| Code | Meaning |
|------|---------|
| 0 | campaignId mismatch (batch vs claim) |
| 1 | Subsequent to gap (stop-on-first-gap) |
| 2 | Zero impression count |
| 3 | Campaign not found |
| 4 | Campaign not active |
| 5 | Publisher mismatch |
| 6 | CPM exceeds bid |
| 7 | Nonce gap |
| 8 | Genesis must have zero previousHash |
| 9 | Invalid previousClaimHash |
| 10 | Invalid claimHash |
| 11 | Insufficient budget |
| 12 | ZK verification failed |

---

## 7. Trust Model and Security Analysis

### Access Control Matrix

| Function | Who Can Call | Protected By |
|----------|-------------|--------------|
| PauseRegistry.pause/unpause | owner | Direct ownership (no timelock — emergency) |
| Timelock.propose/cancel | owner | Timelock ownership |
| Timelock.execute | anyone | 48h delay |
| Publishers.register/update/setCategories | msg.sender (self) | Self-registration |
| Campaigns.createCampaign | anyone | Payable escrow |
| Campaigns.activateCampaign | governanceContract | Set via owner (timelocked) |
| Campaigns.terminateCampaign | governanceContract | Set via owner (timelocked) |
| Campaigns.deductBudget | settlementContract | Set via owner (timelocked) |
| Campaigns.setSettlement/setGovernance | owner (Timelock) | 48h delay |
| Settlement.settleClaims | batch.user or relayContract | User identity check |
| Settlement.setRelay/setZK | owner (Timelock) | 48h delay |
| Relay.settleClaimsFor | anyone | EIP-712 sig verification |
| GovernanceV2.vote | anyone | Payable stake |
| GovernanceV2.evaluateCampaign | anyone | Majority + quorum thresholds |
| GovernanceV2.setSlashContract | owner, one-shot | Irreversible |
| GovernanceSlash.finalizeSlash | anyone | Must be resolved |
| GovernanceSlash.claimSlashReward | winner, finalized | Lockup + winning side check |

### Trust Assumptions

| Component | Trust Assumption | Severity | Alpha Mitigation |
|-----------|-----------------|----------|------------------|
| Impression count | Extension self-reports impressions | High | Publisher co-signature attestation (optional) |
| Clearing CPM | Extension determines clearing price | Medium | Must be ≤ bidCpmPlanck; ZK proof stub (future: Groth16) |
| Quality score | Extension computes engagement quality | Medium | Computed in background (trusted context), not content script |
| Publisher identity | SDK declares publisher address | Low | On-chain registration check, handshake verification |
| Relay honesty | Relay could delay or drop batches | Low | Claims persist in extension; users can submit directly |
| Admin power | Owner can propose parameter changes | Medium | 48h Timelock on Campaigns + Settlement |
| Pause power | Owner can pause instantly | Medium | Intentional for emergency; cannot pause governance |

### Reentrancy Protection

| Contract | Method |
|----------|--------|
| DatumPublishers | OZ ReentrancyGuard modifier |
| DatumCampaigns | Manual `_locked` bool (OZ import too large for PVM budget) |
| DatumSettlement | OZ ReentrancyGuard modifier |
| DatumGovernanceV2 | No explicit guard (no external calls before state updates — CEI pattern) |
| DatumGovernanceSlash | No explicit guard (delegates transfer to V2.slashAction) |
| DatumTimelock | CEI pattern (clear state before external call) |
| DatumRelay | No state mutation (pure forwarding) |

### DOT Flow Diagram (where money lives)

```
User DOT (wallet)
    ├── createCampaign{value} → Campaigns escrow (remainingBudget)
    │                               ├── deductBudget → Settlement (publisherBal + userBal + protocolBal)
    │                               │                     ├── withdrawPublisher → Publisher wallet
    │                               │                     ├── withdrawUser → User wallet
    │                               │                     └── withdrawProtocol → Protocol wallet
    │                               ├── terminateCampaign → 10% to GovernanceV2
    │                               │                        └── slashAction → Winners
    │                               │                      → 90% to Advertiser wallet
    │                               └── completeCampaign/expirePending → Advertiser wallet
    │
    └── vote{value} → GovernanceV2 (lockAmount per vote)
                         ├── withdraw → Voter wallet (minus slash if loser)
                         └── slash → GovernanceV2 balance → slashAction → Winners
```

---

## 8. PVM Size Budget

All contracts must fit under the 49,152-byte PVM limit (resolc v0.3.0, optimizer mode `z`).

| Contract | PVM Size | Spare | Utilization | Risk |
|----------|----------|-------|-------------|------|
| DatumPauseRegistry | 4,047 | 45,105 | 8.2% | None |
| DatumTimelock | 18,342 | 30,810 | 37.3% | None |
| DatumPublishers | 22,614 | 26,538 | 46.0% | None |
| DatumCampaigns | 48,662 | 490 | 99.0% | **Critical — almost no room for changes** |
| DatumGovernanceV2 | 39,693 | 9,459 | 80.8% | Moderate |
| DatumGovernanceSlash | 30,298 | 18,854 | 61.6% | Low |
| DatumSettlement | 48,820 | 332 | 99.3% | **Critical — almost no room for changes** |
| DatumRelay | 46,180 | 2,972 | 93.9% | High |
| DatumZKVerifier | 1,409 | 47,743 | 2.9% | None |

**Critically constrained:** DatumCampaigns (490 B spare) and DatumSettlement (332 B spare) cannot accept new features without removing existing code. Any new functionality for these contracts requires either:
1. Extracting logic to a new companion contract
2. Removing existing getters or features
3. Waiting for resolc compiler improvements

---

## 9. Known Limitations

### Accepted for Alpha

| Limitation | Detail | Impact | Mitigation |
|------------|--------|--------|------------|
| Daily cap timestamp manipulation | `block.timestamp / 86400` — validators can shift ±15s | Negligible (<0.02%) | Accepted risk |
| Single pending timelock proposal | `propose()` overwrites previous pending | Admin must cancel before re-proposing | Intentional simplicity |
| ZK verifier is a stub | Any non-empty proof passes | No auction proof verification | Post-alpha: Groth16 with BN128 pairing |
| Blake2-256 deferred | Claims use keccak256, not native Blake2 | ~3x more expensive hash | Settlement has only 332 B spare for precompile |
| No on-chain publisher domain | Relay URL discovered via SDK data-relay attribute | URL changes require page update, not chain tx | Post-alpha: on-chain publisher registry |
| Manual reentrancy in Campaigns | `_locked` bool instead of OZ modifier | Equivalent protection, less battle-tested | PVM size constraint |
| No claim expiry | Stale claims can be submitted indefinitely | Low risk — nonce chain prevents replay | Could add block-based expiry post-alpha |
| E51 dual meaning | "slash contract already set" AND "zero votes on termination eval" | Slightly confusing error | Accepted — PVM size constraint |
| E52/E53 dual meaning | Different meanings in GovernanceV2 vs GovernanceSlash | Error context depends on caller | Extension humanizeError provides context |

### Architectural Constraints

| Constraint | Cause | Impact |
|-----------|-------|--------|
| 49,152 B PVM limit | pallet-revive max contract size | Cannot add features to Campaigns/Settlement without removing code |
| resolc v0.3.0 codegen | Compiler maturity | Single transfer site required, try/catch unreliable, 10-20x larger than EVM |
| No EVM CREATE2 | pallet-revive doesn't support some EVM opcodes | Cannot use factory patterns |
| System precompile at 0x900 | Polkadot Hub specific | Must guard with code.length check for Hardhat compatibility |
| Denomination rounding | eth-rpc adapter bug | All transfers must be clean multiples of 10^6 planck |

---

## 10. Test Coverage

### Hardhat EVM Tests: 132/132

| Suite | Tests | Coverage |
|-------|-------|----------|
| campaigns.test.ts | 31 | Full campaign lifecycle, open campaigns, daily cap, auto-complete, metadata, all status transitions |
| settlement.test.ts | 37 | Hash chain validation, revenue split, all 13 rejection reasons, batch processing, stop-on-first-gap, pull payments, open campaign settlement |
| governance.test.ts | 44 | Conviction weighting, quorum, slash, termination protection, grace period, lockup, re-voting, edge cases |
| pause.test.ts | 11 | Global pause on all contracts, pause bypass verification |
| timelock.test.ts | 19 | Propose/execute/cancel, delay enforcement, ownership transfer, edge cases |
| integration.test.ts | 9 | Full happy path (A), termination+slash (B), pending expiry (C), gap handling (D), take rate snapshot (E), relay full flow (F) |

### Extension Jest Tests: 140/140

9 test suites covering: claim building, claim queue, quality scoring, content safety, phishing list, engagement tracking, behavior chain, wallet manager, campaign poller.

### Testnet Deployment Verification

- ECRecover precompile verified working on Paseo
- 9 contracts deployed and wired
- 6 accounts funded, 2 publishers registered
- Campaign #1 active with governance vote
- Publisher relay running, attestations working
