// SDK Detector — checks if the current page has the DATUM Publisher SDK embedded.
// Looks for the datum-sdk.js script tag OR listens for the datum:sdk-ready event.
// Supports both single-slot (legacy #datum-ad-slot) and multi-slot ([data-datum-slot]) pages.

export interface SDKSlot {
  /** The host element that will receive the inline ad */
  el: HTMLElement;
  /** IAB slot format declared on the element (e.g., "leaderboard") */
  format: string;
}

export interface SDKInfo {
  publisher: string;       // Publisher's on-chain address
  tags: string[];          // Tag strings declared by the SDK (e.g., "topic:defi", "locale:en")
  excludedTags: string[];  // Publisher-side tag blacklist (e.g., "topic:gambling")
  relay: string;           // Publisher relay URL (empty = none declared)
  version: string;         // SDK version string
  hasAdSlot: boolean;      // Whether any ad slot element exists
  slotFormat: string;      // IAB slot format of the first slot (backward compat)
  /** All declared slots. Length ≥ 1 when hasAdSlot is true. */
  slots: SDKSlot[];
}

/**
 * Detect the DATUM Publisher SDK on the current page.
 * Checks for script tag first (instant), then listens for the event (2s timeout).
 * Returns null if no SDK is found.
 */
export function detectSDK(): Promise<SDKInfo | null> {
  // Fast path: check for script tag with datum-sdk attributes
  const scriptTag = findSDKScript();
  if (scriptTag) {
    const info = parseScriptTag(scriptTag);
    if (info) return Promise.resolve(info);
  }

  // Slow path: listen for datum:sdk-ready event (SDK may load async)
  return new Promise((resolve) => {
    let resolved = false;

    function onReady(e: Event) {
      if (resolved) return;
      resolved = true;
      document.removeEventListener("datum:sdk-ready", onReady);

      const detail = (e as CustomEvent).detail;
      if (detail && detail.publisher) {
        const slots = collectSlots(detail.slots);
        const firstFormat = slots[0]?.format ?? String(detail.slotFormat ?? "medium-rectangle");
        resolve({
          publisher: String(detail.publisher),
          tags: Array.isArray(detail.tags) ? detail.tags.map(String) : [],
          excludedTags: Array.isArray(detail.excludedTags) ? detail.excludedTags.map(String) : [],
          relay: String(detail.relay ?? ""),
          version: String(detail.version ?? "unknown"),
          hasAdSlot: slots.length > 0,
          slotFormat: firstFormat,
          slots,
        });
      } else {
        resolve(null);
      }
    }

    document.addEventListener("datum:sdk-ready", onReady);

    // Timeout: 2 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        document.removeEventListener("datum:sdk-ready", onReady);
        resolve(null);
      }
    }, 2000);
  });
}

/**
 * Collect all [data-datum-slot] elements from the page.
 * Falls back to a single legacy #datum-ad-slot element.
 */
function collectSlots(sdkSlots?: Array<{ id: string; format: string }>): SDKSlot[] {
  // Multi-slot: [data-datum-slot] elements (modern SDK)
  const multiSlotEls = document.querySelectorAll<HTMLElement>("[data-datum-slot]");
  if (multiSlotEls.length > 0) {
    return Array.from(multiSlotEls).map((el) => ({
      el,
      format: el.getAttribute("data-datum-slot") || "medium-rectangle",
    }));
  }

  // If the SDK event carried a slots array, resolve elements by id
  if (sdkSlots && sdkSlots.length > 0) {
    const result: SDKSlot[] = [];
    for (const s of sdkSlots) {
      const el = document.getElementById(s.id);
      if (el) result.push({ el, format: s.format });
    }
    if (result.length > 0) return result;
  }

  // Legacy fallback: single #datum-ad-slot
  const legacy = document.getElementById("datum-ad-slot");
  if (legacy) {
    const format = legacy.getAttribute("data-slot-format") || "medium-rectangle";
    return [{ el: legacy, format }];
  }

  return [];
}

function findSDKScript(): HTMLScriptElement | null {
  const scripts = document.querySelectorAll("script[data-publisher]");
  for (let i = 0; i < scripts.length; i++) {
    const el = scripts[i] as HTMLScriptElement;
    const src = el.src || "";
    if (src.includes("datum-sdk") || el.hasAttribute("data-tags")) {
      return el;
    }
  }
  return null;
}

function parseScriptTag(el: HTMLScriptElement): SDKInfo | null {
  const publisher = el.getAttribute("data-publisher") || "";
  if (!publisher) return null;

  const tagStr = el.getAttribute("data-tags") || "";
  const tags = tagStr ? tagStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const excludedStr = el.getAttribute("data-excluded-tags") || "";
  const excludedTags = excludedStr
    ? excludedStr.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const slots = collectSlots();
  const firstFormat = slots[0]?.format
    ?? el.getAttribute("data-slot")
    ?? "medium-rectangle";

  return {
    publisher,
    tags,
    excludedTags,
    relay: el.getAttribute("data-relay") || "",
    version: "detected",
    hasAdSlot: slots.length > 0,
    slotFormat: firstFormat,
    slots,
  };
}
