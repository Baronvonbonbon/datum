# Multi-Pricing Model Implementation Plan
# Single-Campaign Action Pots: View → Click → Remote Action

**Date:** 2026-04-22 (revised)
**Replaces:** previous linked-campaign pots design

---

## Design Principle

One campaign. Multiple action pots within it. Each pot has its own budget, daily cap, and rate. The same impression auction selects the campaign; after that, independent events (click, remote action) trigger separate settlement draws from separate pots — without creating separate campaigns or governance flows.

```
Campaign
├── Pot 0 (View / CPM)     budget=5 DOT  rate=1 DOT CPM   ← auction selects on this bid
├── Pot 1 (Click / CPC)    budget=3 DOT  rate=0.5 DOT/click
└── Pot 2 (Remote Action)  budget=2 DOT  rate=2 DOT/action  ← verifier-signed
```

User flow:
1. Impression → claim queued against Pot 0 (view)
2. User clicks CTA → claim queued against Pot 1 (click)
3. User installs app / connects wallet → verifier signs confirmation → claim queued against Pot 2 (action)

Each pot settles independently. A pot exhausting its budget does not affect the others.

---

## Data Model Changes

### New struct: `ActionPotConfig` (in `IDatumCampaigns`)

```solidity
struct ActionPotConfig {
    uint8   actionType;       // 0=view, 1=click, 2=remote-action
    uint256 budgetPlanck;     // funds escrowed for this pot
    uint256 dailyCapPlanck;   // daily spend cap for this pot
    uint256 ratePlanck;       // view: bidCpmPlanck (per-1000); click/action: flat per event
    address actionVerifier;   // action type 2 only: EOA whose sig confirms the action
}
```

`actionType=0` (view) is the only one that participates in the Vickrey auction. Its `ratePlanck` is the CPM bid. Campaigns without a view pot do not appear in the impression auction.

Constraints at creation:
- At most one pot per `actionType` (no duplicate action types)
- At least one pot required
- `sum(pot.budgetPlanck) + bondAmount == msg.value`
- View pot `ratePlanck >= minimumCpmFloor`
- Click/action pot `ratePlanck > 0`
- Action pot: `actionVerifier != address(0)`

### Claim struct: add `actionType`

```solidity
struct Claim {
    uint256 campaignId;
    address publisher;
    uint256 eventCount;           // renamed from impressionCount — 1 for clicks/actions
    uint256 ratePlanck;           // renamed from clearingCpmPlanck — auction rate for view; flat for click/action
    uint8   actionType;           // NEW: 0=view, 1=click, 2=remote-action
    bytes32 clickSessionHash;     // type 1 only; bytes32(0) otherwise
    bytes32 actionVerifierSig;    // type 2 only; bytes32(0) otherwise  [see note below]
    uint256 nonce;
    bytes32 previousClaimHash;
    bytes32 claimHash;
    bytes   zkProof;
    bytes32 nullifier;
}
```

> Note on `actionVerifierSig`: the full signature is 65 bytes (r, s, v). It can be passed alongside the claim as a separate `bytes` parameter rather than packed into the struct — this keeps the struct clean and avoids the 32-byte truncation issue. See P1-C2 below.

**New hash preimage (BREAKING — implement once, covers all action types):**
```
blake2(campaignId, publisher, user, eventCount, ratePlanck,
       actionType, clickSessionHash, nonce, previousHash)
```

