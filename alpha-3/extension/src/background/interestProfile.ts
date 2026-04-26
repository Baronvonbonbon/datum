// Local interest profile — builds an on-device tag affinity vector
// from browsing + ad exposure. Data never leaves the browser.
//
// Tags are stored by their tag string (e.g., "topic:crypto-web3", "locale:en-US",
// "platform:desktop") — the canonical key format for all tag matching.
//
// Sources: page visits (topic from taxonomy), locale (navigator.language / html lang),
// platform (UA detection), and campaign tag exposure (ads viewed).
//
// Uses exponential decay weighting: recent visits count more than old ones.
// Half-life = 7 days: a visit 7 days ago has half the weight of one today.

import { tagStringFromLabel } from "@shared/tagDictionary";

const STORAGE_KEY = "interestProfile";
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // prune visits older than 30 days

// UB-5: In-memory lock for updateProfile — prevents concurrent get→mutate→set race.
// Pending updates are coalesced: if a lock is held, we queue one extra batch
// and process it after the current holder finishes.
let _profileLock = false;
const _profileQueue: string[][] = [];

interface TagVisit {
  /** Tag string (e.g., "topic:crypto-web3", "platform:desktop", "locale:en-US") */
  tag: string;
  timestamp: number;
  /** @deprecated Old field name — migrated to `tag` on read */
  category?: string;
}

export interface UserInterestProfile {
  /** Raw visit log (pruned to 30 days) */
  visits: TagVisit[];
  /** Normalized weights per tag string (0.0 - 1.0, max = 1.0) */
  weights: Record<string, number>;
  /** Visit count per tag string (for confidence calculation) */
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
    const key = v.tag;
    const age = now - v.timestamp;
    const decay = Math.pow(0.5, age / HALF_LIFE_MS);
    rawWeights[key] = (rawWeights[key] ?? 0) + decay;
    visitCounts[key] = (visitCounts[key] ?? 0) + 1;
  }

  // Normalize: max weight = 1.0
  const maxWeight = Math.max(...Object.values(rawWeights), 0.001);
  const weights: Record<string, number> = {};
  for (const [cat, w] of Object.entries(rawWeights)) {
    weights[cat] = Math.round((w / maxWeight) * 1000) / 1000; // 3 decimal places
  }

  return { weights, visitCounts };
}

/** Migrate a single visit entry: convert old TAG_LABELS display value to tag string */
function migrateVisit(v: TagVisit): TagVisit {
  // Already migrated — has `tag` field and it looks like a tag string (contains ":")
  if (v.tag && v.tag.includes(":")) return v;

  // Old format: `category` field contains TAG_LABELS display value (e.g., "Crypto & Web3")
  const oldValue = v.tag || (v as any).category;
  if (!oldValue) return v;

  // If it already looks like a tag string, keep it
  if (oldValue.includes(":")) return { tag: oldValue, timestamp: v.timestamp };

  // Convert display label → tag string
  const tagStr = tagStringFromLabel(oldValue);
  if (tagStr) return { tag: tagStr, timestamp: v.timestamp };

  // Unknown label — keep as-is (will be a no-op weight entry)
  return { tag: oldValue, timestamp: v.timestamp };
}

export const interestProfile = {
  /** Record tag string visits and recompute weights.
   *  Accepts multiple tag strings per call (topic + locale + platform).
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
          profile.visits.push({ tag, timestamp: now });
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

  /** Get the current interest profile (with migration from old format) */
  async getProfile(): Promise<UserInterestProfile> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const profile: UserInterestProfile = stored[STORAGE_KEY] ?? { visits: [], weights: {}, visitCounts: {} };

    // Migrate old visits that used TAG_LABELS display values or `category` field
    let migrated = false;
    for (let i = 0; i < profile.visits.length; i++) {
      const v = profile.visits[i];
      // Check for old `category` field (renamed to `tag`)
      if ((v as any).category && !v.tag) {
        profile.visits[i] = { tag: (v as any).category, timestamp: v.timestamp };
        delete (profile.visits[i] as any).category;
        migrated = true;
      }
      // Check if tag value is a display label instead of tag string
      if (v.tag && !v.tag.includes(":")) {
        const converted = migrateVisit(v);
        if (converted.tag !== v.tag) {
          profile.visits[i] = converted;
          migrated = true;
        }
      }
    }

    if (migrated) {
      // Recompute weights with migrated keys and persist
      const { weights, visitCounts } = computeWeights(profile.visits);
      profile.weights = weights;
      profile.visitCounts = visitCounts;
      await chrome.storage.local.set({ [STORAGE_KEY]: profile });
    }

    return profile;
  },

  /** Remove the most recent visit for each listed tag (negative interest signal).
   *  Called when the user clicks "Not interested" on an ad. */
  async removeRecentVisits(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    if (_profileLock) {
      // Treat as a no-op rather than queuing alongside positive updates
      return;
    }
    _profileLock = true;
    try {
      const profile = await this.getProfile();
      const tagSet = new Set(tags);
      const removed = new Set<string>();
      // Walk backwards — remove the single most recent visit per tag
      for (let i = profile.visits.length - 1; i >= 0 && removed.size < tagSet.size; i--) {
        const tag = profile.visits[i].tag;
        if (tagSet.has(tag) && !removed.has(tag)) {
          profile.visits.splice(i, 1);
          removed.add(tag);
        }
      }
      const { weights, visitCounts } = computeWeights(profile.visits);
      profile.weights = weights;
      profile.visitCounts = visitCounts;
      await chrome.storage.local.set({ [STORAGE_KEY]: profile });
    } finally {
      _profileLock = false;
    }
  },

  /** Reset the interest profile (user-initiated) */
  async resetProfile(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
  },

  /** Get normalized weight for a single tag string (0.0 if not visited) */
  getNormalizedWeight(profile: UserInterestProfile, tagString: string): number {
    return profile.weights[tagString] ?? 0;
  },
};
