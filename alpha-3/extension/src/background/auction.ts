// Second-price Vickrey auction for campaign selection (P19)
// effectiveBid = bidCpmPlanck * interestWeight
// Clearing CPM = secondEffectiveBid / winnerInterestWeight, clamped to [bidCpm*30%, bidCpm]
//
// TX-3: Tag-based interest weighting. Campaigns carry requiredTags (bytes32[]).
// Interest weight = average tag weight from profile using tag strings.

import { UserInterestProfile } from "./interestProfile";
import { tagStringFromHash } from "@shared/tagDictionary";

export interface CampaignCandidate {
  id: string;
  bidCpmPlanck: string;  // serialized bigint
  categoryId: number;
  publisher: string;
  requiredTags?: string[];  // TX-3: bytes32 tag hashes
  [key: string]: any;
}

export interface AuctionResult {
  winner: CampaignCandidate;
  clearingCpmPlanck: bigint;
  participants: number;
  mechanism: "second-price" | "solo" | "floor";
}

/**
 * Run second-price auction over eligible campaigns for a given page.
 * Returns winner + clearing CPM, or null if no candidates.
 */
export function auctionForPage(
  campaigns: CampaignCandidate[],
  pageCategories: Record<string, number>,
  profile: UserInterestProfile,
): AuctionResult | null {
  if (campaigns.length === 0) return null;

  // Compute effective bids
  const scored = campaigns.map((c) => {
    const interestWeight = Math.max(getTagWeight(profile, c), 0.1);
    const bidCpm = BigInt(c.bidCpmPlanck);
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

  if (campaigns.length === 1) {
    // Solo: 70% of bid
    const clearingCpm = (bidCpm * 70n) / 100n;
    return {
      winner: winner.campaign,
      clearingCpmPlanck: clearingCpm > 0n ? clearingCpm : 1n,
      participants: 1,
      mechanism: "solo",
    };
  }

  // 2+ campaigns: second-price
  const second = scored[1];
  // clearingCpm = secondEffectiveBid / (winnerInterestWeight * 1000)
  const clearingRaw = second.effectiveBid / BigInt(Math.round(winner.interestWeight * 1000));

  // Clamp to [bidCpm * 30%, bidCpm]
  const floor = (bidCpm * 30n) / 100n;
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
  };
}

/**
 * TX-3: Get interest weight for a campaign using tag-based matching.
 * Uses requiredTags → tag strings → profile weights.
 * Returns the average weight across all matched tags.
 */
function getTagWeight(profile: UserInterestProfile, c: CampaignCandidate): number {
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

  return 0;
}
