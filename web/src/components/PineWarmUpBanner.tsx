// PineWarmUpBanner — global banner that surfaces while pine is
// still warming up or has hit an error.
//
// Sits below the experimental warning banner in Layout, above the
// protocol-paused banner. Auto-hides on "ready"; reappears on any
// later transition back to connecting/error so transient pine
// failures stay visible.
//
// On "error" the banner offers no retry button — pine's own
// auto-reconnect (exponential backoff up to 5 attempts) handles
// recovery. We expose the error message in the banner so the user
// can decide whether to wait or reload.

import { useEffect, useState } from "react";
import { onPineStatus, type PineStatus } from "../lib/provider";

export function PineWarmUpBanner() {
  const [status, setStatus] = useState<PineStatus | null>(null);

  useEffect(() => onPineStatus(setStatus), []);

  if (!status) return null;
  if (status.state === "ready") return null;

  const isError = status.state === "error";
  const message = buildMessage(status);

  return (
    <div
      role="status"
      style={{
        background: isError
          ? "rgba(169, 48, 48, 0.12)"
          : "rgba(180, 138, 0, 0.10)",
        color: isError ? "var(--error)" : "var(--warn)",
        borderBottom: `1px solid ${isError ? "rgba(169,48,48,0.35)" : "rgba(180,138,0,0.30)"}`,
        padding: "6px 12px",
        fontSize: 12,
        fontFamily: "var(--font-mono, ui-monospace)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isError ? "var(--error)" : "var(--warn)",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      <span>{message}</span>
    </div>
  );
}

function buildMessage(s: PineStatus): string {
  switch (s.state) {
    case "idle":
      return "Pine is starting — chain data will appear shortly.";
    case "connecting":
      return s.step
        ? `Pine syncing — ${s.step}. Some history may be unavailable until the light client is caught up.`
        : "Pine syncing — light client is warming up.";
    case "error":
      return s.error
        ? `Pine offline — ${s.error}. Auto-reconnecting…`
        : "Pine offline — auto-reconnecting…";
    default:
      return "";
  }
}
