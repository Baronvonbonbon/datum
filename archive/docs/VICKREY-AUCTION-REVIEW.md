# Vickrey Auction & Interest Profile Review

**Date:** 2026-04-22
**Scope:** `auction.ts`, `interestProfile.ts`, `campaignMatcher.ts`, `qualityScore.ts`, `DatumCampaigns.sol`, `DatumSettlement.sol`

---

## 1. Current Mechanism Summary

### On-Chain
- `DatumCampaigns.createCampaign()` stores a fixed `bidCpmPlanck` per campaign, enforced to be >= `minimumCpmFloor` (constructor-set immutable).
- Settlement pays `(clearingCpmPlanck * impressionCount) / 1000`. The clearing CPM is set client-side and included in the claim hash — the chain trusts whatever value the relay submits.

### Client-Side Auction (`auction.ts`)
1. Each campaign's **effective bid** = `bidCpmPlanck * interestWeight` (weight floored at 0.1).
2. Campaigns sorted by effective bid descending. Winner selected.
3. **Clearing price:**
   - Solo campaign: **70% of bid** (fixed discount).
   - 2+ campaigns: `secondEffectiveBid / winnerInterestWeight`, clamped to **[30% of winner bid, 100% of winner bid]**.

### Interest Profile (`interestProfile.ts`)
- Tag-visit log with 7-day half-life exponential decay, 30-day max age.
- Weights normalized so the single strongest tag = 1.0; everything else is relative.
- Tags with zero visits get weight 0 (floored to 0.1 in auction).

### Campaign Matcher (`campaignMatcher.ts`)
- Weighted random selection using `score = bidWeight * 0.1 + interestWeight * confidence * pageBoost * bidWeight`.
- Confidence saturates at 20 visits. Page boost = 1.5x for contextual match.

---

## 2. Race-to-the-Bottom Dynamics

The current design produces systematically low clearing prices through several reinforcing mechanisms:

### 2a. Sparse Competition per Impression
Each impression is matched against campaigns that target the specific publisher + pass user preference filters + pass tag matching. In early-stage markets, most auction slots will have 1-2 eligible campaigns. With a solo campaign, clearing = 70% of bid. With two campaigns where one is clearly dominant, the 30% floor kicks in. **Result: advertisers learn that bidding just above `minimumCpmFloor` costs them nothing because they rarely face real competition.**

### 2b. Interest Weight Deflates Clearing Price
The clearing formula divides the second effective bid by the **winner's** interest weight. If the winner has high interest affinity (weight ~1.0), the raw clearing CPM is suppressed. A user deeply interested in crypto sees a crypto campaign clear at essentially the second bidder's raw CPM — but if that second bidder has low affinity, the second effective bid is already tiny.

