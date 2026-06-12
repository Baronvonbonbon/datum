import { describe, it, expect } from "vitest";
import { AD_FORMAT_SIZES, matchAdFormat, fitForTarget } from "../src/shared/types";

describe("matchAdFormat", () => {
  it("returns an exact match for every standard IAB size", () => {
    for (const [fmt, s] of Object.entries(AD_FORMAT_SIZES)) {
      expect(matchAdFormat(s.w, s.h)).toEqual({ format: fmt, exact: true });
    }
  });

  it("matches a same-ratio image to the closest format (not exact)", () => {
    // 1456×180 is 2× a leaderboard (728×90) — same ratio, retina asset.
    const m = matchAdFormat(1456, 180);
    expect(m).toEqual({ format: "leaderboard", exact: false });
  });

  it("returns null for a size with no standard ratio", () => {
    expect(matchAdFormat(500, 700)).toBeNull(); // 0.71 ratio — no standard slot
  });

  it("guards against a zero height", () => {
    expect(matchAdFormat(300, 0)).toBeNull();
  });
});

describe("fitForTarget", () => {
  it("grades a pixel-perfect image as exact", () => {
    expect(fitForTarget(300, 250, 300, 250)).toBe("exact");
  });

  it("grades a same-ratio, larger image as scales", () => {
    expect(fitForTarget(600, 500, 300, 250)).toBe("scales");
  });

  it("grades a wrong-ratio image as mismatch", () => {
    expect(fitForTarget(300, 600, 300, 250)).toBe("mismatch");
  });
});
