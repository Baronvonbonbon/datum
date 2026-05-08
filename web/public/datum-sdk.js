/**
 * DATUM Publisher SDK v3.3
 *
 * Lightweight JS tag (~5 KB) for publishers to embed on their site.
 * Provides two-party attestation via challenge-response handshake
 * with the DATUM browser extension.
 *
 * No-extension fallback: if no extension responds within 1.5s, each empty
 * slot is filled with an inline DATUM house ad pointing to datum.javcon.io,
 * sized to the IAB format. Publisher does not need to configure anything.
 *
 * Multi-slot usage (recommended):
 *   <script src="datum-sdk.js" data-tags="topic:crypto-web3,locale:en" data-publisher="0xYOUR_ADDRESS" data-relay="https://relay.example.com"></script>
 *   <div data-datum-slot="leaderboard"></div>
 *   <div data-datum-slot="medium-rectangle"></div>
 *
 * Single-slot legacy usage:
 *   <script src="datum-sdk.js" data-tags="topic:crypto-web3,locale:en" data-publisher="0xYOUR_ADDRESS" data-slot="leaderboard"></script>
 *   <div id="datum-ad-slot"></div>
 *
 * Slot formats (data-datum-slot or data-slot attribute):
 *   leaderboard (728×90), medium-rectangle (300×250), wide-skyscraper (160×600),
 *   half-page (300×600), mobile-banner (320×50), square (250×250), large-rectangle (336×280).
 *   Defaults to medium-rectangle.
 *
 * Format-based campaign targeting:
 *   Advertisers can add "format:leaderboard" to their campaign's requiredTags to target only
 *   leaderboard slots. The extension automatically injects the slot format as a page tag for
 *   each slot auction, enabling precise format-gated campaign matching.
 *
 * Tag format: comma-separated dimension:value strings (e.g., "topic:defi,locale:en").
 * Short-form values without dimension prefix are auto-resolved (e.g., "defi" → "topic:defi").
 *
 * Excluded tags: data-excluded-tags="topic:gambling,topic:adult" — publisher-side blacklist.
 * Campaigns requiring excluded tags will not be shown.
 */
