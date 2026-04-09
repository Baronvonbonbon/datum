/**
 * contentBridge.ts — In-page replica of the DATUM content script.
 *
 * Replicates content/index.ts main() flow but:
 *  - Sources all content modules directly via @ext alias (no duplication)
 *  - Skips the 5-minute per-campaign dedup (demo runs it on demand)
 *  - Skips engagement tracking (startTracking)
 *  - Accepts an optional publisherOverride so the demo UI can inject any address
 *  - Returns a status object so the UI can show what happened
 */

// @ts-ignore — @ext resolves via Vite alias to alpha-3/extension/src
import { classifyPageToTags, classifyPage } from "@ext/content/taxonomy";
// @ts-ignore
import { detectSDK } from "@ext/content/sdkDetector";
// @ts-ignore
import { performHandshake } from "@ext/content/handshake";
// @ts-ignore
import { injectAdSlotInline, injectDefaultAdInline } from "@ext/content/adSlot";
// @ts-ignore — use @ext/shared so the resolver finds extension/src/shared/
import { tagHash, tagStringFromLocale, tagStringFromPlatform } from "@ext/shared/tagDictionary";
// @ts-ignore
import { validateMetadata, passesContentBlocklist } from "@ext/shared/contentSafety";
// @ts-ignore
import { isUrlPhishing } from "@ext/shared/phishingList";
// @ts-ignore
import { getCurrencySymbol } from "@ext/shared/networks";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

export interface BridgeStatus {
  step: "idle" | "detecting" | "matching" | "auction" | "handshake" | "injected" | "house-ad" | "no-match" | "error";
  campaignId?: string;
  mechanism?: string;
  clearingCpmPlanck?: string;
  participants?: number;
  totalCampaigns?: number;
  activeCampaigns?: number;
  matchedPool?: number;
  error?: string;
}

let _lastAdElement: HTMLElement | null = null;

/** Remove any previously injected in-page ad so the slot is clean before each run. */
function clearPreviousAd() {
  if (_lastAdElement) {
    _lastAdElement.remove();
    _lastAdElement = null;
  }
  // Clear the shadow DOM wrapper — adSlot uses closed shadow mode so innerHTML is ignored.
  // The shadow ref is stored on __datumShadow by injectAdSlotInline / injectDefaultAdInline.
  const slot = document.getElementById("datum-ad-slot");
  if (slot) {
    const shadow = (slot as any).__datumShadow;
    if (shadow) {
      shadow.querySelector(".datum-inline-wrapper")?.remove();
    }
  }
}

/**
 * Run the full SDK-detection → campaign-selection → ad-injection flow in-page.
 *
 * @param publisherOverride  Optional publisher address that overrides what the SDK script tag declares.
 * @param onStatus           Callback fired as the bridge moves through each step.
 */
