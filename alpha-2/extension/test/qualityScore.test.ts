import "./chromeMock";
import { computeQualityScore, meetsQualityThreshold } from "@shared/qualityScore";
import { EngagementEvent } from "@shared/types";

function makeEvent(overrides: Partial<EngagementEvent> = {}): EngagementEvent {
  return {
    campaignId: "1",
    dwellMs: 3000,
    scrollDepthPct: 50,
    tabFocusMs: 2000,
    viewableMs: 2000,
    iabViewable: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("computeQualityScore", () => {
  test("maximum quality engagement", () => {
    const event = makeEvent({
      dwellMs: 5000,      // max dwell → 0.35
      tabFocusMs: 3000,   // max focus → 0.25
      iabViewable: true,  // → 0.25
      scrollDepthPct: 100, // max scroll → 0.15
    });
    expect(computeQualityScore(event)).toBe(1.0);
  });

  test("zero engagement", () => {
    const event = makeEvent({
      dwellMs: 0,
      tabFocusMs: 0,
      iabViewable: false,
      scrollDepthPct: 0,
    });
    expect(computeQualityScore(event)).toBe(0);
  });

  test("dwell-only quality", () => {
    const event = makeEvent({
      dwellMs: 2500,       // 2500/5000 * 0.35 = 0.175
      tabFocusMs: 0,
      iabViewable: false,
      scrollDepthPct: 0,
    });
    expect(computeQualityScore(event)).toBe(0.18); // rounded
  });

  test("viewable adds 0.25", () => {
    const noView = makeEvent({ iabViewable: false });
    const withView = makeEvent({ iabViewable: true });
    const diff = computeQualityScore(withView) - computeQualityScore(noView);
    expect(diff).toBeCloseTo(0.25, 10);
  });

  test("score capped at 1.0 even with excessive values", () => {
    const event = makeEvent({
      dwellMs: 100000,
      tabFocusMs: 100000,
      iabViewable: true,
      scrollDepthPct: 500,
    });
    expect(computeQualityScore(event)).toBe(1.0);
  });

  test("partial dwell and focus", () => {
    const event = makeEvent({
      dwellMs: 1000,        // 1000/5000 * 0.35 = 0.07
      tabFocusMs: 1000,     // 1000/3000 * 0.25 ≈ 0.083
      iabViewable: false,
      scrollDepthPct: 30,   // 30/100 * 0.15 = 0.045
    });
    const score = computeQualityScore(event);
    expect(score).toBeGreaterThan(0.15);
    expect(score).toBeLessThan(0.25);
  });
});

describe("meetsQualityThreshold", () => {
  test("good engagement meets threshold", () => {
    const event = makeEvent({
      dwellMs: 3000,
      tabFocusMs: 2000,
      iabViewable: true,
      scrollDepthPct: 50,
    });
    expect(meetsQualityThreshold(event)).toBe(true);
  });

  test("dwell below 200ms fails threshold", () => {
    const event = makeEvent({ dwellMs: 50 });
    expect(meetsQualityThreshold(event)).toBe(false);
  });

  test("tab focus below 100ms fails threshold", () => {
    const event = makeEvent({ tabFocusMs: 50 });
    expect(meetsQualityThreshold(event)).toBe(false);
  });

  test("exactly at dwell minimum", () => {
    const event = makeEvent({
      dwellMs: 200,         // exactly at MIN_DWELL_MS (alpha)
      tabFocusMs: 100,      // exactly at MIN_TAB_FOCUS_MS (alpha)
      iabViewable: true,    // +0.25
      scrollDepthPct: 50,   // some scroll
    });
    // Score: 0.014 + 0.008 + 0.25 + 0.075 = 0.35 → above 0.05 threshold
    expect(meetsQualityThreshold(event)).toBe(true);
  });

  test("very low quality below 0.05 score fails", () => {
    const event = makeEvent({
      dwellMs: 200,       // just above min
      tabFocusMs: 100,    // just above min
      iabViewable: false, // no viewable bonus
      scrollDepthPct: 0,  // no scroll
    });
    // Score: 0.014 + 0.008 = 0.02 → below 0.05
    expect(meetsQualityThreshold(event)).toBe(false);
  });
});
