// NeedsExtension — panel shown when a signing-required page is
// reached without the DATUM extension installed.
//
// Pages that need signing wrap their write surface in this guard:
//
//   const { installed, connected, connect } = useWallet();
//   if (!installed) return <NeedsExtension />;
//   if (!connected) return <button onClick={connect}>Connect</button>;
//   return <CampaignCreateForm />;
//
// The panel itself is purely informational — no signing happens
// here. Users can still browse the read-only public pages
// (Explorer, public dashboards) without taking any action.

import { BrandMark } from "./BrandMark";

export function NeedsExtension({
  /// Optional headline override. Useful when a page wants to be
  /// specific about WHY the extension is required ("creating a
  /// campaign requires …").
  title,
  /// Optional secondary copy.
  description,
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div
      style={{
        maxWidth: 480,
        margin: "48px auto",
        padding: "32px 28px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ color: "var(--text-muted)" }}>
          <BrandMark size={20} />
        </span>
        <div
          style={{
            color: "var(--text-strong)",
            fontWeight: 700,
            fontSize: 16,
            letterSpacing: "0.02em",
          }}
        >
          {title ?? "Install the DATUM extension"}
        </div>
      </div>

      <p style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.6 }}>
        {description ??
          "Signing-required actions need the DATUM browser extension. It's a self-contained wallet — no MetaMask, no external RPC, keys never leave your device."}
      </p>

      <div style={{ display: "flex", gap: 8 }}>
        <a
          href="https://github.com/Baronvonbonbon/datum#extension"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: "9px 14px",
            background: "var(--btn-primary-bg, var(--text-strong))",
            color: "var(--btn-primary-text, var(--bg))",
            border: "1px solid var(--text-strong)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          Install extension
        </a>
        <a
          href="/explorer"
          style={{
            padding: "9px 14px",
            background: "transparent",
            color: "var(--text-strong)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          Browse as visitor
        </a>
      </div>

      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 11,
          marginTop: 4,
          lineHeight: 1.5,
        }}
      >
        After installing, reload this page. The extension will
        announce itself and the signing flow will become available.
      </div>
    </div>
  );
}
