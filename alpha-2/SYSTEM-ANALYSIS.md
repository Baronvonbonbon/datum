# DATUM Protocol — Complete System Analysis

**Version:** 2.0
**Date:** 2026-03-24
**Scope:** Full analysis of the 13 alpha-2 Solidity contracts, their interfaces, data flows, trust model, and current state.

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
   - 4.10 [DatumPaymentVault](#410-datumpaymentvault)
   - 4.11 [DatumBudgetLedger](#411-datumbudgetledger)
   - 4.12 [DatumCampaignLifecycle](#412-datumcampaignlifecycle)
   - 4.13 [DatumAttestationVerifier](#413-datumattestationverifier)
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

All contracts target Solidity 0.8.24, compiled with `resolc` v1.0.0 for PVM (PolkaVM) bytecode. Each must fit under the 49,152-byte PVM contract size limit.

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
    ↑ read by: Publishers, Campaigns, Settlement (inline staticcall), Relay, CampaignLifecycle

DatumTimelock (standalone)
    ↓ owns: Campaigns, Settlement (post-deploy ownership transfer)

DatumPublishers (OZ ReentrancyGuard+Ownable, uses PauseRegistry)
    ↑ read by: Campaigns (take rate snapshot, blocklist, allowlist), Settlement (blocklist check)
    S12: global blocklist + per-publisher allowlist

DatumCampaigns (core state, manual _locked reentrancy)
    ← reads: PauseRegistry, Publishers
    ← called by: GovernanceV2 (activateCampaign), CampaignLifecycle (setCampaignStatus, setTerminationBlock)
    → calls: BudgetLedger.initializeBudget{value}() on campaign creation

DatumBudgetLedger (OZ ReentrancyGuard, budget escrow)
    ← called by: Campaigns (initializeBudget), Settlement (deductAndTransfer), CampaignLifecycle (drainToAdvertiser, drainFraction)
    → sends DOT: to PaymentVault (deductAndTransfer), to Advertiser (drainToAdvertiser), to GovernanceV2 (drainFraction)
    P20: tracks lastSettlementBlock per campaign

DatumCampaignLifecycle (OZ ReentrancyGuard, lifecycle transitions)
    ← reads: Campaigns (status, advertiser, pendingExpiryBlock), BudgetLedger (lastSettlementBlock), PauseRegistry
    ← called by: GovernanceV2 (terminateCampaign), Settlement (completeCampaign auto-complete), Advertiser (completeCampaign)
    → calls: Campaigns.setCampaignStatus(), BudgetLedger.drainToAdvertiser()/drainFraction()
    P20: expireInactiveCampaign() — permissionless 30-day timeout

DatumPaymentVault (OZ ReentrancyGuard+Ownable, pull-payment vault)
    ← receives DOT: from BudgetLedger.deductAndTransfer()
    ← called by: Settlement (creditSettlement — records balance split)
    → sends DOT: to Publisher, User, Protocol (pull-payment withdrawals)
    O3: minimumBalance() dust guard on all withdrawals

DatumGovernanceV2 (conviction-weighted voting, no explicit reentrancy — CEI pattern)
    ← reads: Campaigns (getCampaignForSettlement — status check)
    ← called by: GovernanceSlash (slashAction)
    → calls: Campaigns.activateCampaign(), CampaignLifecycle.terminateCampaign()
    → sends DOT: to voters (withdraw), to slash claimants (slashAction)
    Uses ISystem precompile: minimumBalance() for dust prevention

DatumGovernanceSlash (OZ ReentrancyGuard, slash distribution)
    ← reads: GovernanceV2 (resolved, ayeWeighted, nayWeighted, slashCollected, getVote, convictionWeight)
    ← reads: Campaigns (getCampaignForSettlement — status check)
    → calls: GovernanceV2.slashAction() to transfer rewards

DatumSettlement (OZ ReentrancyGuard, claim processing)
    ← reads: Campaigns (getCampaignForSettlement — inline staticcall), Publishers (isBlocked — inline staticcall), PauseRegistry (inline staticcall)
    ← called by: Relay (settleClaims), AttestationVerifier (settleClaims), User (settleClaims direct)
    → calls: BudgetLedger.deductAndTransfer(), PaymentVault.creditSettlement(), CampaignLifecycle.completeCampaign() (auto-complete)
    Uses ISystem precompile: hashBlake256() for claim hash verification (keccak256 fallback on EVM)
    S12: publisher blocklist check in _validateClaim() (reason code 11)

DatumRelay (no state mutation — pure forwarding + sig verification)
    ← reads: PauseRegistry, Campaigns (getCampaignForSettlement for publisher co-sig)
    → calls: Settlement.settleClaims()
    EIP-712 domain: "DatumRelay"

DatumAttestationVerifier (P1 — mandatory publisher attestation for direct settlement)
    ← reads: Campaigns (getCampaignForSettlement — publisher lookup)
    → calls: Settlement.settleClaims()
    EIP-712 domain: "DatumAttestationVerifier"
    All campaigns require attestation: targeted verifies against cPublisher, open verifies against claims[0].publisher

DatumZKVerifier (standalone, stub)
    Currently unused — ZK verification removed from Settlement in alpha-2
```

---

## 3. Deployment and Wiring

### Deploy Order

1. **DatumPauseRegistry** — no dependencies
2. **DatumTimelock** — no dependencies
3. **DatumPublishers**(takeRateUpdateDelayBlocks=14400, pauseRegistry)
4. **DatumCampaigns**(minimumCpmFloor, pendingTimeoutBlocks=28800, publishers, pauseRegistry)
5. **DatumBudgetLedger** — no constructor args
6. **DatumPaymentVault** — no constructor args
7. **DatumCampaignLifecycle**(pauseRegistry, inactivityTimeoutBlocks=432000)
8. **DatumGovernanceV2**(campaigns, quorum=100 DOT, slashBps=1000, terminationQuorum=100 DOT, baseGrace=14400, gracePerQuorum=14400, maxGrace=432000)
9. **DatumGovernanceSlash**(voting=GovernanceV2, campaigns)
10. **DatumSettlement**(campaigns, pauseRegistry)
11. **DatumRelay**(settlement, campaigns, pauseRegistry)
12. **DatumAttestationVerifier**(settlement, campaigns)
13. **DatumZKVerifier** — no dependencies

### Post-Deploy Wiring

```
// Campaigns wiring
campaigns.setSettlementContract(settlement)
campaigns.setGovernanceContract(governanceV2)
campaigns.setLifecycleContract(lifecycle)
campaigns.setBudgetLedger(budgetLedger)

// BudgetLedger wiring
budgetLedger.setCampaigns(campaigns)
budgetLedger.setSettlement(settlement)
budgetLedger.setLifecycle(lifecycle)

// CampaignLifecycle wiring
lifecycle.setCampaigns(campaigns)
lifecycle.setBudgetLedger(budgetLedger)
lifecycle.setGovernanceContract(governanceV2)
lifecycle.setSettlementContract(settlement)

// Settlement wiring
settlement.configure(budgetLedger, paymentVault, lifecycle, relay, publishers)
settlement.setAttestationVerifier(attestationVerifier)

// PaymentVault wiring
paymentVault.setSettlement(settlement)

// GovernanceV2 wiring
governanceV2.setSlashContract(governanceSlash)   // one-shot, irreversible
governanceV2.setLifecycle(lifecycle)

// Ownership transfer
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

**Purpose:** Publisher registry with S12 blocklist/allowlist. Publishers register with a take rate (30-80%), can queue rate updates with a block delay, and declare category bitmasks for ad matching. Owner can globally block addresses; publishers can manage per-publisher advertiser allowlists.

**PVM Size:** 35,741 bytes (13,411 spare)

**Inherits:** OZ ReentrancyGuard, Ownable (no Pausable — S5 uses global PauseRegistry)

**Constants:**
| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_TAKE_RATE_BPS` | 3000 | 30% minimum |
| `MAX_TAKE_RATE_BPS` | 8000 | 80% maximum |
| `DEFAULT_TAKE_RATE_BPS` | 5000 | 50% — used for open campaigns (publisher=address(0)) |

**Constructor:**
```solidity
constructor(uint256 _takeRateUpdateDelayBlocks, address _pauseRegistry)
```
- `_takeRateUpdateDelayBlocks`: Block delay before queued take rate becomes effective (14,400 = ~24h on Polkadot Hub)
- `_pauseRegistry`: DatumPauseRegistry address for global pause

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `_publishers` | mapping(address => Publisher) | Private publisher registry |
| `takeRateUpdateDelayBlocks` | uint256 | Configurable delay for rate updates |
| `blocked` | mapping(address => bool) | S12 global blocklist |
| `allowlistEnabled` | mapping(address => bool) | S12 per-publisher allowlist toggle |
| `_allowedAdvertisers` | mapping(address => mapping(address => bool)) | S12 per-publisher advertiser allowlist |
| `pauseRegistry` | IDatumPauseRegistry | Global pause reference |

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
| `registerPublisher(takeRateBps)` | anyone, nonReentrant, whenNotPaused | uint16 takeRateBps (3000-8000) | Register msg.sender as publisher. Reverts if blocked (E62). |
| `updateTakeRate(newTakeRateBps)` | registered publisher, nonReentrant, whenNotPaused | uint16 newTakeRateBps (3000-8000) | Queue rate update with delay |
| `applyTakeRateUpdate()` | registered publisher, nonReentrant, whenNotPaused | (none) | Apply queued update if delay elapsed |
| `setCategories(bitmask)` | registered publisher, whenNotPaused | uint256 bitmask | Set category bitmask (bits 1-26) |
| `getPublisher(publisher)` | view | address | Returns full Publisher struct |
| `getCategories(publisher)` | view | address | Returns categoryBitmask |
| `isRegisteredWithRate(publisher)` | view | address | Returns (bool registered, uint16 takeRateBps) — slim getter |
| `isBlocked(addr)` | view | address | Returns blocked status |
| `blockAddress(addr)` | owner only | address | S12 global blocklist — block an address |
| `unblockAddress(addr)` | owner only | address | S12 global unblock |
| `setAllowlistEnabled(enabled)` | publisher, whenNotPaused | bool | S12 toggle per-publisher allowlist |
| `setAllowedAdvertiser(advertiser, allowed)` | publisher, whenNotPaused | address, bool | S12 manage per-publisher advertiser allowlist |
| `isAllowedAdvertiser(publisher, advertiser)` | view | address, address | S12 check if advertiser is on publisher's allowlist |

**Events:** `PublisherRegistered`, `PublisherTakeRateQueued`, `PublisherTakeRateApplied`, `CategoriesUpdated`, `AddressBlocked`, `AddressUnblocked`, `AllowlistToggled`, `AdvertiserAllowlistUpdated`

**Notes:**
- Uses global PauseRegistry (S5), no contract-level pause.
- `isRegisteredWithRate()` is a slim getter that avoids full struct ABI decode in PVM — saves bytecode in callers.
- Category bitmask: bit N corresponds to category ID N (1-26). Extension matches campaigns by `(campaign.categoryId & publisher.categoryBitmask) != 0`.
- S12 blocklist: `blockAddress()`/`unblockAddress()` are onlyOwner. Must migrate to timelock-gated before mainnet.

---

### 4.4 DatumCampaigns

**Purpose:** Campaign state management. Handles creation (with DOT escrow via BudgetLedger), activation by governance, pausing by advertiser. Lifecycle transitions (complete, terminate, expire) moved to CampaignLifecycle satellite. Budget management moved to BudgetLedger satellite.

**PVM Size:** 42,466 bytes (6,686 spare)

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
| `lifecycleContract` | address | Authorized CampaignLifecycle caller |
| `budgetLedger` | IDatumBudgetLedger | Budget escrow reference |
| `publishers` | IDatumPublishers | Publisher registry reference |
| `pauseRegistry` | IDatumPauseRegistry | Pause registry reference |

**Campaign Struct (8 fields — budget fields moved to BudgetLedger):**
```solidity
struct Campaign {
    address advertiser;
    address publisher;           // address(0) = open campaign (any publisher)
    uint256 pendingExpiryBlock;  // Auto-expire after this block
    uint256 terminationBlock;    // Block of governance termination (0 = not terminated)
    uint256 bidCpmPlanck;        // Max CPM per 1000 impressions
    uint16 snapshotTakeRateBps;  // Publisher take rate locked at creation
    CampaignStatus status;       // Enum: Pending/Active/Paused/Completed/Terminated/Expired
    uint8 categoryId;            // 0=uncategorized, 1-26 taxonomy
}
```

**Campaign Status State Machine:**
```
                     evaluateCampaign()           completeCampaign() (via Lifecycle)
    Pending ──────────────────────→ Active ──────────────────────→ Completed
       │                              │  ↑
       │ expirePendingCampaign()      │  │ togglePause()
       │ (via Lifecycle)              │  │
       ↓                              │  │
    Expired                        Paused
                                      │
                        terminateCampaign() (via Lifecycle)
                                      ↓
                                 Terminated
```

**Functions:**
| Function | Access | Payable | Description |
|----------|--------|---------|-------------|
| `createCampaign(publisher, dailyCapPlanck, bidCpmPlanck, categoryId)` | anyone | yes (msg.value = budget) | Create campaign. Snapshots publisher take rate. If publisher=address(0), uses DEFAULT_TAKE_RATE_BPS (5000). Calls budgetLedger.initializeBudget{value}(). S12: checks blocklist (E62) and allowlist (E63). Returns campaignId. |
| `setMetadata(campaignId, metadataHash)` | advertiser only | no | Emit CampaignMetadataSet event with IPFS CID hash. Metadata stored off-chain. |
| `activateCampaign(campaignId)` | governance only (E19), Pending only (E20), not paused | no | Pending → Active |
| `togglePause(campaignId, pause)` | advertiser only (E21) | no | Active ↔ Paused |
| `setCampaignStatus(campaignId, newStatus)` | lifecycleContract only (E25) | no | Set campaign status (used by CampaignLifecycle for complete/terminate/expire) |
| `setTerminationBlock(campaignId, blockNum)` | lifecycleContract only (E25) | no | Set termination block (used by CampaignLifecycle) |
| `getCampaignForSettlement(campaignId)` | view | — | Returns (status, publisher, bidCpmPlanck, snapshotTakeRateBps). Slim 4-field tuple to minimize PVM ABI decode overhead. |
| `setSettlementContract(addr)` | owner only | no | Set authorized settlement caller |
| `setGovernanceContract(addr)` | owner only | no | Set authorized governance caller |
| `setLifecycleContract(addr)` | owner only | no | Set authorized lifecycle caller |
| `setBudgetLedger(addr)` | owner only | no | Set budget ledger reference |
| `transferOwnership(newOwner)` | owner only | no | Transfer admin ownership |

**Events:** `CampaignCreated`, `CampaignMetadataSet`, `CampaignActivated`, `CampaignPaused`, `CampaignResumed`

**Critical Design Notes:**

1. **Take rate snapshot:** At campaign creation, the publisher's current `takeRateBps` is copied into `snapshotTakeRateBps`. Settlement always uses this snapshot, never the live rate. This prevents a publisher from increasing their take rate after a campaign starts.

2. **Open campaigns:** When `publisher=address(0)`, any registered publisher can serve the ad. The snapshot take rate defaults to 5000 (50%). The extension resolves the publisher at runtime.

3. **Manual reentrancy guard:** Uses `_locked` bool instead of OZ `ReentrancyGuard` modifier. Campaigns has no OZ imports, so importing OZ just for reentrancy would cost +707 B PVM. At 42,466 bytes (6,686 spare), this is still efficient.

4. **Single transfer site:** All native transfers go through `_send(address, uint256)` to avoid a resolc codegen bug where multiple `transfer()` sites produce broken RISC-V code.

5. **S12 blocklist/allowlist:** `createCampaign` checks `publishers.isBlocked(msg.sender)` and `publishers.isBlocked(publisher)` (E62). If publisher has allowlist enabled, checks `publishers.isAllowedAdvertiser(publisher, msg.sender)` (E63).

6. **Satellite pattern:** Budget management (remainingBudget, dailyCap, dailySpent, lastSpendDay) extracted to BudgetLedger. Lifecycle transitions (complete, terminate, expire) extracted to CampaignLifecycle. Campaigns only stores core state and delegates via `setCampaignStatus`/`setTerminationBlock` (gated to lifecycleContract).

---

### 4.5 DatumGovernanceV2

**Purpose:** Conviction-weighted voting for campaign activation and termination, with symmetric slash for the losing side. Escalating conviction with 9 levels (0-8), hardcoded weights and lockups.

**PVM Size:** 47,939 bytes (1,213 spare — critically constrained)

**Constructor:**
```solidity
constructor(
    address _campaigns,
    uint256 _quorum,                  // 100 DOT (10^12 planck)
    uint256 _slashBps,                // 1000 (10%)
    uint256 _terminationQuorum,       // 100 DOT
    uint256 _baseGrace,               // 14400 blocks (~24h)
    uint256 _gracePerQuorum,          // 14400 blocks
    uint256 _maxGrace                 // 432000 blocks (~30d)
)
```
Note: No baseLockup/maxLockup parameters — lockups are hardcoded in if/else chains (saves ~2.7 KB vs storage arrays).

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Admin (can set slashContract) |
| `campaigns` | address | DatumCampaigns reference |
| `slashContract` | address | DatumGovernanceSlash (set once, irreversible) |
| `lifecycle` | IDatumCampaignLifecycle | CampaignLifecycle reference |
| `baseGraceBlocks` | uint256 | Base grace period for termination |
| `gracePerQuorum` | uint256 | Grace scaling factor per quorum of nay weight |
| `maxGraceBlocks` | uint256 | Maximum grace period cap |
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
    uint8 conviction;         // 0-8
    uint256 lockedUntilBlock; // Can't withdraw until this block
}
```

**Conviction Mechanics (9 levels, hardcoded):**
| Conviction | Weight | Lockup |
|------------|--------|--------|
| 0 | 1x | 0 (instant withdraw) |
| 1 | 2x | 1 day (14,400 blocks) |
| 2 | 3x | 3 days (43,200 blocks) |
| 3 | 4x | 7 days (100,800 blocks) |
| 4 | 6x | 21 days (302,400 blocks) |
| 5 | 9x | 90 days (1,296,000 blocks) |
| 6 | 14x | 180 days (2,592,000 blocks) |
| 7 | 18x | 270 days (3,888,000 blocks) |
| 8 | 21x | 365 days (5,256,000 blocks) |

Weights and lockups are hardcoded via if/else chains — no storage arrays. Conviction 0 = no lock (low-risk entry), conviction 8 = 21x at 365d (maximum commitment).

**Functions:**
| Function | Access | Payable | Description |
|----------|--------|---------|-------------|
| `vote(campaignId, aye, conviction)` | anyone, campaign Pending/Active | yes (stake) | Cast conviction-weighted vote. One vote per (campaign, voter). Records `firstNayBlock` on first nay. Conviction 0-8 (E40 if > 8). |
| `withdraw(campaignId)` | voter, after lockup | no | Return stake minus slash (if on losing side of resolved campaign). Zeroes vote (allows re-voting if campaign still active). Uses system precompile for dust prevention (E58). |
| `evaluateCampaign(campaignId)` | anyone | no | Evaluate campaign state transition based on vote tallies. See evaluation logic below. |
| `slashAction(action, campaignId, target, value)` | slashContract only | no | Transfer DOT to `target` (action=0). Used by GovernanceSlash to pay winners. Dust prevention via system precompile (E58). |
| `setSlashContract(_slash)` | owner, one-shot (E51 if already set) | no | Set GovernanceSlash address. Irreversible. |
| `setLifecycle(addr)` | owner | no | Set CampaignLifecycle reference |
| `getVote(campaignId, voter)` | view | — | Returns (direction, lockAmount, conviction, lockedUntilBlock) |
| `convictionWeight(conviction)` | pure | — | Returns weight for conviction level (public, used by GovernanceSlash) |

**Evaluation Logic (evaluateCampaign):**

| Campaign Status | Condition | Action | Result Code |
|----------------|-----------|--------|-------------|
| Pending (0) | total >= quorum AND aye > 50% | activateCampaign() | 1 |
| Pending (0) | total >= quorum AND aye <= 50% | Revert E47 (aye majority required) | — |
| Active (1) / Paused (2) | nay >= 50% AND nay >= terminationQuorum AND scaled grace elapsed | lifecycle.terminateCampaign(), set resolved | 4 |
| Completed (3) | not yet resolved | Set resolved (enables slash) | 3 |
| Terminated (4) | not yet resolved | Set resolved | 4 |
| Other | — | Revert E50 | — |

**Anti-Grief Termination Protection:**
Three guards prevent a single low-stake nay vote from terminating an active campaign:
1. **terminationQuorum** (E52): Nay-side weighted total must be >= 100 DOT
2. **Scaled grace period** (E53): `grace = baseGraceBlocks + (total * gracePerQuorum / quorumWeighted)`, capped at `maxGraceBlocks`. Must wait this duration after the first nay vote before termination can be evaluated. Higher total stakes = longer grace.
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

**Purpose:** Distributes slash pool rewards to winning-side voters. Two-step: finalize (snapshot winning weight), then each winner claims their proportional share. Unclaimed pools can be swept after deadline.

**PVM Size:** 37,160 bytes (11,992 spare)

**Inherits:** OZ ReentrancyGuard

**Constructor:**
```solidity
constructor(address _voting, address _campaigns)
```

**Constants:**
| Constant | Value | Description |
|----------|-------|-------------|
| `SWEEP_DEADLINE_BLOCKS` | 5,256,000 | ~365 days before unclaimed pools can be swept |

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `voting` | address | DatumGovernanceV2 |
| `campaigns` | address | DatumCampaigns |
| `winningWeight[campaignId]` | uint256 | Snapshot of winning side's total weighted votes |
| `finalized[campaignId]` | bool | Whether slash has been finalized |
| `finalizedBlock[campaignId]` | uint256 | Block when finalized (for sweep deadline) |
| `claimed[campaignId][voter]` | bool | Whether voter has claimed their slash reward |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `finalizeSlash(campaignId)` | anyone, not yet finalized (E59), must be resolved (E60) | Snapshot the winning side's total weight. Completed → aye weight. Terminated → nay weight. |
| `claimSlashReward(campaignId)` | winner, finalized (E54), not yet claimed (E55), lockup expired (E45) | Calculate `share = pool * voterWeight / winningWeight`, transfer via V2.slashAction(). |
| `getClaimable(campaignId, voter)` | view | Returns claimable amount (0 if not winner, already claimed, or not finalized) |
| `sweepSlashPool(campaignId)` | anyone, finalized, past deadline | Sweep unclaimed slash pool to owner. Reverts if zero balance (E61). |

**Slash Distribution Formula:**
```
voterWeight = lockAmount * convictionWeight(conviction)
pool = slashCollected[campaignId]     // accumulated from losing-side withdrawals
share = pool * voterWeight / winningWeight
```

Note: Uses `convictionWeight()` public function from GovernanceV2 (not `1 << conviction`).

**Flow:**
1. Campaign resolves (Completed or Terminated)
2. Losing-side voters withdraw → slashBps (10%) deducted → `slashCollected` accumulates
3. Anyone calls `finalizeSlash(campaignId)` → snapshots winning weight
4. Each winner calls `claimSlashReward(campaignId)` → receives proportional share
5. DOT transfers from GovernanceV2 balance via `slashAction(0, campaignId, winner, amount)`
6. After SWEEP_DEADLINE_BLOCKS, anyone can call `sweepSlashPool(campaignId)` to recover unclaimed dust

**Important:** Finalization should happen *after* all losing-side voters have withdrawn, to maximize the slash pool. If finalized early, rewards are based on whatever has been collected so far.

---

### 4.7 DatumSettlement

**Purpose:** Core settlement engine. Validates claim hash chains, processes batches, and coordinates budget deduction (via BudgetLedger) and revenue recording (via PaymentVault). No longer holds DOT or manages pull-payment balances.

**PVM Size:** 48,052 bytes (1,100 spare — critically constrained)

**Inherits:** OZ ReentrancyGuard (no Ownable — manual owner)

**Constructor:**
```solidity
constructor(address _campaigns, address _pauseRegistry)
```

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Admin (transferred to Timelock post-deploy) |
| `campaigns` | address | Campaigns reference (plain address, inline staticcall — no typed interface import) |
| `budgetLedger` | address | BudgetLedger for budget deduction |
| `paymentVault` | address | PaymentVault for revenue recording |
| `lifecycle` | address | CampaignLifecycle for auto-complete |
| `relayContract` | address | Authorized DatumRelay caller |
| `pauseRegistry` | address | Pause registry (plain address, inline staticcall) |
| `publishers` | address | Publishers registry (plain address, inline staticcall for blocklist) |
| `attestationVerifier` | address | Authorized AttestationVerifier caller |
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
}
```
Note: `zkProof` field removed — ZK verification removed from Settlement in alpha-2.

**Claim Hash Formula (must match extension):**
```solidity
// On PolkaVM: Blake2-256 via ISystem(0x900).hashBlake256()
// On EVM (Hardhat): keccak256 fallback
hash(abi.encodePacked(
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
| `settleClaims(batches)` | user or relayContract or attestationVerifier (E32), nonReentrant, not paused | Process claim batches. Each batch has a user, campaignId, and array of claims. |
| `configure(budgetLedger, paymentVault, lifecycle, relay, publishers)` | owner | Consolidated 5-arg admin setter |
| `setAttestationVerifier(addr)` | owner | Set authorized attestation verifier caller |
| `transferOwnership(newOwner)` | owner | Transfer admin ownership |

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
| 12 | `publishers.isBlocked(claim.publisher)` | 11 | Publisher blocked (S12 blocklist) |

**Revenue Split (_settleSingleClaim):**
```
totalPayment     = (clearingCpmPlanck * impressionCount) / 1000
publisherPayment = totalPayment * snapshotTakeRateBps / 10000
remainder        = totalPayment - publisherPayment
userPayment      = remainder * 7500 / 10000   (75%)
protocolFee      = remainder - userPayment     (25%)
```

Settlement calls `budgetLedger.deductAndTransfer(campaignId, totalPayment, paymentVault)` to move DOT from escrow to PaymentVault, then `paymentVault.creditSettlement(publisher, pubAmount, user, userAmount, protocolFee)` to record the balance split.

**Example (50% take rate, 0.016 DOT CPM, 1000 impressions):**
```
totalPayment     = 0.016 DOT = 160,000,000 planck
publisherPayment = 80,000,000 planck (50%)
remainder        = 80,000,000 planck
userPayment      = 60,000,000 planck (75% of remainder = 37.5% of total)
protocolFee      = 20,000,000 planck (25% of remainder = 12.5% of total)
```

**Events:** `ClaimSettled` (with full payment breakdown), `ClaimRejected` (with reason code)

**Batch Size Limit:** `MAX_CLAIMS_PER_BATCH = 5` (enforced on-chain, E28)

**Design Notes:**
- Settlement no longer holds DOT or manages withdrawals — all DOT flows through BudgetLedger to PaymentVault.
- Uses plain `address` types with inline staticcall for campaigns, pauseRegistry, and publishers (no typed interface imports — saves ~3 KB PVM each).
- Admin consolidated into single `configure()` (5-arg) + `transferOwnership()` + `setAttestationVerifier()` — ContractReferenceChanged events removed (saved 2,640 B for O1).
- Blake2-256 claim hash via `ISystem(0x900).hashBlake256()` with keccak256 fallback on EVM (O1). Guarded by `SYSTEM_ADDR.code.length > 0`.
- S12: `_validateClaim()` calls `publishers.isBlocked(claim.publisher)` — reason code 11.

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

**Purpose:** Stub ZK proof verifier. Currently unused in alpha-2 — ZK verification removed from Settlement. Post-alpha, this will be replaced with a real Groth16/PLONK verifier integrated via Relay or a separate verifier contract.

**PVM Size:** 1,409 bytes (47,743 spare)

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `verify(proof, publicInputsHash)` | pure | Returns `proof.length > 0` |

**Integration:** ZK verification was removed from Settlement in alpha-2 to save PVM space. The contract is deployed but unused. Post-alpha: Groth16 circuits will require BN128 pairing precompile (P9).

---

### 4.10 DatumPaymentVault

**Purpose:** Pull-payment vault for publisher, user, and protocol balances. Extracted from DatumSettlement (alpha). DOT arrives from BudgetLedger; Settlement records balance split.

**PVM Size:** 17,341 bytes (31,811 spare)

**Inherits:** OZ ReentrancyGuard, Ownable

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `settlement` | address | Authorized credit caller |
| `publisherBalance[address]` | uint256 | Accumulated publisher earnings (pull pattern) |
| `userBalance[address]` | uint256 | Accumulated user earnings (pull pattern) |
| `protocolBalance` | uint256 | Accumulated protocol fees |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `creditSettlement(publisher, pubAmount, user, userAmount, protocolAmount)` | settlement only | Non-payable (DOT already at vault from BudgetLedger). Records balance split. |
| `withdrawPublisher()` | publisher, nonReentrant | Pull payment — withdraw accumulated publisher balance |
| `withdrawUser()` | user, nonReentrant | Pull payment — withdraw accumulated user balance |
| `withdrawProtocol(recipient)` | owner, nonReentrant | Pull protocol fees to specified address |
| `setSettlement(addr)` | onlyOwner | Set authorized settlement caller |

**O3 Dust Guard:** `_send()` checks `minimumBalance()` via system precompile (E58) on all withdrawals. Guarded by `SYSTEM_ADDR.code.length > 0` for Hardhat compatibility.

**Events:** `SettlementCredited`, `PublisherWithdrawal`, `UserWithdrawal`, `ProtocolWithdrawal`

---

### 4.11 DatumBudgetLedger

**Purpose:** Per-campaign budget escrow and daily cap enforcement. Extracted from DatumCampaigns (alpha).

**PVM Size:** 29,809 bytes (19,343 spare)

**Inherits:** OZ ReentrancyGuard

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `Budget.remaining` | uint256 | Remaining campaign budget in planck |
| `Budget.dailyCap` | uint256 | Max spend per day |
| `Budget.dailySpent` | uint256 | Spent today |
| `Budget.lastSpendDay` | uint256 | block.timestamp / 86400 |
| `_budgets` | mapping(uint256 => Budget) | Per-campaign budget storage |
| `lastSettlementBlock` | mapping(uint256 => uint256) | P20 inactivity tracking (set on init, updated on deduct) |
| `owner` | address | Admin |
| `campaigns` | address | Authorized Campaigns caller |
| `settlement` | address | Authorized Settlement caller |
| `lifecycle` | address | Authorized CampaignLifecycle caller |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `initializeBudget(campaignId, budget, dailyCap)` | campaigns only, payable | Sets initial budget + lastSettlementBlock = block.number |
| `deductAndTransfer(campaignId, amount, recipient)` | settlement only, nonReentrant | Deducts budget, enforces daily cap (E26), updates lastSettlementBlock, forwards DOT to PaymentVault. Returns exhausted bool. |
| `drainToAdvertiser(campaignId, advertiser)` | lifecycle only, nonReentrant | Full refund of remaining budget to advertiser |
| `drainFraction(campaignId, recipient, bps)` | lifecycle only, nonReentrant | Partial drain (e.g. 10% termination slash to GovernanceV2) |
| `sweepDust(campaignId)` | anyone, nonReentrant | Terminal campaigns (status >= 3) only. Sends dust to owner. |
| `getRemainingBudget(campaignId)` | view | Returns remaining budget |
| `getDailyCap(campaignId)` | view | Returns daily cap |
| `setCampaigns(addr)` / `setSettlement(addr)` / `setLifecycle(addr)` | owner | Admin setters |
| `transferOwnership(newOwner)` | owner | Transfer admin ownership |

**Events:** `BudgetInitialized`, `BudgetDeducted`, `BudgetDrained`, `DustSwept`, `ContractReferenceChanged`

---

### 4.12 DatumCampaignLifecycle

**Purpose:** Campaign lifecycle transitions: complete, terminate, expire. Extracted from DatumCampaigns (alpha).

**PVM Size:** 40,910 bytes (8,242 spare)

**Inherits:** OZ ReentrancyGuard

**Constructor:**
```solidity
constructor(address _pauseRegistry, uint256 _inactivityTimeoutBlocks)
```
- `_pauseRegistry`: DatumPauseRegistry address
- `_inactivityTimeoutBlocks`: P20 timeout (432,000 blocks = ~30 days)

**State:**
| Variable | Type | Description |
|----------|------|-------------|
| `owner` | address | Admin |
| `campaigns` | IDatumCampaigns | Campaigns reference |
| `budgetLedger` | IDatumBudgetLedger | Budget ledger reference |
| `pauseRegistry` | address | Pause registry reference |
| `governanceContract` | address | Authorized governance caller |
| `settlementContract` | address | Authorized settlement caller |
| `inactivityTimeoutBlocks` | uint256 immutable | P20 timeout (432,000 blocks) |

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `completeCampaign(campaignId)` | advertiser or settlement, nonReentrant | Active/Paused → Completed. Full refund via drainToAdvertiser. |
| `terminateCampaign(campaignId)` | governanceContract only, nonReentrant, not paused | Active/Paused → Terminated. 10% slash to governance (drainFraction 1000 bps), 90% refund to advertiser (drainToAdvertiser). |
| `expirePendingCampaign(campaignId)` | anyone, nonReentrant | Pending past expiryBlock → Expired. Full refund via drainToAdvertiser. |
| `expireInactiveCampaign(campaignId)` | anyone, nonReentrant | P20: Active/Paused + block.number > lastSettlementBlock + inactivityTimeoutBlocks (E64) → Completed. Full refund via drainToAdvertiser. |
| `setCampaigns(addr)` / `setBudgetLedger(addr)` / `setGovernanceContract(addr)` / `setSettlementContract(addr)` | owner | Admin setters |
| `transferOwnership(newOwner)` | owner | Transfer admin ownership |

**Events:** `CampaignCompleted`, `CampaignTerminated`, `CampaignExpired`, `ContractReferenceChanged`

---

### 4.13 DatumAttestationVerifier

**Purpose:** P1 — Mandatory publisher attestation for direct claim settlement. Wraps settleClaims() with EIP-712 publisher co-signature enforcement.

**PVM Size:** 35,920 bytes (13,232 spare)

**Immutables:**
| Variable | Type | Description |
|----------|------|-------------|
| `settlement` | IDatumSettlement | Settlement contract |
| `campaigns` | IDatumCampaignsSettlement | Campaigns contract |
| `DOMAIN_SEPARATOR` | bytes32 | EIP-712, domain name "DatumAttestationVerifier" |

**EIP-712 Type Hash:**
```
PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,uint256 lastNonce,uint256 claimCount)
```
Same type hash as DatumRelay, but different domain (different DOMAIN_SEPARATOR). Signatures are not interchangeable.

**AttestedBatch Struct:**
```solidity
struct AttestedBatch {
    address user;
    uint256 campaignId;
    Claim[] claims;
    bytes publisherSig;
}
```

**Functions:**
| Function | Access | Description |
|----------|--------|-------------|
| `settleClaimsAttested(AttestedBatch[])` | batch.user (E32) | Verify publisher EIP-712 sig for ALL campaigns (E33 length, E34 wrong signer). Targeted: verify against campaign publisher. Open: verify against claims[0].publisher. Forward to settlement.settleClaims(). |

**Design Notes:**
- Users call this instead of Settlement.settleClaims() directly for trusted settlement
- Settlement auth check includes attestationVerifier address
- Different DOMAIN_SEPARATOR from Relay — signatures are not interchangeable
- No state mutation — pure verification + forwarding

---

## 5. Complete Data Flow

### 5.1 Campaign Lifecycle

```
Advertiser                     Campaigns              BudgetLedger         GovernanceV2         CampaignLifecycle
    │                              │                       │                    │                    │
    │── createCampaign{value} ────→│──→ initializeBudget ─→│ Store budget        │                    │
    │   (publisher, dailyCap,      │   {value: DOT}       │ lastSettlementBlock │                    │
    │    bidCpm, categoryId)       │                       │ = block.number      │                    │
    │                              │ status=Pending         │                    │                    │
    │                              │                        │                    │                    │
Voter ─── vote{value}(cId,aye) ──────────────────────────────────────────────→│ Record vote          │
    │                              │                        │                    │                    │
Anyone── evaluateCampaign(cId) ─────────────────────────────────────────────→│ Check majority      │
    │                              │←── activateCampaign ───│                    │ + quorum            │
    │                              │    status=Active        │                    │                    │
    │                              │                        │                    │                    │
    │── completeCampaign(cId) ──────────────────────────────────────────────────────────────────────→│
    │                              │←── setCampaignStatus ──│                    │                    │
    │                              │    status=Completed     │←── drainToAdvertiser ←────────────────│
    │                              │                        │ DOT→advertiser      │                    │
```

### 5.2 Claim Settlement Flow

```
User (browser extension)       Publisher Relay     DatumRelay / AttestationVerifier    Settlement         BudgetLedger    PaymentVault
    │                                 │                       │                          │                  │                │
    │ Build claims locally            │                       │                          │                  │                │
    │ (hash chain, nonces,            │                       │                          │                  │                │
    │  quality scoring)               │                       │                          │                  │                │
    │                                 │                       │                          │                  │                │
    │── Path A: Direct settlement ──────────────────────────────→ settleClaims() ────────→│                  │                │
    │                                 │                       │                          │                  │                │
    │── Path B: Attested ────────────────→ settleClaimsAttested() ─→ settleClaims() ────→│                  │                │
    │   (publisher EIP-712 sig)       │   (P1 verification)   │                          │                  │                │
    │                                 │                       │                          │                  │                │
    │── Path C: Relay ───────────────→│── settleClaimsFor ───→│──→ settleClaims() ──────→│                  │                │
    │   (user EIP-712 sig)            │   (sig verification)  │                          │                  │                │
    │                                 │                       │                          │ Validate claims  │                │
    │                                 │                       │                          │ S12 blocklist    │                │
    │                                 │                       │                          │── deductAndTransfer ──→│           │
    │                                 │                       │                          │                  │──→ DOT ────────→│
    │                                 │                       │                          │── creditSettlement ──────────────→│
    │                                 │                       │                          │                  │                │ Record split
    │                                 │                       │                          │                  │                │

LATER:
Publisher ── withdrawPublisher() ───────────────────────────────────────────────────────────────────────────────→│ Pull DOT
User ── withdrawUser() ────────────────────────────────────────────────────────────────────────────────────────→│ Pull DOT
Owner ── withdrawProtocol(recipient) ──────────────────────────────────────────────────────────────────────────→│ Pull DOT
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
Campaign Budget (escrowed in BudgetLedger)
    │
    │ deductAndTransfer(totalPayment, paymentVault)
    │ DOT sent to PaymentVault
    ↓
PaymentVault receives DOT, Settlement records split:
    │
    ├── takeRate% → publisherBalance[publisher]   ← Publisher take rate
    │
    └── remainder
         │
         ├── 75% → userBalance[user]              ← 37.5% of total at 50% take
         │
         └── 25% → protocolBalance                ← 12.5% of total at 50% take
```

**Pull payments:** Each party calls `withdrawPublisher()`, `withdrawUser()`, or `withdrawProtocol(recipient)` on PaymentVault to receive their accumulated balance.

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
| E25 | Campaigns | Not settlement/lifecycle contract |
| E26 | BudgetLedger | Daily cap exceeded |
| E27 | Campaigns | Bid below minimum CPM floor |
| E28 | Settlement | Batch too large (> 5 claims) |
| E29 | Relay | Deadline expired (block > deadline) |
| E30 | Relay | Invalid signature length (not 65 bytes) |
| E31 | Relay | User signature verification failed |
| E32 | Settlement, AttestationVerifier | Caller not user or relay or attestationVerifier |
| E33 | Relay | Publisher signature length invalid |
| E34 | Relay | Publisher signature verification failed |
| E35 | Timelock | No pending proposal to cancel |
| E36 | Timelock | No pending proposal to execute |
| E37 | Timelock | Timelock delay not elapsed |
| E40 | GovernanceV2 | Conviction > 8 |
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
| E52 | GovernanceV2 | Nay below termination quorum |
| E53 | GovernanceV2 | Grace period not elapsed |
| E54 | GovernanceSlash | Slash not finalized |
| E55 | GovernanceSlash | Already claimed |
| E56 | GovernanceSlash | Not on winning side |
| E57 | Campaigns | Reentrancy |
| E58 | GovernanceV2, PaymentVault | Refund below existential deposit (dust prevention) |
| E59 | GovernanceSlash | Slash already finalized |
| E60 | GovernanceSlash | Campaign not resolved for slash |
| E61 | GovernanceSlash | Zero slash balance |
| E62 | Campaigns, Publishers | Address blocked (S12 blocklist) |
| E63 | Campaigns | Advertiser not on publisher's allowlist (S12) |
| E64 | CampaignLifecycle | Inactivity timeout not reached (P20) |
| P | Campaigns, Settlement, Relay, Publishers, CampaignLifecycle | System paused |

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
| 11 | Publisher blocked (S12) |

---

## 7. Trust Model and Security Analysis

### Access Control Matrix

| Function | Who Can Call | Protected By |
|----------|-------------|--------------|
| PauseRegistry.pause/unpause | owner | Direct ownership (no timelock — emergency) |
| Timelock.propose/cancel | owner | Timelock ownership |
| Timelock.execute | anyone | 48h delay |
| Publishers.register/update/setCategories | msg.sender (self) | Self-registration |
| Publishers.blockAddress/unblockAddress | owner | Direct ownership (no timelock — pre-mainnet) |
| Campaigns.createCampaign | anyone | Payable escrow, S12 blocklist/allowlist |
| Campaigns.activateCampaign | governanceContract | Set via owner (timelocked) |
| Campaigns.setCampaignStatus/setTerminationBlock | lifecycleContract | Set via owner (timelocked) |
| Campaigns.setSettlement/setGovernance/setLifecycle/setBudgetLedger | owner (Timelock) | 48h delay |
| BudgetLedger.initializeBudget | campaigns only | Set via owner |
| BudgetLedger.deductAndTransfer | settlement only | Set via owner |
| BudgetLedger.drainToAdvertiser/drainFraction | lifecycle only | Set via owner |
| BudgetLedger.sweepDust | anyone | Terminal campaigns only |
| CampaignLifecycle.completeCampaign | advertiser or settlement | Identity check |
| CampaignLifecycle.terminateCampaign | governanceContract only | Set via owner |
| CampaignLifecycle.expirePendingCampaign | anyone | Block check |
| CampaignLifecycle.expireInactiveCampaign | anyone | Timeout check (P20) |
| Settlement.settleClaims | batch.user or relayContract or attestationVerifier | User identity check (E32) |
| Settlement.configure(5-arg) | owner (Timelock) | 48h delay |
| Settlement.setAttestationVerifier | owner (Timelock) | 48h delay |
| AttestationVerifier.settleClaimsAttested | batch.user | EIP-712 publisher sig verification |
| PaymentVault.creditSettlement | settlement only | Set via owner |
| PaymentVault.withdrawPublisher/withdrawUser | msg.sender (self) | Balance check |
| PaymentVault.withdrawProtocol | owner | Direct ownership |
| Relay.settleClaimsFor | anyone | EIP-712 sig verification |
| GovernanceV2.vote | anyone | Payable stake |
| GovernanceV2.evaluateCampaign | anyone | Majority + quorum thresholds |
| GovernanceV2.setSlashContract | owner, one-shot | Irreversible |
| GovernanceSlash.finalizeSlash | anyone | Must be resolved |
| GovernanceSlash.claimSlashReward | winner, finalized | Lockup + winning side check |

### Trust Assumptions

| Component | Trust Assumption | Severity | Alpha Mitigation |
|-----------|-----------------|----------|------------------|
| Impression count | Extension self-reports impressions | High | Publisher co-signature attestation (mandatory via P1) |
| Clearing CPM | Extension determines clearing price | Medium | Must be <= bidCpmPlanck; ZK proof stub (future: Groth16) |
| Quality score | Extension computes engagement quality | Medium | Computed in background (trusted context), not content script |
| Publisher identity | SDK declares publisher address | Low | On-chain registration check, handshake verification |
| Publisher attestation | P1 enforces publisher co-sig for all campaigns | Low | DatumAttestationVerifier verifies EIP-712 sig; open campaigns verify against claims[0].publisher |
| Relay honesty | Relay could delay or drop batches | Low | Claims persist in extension; users can submit directly |
| Admin power | Owner can propose parameter changes | Medium | 48h Timelock on Campaigns + Settlement |
| Pause power | Owner can pause instantly | Medium | Intentional for emergency; cannot pause governance |

### Reentrancy Protection

| Contract | Method |
|----------|--------|
| DatumPublishers | OZ ReentrancyGuard modifier |
| DatumCampaigns | Manual `_locked` bool (no OZ imports — saves PVM) |
| DatumBudgetLedger | OZ ReentrancyGuard modifier |
| DatumCampaignLifecycle | OZ ReentrancyGuard modifier |
| DatumPaymentVault | OZ ReentrancyGuard modifier |
| DatumSettlement | OZ ReentrancyGuard modifier |
| DatumGovernanceV2 | No explicit guard (no external calls before state updates — CEI pattern) |
| DatumGovernanceSlash | OZ ReentrancyGuard modifier |
| DatumAttestationVerifier | No state mutation (pure forwarding) |
| DatumTimelock | CEI pattern (clear state before external call) |
| DatumRelay | No state mutation (pure forwarding) |

### DOT Flow Diagram (where money lives)

```
User DOT (wallet)
    ├── createCampaign{value} → BudgetLedger escrow (remaining budget)
    │                               ├── deductAndTransfer → PaymentVault (publisherBal + userBal + protocolBal)
    │                               │                           ├── withdrawPublisher → Publisher wallet
    │                               │                           ├── withdrawUser → User wallet
    │                               │                           └── withdrawProtocol → Protocol wallet
    │                               ├── terminateCampaign → 10% to GovernanceV2 (drainFraction)
    │                               │                        └── slashAction → Winners
    │                               │                      → 90% to Advertiser wallet (drainToAdvertiser)
    │                               └── completeCampaign/expirePending/expireInactive → Advertiser wallet (drainToAdvertiser)
    │
    └── vote{value} → GovernanceV2 (lockAmount per vote)
                         ├── withdraw → Voter wallet (minus slash if loser)
                         └── slash → GovernanceV2 balance → slashAction → Winners
```

---

## 8. PVM Size Budget

All contracts must fit under the 49,152-byte PVM limit (resolc v1.0.0, optimizer mode `z`).

| Contract | PVM Size | Spare | Utilization | Risk |
|----------|----------|-------|-------------|------|
| DatumZKVerifier | 1,409 | 47,743 | 2.9% | None |
| DatumPauseRegistry | 4,047 | 45,105 | 8.2% | None |
| DatumPaymentVault | 17,341 | 31,811 | 35.3% | None |
| DatumTimelock | 18,342 | 30,810 | 37.3% | None |
| DatumBudgetLedger | 29,809 | 19,343 | 60.6% | Low |
| DatumAttestationVerifier | 35,920 | 13,232 | 73.1% | Low |
| DatumPublishers | 35,741 | 13,411 | 72.7% | Low |
| DatumGovernanceSlash | 37,160 | 11,992 | 75.6% | Low |
| DatumCampaignLifecycle | 40,910 | 8,242 | 83.2% | Moderate |
| DatumCampaigns | 42,466 | 6,686 | 86.4% | Moderate |
| DatumRelay | 46,178 | 2,974 | 93.9% | High |
| DatumGovernanceV2 | 47,939 | 1,213 | 97.5% | **Critical** |
| DatumSettlement | 48,052 | 1,100 | 97.8% | **Critical** |
| **Total** | **405,314** | — | — | — |

**Critically constrained:** DatumGovernanceV2 (1,213 B spare) and DatumSettlement (1,100 B spare) cannot accept new features without removing existing code. DatumRelay (2,974 B spare) is also high-risk. Any new functionality for these contracts requires either:
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
| ZK verification removed from Settlement | ZKVerifier contract deployed but unused | No auction proof verification | Post-alpha: Groth16 via Relay or separate verifier. BN128 pairing precompile required. |
| Blake2-256 active on-chain only | Settlement uses ISystem.hashBlake256() on PolkaVM | Extension + relay still use keccak256 | Must migrate extension + relay to Blake2-256 before testnet deploy |
| No on-chain publisher domain | Relay URL discovered via SDK data-relay attribute | URL changes require page update, not chain tx | Post-alpha: on-chain publisher registry |
| Manual reentrancy in Campaigns | `_locked` bool instead of OZ modifier | Equivalent protection, less battle-tested | PVM size constraint |
| No claim expiry | Stale claims can be submitted indefinitely | Low risk — nonce chain prevents replay | Could add block-based expiry post-alpha |
| E51 dual meaning | "slash contract already set" AND "zero votes on termination eval" | Slightly confusing error | Accepted — PVM size constraint |
| E52/E53 vs E59/E60 | GovernanceV2 uses E52/E53 (termination quorum/grace); GovernanceSlash uses E59/E60 (already finalized/not resolved) | Separate codes in alpha-2 | Resolved — no longer shared |

### Architectural Constraints

| Constraint | Cause | Impact |
|-----------|-------|--------|
| 49,152 B PVM limit | pallet-revive max contract size | Cannot add features to GovernanceV2/Settlement without removing code |
| resolc v1.0.0 codegen | Compiler maturity | Single transfer site required, try/catch unreliable, 10-20x larger than EVM |
| No EVM CREATE2 | pallet-revive doesn't support some EVM opcodes | Cannot use factory patterns |
| System precompile at 0x900 | Polkadot Hub specific | Must guard with code.length check for Hardhat compatibility |
| Denomination rounding | eth-rpc adapter bug | All transfers must be clean multiples of 10^6 planck |

---

## 10. Test Coverage

### Hardhat EVM Tests: 185/185

| Suite | Tests | Coverage |
|-------|-------|----------|
| integration.test.ts | 18 | Full lifecycle, settlement paths, relay, attestation (P1), blocklist claim rejection |
| settlement.test.ts | 37 | Hash chain, revenue split, all rejection reasons, batch processing, stop-on-first-gap |
| governance.test.ts | 44 | Conviction 0-8, quorum, slash, termination protection, grace period, lockup |
| pause.test.ts | 11 | Global pause on all contracts |
| timelock.test.ts | 19 | Propose/execute/cancel, delay enforcement |
| lifecycle.test.ts | 15 | Complete, terminate, expire, P20 inactivity timeout |
| campaigns.test.ts | 11 | Campaign creation, status, S12 checks |
| publishers.test.ts | 10 | Registration, take rate, categories |
| blocklist.test.ts | 11 | S12 blocklist/allowlist across all layers |
| relay.test.ts | 9 | EIP-712 relay settlement |

### Extension Jest Tests: 140/140

9 test suites covering: claim building, claim queue, quality scoring, content safety, phishing list, engagement tracking, behavior chain, wallet manager, campaign poller.
