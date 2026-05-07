// Interest-weighted campaign selection — replaces first-match bias with
// weighted random selection proportional to score.
//
// Score = bidCpm × interestWeight × confidence × pageBoost
// Selection: weighted random (probability proportional to score)

import { UserInterestProfile } from "./interestProfile";
import { tagStringFromHash, tagStringFromSlug } from "@shared/tagDictionary";

interface CampaignCandidate {
  id: string;
  publisher: string;
  status: number | string;
  viewBid: string;
  categoryId: number | string;
  requiredTags?: string[];
}

function scoreCampaign(
  campaign: CampaignCandidate,
  profile: UserInterestProfile,
  pageCategory: string
): number {
  // Resolve campaign's tag strings for profile weight lookup
  let interestWeight = 0;
  let matchCount = 0;

  const tags: string[] = Array.isArray(campaign.requiredTags) ? campaign.requiredTags : [];
  if (tags.length > 0) {
    for (const hash of tags) {
      const tagStr = tagStringFromHash(hash);
      if (tagStr) {
        interestWeight += profile.weights[tagStr] ?? 0;
        matchCount++;
      }
    }
    if (matchCount > 0) interestWeight /= matchCount;
  }

  // Resolve page category tag once for multiple uses below
  const pageCategoryTag = pageCategory ? tagStringFromSlug(pageCategory) : null;

  // Fallback for tagless campaigns: use page category for profile weight
  if (tags.length === 0 && pageCategoryTag) {
    interestWeight = profile.weights[pageCategoryTag] ?? 0;
    matchCount = 1;
  }

  // Confidence: saturates at 20 visits
  let visitKey = "";
  if (tags.length > 0) {
    visitKey = tagStringFromHash(tags[0]) ?? "";
  } else if (pageCategoryTag) {
    visitKey = pageCategoryTag;
  }
  const visits = visitKey ? (profile.visitCounts[visitKey] ?? 0) : 0;
  const confidence = Math.min(visits, 20) / 20;

  // Contextual boost: 50% bonus when page category matches campaign category
  let pageBoost = 1.0;
  if (pageCategoryTag && tags.length > 0) {
    for (const hash of tags) {
      const tagStr = tagStringFromHash(hash);
      if (tagStr === pageCategoryTag) { pageBoost = 1.5; break; }
    }
  }

  // Bid weight: higher-bidding campaigns get proportionally more impressions
  const bidWeight = Number(campaign.viewBid);

  // Minimum score floor: ensure all campaigns have a chance even with empty profile
  const baseScore = bidWeight * 0.1;

  return baseScore + interestWeight * confidence * pageBoost * bidWeight;
}

/**
 * Select a campaign from a pool using weighted random selection.
 * Returns null if the pool is empty.
 */
export function selectCampaign(
  campaigns: CampaignCandidate[],
  profile: UserInterestProfile,
  pageCategory: string
): CampaignCandidate | null {
  if (campaigns.length === 0) return null;
  if (campaigns.length === 1) return campaigns[0];

  // Score all candidates
  const scores = campaigns.map((c) => ({
    campaign: c,
    score: scoreCampaign(c, profile, pageCategory),
  }));

  // Weighted random selection
  const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
  if (totalScore <= 0) {
    // Fallback: uniform random if all scores are zero
    return campaigns[Math.floor(Math.random() * campaigns.length)];
  }

  let rand = Math.random() * totalScore;
  for (const s of scores) {
    rand -= s.score;
    if (rand <= 0) return s.campaign;
  }

  // Floating-point edge case: return last
  return scores[scores.length - 1].campaign;
}
