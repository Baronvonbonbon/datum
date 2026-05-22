// EnableRpcCta — surfaced on pages that need history older than
// pine's rolling window. Flips the rpcEnabled toggle inline so the
// user doesn't have to dig through settings.
//
// The CTA explains the tradeoff in the same words as the header
// tooltip so a user who arrives via the CTA sees the same warning.

import { useSettings } from "../context/SettingsContext";

export function EnableRpcCta({
  what,
}: {
  /// One short clause describing what the page is trying to load.
  /// Used in the prompt: "{what} sits outside pine's rolling window."
  /// E.g. "settlement history", "past governance votes".
  what?: string;
}) {
  const { settings, updateSettings } = useSettings();
  if (settings.rpcEnabled) return null;

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
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => updateSettings({ rpcEnabled: true })}
          className="nano-btn nano-btn-accent"
          style={{ fontSize: 12, padding: "6px 14px" }}
        >
          Enable RPC for this session
        </button>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          You can switch it off again from the header chip at any time.
        </span>
      </div>
    </div>
  );
}