(function () {
  "use strict";

  var VERSION = "3.3.0";

  // No-extension fallback: how long to wait for the extension to fill a slot
  // before rendering an inline house ad that promotes DATUM.
  var FALLBACK_DELAY_MS = 1500;
  var FALLBACK_URL = "https://datum.javcon.io/?utm_source=sdk&utm_medium=house-ad&utm_campaign=no-extension";

  // House-ad creative pools. Each render: pick a random category, then a
  // random hook + body + CTA from within it. Bodies are written to stand
  // alone (they don't reference the hook), so any pairing reads cleanly.
  // Voice: cypherpunk, anti-surveillance, anti-middleman, pro-self-custody.
  // No project names, no token tickers — just "crypto" and "blockchain".
  var CREATIVE_POOLS = {
    // — What crypto was supposed to be —
    cypherpunk: {
      hooks: [
        "Blockchain was meant to set you free.",
        "Crypto isn't all monkey JPEGs.",
        "Cypherpunks promised this.",
        "Web3 with the actual web.",
        "Real utility. Imagine that.",
        "Useful crypto. Rare, we know.",
        "Not a rug. Not a memecoin."
      ],
      bodies: [
        "Crypto rails for honest advertising — no rugs, no casinos.",
        "Open protocol. Direct payments. No middlemen.",
        "On-chain settlement. Off-chain privacy. Open protocol.",
        "Peer-to-peer payments. Permissionless. Yours.",
        "Some of us are still building the open web.",
        "Not rug you. Not surveil you. Not sell your data.",
        "Crypto used to be about freedom. We remembered.",
        "Open-source. On-chain. On your side."
      ],
      ctas: [
        "Prove it →",
        "Receipts? →",
        "Convince me →",
        "Show your work →",
        "Pull up →",
        "Try me →",
        "Big talk →"
      ]
    },

    // — P2P / "you could be earning" —
    p2p: {
      hooks: [
        "You could be earning from this ad.",
        "This ad slot pays the viewer.",
        "Cut out the ad-tech middlemen.",
        "Ads that pay rent.",
        "Your attention has a price tag.",
        "Direct deposit. From this ad."
      ],
      bodies: [
        "P2P payments straight to your wallet. No ad-tech tax.",
        "Direct on-chain settlement. No middlemen taking a cut.",
        "Smart-contract budgets. Direct deposits. No intermediaries.",
        "Peer-to-peer ad payments. The middlemen aren't invited.",
        "Pay-per-attention, settled on-chain.",
        "Advertisers pay you. Not the ad-tech industrial complex.",
        "Your attention. Your wallet. Your call.",
        "Crypto rails for honest pay-per-view advertising."
      ],
      ctas: [
        "I'm in →",
        "Sign me up →",
        "Pay up →",
        "Where's mine →",
        "Cut me in →",
        "Onboard me →",
        "Take my attention →",
        "Show me the money →"
      ]
    },

    // — Privacy / anti-tracking —
    privacy: {
      hooks: [
        "Stop being the product.",
        "This ad knows nothing about you.",
        "An ad that doesn't snitch.",
        "We didn't follow you here.",
        "Surveillance is so 2010s.",
        "Cookies were always for them."
      ],
      bodies: [
        "No tracking. No cookies. No data leaves your browser.",
        "Cryptographic proof — not creepy profiles.",
        "Your interests stay on your device. Always.",
        "Open-source. On-chain. On your side.",
        "Crypto-native ads. No fingerprinting. No middlemen.",
        "Zero pixels. Zero retargeting. Zero data exfil.",
        "Local-first interest matching. Your profile never leaves your machine.",
        "The ad is on-chain. Your data isn't."
      ],
      ctas: [
        "How? →",
        "No tracking? →",
        "What's the trick →",
        "Source? →",
        "Inspect →",
        "Spill →",
        "Catch? →",
        "Show me →"
      ]
    },

    // — Sass / sovereignty —
    sass: {
      hooks: [
        "Imagine ads that don't suck.",
        "Your data is yours. Wild concept.",
        "An ad that respects your no.",
        "Ads with consent. Revolutionary.",
        "Self-custody, but make it ads."
      ],
      bodies: [
        "Open protocol. Owned by no one. Useful to everyone.",
        "Earn crypto for every verified ad — no profile required.",
        "Opt-in by default. Open by design. Yours by right.",
        "No pixels. No popups. No nonsense.",
        "Your keys. Your data. Your earnings.",
        "Permissionless ad slots. Permissioned attention.",
        "Built for users, not against them."
      ],
      ctas: [
        "Tell me more →",
        "Go on →",
        "I'm listening →",
        "Talk to me →",
        "Refreshing →",
        "About time →",
        "Wait, what →",
        "Sounds nice →"
      ]
    }
  };

  function randPick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function pickCreative() {
    var keys = Object.keys(CREATIVE_POOLS);
    var pool = CREATIVE_POOLS[keys[Math.floor(Math.random() * keys.length)]];
    return {
      hook: randPick(pool.hooks),
      body: randPick(pool.bodies),
      cta: randPick(pool.ctas)
    };
  }

  // HTML-escape user-controlled creative copy. Defensive — copy is hard-coded
  // above today, but escaping keeps that contract for future edits.
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Known short-form → dimension:value mappings for convenience
  var SHORT_FORM_MAP = {
    "arts-entertainment": "topic:arts-entertainment",
    "autos-vehicles": "topic:autos-vehicles",
    "beauty-fitness": "topic:beauty-fitness",
    "books-literature": "topic:books-literature",
    "business-industrial": "topic:business-industrial",
    "computers-electronics": "topic:computers-electronics",
    "finance": "topic:finance",
    "food-drink": "topic:food-drink",
    "gaming": "topic:gaming",
    "health": "topic:health",
    "hobbies-leisure": "topic:hobbies-leisure",
    "home-garden": "topic:home-garden",
    "internet-telecom": "topic:internet-telecom",
    "jobs-education": "topic:jobs-education",
    "law-government": "topic:law-government",
    "news": "topic:news",
    "online-communities": "topic:online-communities",
    "people-society": "topic:people-society",
    "pets-animals": "topic:pets-animals",
    "real-estate": "topic:real-estate",
    "reference": "topic:reference",
    "science": "topic:science",
    "shopping": "topic:shopping",
    "sports": "topic:sports",
    "travel": "topic:travel",
    "crypto-web3": "topic:crypto-web3",
    "defi": "topic:defi",
    "nfts": "topic:nfts",
    "polkadot": "topic:polkadot",
    "daos-governance": "topic:daos-governance",
    "en": "locale:en",
    "es": "locale:es",
    "fr": "locale:fr",
    "de": "locale:de",
    "ja": "locale:ja",
    "ko": "locale:ko",
    "zh": "locale:zh",
    "pt": "locale:pt",
    "ru": "locale:ru",
    "desktop": "platform:desktop",
    "mobile": "platform:mobile",
    "tablet": "platform:tablet",
    // format short-forms (without "format:" prefix)
    "leaderboard": "format:leaderboard",
    "medium-rectangle": "format:medium-rectangle",
    "wide-skyscraper": "format:wide-skyscraper",
    "half-page": "format:half-page",
    "mobile-banner": "format:mobile-banner",
    "square": "format:square",
    "large-rectangle": "format:large-rectangle",
    // creative short-forms
    "video": "creative:video",
  };

  function resolveTag(raw) {
    // Already in dimension:value format (contains ":")
    if (raw.indexOf(":") !== -1) return raw;
    // Try short-form lookup
    return SHORT_FORM_MAP[raw.toLowerCase()] || raw;
  }

  // Read config from script tag attributes
  var scriptTag = document.currentScript;
  if (!scriptTag) {
    // Fallback: find the script tag by src
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf("datum-sdk") !== -1) {
        scriptTag = scripts[i];
        break;
      }
    }
  }

  var publisherAddress = scriptTag ? scriptTag.getAttribute("data-publisher") || "" : "";
  var relayUrl = scriptTag ? scriptTag.getAttribute("data-relay") || "" : "";
  // Legacy single-slot format (used as fallback if no [data-datum-slot] elements found)
  var legacySlotFormat = scriptTag ? scriptTag.getAttribute("data-slot") || "medium-rectangle" : "medium-rectangle";

  // Slot format → pixel dimensions (IAB standard sizes)
  var SLOT_SIZES = {
    "leaderboard":      { w: 728, h: 90  },
    "medium-rectangle": { w: 300, h: 250 },
    "wide-skyscraper":  { w: 160, h: 600 },
    "half-page":        { w: 300, h: 600 },
    "mobile-banner":    { w: 320, h: 50  },
    "square":           { w: 250, h: 250 },
    "large-rectangle":  { w: 336, h: 280 },
  };

  // Tags: comma-separated dimension:value strings or short-form values
  var tagsStr = scriptTag ? scriptTag.getAttribute("data-tags") || "" : "";
  var tags = tagsStr
    ? tagsStr.split(",").map(function (s) { return resolveTag(s.trim()); }).filter(Boolean)
    : [];

  // Excluded tags: publisher-side blacklist
  var excludedStr = scriptTag ? scriptTag.getAttribute("data-excluded-tags") || "" : "";
  var excludedTags = excludedStr
    ? excludedStr.split(",").map(function (s) { return resolveTag(s.trim()); }).filter(Boolean)
    : [];

  // Counter for auto-generated slot IDs
  var slotIdCounter = 0;

  /**
   * Apply IAB dimensions to a slot element and ensure it has an ID.
   * Returns the element's ID.
   */
  function prepareSlotElement(el, format) {
    var size = SLOT_SIZES[format] || SLOT_SIZES["medium-rectangle"];
    el.style.width = size.w + "px";
    el.style.height = size.h + "px";
    el.style.minWidth = size.w + "px";
    el.style.minHeight = size.h + "px";
    if (!el.id) {
      el.id = "datum-slot-" + (++slotIdCounter);
    }
    return el.id;
  }

  /**
   * Collect all [data-datum-slot] elements, size them, and return a slots array.
   * Returns null if no multi-slot elements found (fall back to legacy mode).
   */
  function collectMultiSlots() {
    var els = document.querySelectorAll("[data-datum-slot]");
    if (!els || els.length === 0) return null;
    var slots = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var format = el.getAttribute("data-datum-slot") || "medium-rectangle";
      var id = prepareSlotElement(el, format);
      slots.push({ id: id, format: format });
    }
    return slots;
  }

  /**
   * Legacy single-slot: ensure #datum-ad-slot exists, size it, return its format.
   */
  function ensureLegacySlot() {
    var existing = document.getElementById("datum-ad-slot");
    var slot = existing;
    if (!slot) {
      slot = document.createElement("div");
      slot.id = "datum-ad-slot";
      // Append after the script tag if possible, otherwise body
      if (scriptTag && scriptTag.parentNode) {
        scriptTag.parentNode.insertBefore(slot, scriptTag.nextSibling);
      } else if (document.body) {
        document.body.appendChild(slot);
      }
    }
    // Apply format dimensions so the page reserves the correct space
    var size = SLOT_SIZES[legacySlotFormat] || SLOT_SIZES["medium-rectangle"];
    slot.style.width = size.w + "px";
    slot.style.height = size.h + "px";
    slot.style.minWidth = size.w + "px";
    slot.style.minHeight = size.h + "px";
    slot.setAttribute("data-slot-format", legacySlotFormat);
  }

  // ─── No-extension fallback house ad ─────────────────────────────────────────

  var fallbackTimerId = null;
  var extensionDetected = false;

  /**
   * Render the DATUM house ad inline inside an empty slot. Sized to the slot's
   * IAB format. Self-contained: inline styles only, no external assets, opens
   * in a new tab. Skipped if the slot already has light- or shadow-DOM content.
   */
  function renderHouseAd(slotEl) {
    if (!slotEl) return;
    if (slotEl.querySelector("[data-datum-house-ad]")) return; // already rendered
    if (slotEl.children.length > 0) return; // extension or other content present
    if (slotEl.shadowRoot && slotEl.shadowRoot.childNodes.length > 0) return; // shadow DOM ad

    var format =
      slotEl.getAttribute("data-datum-slot") ||
      slotEl.getAttribute("data-slot-format") ||
      legacySlotFormat ||
      "medium-rectangle";
    var size = SLOT_SIZES[format] || SLOT_SIZES["medium-rectangle"];
    var ratio = size.w / size.h;

    // Layout: tiny strip (mobile-banner), wide strip (leaderboard), or vertical block
    var layout;
    if (ratio >= 3 && size.h < 80) layout = "tiny";
    else if (ratio >= 3) layout = "wide";
    else layout = "vertical";

    var c = pickCreative();
    var hook = esc(c.hook);
    var body = esc(c.body);
    var cta = esc(c.cta);

    var inner;
    if (layout === "tiny") {
      // Single line: ● datum · {hook truncated} · {cta}
      inner =
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#E6007A;margin-right:8px;flex:none;"></span>' +
        '<span style="font-weight:700;font-size:13px;letter-spacing:0.2px;margin-right:10px;flex:none;">datum</span>' +
        '<span style="font-size:11px;opacity:0.92;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + hook + '</span>' +
        '<span style="font-size:11px;font-weight:600;color:#E6007A;margin-left:10px;flex:none;white-space:nowrap;">' + cta + '</span>';
    } else if (layout === "wide") {
      // ● datum  ·  hook (bold) + body (smaller, dimmer)  ·  cta pill
      inner =
        '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#E6007A;margin-right:14px;flex:none;"></span>' +
        '<div style="flex:none;margin-right:18px;">' +
          '<div style="font-weight:700;font-size:17px;letter-spacing:0.3px;line-height:1.1;">datum</div>' +
          '<div style="font-size:9px;opacity:0.6;text-transform:uppercase;letter-spacing:1.2px;line-height:1.2;margin-top:2px;">on-chain ads</div>' +
        '</div>' +
        '<div style="flex:1;min-width:0;line-height:1.25;">' +
          '<div style="font-size:15px;font-weight:600;letter-spacing:0.1px;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + hook + '</div>' +
          '<div style="font-size:12px;opacity:0.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + body + '</div>' +
        '</div>' +
        '<span style="flex:none;margin-left:18px;background:#E6007A;color:#fff;font-size:12px;font-weight:600;padding:8px 14px;border-radius:4px;white-space:nowrap;">' + cta + '</span>';
    } else {
      // Vertical block: ● datum / HOOK / body / cta pill
      inner =
        '<div style="text-align:center;width:100%;">' +
          '<div style="display:inline-flex;align-items:center;gap:6px;margin-bottom:12px;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#E6007A;"></span>' +
            '<span style="font-weight:700;font-size:17px;letter-spacing:0.3px;">datum</span>' +
          '</div>' +
          '<div style="font-size:15px;font-weight:600;line-height:1.25;letter-spacing:0.1px;margin-bottom:10px;padding:0 6px;">' + hook + '</div>' +
          '<div style="font-size:12px;opacity:0.82;line-height:1.4;margin-bottom:14px;padding:0 8px;">' + body + '</div>' +
          '<div style="display:inline-block;background:#E6007A;color:#fff;font-size:12px;font-weight:600;padding:8px 16px;border-radius:4px;">' + cta + '</div>' +
        '</div>';
    }

    var pad = layout === "tiny" ? "0 10px" : layout === "wide" ? "0 16px" : "16px 12px";
    var a = document.createElement("a");
    a.href = FALLBACK_URL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("data-datum-house-ad", "1");
    a.style.cssText =
      "display:flex;align-items:center;justify-content:center;width:100%;height:100%;" +
      "text-decoration:none;color:#ffffff;background:#0E0E1F;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "border:1px solid rgba(230,0,122,0.3);border-radius:6px;" +
      "overflow:hidden;cursor:pointer;box-sizing:border-box;padding:" + pad + ";";
    a.innerHTML = inner;
    slotEl.appendChild(a);
  }

  /**
   * Schedule the fallback check. If no `datum:challenge` event arrives within
   * FALLBACK_DELAY_MS, the extension is assumed absent and every empty slot
   * gets a house ad. The first challenge cancels the timer.
   */
  function scheduleFallback() {
    if (fallbackTimerId) return;
    fallbackTimerId = setTimeout(function () {
      fallbackTimerId = null;
      if (extensionDetected) return;
      var slots = document.querySelectorAll("[data-datum-slot], #datum-ad-slot");
      for (var i = 0; i < slots.length; i++) {
        renderHouseAd(slots[i]);
      }
    }, FALLBACK_DELAY_MS);
  }

  // Dispatch SDK ready event
  function signalReady() {
    // Try multi-slot mode first
    var multiSlots = collectMultiSlots();

    if (multiSlots && multiSlots.length > 0) {
      // Multi-slot: emit slots array; extension fills each slot independently
      document.dispatchEvent(
        new CustomEvent("datum:sdk-ready", {
          detail: {
            publisher: publisherAddress,
            tags: tags,
            excludedTags: excludedTags,
            relay: relayUrl,
            version: VERSION,
            slots: multiSlots,
            // For backward compat with older extension versions
            slotFormat: multiSlots[0].format,
          },
        })
      );
    } else {
      // Legacy single-slot mode
      ensureLegacySlot();
      document.dispatchEvent(
        new CustomEvent("datum:sdk-ready", {
          detail: {
            publisher: publisherAddress,
            tags: tags,
            excludedTags: excludedTags,
            relay: relayUrl,
            version: VERSION,
            slotFormat: legacySlotFormat,
          },
        })
      );
    }
    // Start the no-extension fallback timer. Cancelled on first datum:challenge.
    scheduleFallback();
  }

  // Listen for challenge events from the DATUM extension content script
  document.addEventListener("datum:challenge", function (e) {
    // Extension is present — cancel the no-extension fallback timer and
    // tear down any house ads that may have already rendered (slow boot).
    extensionDetected = true;
    if (fallbackTimerId) {
      clearTimeout(fallbackTimerId);
      fallbackTimerId = null;
    }
    var existing = document.querySelectorAll("[data-datum-house-ad]");
    for (var k = 0; k < existing.length; k++) {
      if (existing[k].parentNode) existing[k].parentNode.removeChild(existing[k]);
    }

    var detail = e.detail || {};
    var challenge = detail.challenge || "";
    var nonce = detail.nonce || "";

    // HMAC-SHA-256(key=publisherAddress, msg=challenge:nonce)
    // Must match handshake.ts computeExpectedSignature() in the extension.
    if (window.crypto && window.crypto.subtle) {
      var encoder = new TextEncoder();
      window.crypto.subtle.importKey(
        "raw",
        encoder.encode(publisherAddress),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      ).then(function (key) {
        return window.crypto.subtle.sign("HMAC", key, encoder.encode(challenge + ":" + nonce));
      }).then(function (sigBuffer) {
        var hashHex = Array.from(new Uint8Array(sigBuffer))
          .map(function (b) { return b.toString(16).padStart(2, "0"); })
          .join("");
        document.dispatchEvent(
          new CustomEvent("datum:response", {
            detail: {
              publisher: publisherAddress,
              challenge: challenge,
              nonce: nonce,
              signature: "0x" + hashHex,
              version: VERSION,
            },
          })
        );
      });
    } else {
      // Fallback: no crypto available, send empty signature (degraded trust)
      document.dispatchEvent(
        new CustomEvent("datum:response", {
          detail: {
            publisher: publisherAddress,
            challenge: challenge,
            nonce: nonce,
            signature: "0x",
            version: VERSION,
          },
        })
      );
    }
  });

  // Signal ready on DOM load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", signalReady);
  } else {
    signalReady();
  }
})();
