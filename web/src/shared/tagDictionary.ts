// TX-5: Standard tag dictionary for tag-based targeting
// Dimensions: topic, locale, platform, audience
// Trimmed per TX-5 review: city/geo/interest removed (extension cannot verify)
//
// Tags are keccak256("dimension:value") on EVM, blake2-256 on PolkaVM.
// This module provides human-readable labels and hash computation.

import { keccak256, toUtf8Bytes } from "ethers";

/** Compute the tag hash for a dimension:value string (keccak256 for EVM/test) */
export function tagHash(tag: string): string {
  return keccak256(toUtf8Bytes(tag));
}

/** Parse a bytes32 tag hash back to its human label (if known) */
export function tagLabel(hash: string): string | undefined {
  return TAG_HASH_TO_LABEL.get(hash.toLowerCase());
}

/** All known tags as dimension:value strings */
export const TAG_DICTIONARY: Record<string, string[]> = {
  topic: [
    "topic:arts-entertainment",
    "topic:autos-vehicles",
    "topic:beauty-fitness",
    "topic:books-literature",
    "topic:business-industrial",
    "topic:computers-electronics",
    "topic:finance",
    "topic:food-drink",
    "topic:gaming",
    "topic:health",
    "topic:hobbies-leisure",
    "topic:home-garden",
    "topic:internet-telecom",
    "topic:jobs-education",
    "topic:law-government",
    "topic:news",
    "topic:online-communities",
    "topic:people-society",
    "topic:pets-animals",
    "topic:real-estate",
    "topic:reference",
    "topic:science",
    "topic:shopping",
    "topic:sports",
    "topic:travel",
    "topic:crypto-web3",
    "topic:defi",
    "topic:nfts",
    "topic:polkadot",
    "topic:daos-governance",
  ],
  locale: [
    "locale:en",
    "locale:en-US",
    "locale:en-GB",
    "locale:es",
    "locale:fr",
    "locale:de",
    "locale:ja",
    "locale:ko",
    "locale:zh",
    "locale:pt",
    "locale:ru",
  ],
  platform: [
    "platform:desktop",
    "platform:mobile",
    "platform:tablet",
  ],
  audience: [
    "audience:developer",
    "audience:student",
    "audience:professional",
    "audience:creator",
    "audience:investor",
  ],
};

/** Map taxonomy category slug → tag string (e.g., "crypto-web3" → "topic:crypto-web3") */
export function tagStringFromSlug(slug: string): string | null {
  const SLUG_TO_TAG: Record<string, string> = {
    "arts-entertainment": "topic:arts-entertainment",
    "autos-vehicles": "topic:autos-vehicles",
    "beauty-fitness": "topic:beauty-fitness",
    "books-literature": "topic:books-literature",
    "business-industrial": "topic:business-industrial",
    "computers-electronics": "topic:computers-electronics",
    "finance": "topic:finance",
    "food-drink": "topic:food-drink",
    "games": "topic:gaming",
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
    "crypto": "topic:crypto-web3",
    "technology": "topic:computers-electronics",
    "privacy": "topic:internet-telecom",
    "open-source": "topic:computers-electronics",
    "environment": "topic:science",
  };
  return SLUG_TO_TAG[slug] ?? null;
}

/** Map locale string → tag string (e.g., "en-us" → "locale:en-US") */
export function tagStringFromLocale(lang: string): string | null {
  const lower = lang.trim().toLowerCase();
  const LOCALE_MAP: Record<string, string> = {
    "en-us": "locale:en-US",
    "en-gb": "locale:en-GB",
    "es": "locale:es",
    "fr": "locale:fr",
    "de": "locale:de",
    "ja": "locale:ja",
    "ko": "locale:ko",
    "zh": "locale:zh",
    "pt": "locale:pt",
    "ru": "locale:ru",
    "en": "locale:en",
  };
  // Try exact match first
  if (LOCALE_MAP[lower]) return LOCALE_MAP[lower];
  // Try base language (e.g., "en-us" → "en")
  const base = lower.split("-")[0];
  return LOCALE_MAP[base] ?? null;
}

