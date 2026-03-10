// DATUM content script — runs on every page at document_idle.
// Classifies the page, checks for matching campaigns, runs auction,
// records impressions with engagement-weighted CPM, tracks engagement,
// and injects an ad slot.

import { classifyPage, CATEGORY_ID_MAP } from "./taxonomy";
import { injectAdSlot, injectAdSlotInline, injectDefaultAd, injectDefaultAdInline } from "./adSlot";
import { startTracking, computeQualityScore } from "./engagement";
import { validateMetadata, passesContentBlocklist, sanitizeCtaUrl } from "@shared/contentSafety";
import { detectSDK, SDKInfo } from "./sdkDetector";
import { performHandshake, Attestation } from "./handshake";

// Dedup: track (campaignId, url) pairs seen this page load
const seenThisLoad = new Set<string>();

async function main() {
  const category = classifyPage(document.title, window.location.hostname);
  if (!category) return;

  // Update local interest profile with page category
  chrome.runtime.sendMessage({ type: "UPDATE_INTEREST", category });

  // Detect Publisher SDK (2s timeout) + fetch campaigns in parallel
  const [sdkInfo, response, settingsStored] = await Promise.all([
    detectSDK(),
    chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" }),
    chrome.storage.local.get("settings"),
  ]);

  // Background returns serialized campaigns (all values are strings)
  const campaigns: Array<Record<string, string>> = response?.campaigns ?? [];

  const publisherAddress: string = sdkInfo?.publisher ?? settingsStored.settings?.publisherAddress ?? "";
  const pageCategoryId = CATEGORY_ID_MAP[category] ?? 0;

  // Filter active campaigns
  const activeCampaigns = campaigns.filter((c) => Number(c.status) === 1 /* Active */);

  let pool: Array<Record<string, string>>;

  if (sdkInfo) {
    // SDK present: filter by category bitmask overlap (campaign category ∩ publisher categories)
    const sdkCatSet = new Set(sdkInfo.categories);
    pool = activeCampaigns.filter((c) => {
      const cCat = Number(c.categoryId);
      // Open campaigns (publisher=0x0...) or campaigns matching this SDK publisher
      const publisherMatch = c.publisher === "0x0000000000000000000000000000000000000000" ||
        c.publisher.toLowerCase() === publisherAddress.toLowerCase();
      // Category match: campaign uncategorized (0) or in SDK's declared categories
      const catMatch = cCat === 0 || sdkCatSet.has(cCat);
      return publisherMatch && catMatch;
    });

    // Fallback: if no SDK-matched campaigns, try all category-matched
    if (pool.length === 0) {
      pool = activeCampaigns.filter(
        (c) => Number(c.categoryId) === pageCategoryId || Number(c.categoryId) === 0
      );
    }
  } else {
    // No SDK: original behavior — category match, then any
    const categoryMatched = activeCampaigns.filter(
      (c) => Number(c.categoryId) === pageCategoryId || Number(c.categoryId) === 0
    );
    pool = categoryMatched.length > 0 ? categoryMatched : activeCampaigns;
  }

  if (pool.length === 0) {
    // No matching campaigns — show default house ad (Polkadot philosophy)
    if (sdkInfo?.hasAdSlot) {
      const target = document.getElementById("datum-ad-slot");
      if (target) {
        injectDefaultAdInline(target);
        return;
      }
    }
    injectDefaultAd();
    return;
  }

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

  // Perform handshake with SDK if present
  let attestation: Attestation | null = null;
  if (sdkInfo) {
    attestation = await performHandshake(sdkInfo.publisher);
  }

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

  // Resolve effective publisher: for open campaigns, use SDK publisher or settings publisher
  const effectivePublisher = match.publisher === "0x0000000000000000000000000000000000000000"
    ? publisherAddress
    : match.publisher;

  const adConfig = {
    campaignId,
    publisherAddress: effectivePublisher,
    category,
    metadata: validatedMeta,
    auctionMechanism: auctionMechanism as any,
    clearingCpmPlanck,
  };

  // Inject ad: inline into SDK slot if available, overlay otherwise
  let adElement: HTMLElement | null = null;
  if (sdkInfo?.hasAdSlot) {
    const target = document.getElementById("datum-ad-slot");
    if (target) {
      adElement = injectAdSlotInline(target, adConfig);
    }
  }
  if (!adElement) {
    adElement = injectAdSlot(adConfig);
  }

  // Start engagement tracking
  if (adElement) {
    startTracking(campaignId, adElement);
  }

  // Notify background to build a claim (with auction clearing CPM + attestation)
  chrome.runtime.sendMessage({
    type: "IMPRESSION_RECORDED",
    campaignId,
    url: window.location.href,
    category,
    publisherAddress: effectivePublisher,
    clearingCpmPlanck,
    attestation: attestation ?? undefined,
  });
}

// Run on page load — wait for DOM to be ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
