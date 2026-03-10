// Quality scoring — pure functions for engagement quality assessment.
// Shared between background (trusted computation) and content (display only).
// Moved from content/engagement.ts to prevent untrusted page scripts
// from influencing quality-gated claim decisions.

import { EngagementEvent } from "./types";

// Engagement quality thresholds
const MIN_DWELL_MS = 1000;         // ad must be visible >=1s
const MIN_TAB_FOCUS_MS = 500;      // tab must be focused >=0.5s
const MIN_QUALITY_SCORE = 0.3;     // minimum composite quality to record claim

/**
 * Compute engagement quality score (0.0 - 1.0).
 * Combines dwell time, tab focus, viewability, and scroll engagement.
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
