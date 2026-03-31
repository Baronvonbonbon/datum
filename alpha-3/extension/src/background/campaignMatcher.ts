// Interest-weighted campaign selection — replaces first-match bias with
// weighted random selection proportional to score.
//
// Score = bidCpm × interestWeight × confidence × pageBoost
// Selection: weighted random (probability proportional to score)

import { UserInterestProfile } from "./interestProfile";
import { CATEGORY_TO_TAG, TAG_LABELS } from "@shared/tagDictionary";

interface CampaignCandidate {
  id: string;
  publisher: string;
  status: number | string;
  bidCpmPlanck: string;
  categoryId: number | string;
}

function scoreCampaign(
  campaign: CampaignCandidate,
  profile: UserInterestProfile,
  pageCategory: string
): number {
  const catTag = CATEGORY_TO_TAG[Number(campaign.categoryId)] ?? "";
  const catName = catTag ? (TAG_LABELS[catTag] ?? "") : "";

  // Interest weight from profile (0.0 if no visits to this category)
  const interestWeight = profile.weights[catName] ?? 0;

  // Confidence: saturates at 20 visits (avoids runaway bias from heavy browsing in one category)
  const visits = profile.visitCounts[catName] ?? 0;
  const confidence = Math.min(visits, 20) / 20;

  // Contextual boost: 50% bonus when page category matches campaign category
  const pageBoost = catName === pageCategory ? 1.5 : 1.0;

  // Bid weight: higher-bidding campaigns get proportionally more impressions
  const bidWeight = Number(campaign.bidCpmPlanck);

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
