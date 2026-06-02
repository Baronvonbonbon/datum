// Interest-weighted campaign selection (CPM-based; no price auction).
// effectiveBid = viewBid * interestWeight  (viewBid = view/CPM pot ratePlanck)
// The winner is chosen by interest-weighted relevance; the claim pays the winner's
// OWN CPM (its pot ratePlanck) — second-price clearing was removed (unenforceable
// on-chain). The clearing CPM is rounded DOWN to a denomination-clean granularity so
// the resulting Paseo settlement payout satisfies the eth-rpc `value % 1e6 < 500000`
// rule (totalPayment = rate*events/1000 stays a multiple of 1e6 through a 50% take split).
//
// TX-3: Tag-based interest weighting. Campaigns carry requiredTags (bytes32[]).
// Interest weight = average tag weight from profile using tag strings.
// Tagless campaigns (requiredTags=[]) use page tags as fallback — the user's
// interest in the current page topic determines the effective bid.

import { UserInterestProfile } from "./interestProfile";
import { tagStringFromHash } from "@shared/tagDictionary";

export interface CampaignCandidate {
  id: string;
  viewBid: string;          // serialized bigint — view pot ratePlanck (CPM)
  categoryId: number;
  publisher: string;
  requiredTags?: string[];  // TX-3: bytes32 tag hashes
  [key: string]: any;
}

export interface ScoredBid {
  id: string;
  viewBid: string;          // serialized bigint — view pot ratePlanck
  interestWeight: number;
  effectiveBidMicro: string; // effectiveBid.toString() (viewBid * weight * 1000)
}

export interface AuctionResult {
  winner: CampaignCandidate;
  clearingCpmPlanck: bigint;
  participants: number;
  mechanism: "cpm";
  allScored: ScoredBid[];
  /** Ratio of clearingCpmPlanck to winner's viewBid (0–1) after clean-rounding. */
  bidEfficiency: number;
}

// Round the clearing CPM DOWN to this granularity so Paseo settlement payouts stay
// `value % 1e6 < 500000`. 2e9 planck (0.2 PAS) per 1000 impressions keeps
// totalPayment = rate*events/1000 a multiple of 2e6 → clean even after a 50% take
// split, for any eventCount. Campaigns are also SEEDED on clean multiples of this,
// so for them the rounding is a no-op; it's a safety net for any off-grid CPM.
const CPM_GRANULARITY = 2_000_000_000n;
export function roundCpmClean(cpm: bigint): bigint {
  if (cpm <= 0n) return cpm;
  if (cpm < CPM_GRANULARITY) return cpm; // below grid — can't round up (would exceed the bid)
  return cpm - (cpm % CPM_GRANULARITY);
}

/**
 * Run second-price auction over eligible campaigns for a given page.
 * Returns winner + clearing CPM, or null if no candidates.
 *
 * @param pageTags - tag strings for the current page (e.g., ["topic:finance", "locale:en"]).
 *   Used as fallback interest signal for campaigns without requiredTags.
 * @param contextualMode - if true, weight campaigns by page-tag overlap only (no profile weights).
 */
