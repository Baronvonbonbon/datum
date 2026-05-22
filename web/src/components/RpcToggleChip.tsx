// RpcToggleChip — header switch that controls the centralized-RPC
// fallback path. Pine is always the primary chain-access path; this
// toggle gates whether the app may consult the public Paseo RPC for
// history beyond pine's rolling window.
//
// Default: OFF. Pine reads are trustless and metadata-private; the
// only thing RPC adds is older history. The toggle's hover tooltip
// explains the tradeoff before users flip it on.

import { useState } from "react";
import { useSettings } from "../context/SettingsContext";

const TOOLTIP = [
  "RPC is provided for historical lookup but may expose metadata to the gateway.",
  "",
  "The pine/smoldot path is preferred for most interactions and runs as a",
  "light client validation node in your browser — your queries never leave",
  "the device. Pine indexes from the moment you connect, so anything older",
  "than that requires an RPC fetch.",
  "",
  "Toggle on if you need to load history that predates this session.",
].join("\n");

export function RpcToggleChip() {
  const { settings, updateSettings } = useSettings();
  const on = settings.rpcEnabled === true;
  // Re-render on hover so the tooltip stays in sync if the toggle is flipped
  // via keyboard during inspection.
  const [, force] = useState(0);

  function toggle() {
    updateSettings({ rpcEnabled: !on });
    force((n) => n + 1);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={TOOLTIP}
      aria-pressed={on}
      className="nano-rpc-toggle"
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
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: on ? "var(--warn, #b48a00)" : "var(--text-muted)",
          opacity: on ? 1 : 0.45,
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      <span>rpc</span>
      <span style={{ color: on ? "var(--warn, #b48a00)" : "var(--text-muted)", fontWeight: 600 }}>
        {on ? "on" : "off"}
      </span>
    </button>
  );
}
