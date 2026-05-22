// PineStatusChip — header indicator for the pine smoldot connection.
//
// Subscribes to onPineStatus() and renders a compact dot + label
// reflecting the current state. Hover (title) reveals more
// detail: peers count, sync step, finalized head, error message.
//
// Colour key:
//   idle / connecting → amber  (we're not authoritative on chain yet)
//   ready             → green
//   error             → red
//
// The chip is purely informational; clicking does nothing in
// this drop. A future drop could route to a /diagnostics page.

import { useEffect, useState } from "react";
import { onPineStatus, type PineStatus } from "../lib/provider";

export function PineStatusChip() {
  const [status, setStatus] = useState<PineStatus | null>(null);

  useEffect(() => onPineStatus(setStatus), []);

  if (!status) return null;

  const { color, label } = visualForStatus(status);
  const title = buildTitle(status);

  return (
    <span
      className="nano-pine-chip"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius, 4px)",
        fontSize: 11,
        fontFamily: "var(--font-mono, ui-monospace)",
        color: "var(--text-muted)",
        background: "var(--bg-surface, transparent)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      <span>pine</span>
      <span style={{ color: "var(--text-strong)" }}>{label}</span>
    </span>
  );
}

function visualForStatus(s: PineStatus): { color: string; label: string } {
  switch (s.state) {
    case "ready":
      return {
        color: "var(--ok, #2c8a3a)",
        label:
          s.finalizedHead > 0 ? `#${s.finalizedHead.toLocaleString()}` : "ready",
      };
    case "connecting":
      return {
        color: "var(--warn, #b48a00)",
        label: s.step ? truncate(s.step, 22) : "connecting…",
      };
    case "error":
      return {
        color: "var(--error, #a93030)",
        label: "offline",
      };
    case "idle":
    default:
      return {
        color: "var(--warn, #b48a00)",
        label: "starting…",
      };
  }
}

function buildTitle(s: PineStatus): string {
  const lines = [
    `pine state: ${s.state}`,
    `step: ${s.step || "—"}`,
    `peers: ${s.peers}`,
    `finalized: ${s.finalizedHead > 0 ? "#" + s.finalizedHead.toLocaleString() : "—"}`,
    `indexed from: ${s.indexedFromBlock > 0 ? "#" + s.indexedFromBlock.toLocaleString() : "—"}`,
  ];
  if (s.error) lines.push(`error: ${s.error}`);
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
