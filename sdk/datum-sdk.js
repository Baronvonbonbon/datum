/**
 * DATUM Publisher SDK v3.0
 *
 * Lightweight JS tag (~2 KB) for publishers to embed on their site.
 * Provides two-party attestation via challenge-response handshake
 * with the DATUM browser extension.
 *
 * Usage:
 *   <script src="datum-sdk.js" data-tags="topic:crypto-web3,locale:en" data-publisher="0xYOUR_ADDRESS" data-relay="https://relay.example.com"></script>
 *   <div id="datum-ad-slot"></div>
 *
 * Tag format: comma-separated dimension:value strings (e.g., "topic:defi,locale:en").
 * Short-form values without dimension prefix are auto-resolved (e.g., "defi" → "topic:defi").
 *
 * Excluded tags: data-excluded-tags="topic:gambling,topic:adult" — publisher-side blacklist.
 * Campaigns requiring excluded tags will not be shown.
 */
(function () {
  "use strict";

  var VERSION = "3.0.0";

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
  };

  function resolveTag(raw) {
    // Already in dimension:value format
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

  // Ensure ad slot placeholder exists
  function ensureAdSlot() {
    if (!document.getElementById("datum-ad-slot")) {
      var slot = document.createElement("div");
      slot.id = "datum-ad-slot";
      slot.style.cssText = "min-height:90px;min-width:300px;";
      // Append after the script tag if possible, otherwise body
      if (scriptTag && scriptTag.parentNode) {
        scriptTag.parentNode.insertBefore(slot, scriptTag.nextSibling);
      } else if (document.body) {
        document.body.appendChild(slot);
      }
    }
  }

  // Dispatch SDK ready event
  function signalReady() {
    ensureAdSlot();
    document.dispatchEvent(
      new CustomEvent("datum:sdk-ready", {
        detail: {
          publisher: publisherAddress,
          tags: tags,
          excludedTags: excludedTags,
          relay: relayUrl,
          version: VERSION,
        },
      })
    );
  }

  // Listen for challenge events from the DATUM extension content script
  document.addEventListener("datum:challenge", function (e) {
    var detail = e.detail || {};
    var challenge = detail.challenge || "";
    var nonce = detail.nonce || "";

    // Simple HMAC-like response: hash(publisher + challenge + nonce)
    // In production, this would use the publisher's signing key
    var responseData = publisherAddress + ":" + challenge + ":" + nonce;

    // Use SubtleCrypto if available for a real hash, otherwise a simple checksum
    if (window.crypto && window.crypto.subtle) {
      var encoder = new TextEncoder();
      window.crypto.subtle
        .digest("SHA-256", encoder.encode(responseData))
        .then(function (hashBuffer) {
          var hashArray = Array.from(new Uint8Array(hashBuffer));
          var hashHex = hashArray
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