/** Map user agent → tag string (e.g., "platform:desktop") */
export function tagStringFromPlatform(ua: string): string {
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "platform:tablet";
  if (/Mobi|Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return "platform:mobile";
  return "platform:desktop";
}

/** Reverse lookup: TAG_LABELS display value → tag string */
const TAG_LABEL_TO_STRING = new Map<string, string>();
// populated after TAG_LABELS is defined (see bottom of file)

export function tagStringFromLabel(label: string): string | null {
  return TAG_LABEL_TO_STRING.get(label) ?? null;
}

/** Reverse lookup: tag hash → tag string (if known) */
export function tagStringFromHash(hash: string): string | null {
  const label = TAG_HASH_TO_LABEL.get(hash.toLowerCase());
  if (!label) return null;
  return TAG_LABEL_TO_STRING.get(label) ?? null;
}

/** @deprecated Use tag strings directly. Map from old categoryId to equivalent topic tag */
export const CATEGORY_TO_TAG: Record<number, string> = {
  1: "topic:arts-entertainment",
  2: "topic:autos-vehicles",
  3: "topic:beauty-fitness",
  4: "topic:books-literature",
  5: "topic:business-industrial",
  6: "topic:computers-electronics",
  7: "topic:finance",
  8: "topic:food-drink",
  9: "topic:gaming",
  10: "topic:health",
  11: "topic:hobbies-leisure",
  12: "topic:home-garden",
  13: "topic:internet-telecom",
  14: "topic:jobs-education",
  15: "topic:law-government",
  16: "topic:news",
  17: "topic:online-communities",
  18: "topic:people-society",
  19: "topic:pets-animals",
  20: "topic:real-estate",
  21: "topic:reference",
  22: "topic:science",
  23: "topic:shopping",
  24: "topic:sports",
  25: "topic:travel",
  26: "topic:crypto-web3",
};

/** Flat list of all known tags */
export const ALL_TAGS: string[] = Object.values(TAG_DICTIONARY).flat();

/** Human-readable label for a tag string (e.g., "topic:crypto-web3" → "Crypto & Web3") */
export const TAG_LABELS: Record<string, string> = {
  "topic:arts-entertainment": "Arts & Entertainment",
  "topic:autos-vehicles": "Autos & Vehicles",
  "topic:beauty-fitness": "Beauty & Fitness",
  "topic:books-literature": "Books & Literature",
  "topic:business-industrial": "Business & Industrial",
  "topic:computers-electronics": "Computers & Electronics",
  "topic:finance": "Finance",
  "topic:food-drink": "Food & Drink",
  "topic:gaming": "Games",
  "topic:health": "Health",
  "topic:hobbies-leisure": "Hobbies & Leisure",
  "topic:home-garden": "Home & Garden",
  "topic:internet-telecom": "Internet & Telecom",
  "topic:jobs-education": "Jobs & Education",
  "topic:law-government": "Law & Government",
  "topic:news": "News",
  "topic:online-communities": "Online Communities",
  "topic:people-society": "People & Society",
  "topic:pets-animals": "Pets & Animals",
  "topic:real-estate": "Real Estate",
  "topic:reference": "Reference",
  "topic:science": "Science",
  "topic:shopping": "Shopping",
  "topic:sports": "Sports",
  "topic:travel": "Travel",
  "topic:crypto-web3": "Crypto & Web3",
  "topic:defi": "DeFi",
  "topic:nfts": "NFTs",
  "topic:polkadot": "Polkadot",
  "topic:daos-governance": "DAOs & Governance",
  "locale:en": "English",
  "locale:en-US": "English (US)",
  "locale:en-GB": "English (UK)",
  "locale:es": "Spanish",
  "locale:fr": "French",
  "locale:de": "German",
  "locale:ja": "Japanese",
  "locale:ko": "Korean",
  "locale:zh": "Chinese",
  "locale:pt": "Portuguese",
  "locale:ru": "Russian",
  "platform:desktop": "Desktop",
  "platform:mobile": "Mobile",
  "platform:tablet": "Tablet",
  "audience:developer": "Developers",
  "audience:student": "Students",
  "audience:professional": "Professionals",
  "audience:creator": "Creators",
  "audience:investor": "Investors",
};

// Build reverse lookup: hash → display label
const TAG_HASH_TO_LABEL = new Map<string, string>();
for (const tag of ALL_TAGS) {
  const hash = tagHash(tag);
  TAG_HASH_TO_LABEL.set(hash.toLowerCase(), TAG_LABELS[tag] ?? tag);
}

// Build reverse lookup: display label → tag string
for (const [tagStr, label] of Object.entries(TAG_LABELS)) {
  TAG_LABEL_TO_STRING.set(label, tagStr);
}

/**
 * Validate a custom tag string. Must be "dimension:value" format.
 * Returns a normalized tag string or null if invalid.
 */
export function validateCustomTag(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.includes(":")) return null;
  const [dimension, ...rest] = trimmed.split(":");
  const value = rest.join(":");
  if (!dimension || !value) return null;
  // Only allow alphanumeric, hyphens, underscores
  if (!/^[a-z0-9-]+$/.test(dimension) || !/^[a-z0-9-]+$/.test(value)) return null;
  return `${dimension}:${value}`;
}

/**
 * Get a human-readable label for a tag. Falls back to formatting the raw string.
 */
export function tagDisplayLabel(tag: string): string {
  if (TAG_LABELS[tag]) return TAG_LABELS[tag];
  // Format "dimension:some-value" → "Some Value"
  const parts = tag.split(":");
  const value = parts[parts.length - 1];
  return value.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
