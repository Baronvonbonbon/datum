import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { getPineProvider } from "./lib/provider";

// Kick off pine smoldot init the moment the bundle parses. Without
// this, the dashboards' useLogs / useHeroStat subscribers wait on
// status transitions that never fire (pine's getPineProvider is
// lazy + idempotent — listeners need somebody to call it first).
// Errors are swallowed here because the provider's setStatus path
// surfaces the error state to PineWarmUpBanner + PineStatusChip on
// its own.
void getPineProvider().catch(() => undefined);

// Auto-recover from stale chunk references across deploys. The app code-splits
// (Pine/smoldot, route chunks), and each deploy rehashes those filenames — an open
// tab that lazily imports an old hash gets "Failed to fetch dynamically imported
// module" and the failure is cached until reload. Listen for vite's preloadError and
// reload once to pick up the new index + chunks (sessionStorage-guarded vs loops).
window.addEventListener("vite:preloadError", (e: Event) => {
  const KEY = "datum:preload-reloaded-at";
  const last = Number(sessionStorage.getItem(KEY) || "0");
  if (Date.now() - last < 15000) return; // already reloaded recently — avoid a loop
  sessionStorage.setItem(KEY, String(Date.now()));
  (e as Event & { preventDefault?: () => void }).preventDefault?.();
  location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
