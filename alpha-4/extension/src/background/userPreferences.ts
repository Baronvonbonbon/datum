// User ad preferences — block campaigns, block tags, rate limit, min CPM
import { UserPreferences } from "@shared/types";
import { tagStringFromLabel, tagStringFromHash } from "@shared/tagDictionary";

const STORAGE_KEY = "userPreferences";

const DEFAULT_PREFERENCES: UserPreferences = {
  blockedCampaigns: [],
  silencedCategories: [],
  blockedTags: [],
  maxAdsPerHour: 12,
  minBidCpm: "0",
  filterMode: "all",
  allowedTopics: [],
  sweepAddress: "",
  sweepThresholdPlanck: "0",
  contextualMode: false,
};

export async function getPreferences(): Promise<UserPreferences> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const prefs: UserPreferences = { ...DEFAULT_PREFERENCES, ...stored[STORAGE_KEY] };

  // Migration: convert silencedCategories (display labels) → blockedTags (tag strings)
  if (prefs.silencedCategories && prefs.silencedCategories.length > 0) {
    if (!prefs.blockedTags) prefs.blockedTags = [];
    for (const catName of prefs.silencedCategories) {
      const tagStr = tagStringFromLabel(catName);
      if (tagStr && !prefs.blockedTags.includes(tagStr)) {
        prefs.blockedTags.push(tagStr);
      }
    }
    prefs.silencedCategories = [];
    await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
  }

  // Ensure blockedTags exists (for old stored prefs without it)
  if (!prefs.blockedTags) prefs.blockedTags = [];

  return prefs;
}

export async function updatePreferences(partial: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getPreferences();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return updated;
}

export async function blockCampaign(id: string): Promise<void> {
  const prefs = await getPreferences();
  if (!prefs.blockedCampaigns.includes(id)) {
    prefs.blockedCampaigns.push(id);
    await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
  }
}

export async function unblockCampaign(id: string): Promise<void> {
  const prefs = await getPreferences();
  prefs.blockedCampaigns = prefs.blockedCampaigns.filter((c) => c !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
}

export async function blockTag(tag: string): Promise<void> {
  const prefs = await getPreferences();
  if (!prefs.blockedTags.includes(tag)) {
    prefs.blockedTags.push(tag);
    await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
  }
}

export async function unblockTag(tag: string): Promise<void> {
  const prefs = await getPreferences();
  prefs.blockedTags = prefs.blockedTags.filter((t) => t !== tag);
  await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
}

/** Check if a campaign is allowed by user preferences */
export function isCampaignAllowed(
  campaign: { id?: string; categoryId?: number; viewBid?: string; requiredTags?: string[] },
  prefs: UserPreferences,
): boolean {
  // Blocked campaign ID
  if (campaign.id && prefs.blockedCampaigns.includes(campaign.id)) return false;

  // Blocked tags: check if any campaign requiredTag (resolved to tag string) is blocked
  if (prefs.blockedTags && prefs.blockedTags.length > 0 && campaign.requiredTags) {
    for (const hash of campaign.requiredTags) {
      const tagStr = tagStringFromHash(hash);
      if (tagStr && prefs.blockedTags.includes(tagStr)) return false;
    }
  }

  // Selected topics mode: campaign must have at least one allowed topic tag.
  // Open campaigns (no requiredTags) always pass through.
  if (prefs.filterMode === "selected" && prefs.allowedTopics && prefs.allowedTopics.length > 0) {
    if (campaign.requiredTags && campaign.requiredTags.length > 0) {
      const hasAllowedTopic = campaign.requiredTags.some(hash => {
        const tagStr = tagStringFromHash(hash);
        return tagStr && tagStr.startsWith("topic:") && prefs.allowedTopics.includes(tagStr);
      });
      if (!hasAllowedTopic) return false;
    }
  }

  // Min bid CPM
  if (prefs.minBidCpm && prefs.minBidCpm !== "0" && campaign.viewBid) {
    if (BigInt(campaign.viewBid) < BigInt(prefs.minBidCpm)) return false;
  }

  return true;
}

/** Check rate limit — returns true if within limit */
export async function checkRateLimit(maxAdsPerHour: number): Promise<boolean> {
  const key = "impressionTimestamps";
  const stored = await chrome.storage.local.get(key);
  const timestamps: number[] = stored[key] ?? [];
  const oneHourAgo = Date.now() - 3600_000;
  const recent = timestamps.filter((t) => t >= oneHourAgo);
  return recent.length < maxAdsPerHour;
}

/** Record an impression timestamp for rate limiting */
export async function recordImpressionTime(): Promise<void> {
  const key = "impressionTimestamps";
  const stored = await chrome.storage.local.get(key);
  const timestamps: number[] = stored[key] ?? [];
  const oneHourAgo = Date.now() - 3600_000;
  const recent = timestamps.filter((t) => t >= oneHourAgo);
  recent.push(Date.now());
  await chrome.storage.local.set({ [key]: recent });
}
