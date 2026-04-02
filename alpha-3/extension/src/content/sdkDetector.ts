// SDK Detector — checks if the current page has the DATUM Publisher SDK embedded.
// Looks for the datum-sdk.js script tag OR listens for the datum:sdk-ready event.

export interface SDKInfo {
  publisher: string;       // Publisher's on-chain address
  tags: string[];          // Tag strings declared by the SDK (e.g., "topic:defi", "locale:en")
  excludedTags: string[];  // Publisher-side tag blacklist (e.g., "topic:gambling")
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
          tags: Array.isArray(detail.tags)
            ? detail.tags.map(String)
            : [],
          excludedTags: Array.isArray(detail.excludedTags)
            ? detail.excludedTags.map(String)
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
    if (src.includes("datum-sdk") || el.hasAttribute("data-tags")) {
      return el;
    }
  }
  return null;
}

function parseScriptTag(el: HTMLScriptElement): SDKInfo | null {
  const publisher = el.getAttribute("data-publisher") || "";
  if (!publisher) return null;

  // Parse data-tags attribute (comma-separated dimension:value strings)
  const tagStr = el.getAttribute("data-tags") || "";
  const tags = tagStr
    ? tagStr.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Parse data-excluded-tags attribute (publisher-side tag blacklist)
  const excludedStr = el.getAttribute("data-excluded-tags") || "";
  const excludedTags = excludedStr
    ? excludedStr.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    publisher,
    tags,
    excludedTags,
    relay: el.getAttribute("data-relay") || "",
    version: "detected",
    hasAdSlot: !!document.getElementById("datum-ad-slot"),
  };
}
