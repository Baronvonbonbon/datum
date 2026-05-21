// Vitest global setup — runs once before any test file.
//
// jsdom provides a real `window` + DOM APIs. We extend it with:
//   - jest-dom matchers (.toBeInTheDocument(), .toHaveClass(), etc.)
//     for React component tests once they land.
//   - A localStorage reset hook so tests that touch persisted state
//     (rpcSettings, theme prefs) start clean.

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
  // jsdom's localStorage persists across tests by default. Wipe it
  // before each test so persisted-state lookups (rpcSettings,
  // walletTheme, etc.) don't bleed.
  try {
    localStorage.clear();
  } catch {
    // Some environments (worker contexts) lack localStorage entirely.
  }
});

afterEach(() => {
  // No-op for now — placeholder for future cleanups (DOM unmount,
  // observer disconnects, etc.).
});
