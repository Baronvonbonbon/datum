// DATUM content script — runs on every page at document_idle.
// Classifies the page, checks for matching campaigns, runs auction,
// records impressions with engagement-weighted CPM, tracks engagement,
// and injects an ad slot.

import { classifyPage, CATEGORY_ID_MAP } from "./taxonomy";
import { injectAdSlot, injectAdSlotInline, injectDefaultAd, injectDefaultAdInline } from "./adSlot";
import { startTracking, computeQualityScore } from "./engagement";
import { validateMetadata, passesContentBlocklist, sanitizeCtaUrl } from "@shared/contentSafety";
import { isUrlPhishing } from "@shared/phishingList";
import { getCurrencySymbol } from "@shared/networks";
import { NetworkName } from "@shared/types";
import { detectSDK, SDKInfo } from "./sdkDetector";
import { performHandshake, Attestation } from "./handshake";
import { tagHash, TAG_LABELS } from "@shared/tagDictionary";

// Dedup: track (campaignId, url) pairs seen this page load
const seenThisLoad = new Set<string>();

/** Map taxonomy category slug → tag label for profile storage */
const CATEGORY_TO_TAG_LABEL: Record<string, string> = {
  "arts-entertainment": "Arts & Entertainment",
  "autos-vehicles": "Autos & Vehicles",
  "beauty-fitness": "Beauty & Fitness",
  "books-literature": "Books & Literature",
  "business-industrial": "Business & Industrial",
  "computers-electronics": "Computers & Electronics",
  "finance": "Finance",
  "food-drink": "Food & Drink",
  "games": "Games",
  "health": "Health",
  "hobbies-leisure": "Hobbies & Leisure",
  "home-garden": "Home & Garden",
  "internet-telecom": "Internet & Telecom",
  "jobs-education": "Jobs & Education",
  "law-government": "Law & Government",
  "news": "News",
  "online-communities": "Online Communities",
  "people-society": "People & Society",
  "pets-animals": "Pets & Animals",
  "real-estate": "Real Estate",
  "reference": "Reference",
  "science": "Science",
  "shopping": "Shopping",
  "sports": "Sports",
  "travel": "Travel",
  "crypto-web3": "Crypto & Web3",
};

/** Detect locale tag from page and browser.
 *  Returns TAG_LABELS value (e.g., "English (US)") or null. */
function detectLocaleTag(): string | null {
  // 1. <html lang="..."> attribute (page-level, most specific)
  const htmlLang = document.documentElement.lang?.trim().toLowerCase();
  // 2. navigator.language (browser-level fallback)
  const navLang = navigator.language?.trim().toLowerCase();

  const lang = htmlLang || navLang;
  if (!lang) return null;

  // Map to closest locale tag — check specific (en-US) before generic (en)
  const LOCALE_MAP: Record<string, string> = {
    "en-us": "English (US)",
    "en-gb": "English (UK)",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "pt": "Portuguese",
    "ru": "Russian",
    "en": "English",
  };

  // Try exact match first (e.g., "en-us")
  const exact = LOCALE_MAP[lang];
  if (exact) return exact;

  // Try base language (e.g., "en-us" → "en")
  const base = lang.split("-")[0];
  return LOCALE_MAP[base] ?? null;
}

/** Detect platform tag from user agent.
 *  Returns TAG_LABELS value ("Desktop", "Mobile", "Tablet"). */
