# Multi-Pricing Model Analysis: CPC, CPA, and Action-Based Settlement

**Date:** 2026-04-22
**Question:** What does it take to support cost-per-click (CPC), cost-per-action (CPA), and separate budget pots for different event types?

---

## 1. What the Current Architecture Hardcodes

Before extending, it helps to see what assumptions are baked in everywhere:

| Layer | Current Assumption |
|-------|-------------------|
| `Claim` struct | `impressionCount` + `clearingCpmPlanck` — always impression units |
| Payment formula | `(clearingCpmPlanck * impressionCount) / 1000` — CPM-only |
| Hash preimage | `(campaignId, publisher, user, impressionCount, cpm, nonce, prevHash)` — event type is implicit |
| ZK circuit | Public input is `claimHash` which encodes impressions — no click/action concept |
| `DatumCampaigns` | Stores a single `bidCpmPlanck` per campaign |
| `DatumClaimValidator` | Validates that `clearingCpmPlanck <= bidCpmPlanck` — CPM-specific logic |
| `claimBuilder.ts` | Fires on `ENGAGEMENT_RECORDED` (viewability signal) — impression lifecycle only |
| `auction.ts` | Clears an auction into a CPM price — no other event type |

Extending to CPC/CPA means most of these layers need awareness of event type.

---

## 2. The Core Verification Problem

Adding new event types is not just a schema change — each event type has a different **trust model**:

### CPM (Impressions) — Current, Well-Solved
- Event: ad is viewable in the user's browser
- Proof: ZK Groth16 + engagement quality score (dwell, viewability, scroll)
- Fraud risk: impression stuffing (mitigated by ZK nullifier per window)
- Trust: extension-signed engagement event, relayed via bot

