// DATUM content script — runs on every page at document_idle.
// Classifies the page, checks for matching campaigns, runs auction,
// records impressions with engagement-weighted CPM, tracks engagement,
// and injects an ad slot.

import { classifyPageToTags, classifyPage } from "./taxonomy";
import { injectAdSlot, injectAdSlotInline, injectDefaultAd, injectDefaultAdInline } from "./adSlot";
import { startTracking, computeQualityScore } from "./engagement";
import { validateMetadata, passesContentBlocklist, sanitizeCtaUrl } from "@shared/contentSafety";
import { isUrlPhishing } from "@shared/phishingList";
import { getCurrencySymbol } from "@shared/networks";
import { NetworkName } from "@shared/types";
import { detectSDK, SDKInfo } from "./sdkDetector";
import { performHandshake, Attestation } from "./handshake";
import { tagHash, tagStringFromLocale, tagStringFromPlatform, tagStringFromSlug, tagStringFromHash, TAG_LABELS } from "@shared/tagDictionary";

// Dedup: track (campaignId, url) pairs seen this page load
const seenThisLoad = new Set<string>();

/** Detect locale tag from page and browser.
 *  Returns tag string (e.g., "locale:en-US") or null. */
function detectLocaleTag(): string | null {
  // 1. <html lang="..."> attribute (page-level, most specific)
  const htmlLang = document.documentElement.lang?.trim().toLowerCase();
  // 2. navigator.language (browser-level fallback)
  const navLang = navigator.language?.trim().toLowerCase();

  const lang = htmlLang || navLang;
  if (!lang) return null;

  return tagStringFromLocale(lang);
}

/** Detect platform tag from user agent.
 *  Returns tag string (e.g., "platform:desktop"). */
function detectPlatformTag(): string {
  return tagStringFromPlatform(navigator.userAgent);
}

