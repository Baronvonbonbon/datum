// Content safety validation for ad creative metadata.
// Validates schema shape, URL schemes, and content blocklist before rendering.

import { CampaignMetadata, AdFormat } from "./types";

// Field length caps
const MAX_TITLE = 128;
const MAX_DESCRIPTION = 256;
const MAX_CATEGORY = 64;
const MAX_CREATIVE_TEXT = 512;
const MAX_CTA = 64;
const MAX_CTA_URL = 2048;
const MAX_IMAGE_URL = 2048;
const MAX_IMAGES = 7; // one per AdFormat

const VALID_AD_FORMATS = new Set<AdFormat>([
  "leaderboard", "medium-rectangle", "wide-skyscraper",
  "half-page", "mobile-banner", "square", "large-rectangle",
]);

// Metadata byte-size cap (checked before JSON.parse in campaignPoller)
export const MAX_METADATA_BYTES = 10_240; // 10 KB

export interface ValidationResult {
  valid: boolean;
  error?: string;
  data?: CampaignMetadata;
}

/**
 * Runtime shape check + field length validation.
 * Returns validated copy or error.
 */
export function validateMetadata(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object") {
    return { valid: false, error: "metadata is not an object" };
  }

  const obj = raw as Record<string, unknown>;

  // Required string fields
  if (typeof obj.title !== "string") return { valid: false, error: "missing or invalid title" };
  if (typeof obj.description !== "string") return { valid: false, error: "missing or invalid description" };
  if (typeof obj.category !== "string") return { valid: false, error: "missing or invalid category" };
  if (typeof obj.version !== "number") return { valid: false, error: "missing or invalid version" };

  // Creative sub-object
  if (obj.creative === null || typeof obj.creative !== "object") {
    return { valid: false, error: "missing or invalid creative" };
  }
  const creative = obj.creative as Record<string, unknown>;
  if (creative.type !== "text") return { valid: false, error: "creative.type must be \"text\"" };
  if (typeof creative.text !== "string") return { valid: false, error: "missing creative.text" };
  if (typeof creative.cta !== "string") return { valid: false, error: "missing creative.cta" };
  if (typeof creative.ctaUrl !== "string") return { valid: false, error: "missing creative.ctaUrl" };

  // Length caps
  if (obj.title.length > MAX_TITLE) return { valid: false, error: `title exceeds ${MAX_TITLE} chars` };
  if (obj.description.length > MAX_DESCRIPTION) return { valid: false, error: `description exceeds ${MAX_DESCRIPTION} chars` };
  if (obj.category.length > MAX_CATEGORY) return { valid: false, error: `category exceeds ${MAX_CATEGORY} chars` };
  if ((creative.text as string).length > MAX_CREATIVE_TEXT) return { valid: false, error: `creative.text exceeds ${MAX_CREATIVE_TEXT} chars` };
  if ((creative.cta as string).length > MAX_CTA) return { valid: false, error: `creative.cta exceeds ${MAX_CTA} chars` };
  if ((creative.ctaUrl as string).length > MAX_CTA_URL) return { valid: false, error: `creative.ctaUrl exceeds ${MAX_CTA_URL} chars` };

  // Optional single image URL validation
  if (creative.imageUrl !== undefined) {
    if (typeof creative.imageUrl !== "string") return { valid: false, error: "creative.imageUrl must be a string" };
    if ((creative.imageUrl as string).length > MAX_IMAGE_URL) return { valid: false, error: `creative.imageUrl exceeds ${MAX_IMAGE_URL} chars` };
  }

  // Optional per-format images array validation
  let validatedImages: CampaignMetadata["creative"]["images"] | undefined;
  if (creative.images !== undefined) {
    if (!Array.isArray(creative.images)) return { valid: false, error: "creative.images must be an array" };
    if ((creative.images as unknown[]).length > MAX_IMAGES) return { valid: false, error: `creative.images exceeds ${MAX_IMAGES} entries` };
    validatedImages = [];
    for (const entry of creative.images as unknown[]) {
      if (entry === null || typeof entry !== "object") return { valid: false, error: "creative.images entry must be an object" };
      const e = entry as Record<string, unknown>;
      if (typeof e.format !== "string" || !VALID_AD_FORMATS.has(e.format as AdFormat)) {
        return { valid: false, error: `creative.images entry has invalid format: ${e.format}` };
      }
      if (typeof e.url !== "string") return { valid: false, error: "creative.images entry missing url" };
      if (e.url.length > MAX_IMAGE_URL) return { valid: false, error: `creative.images entry url exceeds ${MAX_IMAGE_URL} chars` };
      validatedImages.push({
        format: e.format as AdFormat,
        url: e.url as string,
        ...(typeof e.alt === "string" && e.alt ? { alt: e.alt as string } : {}),
      });
    }
  }

  const data: CampaignMetadata = {
    title: obj.title as string,
    description: obj.description as string,
    category: obj.category as string,
    version: obj.version as number,
    creative: {
      type: "text",
      text: creative.text as string,
      cta: creative.cta as string,
      ctaUrl: creative.ctaUrl as string,
      ...(typeof creative.imageUrl === "string" && creative.imageUrl ? { imageUrl: creative.imageUrl } : {}),
      ...(validatedImages && validatedImages.length > 0 ? { images: validatedImages } : {}),
    },
  };

  return { valid: true, data };
}

/**
 * Allowlist CTA URL scheme: only https:// passes.
 * Returns sanitized URL or null if rejected.
 */
export function sanitizeCtaUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return parsed.href;
  } catch {
    // Invalid URL
  }
  return null;
}

// Multi-word phrases to minimize false positives
const BLOCKED_PHRASES: string[] = [
  "online gambling",
  "casino games",
  "sports betting",
  "online casino",
  "slot machines",
  "adult content",
  "adult entertainment",
  "explicit content",
  "pornographic",
  "illegal drugs",
  "recreational drugs",
  "drug paraphernalia",
  "buy firearms",
  "assault weapons",
  "illegal weapons",
  "tobacco products",
  "buy cigarettes",
  "vaping products",
  "counterfeit goods",
  "replica designer",
  "fake documents",
];

/**
 * Case-insensitive substring match on concatenated text fields.
 * Returns true if metadata passes (no blocked phrases found).
 */
export function passesContentBlocklist(meta: CampaignMetadata): boolean {
  const text = [
    meta.title,
    meta.description,
    meta.category,
    meta.creative.text,
    meta.creative.cta,
  ]
    .join(" ")
    .toLowerCase();

  for (const phrase of BLOCKED_PHRASES) {
    if (text.includes(phrase)) return false;
  }
  return true;
}

/**
 * Full validation pipeline: shape → URL → blocklist.
 * Returns validated copy or null.
 */
export function validateAndSanitize(raw: unknown): CampaignMetadata | null {
  const result = validateMetadata(raw);
  if (!result.valid || !result.data) return null;

  // URL scheme check (don't reject metadata, just null-out the URL — adSlot handles fallback)
  const safeUrl = sanitizeCtaUrl(result.data.creative.ctaUrl);
  if (safeUrl) {
    result.data.creative.ctaUrl = safeUrl;
  }
  // Keep original ctaUrl if sanitization fails — adSlot will render as non-clickable span

  if (!passesContentBlocklist(result.data)) return null;

  return result.data;
}