function detectPlatformTag(): string {
  const ua = navigator.userAgent;
  // Tablet detection: iPad or Android tablet (no "Mobile" token)
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "Tablet";
  // Mobile: iPhone, Android+Mobile, various mobile browsers
  if (/Mobi|Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return "Mobile";
  return "Desktop";
}

async function main() {
  const category = classifyPage(document.title, window.location.hostname);
  if (!category) return;

  // Build tag labels for this page visit: topic + locale + platform
  const tags: string[] = [];
  const topicLabel = CATEGORY_TO_TAG_LABEL[category];
  if (topicLabel) tags.push(topicLabel);
  const localeLabel = detectLocaleTag();
  if (localeLabel) tags.push(localeLabel);
  const platformLabel = detectPlatformTag();
  tags.push(platformLabel);

  // Update local interest profile with page tags
  try { chrome.runtime.sendMessage({ type: "UPDATE_INTEREST", tags, category }); } catch {}

  // Detect Publisher SDK (2s timeout) + fetch campaigns in parallel
  let sdkInfo: SDKInfo | null = null;
  let response: any = null;
  let settingsStored: Record<string, any> = {};
  try {
    [sdkInfo, response, settingsStored] = await Promise.all([
      detectSDK(),
      chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" }),
      chrome.storage.local.get("settings"),
    ]);
  } catch { return; } // background inactive — skip this page

  // Background returns serialized campaigns (all values are strings)
  const campaigns: Array<Record<string, string>> = response?.campaigns ?? [];

  const publisherAddress: string = sdkInfo?.publisher ?? settingsStored.settings?.publisherAddress ?? "";
  const pageCategoryId = CATEGORY_ID_MAP[category] ?? 0;

  // Filter active campaigns
  const activeCampaigns = campaigns.filter((c) => Number(c.status) === 1 /* Active */);

  let pool: Array<Record<string, string>>;

  if (sdkInfo) {
    // TX-3: SDK present — filter by tag overlap or legacy category overlap
    const sdkTagHashes = sdkInfo.tags.length > 0
      ? new Set(sdkInfo.tags.map((t) => tagHash(t).toLowerCase()))
      : null;
    const sdkCatSet = new Set(sdkInfo.categories);

    pool = activeCampaigns.filter((c) => {
      // Open campaigns (publisher=0x0...) or campaigns matching this SDK publisher
      const publisherMatch = c.publisher === "0x0000000000000000000000000000000000000000" ||
        c.publisher.toLowerCase() === publisherAddress.toLowerCase();
      if (!publisherMatch) return false;

      // TX-3: Tag-based matching (if campaign has requiredTags)
      const campaignTags: string[] = Array.isArray(c.requiredTags) ? c.requiredTags : [];
      if (campaignTags.length > 0 && sdkTagHashes) {
        // Campaign requires ALL tags — check publisher SDK declares them all
        return campaignTags.every((t) => sdkTagHashes.has(t.toLowerCase()));
      }

      // Legacy fallback: category-based matching
      const cCat = Number(c.categoryId);
      return cCat === 0 || sdkCatSet.has(cCat);
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
  let selectionResponse: any = null;
  try {
    selectionResponse = await chrome.runtime.sendMessage({
      type: "SELECT_CAMPAIGN",
      campaigns: pool,
      pageCategory: category,
    });
  } catch { return; } // background inactive
  let match = selectionResponse?.selected ?? null;
  const clearingCpmPlanck: string | undefined = selectionResponse?.clearingCpmPlanck;
  const auctionMechanism: string | undefined = selectionResponse?.mechanism;

  // If background returned null (all campaigns blocked/filtered), show house ad
  if (!match) {
    if (sdkInfo?.hasAdSlot) {
      const target = document.getElementById("datum-ad-slot");
      if (target) { injectDefaultAdInline(target); return; }
    }
    injectDefaultAd();
    return;
  }

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

  // If SDK declares a relay URL, push it to background for publisher domain mapping
  if (sdkInfo?.relay && sdkInfo.publisher) {
    try {
      chrome.runtime.sendMessage({
        type: "SET_PUBLISHER_RELAY",
        publisher: sdkInfo.publisher,
        relay: sdkInfo.relay,
      });
    } catch {}
  }

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
  console.log(`[DATUM] Campaign ${campaignId}: cached metadata=${!!rawMeta}, metadataHash=${match.metadataHash ?? "none"}`);
  if (rawMeta) {
    const result = validateMetadata(rawMeta);
    if (result.valid && result.data && passesContentBlocklist(result.data)) {
      // Defense-in-depth: check CTA URL against phishing deny list
      if (result.data.creative.ctaUrl && await isUrlPhishing(result.data.creative.ctaUrl)) {
        console.warn(`[DATUM] Campaign ${campaignId} CTA URL flagged as phishing, rejecting`);
      } else {
        validatedMeta = result.data;
      }
    } else {
      console.warn(`[DATUM] Campaign ${campaignId}: cached metadata failed re-validation: ${result.error ?? "blocklist"}`);
    }
  }

  // If no cached metadata but hash available, fetch via background (no CSP restrictions)
  if (!validatedMeta && match.metadataHash) {
    console.log(`[DATUM] Campaign ${campaignId}: requesting IPFS fetch from background...`);
    try {
      const fetchResp = await chrome.runtime.sendMessage({
        type: "FETCH_IPFS_METADATA",
        campaignId,
        metadataHash: match.metadataHash,
      });
      console.log(`[DATUM] Campaign ${campaignId}: FETCH_IPFS_METADATA response:`, fetchResp?.metadata ? "got metadata" : "null");
      if (fetchResp?.metadata) {
        validatedMeta = fetchResp.metadata;
      }
    } catch (err) {
      console.warn(`[DATUM] Campaign ${campaignId}: FETCH_IPFS_METADATA failed:`, err);
    }
  }

  // Resolve effective publisher: for open campaigns, use SDK publisher or settings publisher
  const effectivePublisher = match.publisher === "0x0000000000000000000000000000000000000000"
    ? publisherAddress
    : match.publisher;

  const ipfsGateway = settingsStored.settings?.ipfsGateway || "https://dweb.link/ipfs/";

  const currencySymbol = getCurrencySymbol((settingsStored.settings?.network ?? "polkadotHub") as NetworkName);

  const adConfig = {
    campaignId,
    publisherAddress: effectivePublisher,
    category,
    metadata: validatedMeta,
    metadataHash: match.metadataHash || undefined,
    auctionMechanism: auctionMechanism as any,
    clearingCpmPlanck,
    ipfsGateway,
    currencySymbol,
    onReport: () => {
      try {
        chrome.runtime.sendMessage({ type: "BLOCK_CAMPAIGN", campaignId: String(campaignId) });
      } catch {}
    },
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
  // Include campaign tags so background can record ad-exposure in interest profile
  const campaignTags: string[] = Array.isArray(match.requiredTags) ? match.requiredTags : [];
  try {
    chrome.runtime.sendMessage({
      type: "IMPRESSION_RECORDED",
      campaignId,
      url: window.location.href,
      category,
      publisherAddress: effectivePublisher,
      clearingCpmPlanck,
      attestation: attestation ?? undefined,
      campaignTags,
    });
  } catch {}
}

// Run on page load — wait for DOM to be ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
