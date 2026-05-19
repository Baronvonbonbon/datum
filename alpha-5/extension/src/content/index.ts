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

  // Detect remote-action conversion tag early — conversion pages may have no matching
  // campaign ad to show, so this must run before any early-return from auction/pool logic.
  // Publisher places <meta name="datum-action" content="<campaignId>"> on thank-you pages.
  {
    const actionMeta = document.querySelector('meta[name="datum-action"]');
    if (actionMeta) {
      const actionCampaignId = actionMeta.getAttribute("content")?.trim();
      if (actionCampaignId && /^\d+$/.test(actionCampaignId)) {
        const actionCampaign = activeCampaigns.find((c: any) => c.id === actionCampaignId);
        const actionPublisher = (actionCampaign?.publisher && actionCampaign.publisher !== "0x0000000000000000000000000000000000000000")
          ? actionCampaign.publisher : publisherAddress;
        if (actionPublisher && actionPublisher !== "0x0000000000000000000000000000000000000000") {
          try {
            chrome.runtime.sendMessage({
              type: "REMOTE_ACTION",
              campaignId: actionCampaignId,
              publisherAddress: actionPublisher,
            });
          } catch {}
        }
      }
    }
  }

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
      for (const slot of (sdkInfo.slots.length > 0 ? sdkInfo.slots : [])) {
        injectDefaultAdInline(slot.el);
      }
      if (sdkInfo.slots.length > 0) return;
    }
    injectDefaultAd();
    return;
  }

  const ipfsGateway = settingsStored.settings?.ipfsGateway || "https://dweb.link/ipfs/";
  const currencySymbol = getCurrencySymbol((settingsStored.settings?.network ?? "polkadotHub") as NetworkName);

  // Push relay URL to background once (not per slot)
  if (sdkInfo?.relay && sdkInfo.publisher) {
    try {
      chrome.runtime.sendMessage({
        type: "SET_PUBLISHER_RELAY",
        publisher: sdkInfo.publisher,
        relay: sdkInfo.relay,
      });
    } catch {}
  }

  // Perform handshake with SDK once (not per slot) — shared attestation
  let attestation: Attestation | null = null;
  if (sdkInfo) {
    attestation = await performHandshake(sdkInfo.publisher);
  }

  /**
   * Select a campaign for one slot and inject it.
   * excludedIds: campaigns already assigned to earlier slots this page load.
   */
  async function fillSlot(
    slotFormat: string,
    slotEl: HTMLElement | null,
    excludedCampaignIds: string[],
  ): Promise<string | null> {
    let selectionResponse: any = null;
    try {
      selectionResponse = await chrome.runtime.sendMessage({
        type: "SELECT_CAMPAIGN",
        campaigns: pool,
        pageCategory: category ?? "",
        pageTags: tags,
        slotFormat,
        excludedCampaignIds,
      });
    } catch { return null; }

    const match = selectionResponse?.selected ?? null;
    const clearingCpmPlanck: string | undefined = selectionResponse?.clearingCpmPlanck;
    const auctionMechanism: string | undefined = selectionResponse?.mechanism;

    // Dispatch auction debug event (one per slot)
    try {
      window.dispatchEvent(new CustomEvent("datum-auction-debug", {
        detail: {
          timestamp: Date.now(),
          slotFormat,
          pageTags: tags,
          pageCategory: category,
          poolSize: pool.length,
          excludedCampaignIds,
          winnerId: match?.id ?? match?.campaignId ?? null,
          mechanism: auctionMechanism ?? (match ? "legacy" : "none"),
          clearingCpmPlanck: clearingCpmPlanck ?? null,
          participants: selectionResponse?.participants ?? 0,
          allBids: selectionResponse?.allBids ?? [],
          campaigns: pool.map((c: any) => ({
            id: c.id,
            viewBid: c.viewBid,
            requiredTags: c.requiredTags ?? [],
            publisher: c.publisher,
            status: c.status,
          })),
        },
      }));
    } catch { /* non-critical */ }

    if (!match) {
      if (slotEl) injectDefaultAdInline(slotEl);
      else injectDefaultAd();
      return null;
    }

    const campaignId = match.id ?? match.campaignId;
    const dedupeKey = `${campaignId}:${window.location.href}:${slotFormat}`;
    if (seenThisLoad.has(dedupeKey)) return null;

    // Check 5-minute per-campaign per-slot dedup in storage
    const storageKey = `impression:${campaignId}:${window.location.hostname}:${slotFormat}`;
    const stored = await chrome.storage.local.get(storageKey);
    const lastSeen: number = stored[storageKey] ?? 0;
    if (Date.now() - lastSeen < 5 * 60 * 1000) return null;

    seenThisLoad.add(dedupeKey);
    await chrome.storage.local.set({ [storageKey]: Date.now() });

    // Load + validate cached IPFS metadata
    const metaKey = `metadata:${campaignId}`;
    const metaStored = await chrome.storage.local.get(metaKey);
    let validatedMeta = null;
    const rawMeta = metaStored[metaKey] ?? null;
    console.log(`[DATUM] Campaign ${campaignId} slot=${slotFormat}: cached metadata=${!!rawMeta}`);
    if (rawMeta) {
      const result = validateMetadata(rawMeta);
      if (result.valid && result.data && passesContentBlocklist(result.data)) {
        if (result.data.creative.ctaUrl && await isUrlPhishing(result.data.creative.ctaUrl)) {
          console.warn(`[DATUM] Campaign ${campaignId} CTA URL flagged as phishing, rejecting`);
        } else {
          validatedMeta = result.data;
        }
      } else {
        console.warn(`[DATUM] Campaign ${campaignId}: cached metadata failed re-validation: ${result.error ?? "blocklist"}`);
      }
    }
    if (!validatedMeta && match.metadataHash) {
      try {
        const fetchResp = await chrome.runtime.sendMessage({
          type: "FETCH_IPFS_METADATA",
          campaignId,
          metadataHash: match.metadataHash,
        });
        if (fetchResp?.metadata) validatedMeta = fetchResp.metadata;
      } catch (err) {
        console.warn(`[DATUM] Campaign ${campaignId}: FETCH_IPFS_METADATA failed:`, err);
      }
    }

    const effectivePublisher = match.publisher === "0x0000000000000000000000000000000000000000"
      ? publisherAddress
      : match.publisher;

    const firstTopicTag = (() => {
      const reqTags: string[] = Array.isArray(match.requiredTags) ? match.requiredTags : [];
      for (const hash of reqTags) {
        const tagStr = tagStringFromHash(hash);
        if (!tagStr || !tagStr.startsWith("topic:")) continue;
        const label = TAG_LABELS[tagStr] ?? tagStr.replace("topic:", "");
        return { hash, label };
      }
      return null;
    })();

    // Record impression (per slot — each slot impression is independent)
    const campaignTags: string[] = Array.isArray(match.requiredTags) ? match.requiredTags : [];
    let impressionNonce: string | null = null;
    try {
      const impResp = await chrome.runtime.sendMessage({
        type: "IMPRESSION_RECORDED",
        campaignId,
        url: window.location.href,
        category: category ?? "",
        publisherAddress: effectivePublisher,
        clearingCpmPlanck,
        attestation: attestation ?? undefined,
        campaignTags,
      });
      impressionNonce = impResp?.impressionNonce ?? null;
    } catch {}

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
      topicLabel: firstTopicTag?.label,
      slotFormat,
      impressionNonce: impressionNonce ?? undefined,
      onCtaClick: impressionNonce ? () => {
        try {
          chrome.runtime.sendMessage({
            type: "AD_CLICK",
            campaignId: String(campaignId),
            publisherAddress: effectivePublisher,
            impressionNonce: impressionNonce!,
          });
        } catch {}
      } : undefined,
      onReport: () => {
        try { chrome.runtime.sendMessage({ type: "BLOCK_CAMPAIGN", campaignId: String(campaignId) }); } catch {}
      },
      onReportAd: (reason: number) => {
        try { chrome.runtime.sendMessage({ type: "REPORT_AD", campaignId: String(campaignId), reason }); } catch {}
      },
      onReportPage: (reason: number) => {
        try { chrome.runtime.sendMessage({ type: "REPORT_PAGE", campaignId: String(campaignId), reason }); } catch {}
      },
      onHideTopic: firstTopicTag ? () => {
        try { chrome.runtime.sendMessage({ type: "BLOCK_TAG", tag: firstTopicTag.hash }); } catch {}
      } : undefined,
      onNotInterested: () => {
        try {
          chrome.runtime.sendMessage({
            type: "UPDATE_INTEREST",
            tags: Array.isArray(match.requiredTags) ? match.requiredTags : [],
            delta: -1,
          });
        } catch {}
      },
    };

    let adElement: HTMLElement | null = null;
    if (slotEl) {
      adElement = injectAdSlotInline(slotEl, adConfig);
    }
    if (!adElement) {
      adElement = injectAdSlot(adConfig);
    }
    if (adElement) startTracking(campaignId, adElement);

    return String(campaignId);
  }

  // ── Multi-slot path (SDK with [data-datum-slot] elements) ─────────────────────
  if (sdkInfo?.slots && sdkInfo.slots.length > 0) {
    const assignedIds: string[] = [];
    for (const slot of sdkInfo.slots) {
      const winnerId = await fillSlot(slot.format, slot.el, assignedIds);
      if (winnerId) assignedIds.push(winnerId);
    }
    return;
  }

  // ── Single-slot / overlay path ────────────────────────────────────────────────
  await fillSlot(sdkInfo?.slotFormat ?? "medium-rectangle", null, []);
}

// Run on page load — wait for DOM to be ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
