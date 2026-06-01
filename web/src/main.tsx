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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
