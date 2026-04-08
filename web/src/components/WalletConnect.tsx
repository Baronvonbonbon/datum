import { useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useSettings } from "../context/SettingsContext";

interface Props {
  onClose: () => void;
}

export function WalletConnect({ onClose }: Props) {
  const { connect, isDatumAvailable, isInjectedAvailable, error, clearError } = useWallet();
  const { settings } = useSettings();
  const [manualKey, setManualKey] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConnect(method: "datum" | "injected" | "manual") {
    setBusy(true);
    clearError();
    try {
      // Capture and immediately clear private key from state
      const key = manualKey;
      setManualKey("");
      await connect(method, method === "manual" ? { privateKey: key, rpcUrl: settings.rpcUrl } : undefined);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nano-card"
        style={{ padding: 28, width: 360, maxWidth: "90vw" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 15 }}>Connect Wallet</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {isDatumAvailable && (
            <button
              onClick={() => handleConnect("datum")}
              disabled={busy}
              className="nano-btn nano-btn-accent"
              style={{ justifyContent: "center", padding: "10px 16px" }}
            >
              DATUM Extension
              <span style={{ fontSize: 11, opacity: 0.7 }}>Detected ✓</span>
            </button>
          )}

          {isInjectedAvailable && (
            <button
              onClick={() => handleConnect("injected")}
              disabled={busy}
              className="nano-btn"
              style={{ justifyContent: "center", padding: "10px 16px" }}
            >
              MetaMask / Browser Wallet
            </button>
          )}

          {!isDatumAvailable && !isInjectedAvailable && (
            <div className="nano-info nano-info--warn" style={{ fontSize: 12 }}>
              No wallet detected. Install the{" "}
              <a href="https://github.com/Baronvonbonbon/datum" target="_blank" rel="noopener noreferrer">
                DATUM extension
              </a>{" "}
              or use a private key below.
            </div>
          )}

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
            <button
              onClick={() => setShowManual(!showManual)}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
            >
              {showManual ? "▼" : "▶"} Private Key <span style={{ opacity: 0.5 }}>(testing only)</span>
            </button>

            {showManual && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="nano-info nano-info--warn" style={{ fontSize: 11 }}>
                  <strong>Testing only.</strong> Do not use keys controlling real funds.
                </div>
                <input
                  type="password"
                  value={manualKey}
                  onChange={(e) => setManualKey(e.target.value)}
                  placeholder="0x private key"
                  className="nano-input"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
                <button
                  onClick={() => handleConnect("manual")}
                  disabled={busy || !manualKey.trim()}
                  className="nano-btn"
                  style={{ justifyContent: "center" }}
                >
                  Connect with Private Key
                </button>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="nano-info nano-info--error" style={{ marginTop: 12, fontSize: 12 }}>
            {error}
          </div>
        )}

        {busy && (
          <div style={{ marginTop: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            Connecting…
          </div>
        )}
      </div>
    </div>
  );
}