### CPC (Clicks) — Moderately Hard
- Event: user clicks the ad
- Proof: extension intercepts click in content script, signs with user key
- Fraud risk: **publisher-side click injection** (publisher's page JS synthetically triggers click events), **user click farms** (users clicking their own ads for rewards)
- Mitigation path: require a prior impression claim in the chain before a click claim is valid; enforce minimum dwell before click is accepted; publisher stake slashing for anomalous click-through rates
- Trust: lower than impressions — click is captured in untrusted page context

### CPA (Conversions / Actions) — Hard
- Event: user completes a goal on the advertiser's site (signup, purchase, download)
- Proof: no cryptographic proof available without cooperation from the advertiser's backend
- Fraud risk: advertiser under-reporting conversions (denying payment), user manufacturing fake conversions
- Mitigation path: advertiser deploys a `DatumConversionTrigger` contract on-chain; user's wallet calls it when the action completes; on-chain call is the settlement trigger
- Trust: requires advertiser to implement on-chain conversion hooks

### CPE (Cost Per Engagement) — Easiest Extension
- Event: quality score exceeds a threshold (e.g., watched >30s, scrolled 80%+ of landing page)
- Proof: existing `qualityScore.ts` already computes this; just needs to be a claim trigger
- Fraud risk: same as impressions — mitigated by existing ZK + nullifier
- This is the most natural first extension of the current model

---

## 3. The "Separate Pots" Architecture

The user's instinct — different budgets with different rates for different actions — is the right framing. This maps cleanly to the existing campaign structure.

**Design: One Campaign, Multiple Budget Pots**

Each "pot" is defined at campaign creation:

```
struct PricingPot {
    uint8   eventType;       // 0=impression, 1=click, 2=action, 3=engagement
    uint256 budgetPlanck;    // budget allocated to this pot
    uint256 dailyCapPlanck;  // daily spend cap for this pot
    uint256 ratePlanck;      // rate per event (per-1000 for impression, flat for CPC/CPA)
}
```

Alternatively, pots can be **separate campaigns** pointing to the same creative/metadata — simpler from a contract complexity standpoint since it reuses all existing infrastructure (governance, lifecycle, budget ledger). A `parentCampaignId` field links them.

**Recommendation: Separate campaigns with a `parentCampaignId` link.** This avoids multi-pot accounting complexity in the budget ledger and claim validator, and lets each pot have its own governance activation, daily cap, and independent lifecycle.

---

## 4. What Each Layer Needs to Change

### 4a. `Claim` Struct and Hash Preimage

Add `eventType` to the claim and include it in the hash:

```
struct Claim {
    uint256 campaignId;
    address publisher;
    uint256 impressionCount;   // repurposed as "eventCount" for non-CPM types
    uint256 clearingCpmPlanck; // repurposed as "ratePerEvent" for non-CPM types
    uint8   eventType;         // NEW: 0=impression, 1=click, 2=engagement, 3=action
    uint256 nonce;
    bytes32 previousClaimHash;
    bytes32 claimHash;
    bytes   zkProof;
    bytes32 nullifier;
}
```

Hash preimage becomes:
`(campaignId, publisher, user, eventCount, ratePlanck, eventType, nonce, prevHash)`

**This is a breaking change to the hash chain.** Existing clients would need to re-sync. Manageable during alpha — problematic post-mainnet.

### 4b. `DatumCampaigns.sol`

Add `pricingModel` to the Campaign struct:

```solidity
uint8 pricingModel; // 0=CPM, 1=CPC, 2=CPE, 3=CPA
uint256 bidRatePlanck; // existing bidCpmPlanck renamed, semantic depends on pricingModel
```

Or take the **separate campaign approach**: add `parentCampaignId` (0 = standalone) to allow grouping without changing core accounting.

### 4c. `DatumClaimValidator.sol`

Currently validates `clearingCpmPlanck <= bidCpmPlanck`. With multiple event types:
- CPM: same check (clearing <= bid)
- CPC: check `ratePerClick <= campaignClickRate`; additionally verify that a corresponding impression claim exists in this session (requires impression-click correlation storage)
- CPE: check quality score threshold committed in claim; verify score >= campaignMinQuality
- CPA: check that the action trigger contract was called (verify a cross-contract receipt)

CPC requires the most new logic in the validator: it needs to look up whether this (user, campaignId, session) had a qualifying impression recently. This is essentially the same as the nullifier registry but for impression-click correlation.

### 4d. `DatumSettlement.sol`

The payment formula needs to branch on event type:

```solidity
uint256 totalPayment;
if (claim.eventType == 0) {
    // CPM: existing formula
    totalPayment = (claim.clearingCpmPlanck * claim.impressionCount) / 1000;
} else {
    // CPC / CPE / CPA: flat rate × event count
    totalPayment = claim.ratePlanck * claim.eventCount;
}
```

The rate limiter (`DatumSettlementRateLimiter`) would need to be aware of event type to avoid conflating impression caps with click caps.

### 4e. Extension: `claimBuilder.ts`

Currently triggers on `ENGAGEMENT_RECORDED` (viewability). Needs new triggers:

- **Click claims**: triggered on `AD_CLICK` from content script; content script intercepts click on the injected ad element; extension signs and queues a click claim
- **Engagement claims**: triggered when `qualityScore >= campaignMinQuality` from the existing engagement event
- **Action claims**: triggered by advertiser's on-chain `ConversionTrigger` contract event picked up by `campaignPoller`; no content script involvement

Click claims need their own chain state keyed on `(user, campaignId, eventType)` to avoid conflating CPM nonces with CPC nonces.

### 4f. Extension: `content/adSlot.ts`

Currently only tracks viewability. For CPC:
- Add click event listener to the ad element
- Ensure it's a genuine user-initiated click (not programmatic) — check `event.isTrusted === true`
- Send `AD_CLICK` message to background with `campaignId`, `publisherAddress`, `timestamp`

`event.isTrusted` is browser-enforced and cannot be spoofed by page scripts, making this the primary click authenticity check.

### 4g. `auction.ts`

The auction currently only operates on CPM bids. For a campaign with mixed pots, the auction would:
1. Run normally to select the winner and clear a CPM price for the impression pot
2. If the winning campaign also has a CPC pot, record the campaign selection so a subsequent click can reference the same campaign

No structural change needed in the auction itself if pots are separate campaigns — the impression campaign wins or loses independently of the click campaign.

---

## 5. Click Fraud Mitigation

CPC without fraud protection would be instantly gamed. Required mitigations:

| Mechanism | Where | Notes |
|-----------|-------|-------|
| `isTrusted` click gate | `adSlot.ts` | Blocks programmatic clicks from page scripts |
| Impression-before-click requirement | `DatumClaimValidator` | Click rejected unless impression claim exists in current session window |
| Min dwell before click | `DatumClaimValidator` | Click within first 500ms of impression is suspect — add `impressionAge` to click claim |
| Publisher click rate anomaly | `DatumPublisherReputation` | Flag publishers whose CTR exceeds 3× network average; reputation-gate settlement |
| Publisher stake slashing | `DatumPublisherGovernance` | High-CTR publishers subject to fraud governance vote; slash on upheld fraud |
| Max clicks per campaign per user | `DatumSettlement` | Similar to `MAX_USER_IMPRESSIONS` — e.g., max 1 click per campaign per user |

The impression-before-click requirement is the most important. It means:
- The click claim's hash chain must include the `impressionNonce` from the session
- Or: a `DatumClickRegistry` contract stores impression-click session mapping (similar to NullifierRegistry)

---

## 6. Phased Implementation Plan

### Phase 1 — CPE (Cost Per Engagement) — Low Effort, Zero New Trust Assumptions

CPE is the natural first step because it uses the existing ZK impression proof infrastructure, just with a higher quality threshold and a higher payment rate.

Changes:
- Add `pricingModel=CPE` + `minQualityScore` + `engagementRatePlanck` to campaigns
- `claimBuilder.ts`: when engagement event exceeds `minQualityScore`, queue CPE claim instead of CPM claim
- Settlement: `totalPayment = engagementRatePlanck * eventCount` (flat, not per-1000)
- No new trust assumptions; same ZK proof covers the engagement event

This proves the multi-pricing infrastructure before tackling click fraud.

### Phase 2 — CPC (Cost Per Click) — Moderate Effort, New Trust Surface

Changes:
- `adSlot.ts`: click listener with `isTrusted` gate
- New claim type in `claimBuilder.ts` for click events
- `DatumClickRegistry` contract: records impression→click sessions, enforces 1 click per impression window
- `DatumClaimValidator`: click-specific validation branch
- `DatumSettlement`: flat-rate payment branch
- `DatumPublisherReputation`: CTR anomaly detection

### Phase 3 — CPA (Cost Per Action) — High Effort, Requires Advertiser Integration

Changes:
- `DatumConversionTrigger.sol`: advertiser-deployed, user calls `recordConversion(campaignId)` on advertiser's site
- `campaignPoller.ts`: watches for `ConversionRecorded` events on-chain, queues action claims
- No extension content-script involvement — triggered by on-chain event
- Settlement reads `ConversionTrigger` address from campaign config to validate

CPA is viable but requires advertisers to adopt the on-chain conversion contract. This is a significant integration lift compared to the current SDK drop-in.

---

## 7. Viability Verdict

| Model | Viable? | Effort | Trust Level | Timeline |
|-------|---------|--------|-------------|----------|
| CPE (Cost Per Engagement) | Yes | Low | Same as CPM | Alpha-4 |
| CPC (Cost Per Click) | Yes, with fraud mitigations | Moderate | Lower than CPM (click in untrusted context) | Alpha-4/5 |
| CPA (Cost Per Action) | Yes, with on-chain conversion contract | High | Depends on advertiser integration | Beta |
| Separate pots architecture | Yes | Low-Moderate | Same as constituent types | Alpha-4 |

**The separate pots approach (linked campaigns) is the right architecture** — it keeps contracts simple, reuses governance and lifecycle infrastructure, and gives advertisers clear per-objective budget control and reporting. The additional 1-3 campaigns per advertiser objective is negligible on-chain overhead.

CPC is viable but requires treating click fraud as a first-class concern from day one. Shipping CPC without the impression-before-click registry and reputation-gated settlement would immediately attract click farm abuse.