export async function runContentBridge(
  publisherOverride?: string,
  onStatus?: (s: BridgeStatus) => void,
): Promise<BridgeStatus> {
  const report = (s: BridgeStatus) => { onStatus?.(s); return s; };

  clearPreviousAd();
  report({ step: "detecting" });

  // Classify this page
  const metaDescription =
    document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;
  const metaKeywords =
    document.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? undefined;

  const pageTags: string[] = classifyPageToTags(
    document.title, window.location.hostname, metaDescription, metaKeywords
  );
  const category: string = classifyPage(document.title, window.location.hostname) ?? "";

  // Locale + platform tags
  const htmlLang = document.documentElement.lang?.trim().toLowerCase();
  const navLang = navigator.language?.trim().toLowerCase();
  const lang = htmlLang || navLang;
  const localeTag: string | null = lang ? tagStringFromLocale(lang) : null;
  const platformTag: string = tagStringFromPlatform(navigator.userAgent);

  const tags: string[] = [...pageTags];
  if (localeTag) tags.push(localeTag);
  tags.push(platformTag);

  // Fire UPDATE_INTEREST (best-effort)
  try { chrome.runtime.sendMessage({ type: "UPDATE_INTEREST", tags }); } catch { /* */ }

  // Detect SDK + fetch campaigns + settings in parallel
  let sdkInfo: any = null;
  let campaignsResp: any = null;
  let settingsStored: any = {};
  try {
    [sdkInfo, campaignsResp, settingsStored] = await Promise.all([
      detectSDK(),
      chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" }),
      chrome.storage.local.get("settings"),
    ]);
  } catch (err) {
    return report({ step: "error", error: String(err) });
  }

  report({ step: "matching" });

  console.log("[bridge] SDK detected:", sdkInfo ? `publisher=${sdkInfo.publisher}, tags=${sdkInfo.tags?.join(",")}` : "null");

  // Publisher address: override > SDK tag > settings
  const publisherAddress: string =
    publisherOverride ?? sdkInfo?.publisher ?? settingsStored.settings?.publisherAddress ?? "";

  const campaigns: Array<Record<string, string>> = campaignsResp?.campaigns ?? [];
  const activeCampaigns = campaigns.filter((c) => Number(c.status) === 1);

  console.log(`[bridge] Campaigns: ${campaigns.length} total, ${activeCampaigns.length} active, publisher=${publisherAddress}`);

  // Build page tag hash set
  const pageTagHashes = new Set(tags.map((t: string) => tagHash(t).toLowerCase()));
  if (sdkInfo?.tags?.length > 0) {
    for (const t of sdkInfo.tags) pageTagHashes.add(tagHash(t).toLowerCase());
  }

  const excludedTagHashes = new Set<string>();
  if (sdkInfo?.excludedTags?.length > 0) {
    for (const t of sdkInfo.excludedTags) excludedTagHashes.add(tagHash(t).toLowerCase());
  }

  // Publisher allowlist check (demo always returns false — see daemon handler)
  let publisherAllowlistEnabled = false;
  if (publisherAddress) {
    try {
      const alResp = await chrome.runtime.sendMessage({
        type: "CHECK_PUBLISHER_ALLOWLIST",
        publisher: publisherAddress,
      });
      publisherAllowlistEnabled = alResp?.allowlistEnabled ?? false;
    } catch { /* */ }
  }

  // Tag-first campaign matching (mirrors content/index.ts exactly)
  let pool = activeCampaigns.filter((c) => {
    const publisherMatch =
      c.publisher === "0x0000000000000000000000000000000000000000" ||
      c.publisher.toLowerCase() === publisherAddress.toLowerCase();
    if (!publisherMatch) return false;
    if (c.publisher === "0x0000000000000000000000000000000000000000" && publisherAllowlistEnabled) return false;

    const campaignTags: string[] = Array.isArray(c.requiredTags) ? c.requiredTags : [];
    if (excludedTagHashes.size > 0 && campaignTags.some((t) => excludedTagHashes.has(t.toLowerCase()))) return false;
    if (campaignTags.length > 0) {
      return campaignTags.every((t) => pageTagHashes.has(t.toLowerCase()));
    }
    return true;
  });

  // Broad fallback
  if (pool.length === 0) {
    pool = activeCampaigns.filter((c) => {
      if (c.publisher === "0x0000000000000000000000000000000000000000") {
        return !publisherAllowlistEnabled;
      }
      return c.publisher.toLowerCase() === publisherAddress.toLowerCase();
    });
  }

  if (pool.length === 0) {
    console.log("[bridge] No campaigns in pool after matching — showing house ad");
    console.log(`[bridge] Page tag hashes (${pageTagHashes.size}):`, [...pageTagHashes].slice(0, 5));
    if (activeCampaigns.length > 0) {
      const sample = activeCampaigns[0];
      console.log(`[bridge] Sample campaign: id=${sample.id}, publisher=${sample.publisher}, requiredTags=`, sample.requiredTags);
    }
    const target = document.getElementById("datum-ad-slot");
    if (target) { injectDefaultAdInline(target); }
    return report({ step: "house-ad", totalCampaigns: campaigns.length, activeCampaigns: activeCampaigns.length, matchedPool: 0 });
  }

  // Auction
  report({ step: "auction" });
  let selectionResp: any = null;
  try {
    selectionResp = await chrome.runtime.sendMessage({
      type: "SELECT_CAMPAIGN",
      campaigns: pool,
      pageCategory: category,
    });
  } catch (err) {
    return report({ step: "error", error: String(err) });
  }

  const match = selectionResp?.selected ?? null;
  const clearingCpmPlanck: string | undefined = selectionResp?.clearingCpmPlanck;
  const auctionMechanism: string | undefined = selectionResp?.mechanism;
  const participants: number | undefined = selectionResp?.participants;

  if (!match) {
    const target = document.getElementById("datum-ad-slot");
    if (target) { injectDefaultAdInline(target); }
    return report({ step: "house-ad" });
  }

  const campaignId = match.id ?? match.campaignId;

  // Handshake
  report({ step: "handshake", campaignId, mechanism: auctionMechanism, clearingCpmPlanck, participants });
  let attestation: any = null;
  if (sdkInfo || publisherAddress) {
    const publisher = publisherAddress || sdkInfo?.publisher;
    if (publisher) {
      attestation = await performHandshake(publisher).catch(() => null);
    }
  }

  // Load cached IPFS metadata
  const metaKey = `metadata:${campaignId}`;
  const metaStored = await chrome.storage.local.get(metaKey);
  let validatedMeta: any = null;
  const rawMeta = metaStored[metaKey] ?? null;
  if (rawMeta) {
    const result = validateMetadata(rawMeta);
    if (result.valid && result.data && passesContentBlocklist(result.data)) {
      if (!result.data.creative.ctaUrl || !(await isUrlPhishing(result.data.creative.ctaUrl))) {
        validatedMeta = result.data;
      }
    }
  }

  // Fetch from IPFS if not cached
  if (!validatedMeta && match.metadataHash) {
    try {
      const fetchResp = await chrome.runtime.sendMessage({
        type: "FETCH_IPFS_METADATA",
        campaignId,
        metadataHash: match.metadataHash,
      });
      if (fetchResp?.metadata) validatedMeta = fetchResp.metadata;
    } catch { /* */ }
  }

  const effectivePublisher =
    match.publisher === "0x0000000000000000000000000000000000000000"
      ? publisherAddress
      : match.publisher;

  const ipfsGateway = settingsStored.settings?.ipfsGateway || "https://dweb.link/ipfs/";
  const currencySymbol = getCurrencySymbol(
    (settingsStored.settings?.network ?? "polkadotHub") as any
  );

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
      try { chrome.runtime.sendMessage({ type: "BLOCK_CAMPAIGN", campaignId: String(campaignId) }); } catch { /* */ }
    },
  };

  // Inject into #datum-ad-slot (inline) if present, otherwise skip overlay in demo context
  const target = document.getElementById("datum-ad-slot");
  if (target) {
    _lastAdElement = injectAdSlotInline(target, adConfig);
  }

  // Notify daemon (best-effort — impression claim building)
  try {
    chrome.runtime.sendMessage({
      type: "IMPRESSION_RECORDED",
      campaignId,
      url: window.location.href,
      category,
      publisherAddress: effectivePublisher,
      clearingCpmPlanck,
      attestation: attestation ?? undefined,
      campaignTags: Array.isArray(match.requiredTags) ? match.requiredTags : [],
    });
  } catch { /* */ }

  return report({ step: "injected", campaignId, mechanism: auctionMechanism, clearingCpmPlanck, participants, totalCampaigns: campaigns.length, activeCampaigns: activeCampaigns.length, matchedPool: pool.length });
}
