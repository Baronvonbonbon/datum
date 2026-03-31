// Local interest profile — builds an on-device tag affinity vector
// from browsing + ad exposure. Data never leaves the browser.
//
// Tags are stored by their TAG_LABELS value (e.g., "Crypto & Web3", "English (US)",
// "Desktop") so they align with auction.ts::getTagWeight() lookups.
//
// Sources: page visits (topic from taxonomy), locale (navigator.language / html lang),
// platform (UA detection), and campaign tag exposure (ads viewed).
//
// Uses exponential decay weighting: recent visits count more than old ones.
// Half-life = 7 days: a visit 7 days ago has half the weight of one today.

const STORAGE_KEY = "interestProfile";
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // prune visits older than 30 days

// UB-5: In-memory lock for updateProfile — prevents concurrent get→mutate→set race.
// Pending updates are coalesced: if a lock is held, we queue one extra batch
// and process it after the current holder finishes.
let _profileLock = false;
const _profileQueue: string[][] = [];

interface TagVisit {
  /** TAG_LABELS value (e.g., "Crypto & Web3", "Desktop", "English (US)") */
  category: string;
  timestamp: number;
}

export interface UserInterestProfile {
  /** Raw visit log (pruned to 30 days) */
  visits: TagVisit[];
  /** Normalized weights per tag label (0.0 - 1.0, max = 1.0) */
  weights: Record<string, number>;
  /** Visit count per tag label (for confidence calculation) */
  visitCounts: Record<string, number>;
}

function computeWeights(visits: TagVisit[]): {
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
  /** Record tag label visits and recompute weights.
   *  Accepts multiple tag labels per call (topic + locale + platform).
   *  UB-5: In-memory lock prevents concurrent get→mutate→set races.
   *  Concurrent callers queue their tags; the lock holder drains the queue. */
  async updateProfile(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    if (_profileLock) {
      _profileQueue.push(tags);
      return;
    }
    _profileLock = true;
    try {
      // Collect all queued tag arrays
      const allTagSets = [tags, ..._profileQueue.splice(0)];

      const profile = await this.getProfile();
      const now = Date.now();

      for (const tagSet of allTagSets) {
        for (const tag of tagSet) {
          profile.visits.push({ category: tag, timestamp: now });
        }
      }

      // Prune old visits (>30 days)
      const cutoff = now - MAX_AGE_MS;
      profile.visits = profile.visits.filter((v) => v.timestamp >= cutoff);

      // Recompute weights
      const { weights, visitCounts } = computeWeights(profile.visits);
      profile.weights = weights;
      profile.visitCounts = visitCounts;

      await chrome.storage.local.set({ [STORAGE_KEY]: profile });
    } finally {
      _profileLock = false;
    }
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

  /** Get normalized weight for a single tag label (0.0 if not visited) */
  getNormalizedWeight(profile: UserInterestProfile, tagLabel: string): number {
    return profile.weights[tagLabel] ?? 0;
  },
};