export function auctionForPage(
  campaigns: CampaignCandidate[],
  pageCategories: Record<string, number>,
  profile: UserInterestProfile,
  pageTags?: string[],
  contextualMode?: boolean,
): AuctionResult | null {
  if (campaigns.length === 0) return null;

  // Compute effective bids
  const scored = campaigns.map((c) => {
    const interestWeight = Math.max(getTagWeight(profile, c, pageTags, contextualMode), 0.1);
    const bidCpm = BigInt(c.viewBid);
    // effectiveBid in micro-planck (multiply by 1000 for precision)
    const effectiveBid = bidCpm * BigInt(Math.round(interestWeight * 1000));
    return { campaign: c, bidCpm, interestWeight, effectiveBid };
  });

  // Sort by effectiveBid descending (deterministic)
  scored.sort((a, b) => {
    if (b.effectiveBid > a.effectiveBid) return 1;
    if (b.effectiveBid < a.effectiveBid) return -1;
    return 0;
  });

  const winner = scored[0];
  const bidCpm = winner.bidCpm;

  const allScored: ScoredBid[] = scored.map((s) => ({
    id: String(s.campaign.id ?? s.campaign.campaignId ?? "?"),
    viewBid: s.bidCpm.toString(),
    interestWeight: s.interestWeight,
    effectiveBidMicro: s.effectiveBid.toString(),
  }));

  // No price auction. Second-price clearing is unenforceable on-chain — the contract
  // never sees competing bids, so any clearing CPM is just an unverifiable client
  // assertion. The winner is chosen by interest-weighted relevance above (the
  // privacy-preserving part); the claim pays the winner's own CPM (its pot
  // ratePlanck), rounded DOWN to a denomination-clean granularity so the Paseo
  // settlement payout doesn't hit the `value % 1e6 ≥ 500000` revert. Rounding down
  // keeps clearingCpm ≤ the pot ratePlanck, so the validator's `ratePlanck ≤ pot`
  // check still holds.
  const clearingCpm = roundCpmClean(bidCpm);
  return {
    winner: winner.campaign,
    clearingCpmPlanck: clearingCpm,
    participants: campaigns.length,
    mechanism: "cpm",
    allScored,
    bidEfficiency: bidCpm > 0n ? Number((clearingCpm * 1000n) / bidCpm) / 1000 : 1,
  };
}

/**
 * TX-3: Get interest weight for a campaign using tag-based matching.
 * Uses requiredTags → tag strings → profile weights.
 * Returns the average weight across all matched tags.
 *
 * Fallback for tagless campaigns: uses page tags from the content script
 * (the page's classified topics) to look up the user's profile weight.
 * This ensures generic/open campaigns still benefit from interest-based pricing.
 *
 * In contextual mode: weight by page-tag overlap only — no profile weights used.
 * Campaigns whose requiredTags overlap with the current page's tags score higher;
 * tagless campaigns get a neutral participation weight of 0.5.
 */
function getTagWeight(
  profile: UserInterestProfile,
  c: CampaignCandidate,
  pageTags?: string[],
  contextualMode?: boolean,
): number {
  if (contextualMode) {
    // Contextual mode: match campaign requiredTags against current page tags only.
    // No user profile weights — the page content is the only signal.
    if (c.requiredTags && c.requiredTags.length > 0) {
      if (!pageTags || pageTags.length === 0) return 0.1; // can't assess relevance — low floor
      const pageTagSet = new Set(pageTags);
      let matches = 0;
      for (const hash of c.requiredTags) {
        const tagStr = tagStringFromHash(hash);
        if (tagStr && pageTagSet.has(tagStr)) matches++;
      }
      // Proportion of required tags present on this page (at least floor 0.1 to participate)
      return matches > 0 ? matches / c.requiredTags.length : 0.1;
    }
    // Tagless campaigns always eligible — neutral weight so bid price decides
    return 0.5;
  }

  // Campaign has explicit required tags — use profile weights
  if (c.requiredTags && c.requiredTags.length > 0) {
    let totalWeight = 0;
    let matchCount = 0;
    for (const hash of c.requiredTags) {
      // Resolve hash → tag string → profile weight
      const tagStr = tagStringFromHash(hash);
      if (tagStr) {
        totalWeight += profile.weights[tagStr] ?? 0;
        matchCount++;
      }
    }
    return matchCount > 0 ? totalWeight / matchCount : 0;
  }

  // Tagless campaign: use page's topic tags as context signal.
  // Average the user's profile weight across the page's topics.
  if (pageTags && pageTags.length > 0) {
    let totalWeight = 0;
    let matchCount = 0;
    for (const tag of pageTags) {
      // Only use topic tags for interest weighting (skip locale/platform)
      if (!tag.startsWith("topic:")) continue;
      const w = profile.weights[tag] ?? 0;
      totalWeight += w;
      matchCount++;
    }
    return matchCount > 0 ? totalWeight / matchCount : 0;
  }

  return 0;
}
