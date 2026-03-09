// DATUM content script — runs on every page at document_idle.
// Classifies the page, checks for matching campaigns, runs auction,
// records impressions with engagement-weighted CPM, tracks engagement,
// and injects an ad slot.

import { classifyPage, CATEGORY_ID_MAP } from "./taxonomy";
import { injectAdSlot } from "./adSlot";
import { startTracking, computeQualityScore } from "./engagement";
import { validateMetadata, passesContentBlocklist, sanitizeCtaUrl } from "@shared/contentSafety";

// Dedup: track (campaignId, url) pairs seen this page load
const seenThisLoad = new Set<string>();

async function main() {
  const category = classifyPage(document.title, window.location.hostname);
  if (!category) return;

  // Update local interest profile with page category
  chrome.runtime.sendMessage({ type: "UPDATE_INTEREST", category });

  // Fetch active campaigns and configured publisher address in parallel
  const [response, settingsStored] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" }),
    chrome.storage.local.get("settings"),
  ]);

  // Background returns serialized campaigns (all values are strings)
  const campaigns: Array<Record<string, string>> = response?.campaigns ?? [];

  const publisherAddress: string = settingsStored.settings?.publisherAddress ?? "";
  const pageCategoryId = CATEGORY_ID_MAP[category] ?? 0;

  // Filter active campaigns; prefer category match, then publisher match, then any.
  const activeCampaigns = campaigns.filter((c) => Number(c.status) === 1 /* Active */);
  const categoryMatched = activeCampaigns.filter(
    (c) => Number(c.categoryId) === pageCategoryId || Number(c.categoryId) === 0
  );
  const pool = categoryMatched.length > 0 ? categoryMatched : activeCampaigns;

  if (pool.length === 0) return;

  // Use auction-based campaign selection via background (interest-aware + Vickrey)
  const selectionResponse = await chrome.runtime.sendMessage({
    type: "SELECT_CAMPAIGN",
    campaigns: pool,
    pageCategory: category,
  });
  let match = selectionResponse?.selected ?? null;
  const clearingCpmPlanck: string | undefined = selectionResponse?.clearingCpmPlanck;
  const auctionMechanism: string | undefined = selectionResponse?.mechanism;

  // Fallback: publisher preference or first in pool
  if (!match) {
    match = publisherAddress
      ? (pool.find(
          (c) => c.publisher.toLowerCase() === publisherAddress.toLowerCase()
        ) ?? pool[0])
      : pool[0];
  }
  if (!match) return;

  const campaignId = match.id ?? match.campaignId;
  const dedupeKey = `${campaignId}:${window.location.href}`;
  if (seenThisLoad.has(dedupeKey)) return;

  // Check 5-minute per-campaign dedup in storage
  const storageKey = `impression:${campaignId}:${window.location.hostname}`;
  const stored = await chrome.storage.local.get(storageKey);
  const lastSeen: number = stored[storageKey] ?? 0;
  const dedupMinutes = 5 * 60 * 1000;
  if (Date.now() - lastSeen < dedupMinutes) return;

  seenThisLoad.add(dedupeKey);
  await chrome.storage.local.set({ [storageKey]: Date.now() });

  // Load cached IPFS metadata for creative rendering
  const metaKey = `metadata:${campaignId}`;
  const metaStored = await chrome.storage.local.get(metaKey);

  // Defense-in-depth: re-validate metadata from storage before rendering
  let validatedMeta = null;
  const rawMeta = metaStored[metaKey] ?? null;
  if (rawMeta) {
    const result = validateMetadata(rawMeta);
    if (result.valid && result.data && passesContentBlocklist(result.data)) {
      validatedMeta = result.data;
    }
  }

  // Inject ad unit
  const adElement = injectAdSlot({
    campaignId,
    publisherAddress: match.publisher,
    category,
    metadata: validatedMeta,
    auctionMechanism: auctionMechanism as any,
    clearingCpmPlanck,
  });

  // Start engagement tracking
  if (adElement) {
    startTracking(campaignId, adElement);
  }

  // Notify background to build a claim (with auction clearing CPM)
  // Impression recorded immediately; engagement quality score will be
  // sent separately via ENGAGEMENT_QUALITY_RESULT to discount low-quality views.
  chrome.runtime.sendMessage({
    type: "IMPRESSION_RECORDED",
    campaignId,
    url: window.location.href,
    category,
    publisherAddress: match.publisher,
    clearingCpmPlanck,
  });
}

// Run on page load — wait for DOM to be ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
