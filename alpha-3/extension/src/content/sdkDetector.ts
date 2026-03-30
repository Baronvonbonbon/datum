// SDK Detector — checks if the current page has the DATUM Publisher SDK embedded.
// Looks for the datum-sdk.js script tag OR listens for the datum:sdk-ready event.

export interface SDKInfo {
  publisher: string;       // Publisher's on-chain address
  categories: number[];    // Category IDs declared by the SDK (deprecated — use tags)
  tags: string[];          // TX-4: Tag strings declared by the SDK (e.g., "topic:defi,locale:en")
  relay: string;           // Publisher relay URL (empty = none declared)
  version: string;         // SDK version string
  hasAdSlot: boolean;      // Whether <div id="datum-ad-slot"> exists
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
        resolve({
          publisher: String(detail.publisher),
          categories: Array.isArray(detail.categories)
            ? detail.categories.map(Number).filter((n: number) => !isNaN(n))
            : [],
          tags: Array.isArray(detail.tags)
            ? detail.tags.map(String)
            : [],
          relay: String(detail.relay ?? ""),
          version: String(detail.version ?? "unknown"),
          hasAdSlot: !!document.getElementById("datum-ad-slot"),
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

function findSDKScript(): HTMLScriptElement | null {
  const scripts = document.querySelectorAll("script[data-publisher]");
  for (let i = 0; i < scripts.length; i++) {
    const el = scripts[i] as HTMLScriptElement;
    const src = el.src || "";
    if (src.includes("datum-sdk") || el.hasAttribute("data-categories")) {
      return el;
    }
  }
  return null;
}

function parseScriptTag(el: HTMLScriptElement): SDKInfo | null {
  const publisher = el.getAttribute("data-publisher") || "";
  if (!publisher) return null;

  const catStr = el.getAttribute("data-categories") || "";
  const categories = catStr
    ? catStr.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : [];

  // TX-4: Parse data-tags attribute (comma-separated dimension:value strings)
  const tagStr = el.getAttribute("data-tags") || "";
  const tags = tagStr
    ? tagStr.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    publisher,
    categories,
    tags,
    relay: el.getAttribute("data-relay") || "",
    version: "detected",
    hasAdSlot: !!document.getElementById("datum-ad-slot"),
  };
}
