// Local interest profile — builds an on-device category affinity vector
// from browsing history. Data never leaves the browser.
//
// Uses exponential decay weighting: recent visits count more than old ones.
// Half-life = 7 days: a visit 7 days ago has half the weight of one today.

const STORAGE_KEY = "interestProfile";
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // prune visits older than 30 days

interface CategoryVisit {
  category: string;
  timestamp: number;
}

export interface UserInterestProfile {
  /** Raw visit log (pruned to 30 days) */
  visits: CategoryVisit[];
  /** Normalized weights per category (0.0 - 1.0, max = 1.0) */
  weights: Record<string, number>;
  /** Visit count per category (for confidence calculation) */
  visitCounts: Record<string, number>;
}

function computeWeights(visits: CategoryVisit[]): {
  weights: Record<string, number>;
  visitCounts: Record<string, number>;
} {
  const now = Date.now();
  const rawWeights: Record<string, number> = {};
  const visitCounts: Record<string, number> = {};

  for (const v of visits) {
    const age = now - v.timestamp;
    const decay = Math.pow(0.5, age / HALF_LIFE_MS);
    rawWeights[v.category] = (rawWeights[v.category] ?? 0) + decay;
    visitCounts[v.category] = (visitCounts[v.category] ?? 0) + 1;
  }

  // Normalize: max weight = 1.0
  const maxWeight = Math.max(...Object.values(rawWeights), 0.001);
  const weights: Record<string, number> = {};
  for (const [cat, w] of Object.entries(rawWeights)) {
    weights[cat] = Math.round((w / maxWeight) * 1000) / 1000; // 3 decimal places
  }

  return { weights, visitCounts };
}

export const interestProfile = {
  /** Record a category visit and recompute weights */
  async updateProfile(category: string): Promise<void> {
    const profile = await this.getProfile();
    const now = Date.now();

    // Add visit
    profile.visits.push({ category, timestamp: now });

    // Prune old visits (>30 days)
    const cutoff = now - MAX_AGE_MS;
    profile.visits = profile.visits.filter((v) => v.timestamp >= cutoff);

    // Recompute weights
    const { weights, visitCounts } = computeWeights(profile.visits);
    profile.weights = weights;
    profile.visitCounts = visitCounts;

    await chrome.storage.local.set({ [STORAGE_KEY]: profile });
  },

  /** Get the current interest profile */
  async getProfile(): Promise<UserInterestProfile> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? { visits: [], weights: {}, visitCounts: {} };
  },

  /** Reset the interest profile (user-initiated) */
  async resetProfile(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
  },

  /** Get normalized weight for a single category (0.0 if not visited) */
  getNormalizedWeight(profile: UserInterestProfile, categoryName: string): number {
    return profile.weights[categoryName] ?? 0;
  },
};