async function main() {
  // Multi-category classification → tag strings
  let metaDescription: string | undefined;
  let metaKeywords: string | undefined;
  if (typeof document !== "undefined") {
    metaDescription =
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;
    metaKeywords =
      document.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? undefined;
  }

  const pageTags = classifyPageToTags(
    document.title, window.location.hostname, metaDescription, metaKeywords
  );
  // Also get single-category slug for backward compat (SELECT_CAMPAIGN pageCategory)
  const category = classifyPage(document.title, window.location.hostname);
  if (pageTags.length === 0 && !category) return;

  // Build tag strings for this page visit: topics + locale + platform
  const tags: string[] = [...pageTags];
  const localeTag = detectLocaleTag();
  if (localeTag) tags.push(localeTag);
  const platformTag = detectPlatformTag();
  tags.push(platformTag);

  // Update local interest profile with page tag strings
  try { chrome.runtime.sendMessage({ type: "UPDATE_INTEREST", tags }); } catch {}

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

  // Filter active campaigns
  const activeCampaigns = campaigns.filter((c) => Number(c.status) === 1 /* Active */);

  // Build page tag hash set for matching
  const pageTagHashes = new Set(tags.map((t) => tagHash(t).toLowerCase()));

  // If SDK present with data-tags, merge SDK tag hashes into page set.
  // SDK tags are short slugs (e.g. "crypto-web3", "en", "desktop") — resolve
  // to full "dimension:value" strings before hashing so they match on-chain tags.
  if (sdkInfo && sdkInfo.tags.length > 0) {
    for (const t of sdkInfo.tags) {
      let resolved: string;
      if (t.includes(":")) {
        resolved = t; // already "dimension:value" format
      } else {
        resolved = tagStringFromSlug(t) ?? tagStringFromLocale(t) ?? t;
      }
      pageTagHashes.add(tagHash(resolved).toLowerCase());
    }
  }

  // SDK excluded tags (publisher-side blacklist)
  const excludedTagHashes = new Set<string>();
  if (sdkInfo?.excludedTags && sdkInfo.excludedTags.length > 0) {
    for (const t of sdkInfo.excludedTags) {
      excludedTagHashes.add(tagHash(t).toLowerCase());
    }
  }

  // Defense-in-depth: if this publisher has allowlist enabled, open campaigns must not show.
  // Contract enforces this at settlement; we also filter client-side to avoid showing the ad.
  let publisherAllowlistEnabled = false;
  if (publisherAddress) {
    try {
      const alResp = await chrome.runtime.sendMessage({
        type: "CHECK_PUBLISHER_ALLOWLIST",
        publisher: publisherAddress,
      });
      publisherAllowlistEnabled = alResp?.allowlistEnabled ?? false;
    } catch { /* background inactive — conservative: allow */ }
  }

  let pool: Array<Record<string, string>>;

  // Tag-first campaign matching
  pool = activeCampaigns.filter((c) => {
    // Publisher match: open campaigns (publisher=0x0...) or matching this publisher
    const publisherMatch = c.publisher === "0x0000000000000000000000000000000000000000" ||
      c.publisher.toLowerCase() === publisherAddress.toLowerCase();
    if (!publisherMatch) return false;

    // Open campaigns cannot be served by publishers with allowlist enabled
    if (c.publisher === "0x0000000000000000000000000000000000000000" && publisherAllowlistEnabled) return false;

    // Campaign requiredTags (already synthesized from categoryId by poller for backward compat)
    const campaignTags: string[] = Array.isArray(c.requiredTags) ? c.requiredTags : [];

    // Check excluded tags: if any campaign tag is in publisher's excluded set, skip
    if (excludedTagHashes.size > 0 && campaignTags.length > 0) {
      if (campaignTags.some((t) => excludedTagHashes.has(t.toLowerCase()))) return false;
    }

    if (campaignTags.length > 0) {
      // Campaign requires ALL tags (AND logic, matching on-chain)
      return campaignTags.every((t) => pageTagHashes.has(t.toLowerCase()));
    }

    // No requiredTags: open match (any page)
    return true;
  });

  // If no matching campaigns, fall back to all active campaigns (broad match)
  if (pool.length === 0) {
    pool = activeCampaigns.filter((c) => {
      if (c.publisher === "0x0000000000000000000000000000000000000000") {
        if (publisherAllowlistEnabled) return false;
        return true;
      }
      return c.publisher.toLowerCase() === publisherAddress.toLowerCase();
    });
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
      pageCategory: category ?? "",
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
    category: category ?? "",
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

    // Append dismiss controls (✕ button + 3-option popover)
    adElement.style.position = "relative";
    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "✕";
    dismissBtn.title = "Ad options";
    Object.assign(dismissBtn.style, {
      position: "absolute", top: "4px", right: "4px", zIndex: "9999",
      background: "rgba(0,0,0,0.45)", color: "#fff", border: "none",
      borderRadius: "3px", width: "18px", height: "18px", fontSize: "10px",
      cursor: "pointer", lineHeight: "1", padding: "0", fontFamily: "inherit",
      opacity: "0.7",
    });

    const popover = document.createElement("div");
    Object.assign(popover.style, {
      display: "none", position: "absolute", top: "24px", right: "4px", zIndex: "10000",
      background: "#1a1a1a", border: "1px solid #444", borderRadius: "4px",
      padding: "4px 0", minWidth: "160px", boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
      fontFamily: "system-ui, sans-serif",
    });

    const firstTopicTag = (() => {
      const tags: string[] = Array.isArray(match.requiredTags) ? match.requiredTags : [];
      for (const hash of tags) {
        const tagStr = tagStringFromHash(hash);
        if (!tagStr || !tagStr.startsWith("topic:")) continue;
        const label = TAG_LABELS[tagStr] ?? tagStr.replace("topic:", "");
        return { hash, label };
      }
      return null;
    })();

    function addOption(text: string, onClick: () => void) {
      const btn = document.createElement("button");
      btn.textContent = text;
      Object.assign(btn.style, {
        display: "block", width: "100%", background: "none", border: "none",
        color: "#ddd", fontSize: "11px", padding: "5px 10px", cursor: "pointer",
        textAlign: "left", fontFamily: "inherit",
      });
      btn.addEventListener("mouseenter", () => { btn.style.background = "#333"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "none"; });
      btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      popover.appendChild(btn);
    }

    addOption("Hide this ad", () => {
      try { chrome.runtime.sendMessage({ type: "BLOCK_CAMPAIGN", campaignId }); } catch { /* */ }
      adElement!.style.display = "none";
    });

    if (firstTopicTag) {
      addOption(`Hide topic ads`, () => {
        try { chrome.runtime.sendMessage({ type: "BLOCK_TAG", tag: firstTopicTag.hash }); } catch { /* */ }
        adElement!.style.display = "none";
      });
    }

    addOption("Not interested", () => {
      try {
        chrome.runtime.sendMessage({
          type: "UPDATE_INTEREST",
          tags: Array.isArray(match.requiredTags) ? match.requiredTags : [],
          delta: -1,
        });
      } catch { /* */ }
      popover.style.display = "none";
    });

    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      popover.style.display = popover.style.display === "none" ? "block" : "none";
    });

    document.addEventListener("click", () => { popover.style.display = "none"; }, { once: false });

    adElement.appendChild(dismissBtn);
    adElement.appendChild(popover);
  }

  // Notify background to build a claim (with auction clearing CPM + attestation)
  // Include campaign tags so background can record ad-exposure in interest profile
  const campaignTags: string[] = Array.isArray(match.requiredTags) ? match.requiredTags : [];
  try {
    chrome.runtime.sendMessage({
      type: "IMPRESSION_RECORDED",
      campaignId,
      url: window.location.href,
      category: category ?? "",
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
