// EnableRpcCta — surfaced on pages that need history older than
// pine's rolling window. Flips the rpcEnabled toggle inline so the
// user doesn't have to dig through settings.
//
// Two opt-in modes:
//   - **Pull once via RPC** (preferred): runs the page-supplied
//     `onOneShot` fetch with rpc enabled, then auto-disables. The
//     gateway sees one batch of queries; RPC closes the moment the
//     fetch settles. Only rendered when the page passes `onOneShot`.
//   - **Enable for this session**: turns rpc on and leaves it on.
//     User has to flip the header chip to disable.

import { useState } from "react";
import { useSettings } from "../context/SettingsContext";

export function EnableRpcCta({
  what,
  onOneShot,
}: {
  /// One short clause describing what the page is trying to load.
  /// Used in the prompt: "{what} sits outside pine's rolling window."
  /// E.g. "settlement history", "past governance votes".
  what?: string;
  /// Optional page-supplied fetch. When provided, the CTA renders a
  /// "Pull once via RPC" button that enables RPC, awaits the fetch,
  /// then disables RPC again — minimising the metadata-exposure
  /// window to the duration of one batch of queries. Settles cleanly
  /// on both success and error.
  onOneShot?: () => Promise<unknown>;
}) {
  const { settings, updateSettings } = useSettings();
  const [oneShotActive, setOneShotActive] = useState(false);
  if (settings.rpcEnabled) return null;

  async function handleOneShot() {
    if (!onOneShot) return;
    setOneShotActive(true);
    updateSettings({ rpcEnabled: true });
    try {
      await onOneShot();
    } catch (err) {
      // Surfaced by the page's own error handling; we just need to
      // make sure rpc disables either way.
      console.warn("[EnableRpcCta] one-shot fetch errored", err);
    } finally {
      updateSettings({ rpcEnabled: false });
      setOneShotActive(false);
    }
  }

  return (
    <div
      className="nano-card"
      style={{
        padding: "18px 20px",
        borderColor: "rgba(180,138,0,0.4)",
        background: "rgba(180,138,0,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--warn, #b48a00)",
            display: "inline-block",
          }}
        />
        <strong style={{ color: "var(--warn, #b48a00)", fontSize: 13, letterSpacing: "0.03em" }}>
          Historical data needs RPC
        </strong>
      </div>
      <p style={{ fontSize: 13, color: "var(--text)", margin: 0, lineHeight: 1.6 }}>
        {what ? `${what} sits ` : "Some of this data sits "}
        outside pine's rolling window. Pine validates blocks trustlessly in your
        browser, but only indexes from when you connected — older history must
        be fetched from a centralized RPC gateway, which exposes query metadata
        to that gateway.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {onOneShot && (
          <button
            type="button"
            onClick={handleOneShot}
            disabled={oneShotActive}
            className="nano-btn nano-btn-accent"
            style={{ fontSize: 12, padding: "6px 14px" }}
            title="Enables RPC for the duration of this one fetch, then turns it off automatically."
          >
            {oneShotActive ? "Pulling…" : "Pull once via RPC"}
          </button>
        )}
        <button
          type="button"
          onClick={() => updateSettings({ rpcEnabled: true })}
          disabled={oneShotActive}
          className={onOneShot ? "nano-btn" : "nano-btn nano-btn-accent"}
          style={{ fontSize: 12, padding: "6px 14px" }}
        >
          Enable for this session
        </button>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {onOneShot
            ? "One-shot auto-disables after the fetch. Session-mode persists until you flip the header chip."
            : "You can switch it off again from the header chip at any time."}
        </span>
      </div>
    </div>
  );
}
