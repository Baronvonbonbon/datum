// Meta extractors — read structured metadata already deployed by publishers
// for other systems (Google, Facebook, ad exchanges) and map to Datum topic slugs.
//
// Privacy: all extraction runs on-device in the content script. Raw text is used
// only for local mapping and immediately discarded. Only abstract topic slugs
// are returned — never stored, never sent to background.

import { TAXONOMY } from "./taxonomy";

type ScoreMap = Record<string, number>;

// ---------------------------------------------------------------------------
// IAB Content Taxonomy Tier-1 → Datum category slug
// ---------------------------------------------------------------------------
const IAB_TO_SLUG: Record<string, string> = {
  "IAB1":  "arts-entertainment",
  "IAB2":  "autos-vehicles",
  "IAB3":  "business-industrial",
  "IAB4":  "jobs-education",
  "IAB5":  "jobs-education",
  "IAB6":  "people-society",
  "IAB7":  "health",
  "IAB8":  "food-drink",
  "IAB9":  "hobbies-leisure",
  "IAB10": "home-garden",
  "IAB11": "law-government",
  "IAB12": "news",
  "IAB13": "finance",
  "IAB14": "people-society",
  "IAB15": "science",
  "IAB16": "pets-animals",
  "IAB17": "sports",
  "IAB18": "beauty-fitness",
  "IAB19": "computers-electronics",
  "IAB20": "travel",
  "IAB21": "real-estate",
  "IAB22": "shopping",
  "IAB23": "people-society",
  // IAB24 (uncategorized) and IAB25/IAB26 (non-standard) — skip
};

// ---------------------------------------------------------------------------
// Schema.org @type → Datum category slug (weak type hints)
// ---------------------------------------------------------------------------
const SCHEMA_TYPE_HINTS: Record<string, string> = {
  "article":             "news",
  "newsarticle":         "news",
  "blogposting":        "news",
  "product":             "shopping",
  "recipe":              "food-drink",
  "sportsevent":         "sports",
  "musicevent":          "arts-entertainment",
  "musicalbum":          "arts-entertainment",
  "musicrecording":      "arts-entertainment",
  "movie":               "arts-entertainment",
  "tvseries":            "arts-entertainment",
  "book":                "books-literature",
  "course":              "jobs-education",
  "softwareapplication": "computers-electronics",
  "videogame":           "games",
  "game":                "games",
  "medicalcondition":    "health",
  "drug":                "health",
  "financialproduct":    "finance",
  "realestagelisting":   "real-estate",
  "jobosting":           "jobs-education",
  "event":               "arts-entertainment",
};

// ---------------------------------------------------------------------------
// OG og:type → Datum category slug
// ---------------------------------------------------------------------------
const OG_TYPE_MAP: Record<string, string> = {
  "product":   "shopping",
  "book":      "books-literature",
  "game":      "games",
};
// music.* and video.* handled via prefix check

// ---------------------------------------------------------------------------
// Fuzzy keyword matching: map free-text terms to taxonomy slugs
// Reuses the existing TAXONOMY keyword lists for consistency.
// ---------------------------------------------------------------------------

/** Map a free-text term to zero or more Datum category slugs using TAXONOMY keywords. */
function fuzzyMatchTerm(term: string): string[] {
  const lower = term.toLowerCase().trim();
  if (!lower) return [];
  const matches: string[] = [];
  for (const entry of TAXONOMY) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw) || kw.includes(lower)) {
        matches.push(entry.category);
        break;
      }
    }
  }
  return matches;
}