`actionVerifierSig` is NOT in the hash (it's a proof of the hash, not part of it).

### BudgetLedger: second key on actionType

```solidity
// Before
mapping(uint256 => Budget) private _budgets;

// After
mapping(uint256 => mapping(uint8 => Budget)) private _budgets;
```

All BudgetLedger functions that touch `_budgets` gain a `uint8 actionType` parameter.

### Settlement: separate hash chains per action type

```solidity
// Before
mapping(address => mapping(uint256 => uint256)) public lastNonce;
mapping(address => mapping(uint256 => bytes32)) public lastClaimHash;

// After
mapping(address => mapping(uint256 => mapping(uint8 => uint256))) public lastNonce;
mapping(address => mapping(uint256 => mapping(uint8 => bytes32))) public lastClaimHash;
```

---

## Phase 1 — Core Infrastructure (All Action Types)

Everything in this phase must ship together. It's the foundation the click and action handling builds on.

---

### C1: `DatumCampaigns.sol`

**Remove** from Campaign struct: `bidCpmPlanck`, `snapshotTakeRateBps` (moved into pot/validation)
**Keep** in Campaign struct: `advertiser`, `publisher`, `pendingExpiryBlock`, `terminationBlock`, `status`

**Add** mappings:
```solidity
mapping(uint256 => ActionPotConfig[]) private _campaignPots;
```

**Change** `createCampaign()` signature:
```solidity
function createCampaign(
    address publisher,
    ActionPotConfig[] calldata actionPots,   // replaces bidCpmPlanck + dailyCapPlanck
    bytes32[] calldata requiredTags,
    bool requireZkProof,
    address rewardToken,
    uint256 rewardPerImpression,
    uint256 bondAmount
) external payable returns (uint256 campaignId)
```

Validation additions:
- `require(actionPots.length > 0 && actionPots.length <= 3, "E93")`
- Loop: detect duplicate `actionType`, check each `budgetPlanck >= MINIMUM_BUDGET_PLANCK`
- Compute `totalBudget = sum(pot.budgetPlanck)`, assert `msg.value == totalBudget + bondAmount`
- View pot: `require(ratePlanck >= minimumCpmFloor, "E27")`
- Action pot: `require(actionVerifier != address(0), "E00")`
- For each pot: call `budgetLedger.initializeBudget{value: pot.budgetPlanck}(campaignId, pot.actionType, pot.budgetPlanck, pot.dailyCapPlanck)`

**Add** view functions:
```solidity
function getCampaignPots(uint256 id) external view returns (ActionPotConfig[] memory)
function getCampaignPot(uint256 id, uint8 actionType) external view returns (ActionPotConfig memory)
function getCampaignViewBid(uint256 id) external view returns (uint256)  // returns view pot ratePlanck for auction
```

**Impact on `getCampaignForSettlement()`:** Add `ActionPotConfig` return value (or make settlement call `getCampaignPot(id, actionType)` separately).

---

### C2: `DatumBudgetLedger.sol`

All functions gain `uint8 actionType`:

```solidity
function initializeBudget(uint256 campaignId, uint8 actionType, uint256 budget, uint256 dailyCap) external payable
function deductAndTransfer(uint256 campaignId, uint8 actionType, uint256 amount, address recipient) external nonReentrant returns (bool exhausted)
function drainToAdvertiser(uint256 campaignId, address advertiser) external nonReentrant returns (uint256 drained)
// drainToAdvertiser loops over all actionTypes (0,1,2) and drains each
function drainFraction(uint256 campaignId, address recipient, uint256 bps) external nonReentrant returns (uint256 amount)
// drainFraction loops and drains proportionally from each pot
function getRemainingBudget(uint256 campaignId, uint8 actionType) external view returns (uint256)
function getTotalRemainingBudget(uint256 campaignId) external view returns (uint256)
// getTotalRemainingBudget sums across all three actionTypes
```

`_budgets[campaignId][actionType]` is the new storage key.

`drainToAdvertiser` and `drainFraction` loop `actionType` in `[0, 1, 2]` and drain whichever are non-zero. This keeps the lifecycle contract's refund path simple.

`sweepDust` loops the same three keys.

`lastSettlementBlock` stays keyed by `campaignId` only (any pot settlement counts as activity).

---

### C3: `interfaces/IDatumSettlement.sol` — **BREAKING CHANGE**

Replace the `Claim` struct with the new version (see Data Model section above). Rename `impressionCount` → `eventCount` and `clearingCpmPlanck` → `ratePlanck` in struct and all events.

Add `bytes[] calldata actionSigs` as a parallel array to `Claim[]` in settlement functions (for type-2 claims that carry a verifier signature). Length must match `claims` length; non-action claims pass `bytes("")`.

```solidity
struct ClaimBatch {
    address user;
    uint256 campaignId;
    Claim[] claims;
    bytes[] actionSigs;   // NEW: parallel to claims; "" for view/click claims
}
```

Update `settleClaimsMulti` struct similarly.

---

### C4: `DatumClaimValidator.sol`

Add routing by `actionType`:

```solidity
// Type 0: view (CPM)
require(claim.ratePlanck <= pot.ratePlanck, "E06");
require(claim.clickSessionHash == bytes32(0), "E93");

// Type 1: click (CPC)
require(claim.clickSessionHash != bytes32(0), "E90");
require(clickRegistry.hasUnclaimed(claim.clickSessionHash), "E90");
require(claim.ratePlanck == pot.ratePlanck, "E06"); // flat rate, no clearing discount

// Type 2: remote action
require(claim.ratePlanck == pot.ratePlanck, "E06");
// Verifier sig checked here — pass actionSig from ClaimBatch:
address signer = recoverActionSigner(computedHash, actionSig);
require(signer == pot.actionVerifier, "E94");
```

`recoverActionSigner` uses `ecrecover` on the claim hash (already computed as part of hash chain validation).

Fetch the relevant `ActionPotConfig` via `campaigns.getCampaignPot(campaignId, actionType)`.

---

### C5: `DatumSettlement.sol`

**Hash chains:** change `lastNonce` and `lastClaimHash` to triple-keyed maps (see Data Model section).

**Budget deduction:** pass `claim.actionType` to `deductAndTransfer`:
```solidity
(bool dOk, bytes memory dRet) = budgetLedger.call(
    abi.encodeWithSelector(DEDUCT_SELECTOR,
        claim.campaignId, claim.actionType, totalPayment, paymentVault)
);
```

**Payment formula dispatch:**
```solidity
uint256 totalPayment;
if (claim.actionType == 0) {
    // View: CPM formula
    totalPayment = (claim.ratePlanck * claim.eventCount) / 1000;
} else {
    // Click or Remote Action: flat rate × event count (eventCount is always 1 per claim)
    totalPayment = claim.ratePlanck * claim.eventCount;
}
```

**After CPC settlement:** call `clickRegistry.markClaimed(claim.clickSessionHash)`.

**Rate limiter:** pass `claim.actionType` to `checkAndIncrement` so view-impression caps don't mix with click/action caps. Add `actionType` param to `IDatumSettlementRateLimiter`.

**Reputation:** pass click/action counts to `publisherReputation.recordSettlement()` after each batch.

---

### C6: `DatumClickRegistry.sol` (new)

One click per (user, campaign) lifetime. Records session hash; settlement marks claimed.

```solidity
contract DatumClickRegistry {
    struct Session {
        uint256 campaignId;
        address user;
        uint256 blockNumber;
        bool    claimed;
    }
    mapping(bytes32 => Session) public sessions;
    // sessionHash = blake2(user, campaignId, impressionNonce)
    // impressionNonce ties the click to a specific prior impression claim

    uint256 public constant MAX_CLICKS_PER_USER_PER_CAMPAIGN = 1;
    mapping(address => mapping(uint256 => uint256)) public clickCount;

    address public relay;     // records clicks (relay bot submits on behalf of user)
    address public settlement; // marks claimed

    function recordClick(bytes32 sessionHash, uint256 campaignId, address user, uint256 blockNum) external; // relay-only
    function markClaimed(bytes32 sessionHash) external; // settlement-only
    function hasUnclaimed(bytes32 sessionHash) external view returns (bool);
}
```

`sessionHash = blake2(user, campaignId, impressionNonce)` — ties the click to the specific impression nonce from the user's view chain. This prevents orphan clicks (clicks without a prior impression).

---

### E1: `shared/types.ts`

Update `Claim` interface to match new struct (rename `impressionCount` → `eventCount`, `clearingCpmPlanck` → `ratePlanck`; add `actionType`, `clickSessionHash`).

Add `ActionPotConfig` interface. Update `Campaign` interface: remove `bidCpmPlanck`, add `pots: ActionPotConfig[]`.

---

### E2: `claimBuilder.ts` — **BREAKING CHANGE**

Update hash preimage to 9 fields (see Data Model section).

Add `actionType` parameter to `onImpression()`. Existing call sites pass `actionType=0`. New call sites for click and action pass `1` and `2`.

Separate chain state per action type: storage key changes from `chainState:${user}:${campaignId}` to `chainState:${user}:${campaignId}:${actionType}`.

For action type 1 (click): populate `clickSessionHash = blake2(user, campaignId, impressionNonce)` where `impressionNonce` is the last settled view nonce for this campaign.

---

### E3: `campaignPoller.ts`

Fetch `getCampaignPots()` instead of `bidCpmPlanck` + `dailyCap` separately. Expose `viewBid` (Pot 0 `ratePlanck`) as the auction input. Cache full `pots` array per campaign.

---

### E4: `auction.ts`

Change `c.bidCpmPlanck` reference to `c.viewBid` (view pot rate). No other changes — auction only ever runs on type-0 pots.

---

### W1: `CreateCampaign.tsx`

Replace single budget/CPM inputs with per-pot configuration. Default: one view pot (always present). Optional: add click pot, add action pot (shows `actionVerifier` address input).

Per pot: budget amount, daily cap, rate. Total estimated spend shown as sum of all pot budgets.

---

## Phase 2 — Click Capture

Depends on Phase 1 infrastructure (ClickRegistry wired in Phase 1, but only used in Phase 2).

---

### E5: `content/adSlot.ts`

Add click listener:
```typescript
adElement.addEventListener("click", (e: MouseEvent) => {
    if (!e.isTrusted) return;
    // Only fire if campaign has a click pot
    if (!campaign.pots.some(p => p.actionType === 1)) return;
    // Minimum dwell: reject click < 500ms after impression start
    if (Date.now() - impressionStartTime < 500) return;
    chrome.runtime.sendMessage({
        type: "AD_CLICK",
        campaignId,
        publisherAddress,
        impressionNonce: currentImpressionNonce,
        timestamp: Date.now(),
    });
}, { once: true });
```

---

### E6: `background/clickHandler.ts` (new)

- Handle `AD_CLICK` message
- Compute `sessionHash = blake2(user, campaignId, impressionNonce)`
- Store in `chrome.storage.local`: `click:${campaignId}:${sessionHash}`
- Submit session to relay (relay calls `clickRegistry.recordClick()`)
- Build and queue a type-1 Claim with `clickSessionHash` populated, chain state keyed `(user, campaignId, 1)`

---

### R1: `relay-bot.mjs` (Phase 2 additions)

- Accept click sessions from extension
- Call `clickRegistry.recordClick(sessionHash, campaignId, user, blockNum)` before settlement
- Submit type-1 claims with `clickSessionHash` in the claim batch

---

## Phase 3 — Remote Action Confirmation

Depends on Phase 1 (action verifier signature validation is already wired in ClaimValidator).

No new contracts needed. The advertiser runs a verifier service (or wallet) whose address is set at campaign creation. When a user completes an action, they request a signature from that service — the service checks the action occurred (e.g., confirms wallet connection, install receipt, etc.) and signs the claim hash.

---

### E7: `background/actionHandler.ts` (new)

- Listen for `REMOTE_ACTION` message (triggered by extension on external event)
- Collect verifier signature from the advertiser's service (HTTPS endpoint, URL stored in campaign metadata)
- Build and queue a type-2 Claim with `actionSig` populated, chain state keyed `(user, campaignId, 2)`

### E8: `content/index.ts`

Detect advertiser's action trigger (meta tag or JS call in page): `<meta name="datum-action" content="campaignId:42">` or `window.datumAction({ campaignId: 42 })`. On detection, send `REMOTE_ACTION` to background.

### W2: `CreateCampaign.tsx` (Phase 3 addition)

For action pot: add `actionVerifier` address input with explanation ("The address that will sign action confirmations — typically your backend wallet or oracle"). Add optional `actionCallbackUrl` to campaign metadata (IPFS) so the extension knows where to request the signature.

---

## Deployment Sequence

### Phase 1 (all at once — BREAKING)
1. Redeploy `DatumBudgetLedger` (new `actionType` key)
2. Redeploy `DatumCampaigns` (ActionPotConfig[], new createCampaign signature)
3. Deploy `DatumClickRegistry` (ready for Phase 2, wired but not yet used)
4. Redeploy `DatumClaimValidator` (routing by actionType)
5. Redeploy `DatumSettlement` (new hash chains, budget deduction with actionType)
6. Wire: `settlement.setClickRegistry()`, re-run all `setX()` wiring ops
7. Release relay bot with new 9-field hash preimage **simultaneously** with extension
8. `setup-testnet.ts`: create test campaign with view + click pots

### Phase 2
- No new contracts
- Extension release with click listener + clickHandler
- Relay bot update to submit click sessions

### Phase 3
- No new contracts
- Extension release with actionHandler + content trigger detection
- Advertiser documentation: verifier service setup

---

## Files Touched

| File | Phase | Change |
|------|-------|--------|
| `contracts/DatumCampaigns.sol` | 1 | ActionPotConfig[], multi-pot createCampaign |
| `contracts/DatumBudgetLedger.sol` | 1 | `(campaignId, actionType)` key, all functions |
| `contracts/DatumSettlement.sol` | 1 | Triple-keyed hash chains, actionType-routed deduction |
| `contracts/DatumClaimValidator.sol` | 1 | Routing by actionType, verifier sig recovery |
| `contracts/DatumSettlementRateLimiter.sol` | 1 | actionType param added |
| `contracts/interfaces/IDatumSettlement.sol` | 1 | New Claim struct — **BREAKING** |
| `contracts/interfaces/IDatumCampaigns.sol` | 1 | ActionPotConfig struct, new createCampaign sig |
| `contracts/interfaces/IDatumBudgetLedger.sol` | 1 | actionType params |
| `contracts/DatumClickRegistry.sol` | 1 | **New contract** (deployed in P1, used in P2) |
| `extension/src/shared/types.ts` | 1 | Claim + Campaign interfaces |
| `extension/src/background/claimBuilder.ts` | 1 | 9-field hash, per-actionType chain state — **BREAKING** |
| `extension/src/background/campaignPoller.ts` | 1 | Fetch pots array |
| `extension/src/background/auction.ts` | 1 | viewBid instead of bidCpmPlanck |
| `extension/src/content/adSlot.ts` | 2 | Click listener |
| `extension/src/background/clickHandler.ts` | 2 | **New file** |
| `extension/src/background/actionHandler.ts` | 3 | **New file** |
| `extension/src/content/index.ts` | 3 | Action trigger detection |
| `web/src/pages/advertiser/CreateCampaign.tsx` | 1,2,3 | Per-pot UI |
| `alpha-3/scripts/deploy.ts` | 1 | ClickRegistry deploy + wiring |
| `alpha-3/scripts/setup-testnet.ts` | 1 | Multi-pot test campaign |
| `relay-bot/relay-bot.mjs` | 1,2 | New hash preimage + click sessions |

---

## Error Codes (New)

| Code | Meaning |
|------|---------|
| E88 | Invalid action type value (>2) |
| E90 | Click session hash invalid or already claimed |
| E93 | Duplicate action type in pot config, or actionPots empty |
| E94 | Action verifier signature invalid |

---

## Key Design Decisions

**Why `actionVerifier` is an EOA, not a contract:**
The advertiser controls an address. When a user completes an action, their device calls the advertiser's HTTPS endpoint (URL stored in IPFS metadata), which checks the action and signs `ecrecover`-compatible message. No on-chain infrastructure required from the advertiser — just a key pair. This is the same trust model as `relaySigner` on the publisher side.

**Why click sessions tie to `impressionNonce`:**
`sessionHash = blake2(user, campaignId, impressionNonce)` means a click claim can only be submitted if a view claim with that specific nonce exists and was settled. This prevents click-farming without impressions and makes the session cryptographically unforgeable.

**Why `actionType=0` is the only auction input:**
The click and action rates are fixed at campaign creation — there's nothing to auction. Only the view CPM competes in the Vickrey auction. Once the campaign wins an impression slot, its click/action pots are available as a bonus if the user engages further. This cleanly separates price discovery (auction) from intent signaling (click) from conversion proof (action).

**Why the action verifier signature is NOT in the claim hash:**
The claim hash is `blake2(...fields...)`. The verifier signature is `sign(claimHash)`. Including the sig in the hash would be circular. The sig is passed alongside the claim in `actionSigs[]` and recovered during validation to check it matches `pot.actionVerifier`.

**Budget independence:**
Each pot's budget is independent. A campaign's view pot running dry doesn't stop click/action rewards from paying out on already-shown impressions. This matters most for CPA: a user might complete an action hours after the view pot expired — they should still get paid if the action pot has remaining budget.