**Example:** Campaign A bids 1 DOT CPM (crypto, weight 1.0), Campaign B bids 0.8 DOT CPM (finance, weight 0.3).
- Effective: A = 1000, B = 240
- Clearing = 240 / 1000 (A's weight factor) = 0.24 DOT CPM
- Clamped to floor = 0.30 DOT CPM (30% of A's bid)
- **A wins the most valuable user and pays 30% of their bid.**

### 2c. The 30% Floor is Too Low
The hard floor at 30% of the winner's bid means even in the worst case, an advertiser pays less than a third of what they offered. This eliminates any incentive to bid truthfully. Rational advertisers will shade bids upward knowing they'll never actually pay the full amount, while the market clearing price remains pinned near the floor.

### 2d. No Reserve Price Dynamics
`minimumCpmFloor` is a constructor immutable — set once at deploy. It cannot adapt to market conditions. If attention becomes more valuable (more users, better engagement), the floor doesn't rise. There is no mechanism for price discovery from the demand side.

### 2e. No User Agency in Price
Users set a `minBidCpm` preference but this is a binary filter (pass/fail), not a signal that feeds into the auction. Users with high-quality attention (high engagement scores, valuable demographics) have no way to demand higher compensation. A user who always scrolls, focuses, and engages deeply is paid the same clearing CPM as one who barely meets the 200ms dwell threshold.

### 2f. Normalized Weights Destroy Absolute Signal
Interest profile normalizes to max=1.0. A user who visits 100 crypto sites and 1 finance site has crypto=1.0 and finance=0.01. But a user who visits only 1 crypto site also has crypto=1.0. The auction cannot distinguish between deep genuine interest and casual browsing. This makes the interest-weighted effective bid unreliable as a signal of attention value.

---

## 3. Proposed Options

### Option A: Dynamic Reserve Price (Recommended — Moderate Complexity)

Replace the static `minimumCpmFloor` with a dynamic floor that responds to market conditions.

**Mechanism:**
- Track a rolling average clearing CPM per tag category (e.g., 7-day EWMA).
- Set the reserve price to `max(globalFloor, 0.7 * rollingAverageCpm)` for each auction.
- When competition is thin, the reserve holds prices near historical norms rather than collapsing to the static floor.

**On-chain change:** Add a `DatumReserveOracle` contract that publishers or a relay can update with aggregated clearing stats. `minimumCpmFloor` becomes a governance-adjustable parameter (via `DatumParameterGovernance`).

**Client-side change:** `auctionForPage()` accepts a `reserveCpm` parameter; the floor clamp uses `max(reserveCpm, bidCpm * 30%)` instead of just `bidCpm * 30%`.

**Pros:** Prevents race-to-bottom in thin markets; adapts to growth; no user-facing complexity.
**Cons:** Requires oracle infrastructure; reserve could lag behind genuine market shifts.

---

### Option B: Quality-Weighted Clearing (Recommended — Low Complexity)

Incorporate the engagement quality score into the payment formula so that higher-quality attention earns more.

**Mechanism:**
- `qualityScore.ts` already computes a 0.0–1.0 score (dwell, focus, viewability, scroll depth).
- Introduce a **quality multiplier** on the clearing CPM: `effectiveClearingCpm = clearingCpm * (0.5 + 0.5 * qualityScore)`.
- Include `qualityScore` in the claim hash so it's committed on-chain.
- Settlement computes payment using the quality-adjusted CPM.

**Impact:** A fully engaged impression (quality=1.0) earns 100% of the clearing CPM. A barely-qualifying impression (quality=0.05) earns ~52.5%. This creates a natural price gradient that rewards quality attention and incentivizes users to engage genuinely.

**Pros:** Directly rewards the behavior that makes impressions valuable; no oracle needed; aligns all three sides (user earns more by engaging, publisher gets better campaigns, advertiser pays fairly for quality).
**Cons:** Advertisers may perceive inconsistent per-impression costs; requires claim hash update and settlement contract change.

---

### Option C: Attention Reserve Pricing (User-Set Floor)

Give users meaningful price agency by replacing the binary `minBidCpm` filter with a graduated reserve that participates in the auction.

**Mechanism:**
- Users set an **attention reserve price** — the minimum they'll accept per 1000 impressions.
- The auction treats this as a virtual second bidder: `clearingCpm = max(userReserve, secondBidClearing)`.
- Users with valuable attention (high engagement history) are shown a suggested reserve based on their historical earnings.
- The extension UI shows estimated hourly earnings at different reserve levels.

**Impact:** Users in high-demand verticals (crypto, finance) can set higher reserves, creating real price signals. Users willing to accept lower rates in exchange for more frequent ads can do so. This converts the user from a passive recipient into an active market participant.

**Pros:** True attention price discovery; respects user autonomy; creates demand-side signal.
**Cons:** Complexity for casual users; risk of users pricing themselves out of the market; requires education.

---

### Option D: Multi-Unit Ascending Clock Auction

Replace the single-shot Vickrey with a multi-round ascending clock mechanism for high-competition slots.

**Mechanism:**
- When 3+ campaigns compete for the same impression slot, run a simulated ascending clock:
  1. Start at `minimumCpmFloor`.
  2. Each round, price increases by 10%. Campaigns whose `bidCpmPlanck < currentPrice` drop out.
  3. When one campaign remains, it wins at the last price where two remained.
- For <=2 campaigns, fall back to the current Vickrey mechanism.

**Impact:** In competitive verticals, prices rise to reflect true demand. The ascending structure is incentive-compatible (dominant strategy is to stay in until your true value). Prevents the second-price discount from suppressing prices in thick markets.

**Pros:** Efficient price discovery in competitive segments; incentive-compatible; proven mechanism.
**Cons:** Only helps when competition exists (doesn't solve thin-market problem); adds latency to auction; more complex client-side code.

---

### Option E: Raise the Floor Clamp + Implement Bid Shading Transparency

The simplest intervention: raise the 30% floor to 60-70% and make the solo discount 85-90% instead of 70%.

**Mechanism:**
- Change `auction.ts` floor from 30% → 65%.
- Change solo clearing from 70% → 85%.
- Add a `bidEfficiency` field to `AuctionResult` showing `clearingCpm / bidCpm` so advertisers see how much they're saving vs. their bid.

**Impact:** Immediately raises clearing prices by ~2x across the board. Advertisers still get a second-price discount but it's bounded to a meaningful range.

**Pros:** Trivial to implement (two constants); no contract changes; immediate revenue impact.
**Cons:** Blunt instrument; doesn't create real price discovery; may need re-tuning as market grows.

---

### Option F: Publisher Quality Tiers with Differentiated Floors

Use the existing `DatumPublisherReputation` score to create tiered reserve prices.

**Mechanism:**
- Define 3-4 publisher tiers based on reputation score (e.g., >90% = Premium, >75% = Standard, else = Basic).
- Each tier has a different minimum CPM floor multiplier (e.g., Premium = 2x base, Standard = 1.5x, Basic = 1x).
- Higher-reputation publishers command higher prices, creating incentive for publishers to maintain quality.
- Tier thresholds adjustable via `DatumParameterGovernance`.

**Impact:** Creates a quality ladder. Premium publishers attract premium bids. Basic publishers compete on volume. Advertisers get what they pay for.

**Pros:** Leverages existing reputation infrastructure; aligns publisher incentives; creates natural market segmentation.
**Cons:** New publishers start at lowest tier; requires reputation system to be accurate and sybil-resistant.

---

## 4. Interaction: Interest Profile Weaknesses

Independent of auction mechanism, the interest profile has structural issues that distort price signals:

| Issue | Impact | Fix |
|-------|--------|-----|
| Max-normalization destroys absolute magnitude | Can't distinguish deep vs. casual interest | Use sigmoid normalization: `weight = 1 / (1 + e^(-k*(rawScore - median)))` with a fixed median |
| 7-day half-life is aggressive | User who doesn't browse on weekend loses half their profile | Extend to 14-day half-life; or use session-count decay instead of time decay |
| No visit frequency signal | 1 visit and 100 visits to same topic both produce weight=1.0 after normalization | Cap normalization at a fixed ceiling (e.g., 50 decay-weighted visits = 1.0) rather than relative max |
| No negative signals | Profile only grows; user can't express disinterest except via blocklist | Add decay-on-dismiss: if user dismisses/blocks an ad, reduce that tag's weight by 0.1 |
| Confidence is unused in auction | `campaignMatcher.ts` uses confidence but `auction.ts` does not | Multiply effective bid by confidence factor to penalize uncertain matches |

---

## 5. Recommended Combination

For the strongest effect with manageable implementation scope, combine:

1. **Option E** (raise floor clamps) — immediate, zero-risk revenue improvement.
2. **Option B** (quality-weighted clearing) — aligns all three parties around genuine engagement.
3. **Option C** (user attention reserve) — creates real demand-side price signals.
4. **Interest profile fixes** (sigmoid normalization + confidence in auction) — improves signal quality feeding into all of the above.

This creates a market where:
- Advertisers compete on genuine value (not just who bids lowest above a static floor).
- Users with better attention earn proportionally more (quality multiplier + reserve pricing).
- Publishers with better reputation command premium rates (via Option F if added later).
- Thin markets are protected by sensible floors rather than collapsing to minimums.

---

## 6. Files Affected by Each Option

| Option | Client-Side | Contracts | New Contract |
|--------|-------------|-----------|--------------|
| A (Dynamic Reserve) | `auction.ts` | `DatumParameterGovernance` | `DatumReserveOracle` |
| B (Quality Clearing) | `auction.ts`, `claimBuilder.ts` | `DatumSettlement`, `DatumClaimValidator` | — |
| C (User Reserve) | `auction.ts`, `userPreferences.ts`, `Settings.tsx` | — | — |
| D (Ascending Clock) | `auction.ts` | — | — |
| E (Raise Floors) | `auction.ts` | — | — |
| F (Publisher Tiers) | `auction.ts`, `campaignPoller.ts` | `DatumPublisherReputation` | — |