/** Map an array of free-text terms and return scores at the given confidence level. */
function matchTerms(terms: string[], confidence: number): ScoreMap {
  const result: ScoreMap = {};
  for (const term of terms) {
    for (const slug of fuzzyMatchTerm(term)) {
      result[slug] = Math.max(result[slug] ?? 0, confidence);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely coerce a JSON-LD value to a string array. */
function toStringArray(val: unknown): string[] {
  if (!val) return [];
  if (typeof val === "string") {
    // CSV or single value
    return val.includes(",") ? val.split(",").map((s) => s.trim()).filter(Boolean) : [val];
  }
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string") as string[];
  return [];
}

/** Safely read a nested property path from an object (e.g., "about.name"). */
function readNested(obj: any, field: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return obj[field];
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract topic signals from Schema.org JSON-LD embedded in the page.
 * Reads: articleSection, keywords, about.name, genre, BreadcrumbList.
 * Ignores: author, publisher, datePublished, or any PII-adjacent fields.
 */
export function extractSchemaOrg(): ScoreMap {
  if (typeof document === "undefined") return {};

  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  if (scripts.length === 0) return {};

  const result: ScoreMap = {};
  const CONFIDENCE = 0.85;
  const TYPE_HINT_CONFIDENCE = 0.7; // weaker — type alone is less specific

  for (let i = 0; i < scripts.length; i++) {
    let data: any;
    try {
      data = JSON.parse(scripts[i].textContent ?? "");
    } catch {
      continue; // malformed JSON — common in the wild
    }

    // Handle @graph arrays (common in WordPress/Yoast)
    const items: any[] = Array.isArray(data["@graph"]) ? data["@graph"] : [data];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const itemType = (typeof item["@type"] === "string" ? item["@type"] : "").toLowerCase();

      // Type hint (weak signal — section/keywords override)
      const typeSlug = SCHEMA_TYPE_HINTS[itemType];
      if (typeSlug) {
        result[typeSlug] = Math.max(result[typeSlug] ?? 0, TYPE_HINT_CONFIDENCE);
      }

      // articleSection
      const sections = toStringArray(readNested(item, "articleSection"));
      for (const [slug, score] of Object.entries(matchTerms(sections, CONFIDENCE))) {
        result[slug] = Math.max(result[slug] ?? 0, score);
      }

      // keywords
      const keywords = toStringArray(readNested(item, "keywords"));
      for (const [slug, score] of Object.entries(matchTerms(keywords, CONFIDENCE))) {
        result[slug] = Math.max(result[slug] ?? 0, score);
      }

      // about → name (can be string, object with .name, or array)
      const about = readNested(item, "about");
      const aboutTerms: string[] = [];
      if (typeof about === "string") {
        aboutTerms.push(about);
      } else if (Array.isArray(about)) {
        for (const a of about) {
          if (typeof a === "string") aboutTerms.push(a);
          else if (a && typeof a.name === "string") aboutTerms.push(a.name);
        }
      } else if (about && typeof (about as any).name === "string") {
        aboutTerms.push((about as any).name);
      }
      for (const [slug, score] of Object.entries(matchTerms(aboutTerms, CONFIDENCE))) {
        result[slug] = Math.max(result[slug] ?? 0, score);
      }

      // genre
      const genres = toStringArray(readNested(item, "genre"));
      for (const [slug, score] of Object.entries(matchTerms(genres, CONFIDENCE))) {
        result[slug] = Math.max(result[slug] ?? 0, score);
      }

      // BreadcrumbList — first 2 levels only
      if (itemType === "breadcrumblist") {
        const elements = Array.isArray(item.itemListElement) ? item.itemListElement : [];
        const breadcrumbTerms: string[] = [];
        for (let j = 0; j < Math.min(elements.length, 2); j++) {
          const name = elements[j]?.name ?? elements[j]?.item?.name;
          if (typeof name === "string") breadcrumbTerms.push(name);
        }
        for (const [slug, score] of Object.entries(matchTerms(breadcrumbTerms, CONFIDENCE))) {
          result[slug] = Math.max(result[slug] ?? 0, score);
        }
      }
    }
  }

  return result;
}

/**
 * Extract topic signals from Open Graph meta tags.
 * Reads: og:type, article:section, article:tag.
 * Ignores: og:url, og:image, og:description (fingerprinting risk).
 */
export function extractOpenGraph(): ScoreMap {
  if (typeof document === "undefined") return {};

  const result: ScoreMap = {};
  const CONFIDENCE = 0.75;

  // og:type
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute("content")?.toLowerCase().trim() ?? "";
  if (ogType) {
    const directSlug = OG_TYPE_MAP[ogType];
    if (directSlug) {
      result[directSlug] = Math.max(result[directSlug] ?? 0, CONFIDENCE);
    } else if (ogType.startsWith("music")) {
      result["arts-entertainment"] = Math.max(result["arts-entertainment"] ?? 0, CONFIDENCE);
    } else if (ogType.startsWith("video")) {
      result["arts-entertainment"] = Math.max(result["arts-entertainment"] ?? 0, CONFIDENCE);
    }
    // "article", "profile", "website" — too generic, skip
  }

  // article:section (single value, free text)
  const section = document.querySelector('meta[property="article:section"]')?.getAttribute("content") ?? "";
  if (section) {
    for (const [slug, score] of Object.entries(matchTerms([section], CONFIDENCE))) {
      result[slug] = Math.max(result[slug] ?? 0, score);
    }
  }

  // article:tag (can appear multiple times)
  const tagElements = document.querySelectorAll('meta[property="article:tag"]');
  const tagTerms: string[] = [];
  for (let i = 0; i < tagElements.length; i++) {
    const content = tagElements[i].getAttribute("content");
    if (content) tagTerms.push(content);
  }
  if (tagTerms.length > 0) {
    for (const [slug, score] of Object.entries(matchTerms(tagTerms, CONFIDENCE))) {
      result[slug] = Math.max(result[slug] ?? 0, score);
    }
  }

  return result;
}

/**
 * Extract topic signals from IAB Content Taxonomy categories.
 * Sources: <meta name="iab-category">, <meta name="iab_category">,
 *          <meta name="content-category">, and prebid.js OpenRTB site.cat config.
 * Only reads site-level content category — never bid responses, user segments,
 * or auction data.
 */
export function extractIABCategory(): ScoreMap {
  if (typeof document === "undefined") return {};

  const result: ScoreMap = {};
  const CONFIDENCE = 0.85;

  // Check meta tags (various CMS conventions)
  const metaSelectors = [
    'meta[name="iab-category"]',
    'meta[name="iab_category"]',
    'meta[name="content-category"]',
    'meta[name="sailthru.tags"]',   // Sailthru CMS — often carries IAB codes
  ];

  for (const selector of metaSelectors) {
    const el = document.querySelector(selector);
    const content = el?.getAttribute("content")?.trim();
    if (!content) continue;

    // Content may be comma-separated (e.g., "IAB19,IAB19-1,IAB13")
    const codes = content.split(",").map((s) => s.trim().toUpperCase());
    for (const code of codes) {
      // Extract tier-1 code (e.g., "IAB19-1" → "IAB19")
      const tier1 = code.includes("-") ? code.split("-")[0] : code;
      const slug = IAB_TO_SLUG[tier1];
      if (slug) {
        result[slug] = Math.max(result[slug] ?? 0, CONFIDENCE);
      }
    }
  }

  // Check prebid.js OpenRTB site-level category (read-only, site-level only)
  try {
    const pbjs = (window as any).pbjs;
    if (pbjs && typeof pbjs.getConfig === "function") {
      const ortb2 = pbjs.getConfig("ortb2");
      const siteCat: unknown = ortb2?.site?.cat;
      if (Array.isArray(siteCat)) {
        for (const cat of siteCat) {
          if (typeof cat !== "string") continue;
          const tier1 = cat.toUpperCase().includes("-") ? cat.toUpperCase().split("-")[0] : cat.toUpperCase();
          const slug = IAB_TO_SLUG[tier1];
          if (slug) {
            result[slug] = Math.max(result[slug] ?? 0, CONFIDENCE);
          }
        }
      }
    }
  } catch {
    // pbjs not available or getConfig throws — expected on most pages
  }

  return result;
}
