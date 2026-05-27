// Tests for resolveCreativeImage + resolveImageUrl — the format-aware
// creative-selection logic used by the ad-slot renderer.
//
// Verifies the whole advertiser → publisher flow:
//   1. Advertiser provides multiple format-keyed images in creative.images
//   2. Publisher SDK declares its slot's format
//   3. Extension picks the exact-format match, or falls back gracefully
//
// Coverage:
//   - exact format match takes precedence
//   - legacy creative.imageUrl is used when no images array
//   - empty images array falls back to legacy imageUrl
//   - format=undefined falls back to first image in the array
//   - missing slot format with images present still returns something
//   - both fields empty → null (text-only render)
//   - IPFS CID URLs resolve via gateway
//   - HTTPS URLs pass through unchanged
//   - non-https / non-CID URLs return null (security)

import "./chromeMock";
import {
  resolveCreativeImage,
  resolveImageUrl,
} from "../src/content/adSlot";

// Minimal creative shape mirroring CampaignMetadata.creative on the
// receiving side. The cast is intentional — we don't want to drag
// CreativeAsset's full type into a unit test.
function mkCreative(opts: {
  imageUrl?: string;
  images?: Array<{ format: string; url: string; alt?: string }>;
}) {
  return {
    type: "text" as const,
    text: "ad text",
    cta: "Learn",
    ctaUrl: "https://example.com",
    ...(opts.imageUrl ? { imageUrl: opts.imageUrl } : {}),
    ...(opts.images ? { images: opts.images as any } : {}),
  };
}

const GATEWAY = "https://ipfs.io/ipfs/";

describe("resolveImageUrl — URL gateway resolution", () => {
  it("passes through HTTPS URLs unchanged", () => {
    expect(resolveImageUrl("https://cdn.example/banner.png", GATEWAY))
      .toBe("https://cdn.example/banner.png");
  });

  it("resolves a bare IPFS CIDv0 via the gateway", () => {
    const cid = "Qmd3HtSerynPjp9aabPjpz5G3DRBnhTu9N3Jf1xeCEPNAm";
    expect(resolveImageUrl(cid, GATEWAY))
      .toBe(`${GATEWAY}${cid}`);
  });

  it("returns null for non-https, non-CID URLs", () => {
    expect(resolveImageUrl("http://insecure.example/x.png", GATEWAY)).toBeNull();
    expect(resolveImageUrl("javascript:alert(1)", GATEWAY)).toBeNull();
    expect(resolveImageUrl("", GATEWAY)).toBeNull();
  });

  it("handles missing gateway by falling back to HTTPS-only", () => {
    expect(resolveImageUrl("https://x.example/img.png")).toBe("https://x.example/img.png");
    expect(resolveImageUrl("Qmabcd", undefined)).toBeNull();
  });
});

describe("resolveCreativeImage — format-aware selection", () => {
  const leaderboard = { format: "leaderboard", url: "https://cdn.example/lb-728x90.png" };
  const medium = { format: "medium-rectangle", url: "https://cdn.example/mr-300x250.png" };
  const banner = { format: "mobile-banner", url: "https://cdn.example/mb-320x50.png" };

  it("picks the exact-format image when slot format matches", () => {
    const c = mkCreative({ images: [leaderboard, medium, banner] });
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY))
      .toBe(leaderboard.url);
    expect(resolveCreativeImage(c, "medium-rectangle", GATEWAY))
      .toBe(medium.url);
    expect(resolveCreativeImage(c, "mobile-banner", GATEWAY))
      .toBe(banner.url);
  });

  it("falls back to the first image when slot format has no exact match", () => {
    const c = mkCreative({ images: [leaderboard, medium] });
    expect(resolveCreativeImage(c, "wide-skyscraper", GATEWAY))
      .toBe(leaderboard.url);
  });

  it("falls back to the first image when slot format is undefined", () => {
    const c = mkCreative({ images: [leaderboard, medium] });
    expect(resolveCreativeImage(c, undefined, GATEWAY))
      .toBe(leaderboard.url);
  });

  it("falls back to legacy imageUrl when no images array", () => {
    const c = mkCreative({ imageUrl: "https://cdn.example/legacy.png" });
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY))
      .toBe("https://cdn.example/legacy.png");
  });

  it("falls back to legacy imageUrl when images array is empty", () => {
    const c = mkCreative({ images: [], imageUrl: "https://cdn.example/legacy.png" });
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY))
      .toBe("https://cdn.example/legacy.png");
  });

  it("returns null when nothing is set", () => {
    const c = mkCreative({});
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY)).toBeNull();
  });

  it("prefers exact-format match over legacy imageUrl", () => {
    const c = mkCreative({
      images: [leaderboard],
      imageUrl: "https://cdn.example/legacy.png",
    });
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY))
      .toBe(leaderboard.url);
  });

  it("resolves IPFS CIDs in per-format images", () => {
    const cid = "Qmd3HtSerynPjp9aabPjpz5G3DRBnhTu9N3Jf1xeCEPNAm";
    const c = mkCreative({
      images: [{ format: "leaderboard", url: cid }],
    });
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY))
      .toBe(`${GATEWAY}${cid}`);
  });

  it("skips an invalid per-format URL but tries the fallback", () => {
    // The selected per-format image's URL fails the resolveImageUrl
    // security check; we then fall back to the legacy imageUrl.
    const c = mkCreative({
      images: [{ format: "leaderboard", url: "http://insecure.example/x.png" }],
      imageUrl: "https://cdn.example/legacy.png",
    });
    expect(resolveCreativeImage(c, "leaderboard", GATEWAY))
      .toBe("https://cdn.example/legacy.png");
  });

  it("handles every IAB format the type system declares", () => {
    const allFormats: Array<{ format: string; url: string }> = [
      { format: "leaderboard",      url: "https://cdn.example/728x90.png"  },
      { format: "medium-rectangle", url: "https://cdn.example/300x250.png" },
      { format: "wide-skyscraper",  url: "https://cdn.example/160x600.png" },
      { format: "half-page",        url: "https://cdn.example/300x600.png" },
      { format: "mobile-banner",    url: "https://cdn.example/320x50.png"  },
      { format: "square",           url: "https://cdn.example/250x250.png" },
      { format: "large-rectangle",  url: "https://cdn.example/336x280.png" },
    ];
    const c = mkCreative({ images: allFormats });
    for (const { format, url } of allFormats) {
      expect(resolveCreativeImage(c, format, GATEWAY)).toBe(url);
    }
  });
});
