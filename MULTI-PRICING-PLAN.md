# Multi-Pricing Model Implementation Plan
# CPE → CPC → CPA + Budget Pots

**Date:** 2026-04-22
**Phases:** 3 (CPE → CPC → CPA)
**Breaking change:** Claim hash preimage extends in Phase 1 — relay bot + extension must release together.

---

## Overview

Three new pricing models on top of the existing CPM infrastructure:

| Model | Trigger | Proof mechanism | New contract | Phase |
|-------|---------|----------------|--------------|-------|
| CPE | Engagement quality ≥ threshold | Existing ZK + quality score | None | 1 |
| CPC | Verified click (`isTrusted`) | Extension-signed click + impression correlation | `DatumClickRegistry` | 2 |
| CPA | On-chain conversion trigger | Advertiser contract call | `DatumConversionRegistry` + `DatumConversionTrigger` | 3 |

**Pots architecture:** Separate linked campaigns per pricing model via `parentCampaignId`. Each pot has its own budget, rate, daily cap, and lifecycle. Reuses all existing governance, budget ledger, and lifecycle infrastructure with zero new accounting complexity.

---

## What the Current Architecture Hardcodes (and must change)

| Layer | Current assumption | Needs to change |
|-------|--------------------|----------------|
| `Claim` struct | `impressionCount` + `clearingCpmPlanck` only | Add `pricingModel`, `qualityScore`, `clickSessionHash`, `conversionHash` |
| Hash preimage | 7 fields, implicit CPM | 11 fields, includes pricing metadata — **BREAKING** |
| Payment formula | `(clearingCpmPlanck * impressionCount) / 1000` | Branch on `pricingModel` |
| `DatumCampaigns` | Single `bidCpmPlanck` | Add `pricingModel`, `minQualityScoreBps`, `parentCampaignId` |
| `DatumClaimValidator` | Validates `clearingCpm ≤ bidCpm` | Route validation by pricing model |
| `claimBuilder.ts` | Fires on `ENGAGEMENT_RECORDED` | New triggers per event type |

---

## Phase 1 — CPE (Cost Per Engagement)

**Scope:** Flat rate per engagement event. Uses existing quality score infrastructure (`qualityScore.ts`). No new contracts. Campaign sets a minimum quality score threshold; payment scales with quality.

---

### P1-C1: `DatumCampaigns.sol`

Add to Campaign struct:
```solidity
uint8  pricingModel;          // 0=CPM, 1=CPE, 2=CPC, 3=CPA
uint16 minQualityScoreBps;    // CPE only: 0-10000 (0.0-1.0); 0 for CPM
uint256 parentCampaignId;     // 0 = standalone; non-zero = child pot
```

Add to `createCampaign()` parameters:
```solidity
uint8   pricingModel,
uint16  minQualityScoreBps,
uint256 parentCampaignId
```

