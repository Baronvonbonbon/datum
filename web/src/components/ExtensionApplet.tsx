/**
 * ExtensionApplet.tsx
 *
 * Renders the DATUM browser extension popup as an inline panel on the demo page.
 * Sources directly from the extension's popup source — no duplicated code.
 *
 * On first mount:
 *   1. The chrome shim is already installed (module-level side effect in extensionDaemon)
 *   2. startDaemon() seeds settings + begins campaign polling
 *   3. The extension's App component renders exactly as it would inside the popup
 */

import { useEffect, useState } from "react";
import { startDaemon } from "../lib/extensionDaemon";
// @ext resolves to alpha-3/extension/src — no code duplication.
// The extSharedResolver Vite plugin redirects @shared inside extension
// files to extension/src/shared instead of web/src/shared.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @ext resolves via Vite alias; TS paths for extension files are best-effort
import { App as ExtApp } from "@ext/popup/App";

export function ExtensionApplet() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    startDaemon()
      .then(() => setReady(true))
      .catch((err) => {
        console.error("[ExtensionApplet]", err);
        setError(String(err));
      });
  }, []);

  return (
    <div style={outerStyle}>
      {/* Browser chrome frame */}
      <div style={frameBarStyle}>
        <div style={frameDotStyle("var(--error)")} />
        <div style={frameDotStyle("var(--warn)")} />
        <div style={frameDotStyle("var(--ok)")} />
        <span style={frameLabelStyle}>DATUM Extension</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", fontFamily: "var(--font-mono)" }}>
          v0.2.0
        </span>
      </div>

      {/* Popup body — 360×560 matching the real popup dimensions */}
      <div style={popupBodyStyle}>
        {error ? (
          <div style={errorStyle}>
            <div style={{ color: "var(--error)", fontWeight: 600, marginBottom: 6 }}>
              Failed to initialise daemon
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all" }}>
              {error}
            </div>
          </div>
        ) : !ready ? (
          <div style={loadingStyle}>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Starting extension daemon…</div>
          </div>
        ) : (
          <ExtApp />
        )}
      </div>
    </div>
  );
}

const outerStyle: React.CSSProperties = {
  width: 360,
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
  boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
  flexShrink: 0,
};

const frameBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  background: "rgba(255,255,255,0.04)",
  borderBottom: "1px solid var(--border)",
};

function frameDotStyle(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: "50%", background: color, opacity: 0.6 };
}

const frameLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  marginLeft: 4,
  letterSpacing: "0.04em",
};

const popupBodyStyle: React.CSSProperties = {
  width: 360,
  minHeight: 480,
  maxHeight: 560,
  overflowY: "auto",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.5,
};

const loadingStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 200,
};

const errorStyle: React.CSSProperties = {
  padding: 16,
  fontSize: 12,
};
