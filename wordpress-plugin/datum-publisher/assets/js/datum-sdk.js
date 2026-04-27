/**
 * DATUM Publisher SDK v3.2
 *
 * Lightweight JS tag (~3 KB) for publishers to embed on their site.
 * Provides two-party attestation via challenge-response handshake
 * with the DATUM browser extension.
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

  var VERSION = "3.2.0";

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
  }

  // Listen for challenge events from the DATUM extension content script
  document.addEventListener("datum:challenge", function (e) {
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