Add validations:
- `pricingModel == CPE → require(minQualityScoreBps > 0 && ≤ 10000, "E88")`
- `parentCampaignId > 0 → verify parent exists, same advertiser, same publisher`
- Enforce single-level hierarchy (parent's parentCampaignId must be 0)

Add view functions: `getPricingModel()`, `getMinQualityScore()`, `getParentCampaignId()`, `getChildCampaigns()`

Add event: `CampaignPricingModelSet(campaignId, pricingModel, minQualityScoreBps, parentId)`

---

### P1-C2: `interfaces/IDatumSettlement.sol` — **BREAKING CHANGE**

Extend `Claim` struct with fields that will carry through all three phases:
```solidity
struct Claim {
    uint256 campaignId;
    address publisher;
    uint256 impressionCount;      // repurposed as "eventCount" for non-CPM
    uint256 clearingCpmPlanck;    // repurposed as "ratePlanck" for non-CPM
    uint8   pricingModel;         // NEW Phase 1
    uint16  qualityScore;         // NEW Phase 1: 0-10000 bps
    bytes32 clickSessionHash;     // NEW Phase 2: bytes32(0) for non-click claims
    bytes32 conversionHash;       // NEW Phase 3: bytes32(0) for non-conversion claims
    uint256 nonce;
    bytes32 previousClaimHash;
    bytes32 claimHash;
    bytes   zkProof;
    bytes32 nullifier;
}
```

Adding all four fields now avoids a second breaking change in Phase 2/3. Non-relevant fields are `bytes32(0)` / `0`.

**New hash preimage (all phases from day 1):**
```
blake2(campaignId, publisher, user, impressionCount, ratePlanck,
       pricingModel, qualityScore, clickSessionHash, conversionHash,
       nonce, previousHash)
```

---

### P1-C3: `DatumClaimValidator.sol`

Add routing in `validateClaim()`:
```solidity
if (campaign.pricingModel == 0) {
    // CPM: existing check
    require(claim.clearingCpmPlanck <= cBidCpm, "E06");
} else if (campaign.pricingModel == 1) {
    // CPE: rate check + quality check
    require(claim.clearingCpmPlanck <= cBidCpm, "E06");
    require(claim.qualityScore >= campaign.minQualityScoreBps, "E88");
}
// CPC / CPA: validated in Phase 2/3
```

Fetch `pricingModel` + `minQualityScoreBps` from campaigns contract alongside existing `bidCpmPlanck`.

---

### P1-C4: `DatumSettlement.sol`

Replace the single payment line with a dispatch function:
```solidity
function _computePayment(Claim calldata claim, uint8 pricingModel, uint16 qualityScore)
    internal pure returns (uint256)
{
    if (pricingModel == 0) {
        // CPM
        return (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
    } else if (pricingModel == 1) {
        // CPE: quality-weighted, still per-impression
        return (claim.clearingCpmPlanck * claim.qualityScore * claim.impressionCount) / 10_000_000;
        // Division: /1000 (CPM) × /10000 (bps quality) = /10_000_000
    } else if (pricingModel == 2) {
        // CPC: flat per click
        return claim.clearingCpmPlanck * claim.impressionCount; // impressionCount = clickCount here
    } else if (pricingModel == 3) {
        // CPA: flat per conversion
        return claim.clearingCpmPlanck * claim.impressionCount; // impressionCount = conversionCount
    }
    revert("E92");
}
```

---

### P1-E1: `shared/types.ts`

Add to `Claim`:
```typescript
pricingModel: number;        // 0-3
qualityScore: bigint;        // 0-10000 bps
clickSessionHash: string;    // bytes32 hex, "0x00..00" for non-click
conversionHash: string;      // bytes32 hex, "0x00..00" for non-conversion
```

Add to campaign interface:
```typescript
pricingModel: number;
minQualityScore: number;     // 0-10000 bps
parentCampaignId: string;    // "0" if standalone
```

---

### P1-E2: `claimBuilder.ts` — **BREAKING CHANGE**

Update hash computation to 11-field preimage (see P1-C2).

For CPM campaigns: pass `pricingModel=0`, `qualityScore=0`, `clickSessionHash=ZeroHash`, `conversionHash=ZeroHash`.

For CPE campaigns: compute `qualityScore` from the `EngagementEvent` using `computeQualityScore()` × 10000 (convert 0.0-1.0 → 0-10000 bps). If `qualityScore < campaign.minQualityScore`, drop the claim (do not queue).

---

### P1-E3: `campaignPoller.ts`

Fetch `pricingModel`, `minQualityScoreBps`, `parentCampaignId` via multicall alongside existing fields. Store in `activeCampaigns` cache. Extension reads these when building claims.

---

### P1-W1: `CreateCampaign.tsx`

Add pricing model selector. For CPE: show "Min Quality Score (%)" input (0-100; converted to bps internally) and "Engagement Rate (planck per 1000 impressions × quality)". Hide the "Bid CPM" label, show "Rate" instead.

Add optional "Link to Parent Campaign" dropdown (lists advertiser's active standalone campaigns).

---

### P1-T: Tests

**Contract:**
- `campaigns.test.ts`: create CPE campaign; create child pot; reject grandchild pot; reject CPE with zero quality threshold
- `settlement.test.ts`: CPE payment formula; CPE claim below threshold rejected (E88); CPM still works unchanged
- `claim-validator.test.ts` (new): routing test for pricingModel 0 vs 1

**Extension:**
- `claimBuilder.test.ts`: update Blake2 hash test for 11-field preimage; test qualityScore bps conversion; CPE claim drops if below threshold

---

## Phase 2 — CPC (Cost Per Click)

**Scope:** Flat rate per verified click. Click captured in content script via `event.isTrusted`. New `DatumClickRegistry` contract enforces impression-before-click correlation and prevents double-claiming.

---

### P2-C1: `DatumClickRegistry.sol` (new)

```solidity
contract DatumClickRegistry {
    struct ClickSession {
        uint256 campaignId;
        address user;
        uint256 blockNumber;
        bool    claimed;
    }
    // sessionHash = blake2(user, campaignId, nonce) — submitted by relay
    mapping(bytes32 => ClickSession) public sessions;
    mapping(address => mapping(uint256 => uint256)) public clickCount;
    uint256 public constant MAX_CLICKS_PER_USER_PER_CAMPAIGN = 1;

    address public settlement;
    address public relay;

    function recordClick(bytes32 sessionHash, uint256 campaignId, address user) external; // relay-only
    function markClaimed(bytes32 sessionHash) external; // settlement-only
    function hasUnclaimed(bytes32 sessionHash) external view returns (bool);
}
```

Key invariant: one click per (user, campaignId) lifetime. `MAX_CLICKS_PER_USER_PER_CAMPAIGN = 1` prevents click farming.

---

### P2-C2: `DatumClaimValidator.sol`

Add CPC branch:
```solidity
} else if (pricingModel == 2) {
    require(claim.clickSessionHash != bytes32(0), "E90");
    require(clickRegistry.hasUnclaimed(claim.clickSessionHash), "E90");
}
```

After validation passes, settlement calls `clickRegistry.markClaimed()`.

---

### P2-C3: `DatumSettlement.sol`

After successful CPC settlement, call `clickRegistry.markClaimed(claim.clickSessionHash)` to prevent reuse. Wire `clickRegistry` address via `setClickRegistry()` (owner-only, same pattern as other satellite addresses).

---

### P2-E1: `content/adSlot.ts`

Add to ad element setup:
```typescript
adElement.addEventListener("click", async (e: MouseEvent) => {
  if (!e.isTrusted) return;  // browser-enforced; blocks programmatic clicks
  const now = Date.now();
  const sessionHash = computeClickSessionHash(campaignId, userAddress, nonce);
  chrome.runtime.sendMessage({
    type: "AD_CLICK",
    campaignId,
    publisherAddress,
    sessionHash,
    timestamp: now,
  });
}, { once: true }); // once: true — one click per impression rendering
```

`{ once: true }` ensures only one click event fires per ad rendering, regardless of how many times the user clicks.

---

### P2-E2: `background/index.ts`

Add `AD_CLICK` message handler:
```typescript
case "AD_CLICK":
  await clickHandler.onAdClick(msg);
  break;
```

---

### P2-E3: `background/clickHandler.ts` (new)

- Receive `AD_CLICK` message
- Verify a matching impression exists in `activeCampaigns` within the last 5 minutes (prevents orphan clicks)
- Store click session in `chrome.storage.local`: key `click:${campaignId}:${sessionHash}`
- Submit click to relay (or queue for batch relay submission)
- Queue CPC claim for settlement with `clickSessionHash` populated

Minimum dwell check: reject clicks where `Date.now() - impressionStartTime < 500ms` (sub-500ms click is likely bot).

---

### P2-E4: `shared/types.ts`

Already updated in Phase 1 (added `clickSessionHash` to Claim struct). No additional changes.

---

### P2-W1: `CreateCampaign.tsx`

Add CPC to pricing model selector. Show "Click Rate (planck per click)" input. Add publisher CTR advisory: fetch DatumPublisherReputation score; warn if historical CTR > 10%.

---

### P2-R1: `relay-bot.mjs`

- Receive click sessions from extension
- Call `DatumClickRegistry.recordClick()` for each valid click
- Submit CPC claims with populated `clickSessionHash` to settlement

---

### P2-T: Tests

**Contract:**
- `click-registry.test.ts` (new): record click; mark claimed; reject second claim; reject unknown session hash; enforce MAX_CLICKS_PER_USER_PER_CAMPAIGN
- `settlement.test.ts`: CPC claim with valid click settles; CPC claim without click rejects (E90); double-claim rejected
- `claim-validator.test.ts`: CPC routing; missing clickSessionHash rejected

**Extension:**
- `clickHandler.test.ts` (new): isTrusted gate; orphan click rejection (no prior impression); sub-500ms dwell rejection; session hash computation
- `claimBuilder.test.ts`: CPC claim with clickSessionHash; `once: true` click listener fires only once

---

## Phase 3 — CPA (Cost Per Action)

**Scope:** Flat rate per on-chain conversion. Advertiser deploys `DatumConversionTrigger` on their site/contract; user wallet calls it after completing the goal; extension polls for the on-chain event.

---

### P3-C1: `DatumConversionRegistry.sol` (new)

Central registry; conversion trigger contracts write into it.

```solidity
contract DatumConversionRegistry {
    struct Conversion {
        uint256 campaignId;
        address user;
        uint256 blockNumber;
        bool    claimed;
    }
    mapping(bytes32 => Conversion) public conversions;
    // conversionHash = blake2(campaignId, user, actionId, blockNumber)

    mapping(uint256 => address) public campaignTrigger; // campaignId → trigger address

    function registerTrigger(uint256 campaignId, address trigger) external; // campaign advertiser only
    function recordConversion(bytes32 conversionHash, uint256 campaignId, address user) external; // trigger-only
    function markClaimed(bytes32 conversionHash) external; // settlement-only
    function hasUnclaimed(bytes32 conversionHash) external view returns (bool);
    event ConversionRecorded(uint256 indexed campaignId, address indexed user, bytes32 conversionHash);
}
```

---

### P3-C2: `DatumConversionTrigger.sol` (template)

Advertiser deploys one per campaign. Calls `ConversionRegistry.recordConversion()` when user completes the goal.

```solidity
contract DatumConversionTrigger {
    IConversionRegistry public registry;
    uint256 public campaignId;
    address public advertiser;

    mapping(address => bool) public hasConverted; // one conversion per user

    function triggerConversion(address user) external {
        require(msg.sender == user || msg.sender == advertiser, "E18");
        require(!hasConverted[user], "E73"); // reuse of existing error code
        hasConverted[user] = true;
        bytes32 h = blake2(abi.encodePacked(campaignId, user, block.number));
        registry.recordConversion(h, campaignId, user);
    }
}
```

---

### P3-C3: `DatumClaimValidator.sol`

Add CPA branch:
```solidity
} else if (pricingModel == 3) {
    require(claim.conversionHash != bytes32(0), "E91");
    require(conversionRegistry.hasUnclaimed(claim.conversionHash), "E91");
}
```

---

### P3-C4: `DatumCampaigns.sol`

Add to `createCampaign()` for CPA: `address conversionTrigger` parameter. After campaign creation, call `conversionRegistry.registerTrigger(campaignId, conversionTrigger)`.

---

### P3-E1: `background/conversionPoller.ts` (new)

Poll `ConversionRegistry` for `ConversionRecorded(campaignId, user, conversionHash)` events where `user == connectedAddress`. Cache hits in `chrome.storage.local`: `conversion:${campaignId}:${conversionHash}`. On hit: queue CPA claim with `conversionHash` populated.

Poll interval: 60 seconds (conversions are low-frequency; no need to match block time).

---

### P3-W1: `CreateCampaign.tsx`

Add CPA to pricing model selector. Show "Action Rate (planck per conversion)" input. Add "Conversion Trigger" section: display the `DatumConversionTrigger` contract ABI + deployment instructions; verify trigger is registered on-chain (call `conversionRegistry.campaignTrigger()`) before allowing campaign activation.

---

### P3-W2: `web/src/pages/advertiser/PotManagement.tsx` (new)

Dashboard view of linked campaigns (parent + children). Shows per-pot budget, daily cap, spend, event count, rate. Allows creating new child pot from parent. Budget allocation summary across the pot family.

---

### P3-T: Tests

**Contract:**
- `conversion-registry.test.ts` (new): record conversion; register trigger; reject unknown trigger; mark claimed; reject double-claim
- `settlement.test.ts`: CPA claim with valid conversion settles; without conversion rejects (E91); double-claim rejected
- `campaigns.test.ts`: create CPA campaign with trigger address; trigger registered in registry

**Extension:**
- `conversionPoller.test.ts` (new): poll for ConversionRecorded events; dedup; cache; queue CPA claim

---

## Cross-Cutting Concerns

### Auction — No Changes Needed

`auction.ts` works for all pricing models without modification. The second-price Vickrey clears on effective CPM bid. For CPC/CPA campaigns, `bidCpmPlanck` represents the per-click or per-conversion rate; the auction treats it identically to a CPM rate. Interest weighting still applies. Advertisers set their rate higher for CPC/CPA campaigns (since per-event value is higher) which naturally produces correct auction ordering.

### Publisher Reputation Integration

`DatumPublisherReputation` should track anomalies per pricing model:
- CPC: flag publishers with CTR > 3× network average (`MIN_SAMPLE = 50 clicks`)
- CPA: flag publishers with conversion rate > 2× network average (`MIN_SAMPLE = 20 conversions`)

Update `relay-bot.mjs`: after CPC/CPA settlement, call `reputation.recordSettlement()` with click/conversion counts alongside impression counts.

### Rate Limiter Integration

`DatumSettlementRateLimiter` currently caps impression counts per publisher per window. For CPC/CPA, the same contract applies — the `impressionCount` field in the CPC/CPA `Claim` carries click/conversion counts. No contract change needed; the rate limiter just caps the event count regardless of type. Publishers can still be rate-limited on total events per window.

### ZK Circuit — No Changes for Phase 1/2

The existing impression ZK circuit (`impression.circom`) remains unchanged for CPM and CPE — qualityScore is a plain field in the hash, not a circuit witness. ZK is optional for CPC/CPA (checkbox per campaign); if required, the circuit would need to commit to clickSessionHash or conversionHash as a public input. Defer this to post-beta.

### Error Codes (New)

| Code | Meaning |
|------|---------|
| E88 | CPE: quality score below campaign minimum |
| E89 | Invalid pricing model (future-proofing) |
| E90 | CPC: click session hash invalid or already claimed |
| E91 | CPA: conversion hash invalid or already claimed |
| E92 | Unknown pricing model in settlement dispatch |

---

## Deployment Per Phase

### Phase 1 Deploy Checklist
- [ ] Redeploy `DatumCampaigns` (new fields + createCampaign signature)
- [ ] Redeploy `DatumSettlement` (payment dispatch)
- [ ] Redeploy `DatumClaimValidator` (quality score validation)
- [ ] ABI sync: web + extension for all three
- [ ] Release relay bot with new 11-field hash preimage simultaneously with extension
- [ ] Announce migration: old claims from pre-Phase-1 clients will be rejected
- [ ] `setup-testnet.ts`: add test CPE campaign creation
- [ ] `deploy.ts`: add new `REQUIRED_KEYS` for updated contracts; bump to 27-contract deploy (no new contracts in P1)

### Phase 2 Deploy Checklist
- [ ] Deploy `DatumClickRegistry`
- [ ] Redeploy `DatumSettlement` (wire clickRegistry)
- [ ] Redeploy `DatumClaimValidator` (CPC branch)
- [ ] `deploy.ts`: 28-contract deploy; wire `settlement.setClickRegistry()`
- [ ] ABI sync + relay bot update for click submission
- [ ] Extension release with click tracking

### Phase 3 Deploy Checklist
- [ ] Deploy `DatumConversionRegistry`
- [ ] Deploy `DatumConversionTrigger` template (not in REQUIRED_KEYS — advertiser deploys per campaign)
- [ ] Redeploy `DatumSettlement` + `DatumClaimValidator` (CPA branch)
- [ ] `deploy.ts`: 29-contract deploy; wire `settlement.setConversionRegistry()`
- [ ] ABI sync + relay bot update for conversion polling
- [ ] Extension release with conversionPoller

---

## Files Touched Summary

| File | Phase | Change type |
|------|-------|-------------|
| `contracts/DatumCampaigns.sol` | 1 | New fields, new params, new views |
| `contracts/DatumSettlement.sol` | 1,2,3 | Payment dispatch, new registries wired |
| `contracts/DatumClaimValidator.sol` | 1,2,3 | Validation routing by pricingModel |
| `contracts/interfaces/IDatumSettlement.sol` | 1 | Claim struct — **BREAKING** |
| `contracts/interfaces/IDatumCampaigns.sol` | 1 | Campaign struct + createCampaign signature |
| `contracts/DatumClickRegistry.sol` | 2 | **New contract** |
| `contracts/DatumConversionRegistry.sol` | 3 | **New contract** |
| `contracts/DatumConversionTrigger.sol` | 3 | **New template contract** |
| `extension/src/shared/types.ts` | 1 | Claim + Campaign interfaces |
| `extension/src/background/claimBuilder.ts` | 1 | New hash preimage — **BREAKING** |
| `extension/src/background/campaignPoller.ts` | 1 | Fetch pricing fields |
| `extension/src/content/adSlot.ts` | 2 | Click listener with isTrusted gate |
| `extension/src/background/clickHandler.ts` | 2 | **New file** |
| `extension/src/background/conversionPoller.ts` | 3 | **New file** |
| `extension/src/background/index.ts` | 2,3 | New message handlers |
| `web/src/pages/advertiser/CreateCampaign.tsx` | 1,2,3 | Pricing model selector + pot UI |
| `web/src/pages/advertiser/PotManagement.tsx` | 3 | **New page** |
| `alpha-3/scripts/deploy.ts` | 1,2,3 | New contracts per phase |
| `alpha-3/scripts/setup-testnet.ts` | 1 | Add CPE test campaign |
| `relay-bot/relay-bot.mjs` | 1,2,3 | New hash preimage; click/conversion submission |
| `alpha-3/test/campaigns.test.ts` | 1 | New pricing model tests |
| `alpha-3/test/settlement.test.ts` | 1,2,3 | New formula + model tests |
| `alpha-3/test/click-registry.test.ts` | 2 | **New test file** |
| `alpha-3/test/conversion-registry.test.ts` | 3 | **New test file** |
| `extension/test/claimBuilder.test.ts` | 1 | Update hash preimage test |
| `extension/test/clickHandler.test.ts` | 2 | **New test file** |
| `extension/test/conversionPoller.test.ts` | 3 | **New test file** |
