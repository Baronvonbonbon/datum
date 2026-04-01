// User ad preferences — block campaigns, silence categories, rate limit, min CPM
import { UserPreferences } from "@shared/types";

const STORAGE_KEY = "userPreferences";

const DEFAULT_PREFERENCES: UserPreferences = {
  blockedCampaigns: [],
  silencedCategories: [],
  maxAdsPerHour: 12,
  maxAdsPerCampaignPerHour: 3,
  minBidCpm: "0",
};

export async function getPreferences(): Promise<UserPreferences> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_PREFERENCES, ...stored[STORAGE_KEY] };
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

export async function silenceCategory(name: string): Promise<void> {
  const prefs = await getPreferences();
  if (!prefs.silencedCategories.includes(name)) {
    prefs.silencedCategories.push(name);
    await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
  }
}

export async function unsilenceCategory(name: string): Promise<void> {
  const prefs = await getPreferences();
  prefs.silencedCategories = prefs.silencedCategories.filter((c) => c !== name);
  await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
}

/** Check if a campaign is allowed by user preferences */
export function isCampaignAllowed(
  campaign: { id?: string; categoryId?: number; bidCpmPlanck?: string },
  prefs: UserPreferences,
  categoryNames: Record<number, string>,
): boolean {
  // Blocked campaign ID
  if (campaign.id && prefs.blockedCampaigns.includes(campaign.id)) return false;

  // Silenced category
  if (campaign.categoryId !== undefined) {
    const catName = categoryNames[campaign.categoryId];
    if (catName && prefs.silencedCategories.includes(catName)) return false;
  }

  // Min bid CPM
  if (prefs.minBidCpm && prefs.minBidCpm !== "0" && campaign.bidCpmPlanck) {
    if (BigInt(campaign.bidCpmPlanck) < BigInt(prefs.minBidCpm)) return false;
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
export async function recordImpressionTime(campaignId?: string): Promise<void> {
  const key = "impressionTimestamps";
  const stored = await chrome.storage.local.get(key);
  const timestamps: number[] = stored[key] ?? [];
  const oneHourAgo = Date.now() - 3600_000;
  const recent = timestamps.filter((t) => t >= oneHourAgo);
  recent.push(Date.now());
  await chrome.storage.local.set({ [key]: recent });

  // UP-8: Per-campaign frequency tracking
  if (campaignId) {
    const cKey = `campaignImpressions:${campaignId}`;
    const cStored = await chrome.storage.local.get(cKey);
    const cTimestamps: number[] = cStored[cKey] ?? [];
    const cRecent = cTimestamps.filter((t) => t >= oneHourAgo);
    cRecent.push(Date.now());
    await chrome.storage.local.set({ [cKey]: cRecent });
  }
}

/** UP-8: Check per-campaign rate limit — returns true if within limit */
export async function checkCampaignRateLimit(campaignId: string, maxPerHour: number): Promise<boolean> {
  const key = `campaignImpressions:${campaignId}`;
  const stored = await chrome.storage.local.get(key);
  const timestamps: number[] = stored[key] ?? [];
  const oneHourAgo = Date.now() - 3600_000;
  const recent = timestamps.filter((t) => t >= oneHourAgo);
  return recent.length < maxPerHour;
}
