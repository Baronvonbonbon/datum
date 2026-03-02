// DATUM content script — runs on every page at document_idle.
// Classifies the page, checks for matching campaigns, records impressions,
// and injects an ad slot when appropriate.

import { classifyPage, CATEGORY_ID_MAP } from "./taxonomy";
import { injectAdSlot } from "./adSlot";

// Dedup: track (campaignId, url) pairs seen this page load
const seenThisLoad = new Set<string>();

async function main() {
  const category = classifyPage(document.title, window.location.hostname);
  if (!category) return;

  // Fetch active campaigns and configured publisher address in parallel
  const [response, settingsStored] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" }),
    chrome.storage.local.get("settings"),
  ]);

  const campaigns: Array<{
    id: string;
    publisher: string;
    status: number;
    bidCpmPlanck: string;
    categoryId: number;
  }> = response?.campaigns ?? [];

  const publisherAddress: string = settingsStored.settings?.publisherAddress ?? "";
  const pageCategoryId = CATEGORY_ID_MAP[category] ?? 0;

  // Filter active campaigns; prefer category match, then publisher match, then any.
  const activeCampaigns = campaigns.filter((c) => c.status === 1 /* Active */);
  const categoryMatched = activeCampaigns.filter(
    (c) => c.categoryId === pageCategoryId || c.categoryId === 0
  );
  const pool = categoryMatched.length > 0 ? categoryMatched : activeCampaigns;
  const match = publisherAddress
    ? (pool.find(
        (c) => c.publisher.toLowerCase() === publisherAddress.toLowerCase()
      ) ?? pool[0])
    : pool[0];
  if (!match) return;

  const dedupeKey = `${match.id}:${window.location.href}`;
  if (seenThisLoad.has(dedupeKey)) return;

  // Check 30-minute per-campaign dedup in storage
  const storageKey = `impression:${match.id}`;
  const stored = await chrome.storage.local.get(storageKey);
  const lastSeen: number = stored[storageKey] ?? 0;
  const thirtyMinutes = 30 * 60 * 1000;
  if (Date.now() - lastSeen < thirtyMinutes) return;

  seenThisLoad.add(dedupeKey);
  await chrome.storage.local.set({ [storageKey]: Date.now() });

  // Load cached IPFS metadata for creative rendering
  const metaKey = `metadata:${match.id}`;
  const metaStored = await chrome.storage.local.get(metaKey);

  // Inject ad unit
  injectAdSlot({
    campaignId: match.id,
    publisherAddress: match.publisher,
    category,
    metadata: metaStored[metaKey] ?? null,
  });

  // Notify background to build a claim
  chrome.runtime.sendMessage({
    type: "IMPRESSION_RECORDED",
    campaignId: match.id,
    url: window.location.href,
    category,
    publisherAddress: match.publisher,
  });
}

// Run on page load — wait for DOM to be ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
