/**
 * DATUM Publisher SDK v1.0
 *
 * Lightweight JS tag (~2 KB) for publishers to embed on their site.
 * Provides two-party attestation via challenge-response handshake
 * with the DATUM browser extension.
 *
 * Usage:
 *   <script src="datum-sdk.js" data-categories="1,6,26" data-publisher="0xYOUR_ADDRESS"></script>
 *   <div id="datum-ad-slot"></div>
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";

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
  var categoriesStr = scriptTag ? scriptTag.getAttribute("data-categories") || "" : "";
  var categories = categoriesStr
    ? categoriesStr.split(",").map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); })
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
          categories: categories,
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
