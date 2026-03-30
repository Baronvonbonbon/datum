// Second-price Vickrey auction for campaign selection (P19)
// effectiveBid = bidCpmPlanck * interestWeight
// Clearing CPM = secondEffectiveBid / winnerInterestWeight, clamped to [bidCpm*30%, bidCpm]
//
// TX-3: Tag-based interest weighting. Campaigns carry requiredTags (bytes32[]).
// Interest weight = max tag weight from profile (falls back to categoryId for backward compat).

import { UserInterestProfile } from "./interestProfile";
import { CATEGORY_NAMES } from "@shared/types";
import { tagLabel, CATEGORY_TO_TAG, TAG_LABELS } from "@shared/tagDictionary";

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
 * Uses requiredTags if available, falls back to categoryId for backward compat.
 * Returns the max weight across all matched tags (best dimension match wins).
 */
function getTagWeight(profile: UserInterestProfile, c: CampaignCandidate): number {
  // TX-3: If campaign has required tags, use tag-based weighting
  if (c.requiredTags && c.requiredTags.length > 0) {
    let maxWeight = 0;
    for (const hash of c.requiredTags) {
      const label = tagLabel(hash);
      if (label) {
        // Check profile for tag label (e.g., "Crypto & Web3")
        const w = profile.weights[label] ?? 0;
        if (w > maxWeight) maxWeight = w;
      }
    }
    return maxWeight;
  }

  // Backward compat: use categoryId → tag label → profile weight
  const catTag = CATEGORY_TO_TAG[c.categoryId];
  if (catTag) {
    const label = TAG_LABELS[catTag];
    if (label) return profile.weights[label] ?? 0;
  }

  // Legacy fallback: direct category name lookup
  const catName = CATEGORY_NAMES[c.categoryId] ?? "";
  return profile.weights[catName] ?? 0;
}
