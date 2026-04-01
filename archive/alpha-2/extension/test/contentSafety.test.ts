import "./chromeMock";
import {
  validateMetadata,
  sanitizeCtaUrl,
  passesContentBlocklist,
  validateAndSanitize,
  MAX_METADATA_BYTES,
} from "@shared/contentSafety";

function validMeta(overrides: Record<string, any> = {}) {
  return {
    title: "Test Campaign",
    description: "A test campaign for unit testing",
    category: "Technology",
    version: 1,
    creative: {
      type: "text",
      text: "Check out this ad",
      cta: "Learn More",
      ctaUrl: "https://example.com/landing",
    },
    ...overrides,
  };
}

describe("validateMetadata", () => {
  test("valid metadata passes", () => {
    const result = validateMetadata(validMeta());
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.title).toBe("Test Campaign");
  });

  test("null input rejected", () => {
    expect(validateMetadata(null).valid).toBe(false);
  });

  test("string input rejected", () => {
    expect(validateMetadata("string").valid).toBe(false);
  });

  test("missing title rejected", () => {
    const m = validMeta();
    delete (m as any).title;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("missing description rejected", () => {
    const m = validMeta();
    delete (m as any).description;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("missing category rejected", () => {
    const m = validMeta();
    delete (m as any).category;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("missing version rejected", () => {
    const m = validMeta();
    delete (m as any).version;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("string version rejected", () => {
    expect(validateMetadata(validMeta({ version: "1" })).valid).toBe(false);
  });

  test("missing creative rejected", () => {
    expect(validateMetadata(validMeta({ creative: null })).valid).toBe(false);
  });

  test("wrong creative.type rejected", () => {
    const m = validMeta();
    m.creative.type = "image" as any;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("missing creative.text rejected", () => {
    const m = validMeta();
    delete (m as any).creative.text;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("missing creative.cta rejected", () => {
    const m = validMeta();
    delete (m as any).creative.cta;
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("missing creative.ctaUrl rejected", () => {
    const m = validMeta();
    delete (m as any).creative.ctaUrl;
    expect(validateMetadata(m).valid).toBe(false);
  });

  // Length caps
  test("title exceeding 128 chars rejected", () => {
    expect(validateMetadata(validMeta({ title: "x".repeat(129) })).valid).toBe(false);
  });

  test("title at exactly 128 chars passes", () => {
    expect(validateMetadata(validMeta({ title: "x".repeat(128) })).valid).toBe(true);
  });

  test("description exceeding 256 chars rejected", () => {
    expect(validateMetadata(validMeta({ description: "x".repeat(257) })).valid).toBe(false);
  });

  test("category exceeding 64 chars rejected", () => {
    expect(validateMetadata(validMeta({ category: "x".repeat(65) })).valid).toBe(false);
  });

  test("creative.text exceeding 512 chars rejected", () => {
    const m = validMeta();
    m.creative.text = "x".repeat(513);
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("creative.cta exceeding 64 chars rejected", () => {
    const m = validMeta();
    m.creative.cta = "x".repeat(65);
    expect(validateMetadata(m).valid).toBe(false);
  });

  test("creative.ctaUrl exceeding 2048 chars rejected", () => {
    const m = validMeta();
    m.creative.ctaUrl = "https://example.com/" + "x".repeat(2030);
    expect(validateMetadata(m).valid).toBe(false);
  });
});

describe("sanitizeCtaUrl", () => {
  test("https URL passes", () => {
    expect(sanitizeCtaUrl("https://example.com")).toBe("https://example.com/");
  });

  test("https with path passes", () => {
    expect(sanitizeCtaUrl("https://example.com/page?q=1")).toBe("https://example.com/page?q=1");
  });

  test("http URL rejected", () => {
    expect(sanitizeCtaUrl("http://example.com")).toBeNull();
  });

  test("javascript: URL rejected", () => {
    expect(sanitizeCtaUrl("javascript:alert(1)")).toBeNull();
  });

  test("data: URL rejected", () => {
    expect(sanitizeCtaUrl("data:text/html,<h1>XSS</h1>")).toBeNull();
  });

  test("ftp: URL rejected", () => {
    expect(sanitizeCtaUrl("ftp://files.example.com")).toBeNull();
  });

  test("invalid URL rejected", () => {
    expect(sanitizeCtaUrl("not a url")).toBeNull();
  });

  test("empty string rejected", () => {
    expect(sanitizeCtaUrl("")).toBeNull();
  });
});

describe("passesContentBlocklist", () => {
  test("clean metadata passes", () => {
    const m = validMeta();
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(true);
  });

  test("blocked phrase in title fails", () => {
    const m = validMeta({ title: "Best Online Gambling Site" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("blocked phrase in description fails", () => {
    const m = validMeta({ description: "Enjoy our casino games and win" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("blocked phrase in creative text fails", () => {
    const m = validMeta();
    m.creative.text = "Buy illegal drugs here";
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("blocked phrase in CTA fails", () => {
    const m = validMeta();
    m.creative.cta = "Buy Firearms Now";
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("case insensitive blocking", () => {
    const m = validMeta({ title: "SPORTS BETTING Tips" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("partial word does not trigger (multi-word phrases)", () => {
    // "adult" alone should not trigger — "adult content" is the phrase
    const m = validMeta({ title: "Adult Education Program" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(true);
  });

  // UB-1: Unicode normalization
  test("unicode homoglyphs detected (NFKD normalization)", () => {
    // "ﬁrearms" uses the ﬁ ligature (U+FB01) → normalized to "firearms"
    const m = validMeta({ title: "Buy \uFB01rearms today" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("accented chars normalized (diacritical stripping)", () => {
    // "càsino gàmes" → "casino games"
    const m = validMeta({ title: "Best c\u00E0sino g\u00E0mes" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  // UB-1: Leetspeak detection
  test("leetspeak substitution blocked (0nline g@mbling)", () => {
    const m = validMeta({ title: "0nline g@mbling" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("leetspeak substitution blocked ($ports b3tting)", () => {
    const m = validMeta({ title: "$port$ b3tting tips" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("leetspeak in creative text blocked", () => {
    const m = validMeta();
    m.creative.text = "Buy !llegal drug$ here";
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(false);
  });

  test("clean text with numbers passes (no false positives)", () => {
    const m = validMeta({ title: "Top 10 Tools for 2025" });
    const result = validateMetadata(m);
    expect(passesContentBlocklist(result.data!)).toBe(true);
  });
});

describe("validateAndSanitize", () => {
  test("valid metadata with https URL passes", () => {
    const result = validateAndSanitize(validMeta());
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Test Campaign");
    expect(result!.creative.ctaUrl).toBe("https://example.com/landing");
  });

  test("blocked content returns null", () => {
    const result = validateAndSanitize(validMeta({ title: "Online Casino Bonus" }));
    expect(result).toBeNull();
  });

  test("invalid shape returns null", () => {
    expect(validateAndSanitize(null)).toBeNull();
    expect(validateAndSanitize("string")).toBeNull();
    expect(validateAndSanitize({})).toBeNull();
  });

  test("http CTA URL preserved (adSlot handles fallback)", () => {
    const m = validMeta();
    m.creative.ctaUrl = "http://insecure.example.com";
    const result = validateAndSanitize(m);
    // Should still return metadata — http URL is kept for adSlot to render as non-clickable
    expect(result).not.toBeNull();
    expect(result!.creative.ctaUrl).toBe("http://insecure.example.com");
  });

  test("MAX_METADATA_BYTES constant is 10KB", () => {
    expect(MAX_METADATA_BYTES).toBe(10_240);
  });
});
