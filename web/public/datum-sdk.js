/**
 * DATUM Publisher SDK v3.5
 *
 * Lightweight JS tag for publishers to embed on their site.
 * Provides two-party attestation via challenge-response handshake
 * with the DATUM browser extension, plus the alpha-5 additions:
 *
 *   - Bulletin Chain creative loader (listen for datum:bulletin-fetch,
 *     fetch from `${relay}/bulletin/<cid>`, emit datum:bulletin-loaded).
 *   - Click reporter (datum:click → POST ${relay}/click → relay batches
 *     to DatumClickRegistry on-chain).
 *   - Relay-path hint (`data-relay-mode="publisher"|"dualsig"|"datumrelay"`,
 *     default "publisher") propagated in sdk-ready so the extension
 *     knows which of the three settlement architectures the page
 *     wants.
 *   - Publisher telemetry on window.DATUM.metrics + optional inline
 *     dev panel via `?datum-dev=1`.
 *
 * Display modes (data-mode on the <script>, or data-datum-mode per slot):
 *   "full"    — no-extension fallback fills each empty slot with the inline
 *               DATUM house ad, sized to the IAB format (default; unchanged).
 *   "minimal" — each empty slot shows a slim labelled placeholder frame only.
 *   "silent"  — each empty slot collapses (zero footprint).
 *   The mode only affects the no-extension state — a real ad from the
 *   extension always wins. Per-slot data-datum-mode overrides the global mode.
 *
 * No-extension fallback: if no extension responds within 1.5s, each empty slot
 * is rendered per its display mode (above). Publisher need configure nothing
 * for the default ("full") behaviour.
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

  var VERSION = "3.5.0";

  // Alpha-5 relay-path architecture. Three modes the publisher can opt
  // into via data-relay-mode:
  //   "publisher" — publisher-direct settlement (default; matches legacy
  //                 behaviour).
  //   "dualsig"   — advertiser + publisher EIP-712 co-sigs (DatumDualSig).
  //   "datumrelay"— bonded DatumRelay operator with on-chain stake.
  // Propagated in datum:sdk-ready so the extension knows which signing /
  // settlement path to take.
  var RELAY_MODES = { "publisher": 1, "dualsig": 1, "datumrelay": 1 };

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

  // ── House-ad theme tokens ─────────────────────────────────────────────────

  var THEME = {
    bg: "linear-gradient(180deg,#0F0F1C 0%,#08080F 100%)",
    fg: "#F5F5F8",
    fgDim: "rgba(245,245,248,0.72)",
    fgFaint: "rgba(245,245,248,0.45)",
    accent: "#E6007A",
    accentSoft: "rgba(230,0,122,0.18)",
    border: "rgba(230,0,122,0.32)",
    glow: "0 8px 28px -16px rgba(230,0,122,0.5), inset 0 0 0 1px rgba(230,0,122,0.06)",
    sans:
      "-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    mono:
      "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace"
  };

  /**
   * Inline SVG brand mark — a reticle (corner brackets framing a dot).
   * Communicates "data point captured / node in a network" without needing
   * an external asset. `px` controls the rendered size.
   */
  function brandSvg(px) {
    px = px || 16;
    return (
      '<svg width="' + px + '" height="' + px + '" viewBox="0 0 16 16" ' +
      'style="display:block;flex:none;" aria-hidden="true">' +
        '<path d="M2 5 L2 2 L5 2 M11 2 L14 2 L14 5 M14 11 L14 14 L11 14 M5 14 L2 14 L2 11" ' +
          'fill="none" stroke="rgba(245,245,248,0.55)" stroke-width="1.4" ' +
          'stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="8" cy="8" r="2.6" fill="' + THEME.accent + '"/>' +
      '</svg>'
    );
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
  var relayMode = scriptTag ? (scriptTag.getAttribute("data-relay-mode") || "publisher").toLowerCase() : "publisher";
  if (!RELAY_MODES[relayMode]) relayMode = "publisher";

  // Display mode — controls a slot's appearance when the DATUM extension is
  // absent (no one to fill the slot with a real ad). Set globally via
  // data-mode on the <script> tag; override per slot via data-datum-mode on a
  // [data-datum-slot] element. Modes:
  //   "full"    — render the DATUM house-ad banner (default; backward-compatible)
  //   "minimal" — render a slim labelled placeholder frame (minor visual cue)
  //   "silent"  — collapse the slot (no footprint)
  // The mode never overrides a real ad: if the extension fills a slot, that wins.
  var DISPLAY_MODES = { "full": 1, "minimal": 1, "silent": 1 };
  var globalMode = scriptTag ? (scriptTag.getAttribute("data-mode") || "full").toLowerCase() : "full";
  if (!DISPLAY_MODES[globalMode]) globalMode = "full";
  function slotMode(el) {
    var m = el && el.getAttribute ? (el.getAttribute("data-datum-mode") || "").toLowerCase() : "";
    return DISPLAY_MODES[m] ? m : globalMode;
  }

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

    // Reusable style fragments
    var wordmark =
      'font-weight:700;letter-spacing:0.2px;color:' + THEME.fg + ';';
    var subtitle =
      'font-family:' + THEME.mono + ';' +
      'font-size:9px;color:' + THEME.fgFaint + ';' +
      'text-transform:uppercase;letter-spacing:1.4px;line-height:1.2;';
    var ctaPill =
      'display:inline-block;background:' + THEME.accent + ';' +
      'color:#fff;font-family:' + THEME.mono + ';font-size:11px;font-weight:600;' +
      'letter-spacing:0.4px;padding:7px 12px;border-radius:5px;white-space:nowrap;' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08),0 2px 10px rgba(230,0,122,0.32);';

    var inner;
    if (layout === "tiny") {
      // Compact strip: brand-block ([reticle] datum  /  // on-chain ad)
      //                · {hook wraps to 2 lines}
      //                · cta pill (matches wide/vertical aesthetic)
      // Brand block keeps the wordmark on top with the subtitle below it,
      // matching the visual flow used by the wide and vertical layouts.
      var ctaPillTiny =
        'display:inline-block;background:' + THEME.accent + ';' +
        'color:#fff;font-family:' + THEME.mono + ';font-size:10px;font-weight:600;' +
        'letter-spacing:0.4px;padding:5px 10px;border-radius:4px;white-space:nowrap;' +
        'line-height:1;' +
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08),0 2px 8px rgba(230,0,122,0.32);';
      // Hook lives in its own flex-item wrapper so the -webkit-box line-clamp
      // doesn't fight the flex algorithm. Without this wrapper the inner span
      // expands to its single-line natural width, pushing the CTA pill over
      // the body text on narrow screens.
      inner =
        '<div style="display:flex;flex-direction:column;align-items:flex-start;flex:none;margin-right:8px;line-height:1;">' +
          '<div style="display:flex;align-items:center;gap:5px;">' +
            brandSvg(11) +
            '<span style="' + wordmark + 'font-size:11px;line-height:1;">datum</span>' +
          '</div>' +
          '<div style="font-family:' + THEME.mono + ';font-size:8px;color:' + THEME.fgFaint + ';' +
            'text-transform:uppercase;letter-spacing:1.4px;line-height:1;margin-top:4px;">// on-chain ad</div>' +
        '</div>' +
        '<div style="flex:1 1 0;min-width:0;overflow:hidden;margin-right:8px;">' +
          '<div style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;' +
            'font-size:10px;color:' + THEME.fgDim + ';line-height:1.2;' +
            'overflow:hidden;text-overflow:ellipsis;' +
            'word-break:break-word;overflow-wrap:break-word;">' + hook + '</div>' +
        '</div>' +
        '<span style="' + ctaPillTiny + 'flex:none;">' + cta + '</span>';
    } else if (layout === "wide") {
      // [reticle] datum / // ON-CHAIN AD   ·   hook + body   ·   cta pill
      inner =
        '<div style="display:flex;align-items:center;gap:10px;flex:none;margin-right:18px;">' +
          brandSvg(18) +
          '<div>' +
            '<div style="' + wordmark + 'font-size:17px;line-height:1.05;">datum</div>' +
            '<div style="' + subtitle + 'margin-top:3px;">// on-chain ad</div>' +
          '</div>' +
        '</div>' +
        '<div style="flex:1;min-width:0;line-height:1.25;">' +
          '<div style="font-size:15px;font-weight:600;color:' + THEME.fg + ';' +
            'letter-spacing:0.1px;margin-bottom:3px;overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap;">' + hook + '</div>' +
          '<div style="font-size:12px;color:' + THEME.fgDim + ';' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + body + '</div>' +
        '</div>' +
        '<span style="' + ctaPill + 'flex:none;margin-left:18px;">' + cta + '</span>';
    } else {
      // Vertical block: [reticle] datum / // ON-CHAIN AD / hook / body / cta pill
      inner =
        '<div style="text-align:center;width:100%;display:flex;flex-direction:column;align-items:center;gap:0;">' +
          '<div style="display:inline-flex;align-items:center;gap:8px;">' +
            brandSvg(16) +
            '<span style="' + wordmark + 'font-size:17px;">datum</span>' +
          '</div>' +
          '<div style="' + subtitle + 'margin-top:6px;margin-bottom:14px;">// on-chain ad</div>' +
          '<div style="font-size:15px;font-weight:600;color:' + THEME.fg + ';' +
            'line-height:1.3;letter-spacing:0.1px;margin-bottom:10px;padding:0 6px;">' + hook + '</div>' +
          '<div style="font-size:12px;color:' + THEME.fgDim + ';' +
            'line-height:1.45;margin-bottom:16px;padding:0 8px;">' + body + '</div>' +
          '<span style="' + ctaPill + '">' + cta + '</span>' +
        '</div>';
    }

    var pad = layout === "tiny" ? "0 12px" : layout === "wide" ? "0 18px" : "18px 14px";
    var a = document.createElement("a");
    a.href = FALLBACK_URL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("data-datum-house-ad", "1");
    a.style.cssText =
      "display:flex;align-items:center;justify-content:" +
      (layout === "vertical" ? "center" : "flex-start") + ";" +
      "width:100%;height:100%;" +
      "text-decoration:none;color:" + THEME.fg + ";" +
      "background:" + THEME.bg + ";" +
      "font-family:" + THEME.sans + ";" +
      "border:1px solid " + THEME.border + ";border-radius:8px;" +
      "box-shadow:" + THEME.glow + ";" +
      "overflow:hidden;cursor:pointer;box-sizing:border-box;" +
      "padding:" + pad + ";";
    a.innerHTML = inner;
    slotEl.appendChild(a);
  }

  // True if a slot already holds an ad (extension light/shadow DOM) — never
  // overwrite a real ad with a placeholder, in any mode.
  function slotIsFilled(slotEl) {
    if (!slotEl) return true;
    if (slotEl.querySelector("[data-datum-house-ad], [data-datum-placeholder]")) return false; // our own placeholder doesn't count as filled
    if (slotEl.children.length > 0) return true;
    if (slotEl.shadowRoot && slotEl.shadowRoot.childNodes.length > 0) return true;
    return false;
  }

  // "minimal" mode: a slim, unobtrusive labelled frame at the slot's size — a
  // minor visual cue that a DATUM slot lives here, with no house-ad creative.
  function renderMinimalCue(slotEl) {
    if (!slotEl || slotIsFilled(slotEl)) return;
    if (slotEl.querySelector("[data-datum-placeholder]")) return;
    var box = document.createElement("div");
    box.setAttribute("data-datum-placeholder", "minimal");
    box.style.cssText =
      "display:flex;align-items:center;justify-content:center;gap:6px;" +
      "width:100%;height:100%;box-sizing:border-box;" +
      "border:1px dashed " + THEME.border + ";border-radius:8px;" +
      "background:transparent;color:" + THEME.fgFaint + ";" +
      "font-family:" + THEME.sans + ";font-size:10px;letter-spacing:0.06em;" +
      "text-transform:uppercase;user-select:none;";
    box.innerHTML =
      '<span style="width:5px;height:5px;border-radius:50%;background:' + THEME.accent + ';flex:none;"></span>' +
      '<span>ad slot · DATUM</span>';
    slotEl.appendChild(box);
  }

  // "silent" mode: collapse the slot entirely — zero footprint when no real ad
  // is served. The original size is stashed so a later challenge can restore it.
  function collapseSlot(slotEl) {
    if (!slotEl || slotIsFilled(slotEl)) return;
    if (slotEl.getAttribute("data-datum-collapsed") === "1") return;
    slotEl.setAttribute("data-datum-collapsed", "1");
    slotEl.setAttribute("data-datum-prev-display", slotEl.style.display || "");
    slotEl.style.display = "none";
  }

  // Restore a collapsed slot (extension showed up after the silent collapse).
  function restoreSlot(slotEl) {
    if (!slotEl || slotEl.getAttribute("data-datum-collapsed") !== "1") return;
    slotEl.style.display = slotEl.getAttribute("data-datum-prev-display") || "";
    slotEl.removeAttribute("data-datum-collapsed");
    slotEl.removeAttribute("data-datum-prev-display");
  }

  /**
   * Schedule the fallback check. If no `datum:challenge` event arrives within
   * FALLBACK_DELAY_MS, the extension is assumed absent and every empty slot is
   * rendered per its display mode (full → house ad, minimal → cue, silent →
   * collapse). The first challenge cancels the timer.
   */
  function scheduleFallback() {
    if (fallbackTimerId) return;
    fallbackTimerId = setTimeout(function () {
      fallbackTimerId = null;
      if (extensionDetected) return;
      var slots = document.querySelectorAll("[data-datum-slot], #datum-ad-slot");
      for (var i = 0; i < slots.length; i++) {
        var mode = slotMode(slots[i]);
        if (mode === "silent") collapseSlot(slots[i]);
        else if (mode === "minimal") renderMinimalCue(slots[i]);
        else renderHouseAd(slots[i]);
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
            relayMode: relayMode,
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
            relayMode: relayMode,
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
    // Tear down any placeholders that rendered during a slow extension boot
    // (house ads + minimal cues) and un-collapse any silent slots, so the
    // extension can fill each slot with a real ad.
    var existing = document.querySelectorAll("[data-datum-house-ad], [data-datum-placeholder]");
    for (var k = 0; k < existing.length; k++) {
      if (existing[k].parentNode) existing[k].parentNode.removeChild(existing[k]);
    }
    var collapsed = document.querySelectorAll("[data-datum-collapsed]");
    for (var c = 0; c < collapsed.length; c++) {
      restoreSlot(collapsed[c]);
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

  // ─── Alpha-5: Bulletin Chain creative loader ────────────────────────────────
  //
  // Flow:
  //   1. Extension resolves a campaign for a slot and reads
  //      getCampaignCreativeCid(campaignId) on-chain.
  //   2. Extension dispatches `datum:bulletin-fetch` with { slotId, cid,
  //      campaignId }. The publisher's relay endpoint doubles as a
  //      read-only Bulletin/IPFS HTTPS gateway.
  //   3. SDK GETs `${relay}/bulletin/<cid>`, expecting an HTML/JSON
  //      response describing the creative (`{ html?, imgUrl?, href?,
  //      alt? }`). Anything else is treated as the rendered HTML body.
  //   4. SDK dispatches `datum:bulletin-loaded` with the URL/HTML the
  //      extension can paste into the slot DOM. Failures emit
  //      `datum:bulletin-error` instead of throwing — the extension
  //      falls back to its standard creative path.
  //
  // The SDK never reaches chain directly; the relay endpoint is the
  // publisher's single point of trust for read-side gateway service.

  function fetchBulletinCreative(detail) {
    var slotId = detail && detail.slotId;
    var cid = detail && detail.cid;
    var campaignId = detail && detail.campaignId;
    if (!slotId || !cid) return;
    if (!relayUrl) {
      document.dispatchEvent(
        new CustomEvent("datum:bulletin-error", {
          detail: { slotId: slotId, cid: cid, reason: "no-relay" },
        })
      );
      return;
    }
    var gateway = relayUrl.replace(/\/+$/, "") + "/bulletin/" + encodeURIComponent(cid);
    var started = (window.performance && performance.now) ? performance.now() : Date.now();
    try {
      fetch(gateway, { method: "GET", credentials: "omit" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          var ct = (res.headers.get("content-type") || "").toLowerCase();
          if (ct.indexOf("application/json") !== -1) return res.json();
          return res.text().then(function (t) { return { html: t }; });
        })
        .then(function (creative) {
          var rtMs = ((window.performance && performance.now) ? performance.now() : Date.now()) - started;
          DATUM_METRICS.bulletinFetchMs = Math.round(rtMs);
          DATUM_METRICS.bulletinFetched += 1;
          document.dispatchEvent(
            new CustomEvent("datum:bulletin-loaded", {
              detail: {
                slotId: slotId,
                campaignId: campaignId || 0,
                cid: cid,
                creative: creative,
                rtMs: Math.round(rtMs),
              },
            })
          );
        })
        .catch(function (err) {
          DATUM_METRICS.bulletinErrors += 1;
          document.dispatchEvent(
            new CustomEvent("datum:bulletin-error", {
              detail: {
                slotId: slotId,
                cid: cid,
                reason: String(err && err.message || err),
              },
            })
          );
        });
    } catch (err) {
      DATUM_METRICS.bulletinErrors += 1;
      document.dispatchEvent(
        new CustomEvent("datum:bulletin-error", {
          detail: { slotId: slotId, cid: cid, reason: String(err) },
        })
      );
    }
  }

  document.addEventListener("datum:bulletin-fetch", function (e) {
    fetchBulletinCreative(e.detail);
  });

  // ─── Alpha-5: Click reporter (DatumClickRegistry) ───────────────────────────
  //
  // When the user clicks an ad, the extension dispatches `datum:click`
  // with { slotId, campaignId, href }. The SDK POSTs to
  // `${relay}/click` so the relay can batch + submit
  // DatumClickRegistry.recordClick on-chain.
  //
  // No-op when the publisher hasn't configured a relay endpoint — the
  // legacy CPM-only path keeps working.

  function reportClick(detail) {
    var campaignId = detail && detail.campaignId;
    if (!campaignId || !relayUrl) return;
    var body = JSON.stringify({
      publisher: publisherAddress,
      campaignId: String(campaignId),
      slotId: detail.slotId || "",
      href: detail.href || "",
      ts: Math.floor(Date.now() / 1000),
      v: VERSION,
    });
    var url = relayUrl.replace(/\/+$/, "") + "/click";
    DATUM_METRICS.clicksReported += 1;
    try {
      // Prefer sendBeacon — survives page unload on outbound clicks. Falls
      // back to fetch keepalive when beacon isn't available.
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon(
          url,
          new Blob([body], { type: "application/json" })
        );
        if (ok) return;
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
        credentials: "omit",
      }).catch(function () {
        DATUM_METRICS.clickErrors += 1;
      });
    } catch (_) {
      DATUM_METRICS.clickErrors += 1;
    }
  }

  document.addEventListener("datum:click", function (e) {
    reportClick(e.detail || {});
  });

  // ─── Alpha-5: Telemetry surface (window.DATUM.metrics) ──────────────────────
  //
  // Read-only counters publishers can inspect from the page console
  // or from analytics scripts. Updated in-place by the SDK as events
  // flow through.

  var DATUM_METRICS = {
    impressionsServed: 0,
    bulletinFetched: 0,
    bulletinFetchMs: 0,
    bulletinErrors: 0,
    clicksReported: 0,
    clickErrors: 0,
    attestationRtMs: 0,
    lastChallengeAt: 0,
    lastResponseAt: 0,
  };

  // Count successful handshakes as impressions served. Hooked into the
  // existing datum:response dispatch — the extension only requests a
  // response after the slot has been allocated, so the response is
  // proxy for "extension is about to render an ad here."
  document.addEventListener("datum:fill", function (e) {
    DATUM_METRICS.impressionsServed += 1;
    if (e && e.detail && e.detail.slotId && devPanelEl) refreshDevPanel();
  });

  // Patch the handshake to record attestation latency. We instrument
  // around the existing listener by adding our own that runs after it
  // (DOM listeners fire in registration order; this file's earlier
  // datum:challenge handler is registered above).
  document.addEventListener("datum:challenge", function () {
    DATUM_METRICS.lastChallengeAt = Date.now();
  });
  document.addEventListener("datum:response", function () {
    var now = Date.now();
    if (DATUM_METRICS.lastChallengeAt > 0) {
      DATUM_METRICS.attestationRtMs = now - DATUM_METRICS.lastChallengeAt;
    }
    DATUM_METRICS.lastResponseAt = now;
    if (devPanelEl) refreshDevPanel();
  });

  // Expose a frozen wrapper so consumers can read but not write.
  var DATUM_API = {
    version: VERSION,
    relayMode: relayMode,
    get metrics() {
      // Return a shallow copy so callers can't mutate the internal map.
      var out = {};
      for (var k in DATUM_METRICS) {
        if (Object.prototype.hasOwnProperty.call(DATUM_METRICS, k)) out[k] = DATUM_METRICS[k];
      }
      return out;
    },
  };
  try { Object.freeze(DATUM_API); } catch (_) { /* old browsers */ }
  window.DATUM = DATUM_API;

  // ─── Alpha-5: Dev console panel (?datum-dev=1) ──────────────────────────────
  //
  // A floating panel publishers can enable on a query-string flag for
  // debugging SDK ↔ extension wiring. No-op in production — hidden
  // unless ?datum-dev=1 is in the URL.

  var devPanelEl = null;
  function maybeMountDevPanel() {
    try {
      if (window.location.search.indexOf("datum-dev=1") === -1) return;
    } catch (_) { return; }
    if (devPanelEl || !document.body) return;
    var el = document.createElement("div");
    el.setAttribute("data-datum-dev-panel", "");
    el.style.cssText = [
      "position:fixed", "right:12px", "bottom:12px", "z-index:2147483647",
      "background:#0b0d12", "color:#e6e7eb", "font:11px/1.4 ui-monospace,Menlo,Consolas,monospace",
      "border:1px solid #2a2f3a", "border-radius:6px", "padding:10px 12px",
      "min-width:220px", "box-shadow:0 4px 12px rgba(0,0,0,0.35)", "pointer-events:auto",
    ].join(";");
    document.body.appendChild(el);
    devPanelEl = el;
    refreshDevPanel();
  }
  function refreshDevPanel() {
    if (!devPanelEl) return;
    var m = DATUM_METRICS;
    devPanelEl.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px">DATUM SDK ' + VERSION + '</div>' +
      '<div>relay-mode: <span style="color:#9aa">' + relayMode + '</span></div>' +
      '<div>impressions: <span style="color:#9aa">' + m.impressionsServed + '</span></div>' +
      '<div>attestation: <span style="color:#9aa">' + m.attestationRtMs + ' ms</span></div>' +
      '<div>bulletin: <span style="color:#9aa">' + m.bulletinFetched + ' ok / ' + m.bulletinErrors + ' err</span></div>' +
      '<div>clicks: <span style="color:#9aa">' + m.clicksReported + ' ok / ' + m.clickErrors + ' err</span></div>';
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeMountDevPanel);
  } else {
    maybeMountDevPanel();
  }

  // Signal ready on DOM load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", signalReady);
  } else {
    signalReady();
  }
})();
