// Engagement capture — tracks standard viewability signals per impression.
// Captures dwell time, scroll depth, tab focus, viewability.
// Data sent to background for behavior chain on ad close or page unload.
// Quality scoring: impressions below threshold are rejected before claims.

import { EngagementEvent } from "@shared/types";

// Engagement quality thresholds
const MIN_DWELL_MS = 1000;         // ad must be visible >=1s
const MIN_TAB_FOCUS_MS = 500;      // tab must be focused >=0.5s
const MIN_QUALITY_SCORE = 0.3;     // minimum composite quality to record claim

/**
 * Compute engagement quality score (0.0 - 1.0).
 * Combines dwell time, tab focus, viewability, and scroll engagement.
 * Used to gate impression recording and weight clearing CPM.
 */
export function computeQualityScore(event: EngagementEvent): number {
  // Dwell component: 0-0.35 (linear to 5s, capped)
  const dwellScore = Math.min(event.dwellMs / 5000, 1) * 0.35;

  // Tab focus component: 0-0.25 (linear to 3s, capped)
  const focusScore = Math.min(event.tabFocusMs / 3000, 1) * 0.25;

  // Viewability: 0 or 0.25
  const viewableScore = event.iabViewable ? 0.25 : 0;

  // Scroll engagement: 0-0.15 (visited more of page = more engaged)
  const scrollScore = Math.min(event.scrollDepthPct / 100, 1) * 0.15;

  return Math.round((dwellScore + focusScore + viewableScore + scrollScore) * 100) / 100;
}

/**
 * Check if engagement meets minimum quality threshold for claiming.
 */
export function meetsQualityThreshold(event: EngagementEvent): boolean {
  if (event.dwellMs < MIN_DWELL_MS) return false;
  if (event.tabFocusMs < MIN_TAB_FOCUS_MS) return false;
  return computeQualityScore(event) >= MIN_QUALITY_SCORE;
}

interface TrackingState {
  campaignId: string;
  startTime: number;
  dwellMs: number;
  viewableMs: number;
  viewableStart: number | null;
  tabFocusMs: number;
  tabFocusStart: number | null;
  scrollDepthPct: number;
  iabViewable: boolean;    // >=50% visible for >=1s continuous
  intersecting: boolean;
  observer: IntersectionObserver | null;
  sent: boolean;
}

let active: TrackingState | null = null;

export function startTracking(campaignId: string, adElement: HTMLElement): void {
  if (active) return; // only one tracking at a time

  const now = Date.now();
  const state: TrackingState = {
    campaignId,
    startTime: now,
    dwellMs: 0,
    viewableMs: 0,
    viewableStart: null,
    tabFocusMs: 0,
    tabFocusStart: document.visibilityState === "visible" ? now : null,
    scrollDepthPct: getScrollDepth(),
    iabViewable: false,
    intersecting: false,
    observer: null,
    sent: false,
  };

  // IntersectionObserver for viewport tracking (50% threshold)
  state.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const wasIntersecting = state.intersecting;
        state.intersecting = entry.isIntersecting;

        if (entry.isIntersecting && !wasIntersecting) {
          state.viewableStart = Date.now();
        } else if (!entry.isIntersecting && wasIntersecting && state.viewableStart) {
          const viewTime = Date.now() - state.viewableStart;
          state.viewableMs += viewTime;
          state.dwellMs += viewTime;
          state.viewableStart = null;
        }

        // Viewability: >=50% visible for >=1s continuous
        if (entry.isIntersecting && state.viewableStart) {
          setTimeout(() => {
            if (state.intersecting && state.viewableStart) {
              const continuous = Date.now() - state.viewableStart;
              if (continuous >= 1000) {
                state.iabViewable = true;
              }
            }
          }, 1000);
        }
      }
    },
    { threshold: 0.5 }
  );
  state.observer.observe(adElement);

  // Visibility change listener for tab focus tracking
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      state.tabFocusStart = Date.now();
    } else if (state.tabFocusStart) {
      state.tabFocusMs += Date.now() - state.tabFocusStart;
      state.tabFocusStart = null;
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Scroll depth tracking
  const onScroll = () => {
    const depth = getScrollDepth();
    if (depth > state.scrollDepthPct) {
      state.scrollDepthPct = depth;
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  // Mutation observer to detect ad removal
  const mutationObserver = new MutationObserver(() => {
    if (!document.body.contains(adElement)) {
      finalize(state);
      mutationObserver.disconnect();
    }
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  // Page unload
  const onUnload = () => finalize(state);
  window.addEventListener("beforeunload", onUnload);

  // Store cleanup refs
  active = state;
  (state as any)._cleanup = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("beforeunload", onUnload);
    state.observer?.disconnect();
    mutationObserver.disconnect();
  };
}

function finalize(state: TrackingState): void {
  if (state.sent) return;
  state.sent = true;

  // Finalize in-progress measurements
  const now = Date.now();
  if (state.viewableStart && state.intersecting) {
    state.viewableMs += now - state.viewableStart;
    state.dwellMs += now - state.viewableStart;
  }
  if (state.tabFocusStart) {
    state.tabFocusMs += now - state.tabFocusStart;
  }

  // Minimum tracking duration: 500ms (ignore accidental closes)
  const elapsed = now - state.startTime;
  if (elapsed < 500) return;

  const event: EngagementEvent = {
    campaignId: state.campaignId,
    dwellMs: state.dwellMs,
    scrollDepthPct: state.scrollDepthPct,
    tabFocusMs: state.tabFocusMs,
    viewableMs: state.viewableMs,
    iabViewable: state.iabViewable,
    timestamp: now,
  };

  // Always send engagement data to background for behavior chain
  chrome.runtime.sendMessage({ type: "ENGAGEMENT_RECORDED", event });

  // Gate impression recording on quality threshold
  if (meetsQualityThreshold(event)) {
    const qualityScore = computeQualityScore(event);
    chrome.runtime.sendMessage({
      type: "ENGAGEMENT_QUALITY_RESULT",
      campaignId: state.campaignId,
      qualityScore,
      passed: true,
    });
  } else {
    chrome.runtime.sendMessage({
      type: "ENGAGEMENT_QUALITY_RESULT",
      campaignId: state.campaignId,
      qualityScore: computeQualityScore(event),
      passed: false,
    });
  }

  // Cleanup
  (state as any)._cleanup?.();
  active = null;
}

function getScrollDepth(): number {
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const scrollHeight = document.documentElement.scrollHeight;
  const clientHeight = document.documentElement.clientHeight;
  if (scrollHeight <= clientHeight) return 100;
  return Math.round((scrollTop / (scrollHeight - clientHeight)) * 100);
}
