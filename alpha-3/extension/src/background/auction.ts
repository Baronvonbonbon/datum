// Second-price Vickrey auction for campaign selection (P19)
// effectiveBid = viewBid * interestWeight  (viewBid = view/CPM pot ratePlanck)
// Clearing CPM = secondEffectiveBid / winnerInterestWeight, clamped to [viewBid*30%, viewBid]
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
  mechanism: "second-price" | "solo" | "floor";
  allScored: ScoredBid[];
  /** Ratio of clearingCpmPlanck to winner's viewBid (0–1). Indicates auction efficiency. */
  bidEfficiency: number;
}

/**
 * Run second-price auction over eligible campaigns for a given page.
 * Returns winner + clearing CPM, or null if no candidates.
 *
 * @param pageTags - tag strings for the current page (e.g., ["topic:finance", "locale:en"]).
 *   Used as fallback interest signal for campaigns without requiredTags.
 */
export function auctionForPage(
  campaigns: CampaignCandidate[],
  pageCategories: Record<string, number>,
  profile: UserInterestProfile,
  pageTags?: string[],
): AuctionResult | null {
  if (campaigns.length === 0) return null;

  // Compute effective bids
  const scored = campaigns.map((c) => {
    const interestWeight = Math.max(getTagWeight(profile, c, pageTags), 0.1);
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

  if (campaigns.length === 1) {
    // Solo: 85% of bid (raised from 70% — reduces solo discount)
    const clearingCpm = (bidCpm * 85n) / 100n;
    const finalCpm = clearingCpm > 0n ? clearingCpm : 1n;
    return {
      winner: winner.campaign,
      clearingCpmPlanck: finalCpm,
      participants: 1,
      mechanism: "solo",
      allScored,
      bidEfficiency: bidCpm > 0n ? Number(finalCpm) / Number(bidCpm) : 0,
    };
  }

  // 2+ campaigns: second-price
  const second = scored[1];
  // clearingCpm = secondEffectiveBid / (winnerInterestWeight * 1000)
  const clearingRaw = second.effectiveBid / BigInt(Math.round(winner.interestWeight * 1000));

  // Clamp to [bidCpm * 65%, bidCpm] (floor raised from 30% — tighter range)
  const floor = (bidCpm * 65n) / 100n;
  let clearingCpm: bigint;
  let mechanism: "second-price" | "floor";

  if (clearingRaw < floor) {
    clearingCpm = floor > 0n ? floor : 1n;
    mechanism = "floor";
  } else if (clearingRaw > bidCpm) {
    clearingCpm = bidCpm;
    mechanism = "second-price";
  } else {
    clearingCpm = clearingRaw > 0n ? clearingRaw : 1n;
    mechanism = "second-price";
  }

  return {
    winner: winner.campaign,
    clearingCpmPlanck: clearingCpm,
    participants: campaigns.length,
    mechanism,
    allScored,
    bidEfficiency: bidCpm > 0n ? Number(clearingCpm) / Number(bidCpm) : 0,
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
 */
function getTagWeight(
  profile: UserInterestProfile,
  c: CampaignCandidate,
  pageTags?: string[],
): number {
  // Campaign has explicit required tags — use those
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
