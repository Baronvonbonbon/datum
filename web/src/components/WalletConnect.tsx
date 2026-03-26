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
      await connect(method, method === "manual" ? { privateKey: manualKey, rpcUrl: settings.rpcUrl } : undefined);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0f0f1a",
          border: "1px solid #2a2a4a",
          borderRadius: 8,
          padding: 24,
          width: 360,
          maxWidth: "90vw",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ color: "#a0a0ff", fontWeight: 700, fontSize: 16 }}>Connect Wallet</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {isDatumAvailable && (
            <button
              onClick={() => handleConnect("datum")}
              disabled={busy}
              style={primaryBtn}
            >
              DATUM Extension
              <span style={{ fontSize: 11, marginLeft: 8, opacity: 0.7 }}>Detected ✓</span>
            </button>
          )}

          {isInjectedAvailable && (
            <button
              onClick={() => handleConnect("injected")}
              disabled={busy}
              style={secondaryBtn}
            >
              MetaMask / Browser Wallet
            </button>
          )}

          {!isDatumAvailable && !isInjectedAvailable && (
            <div style={{ padding: 12, background: "#1a1a0a", border: "1px solid #3a3a0a", borderRadius: 4, color: "#c0c060", fontSize: 12 }}>
              No wallet detected. Install the{" "}
              <a href="https://github.com/Baronvonbonbon/datum" target="_blank" rel="noopener noreferrer" style={{ color: "#a0a0ff" }}>
                DATUM extension
              </a>{" "}
              or MetaMask, or use a private key below.
            </div>
          )}

          <div style={{ borderTop: "1px solid #1a1a2a", paddingTop: 8, marginTop: 4 }}>
            <button
              onClick={() => setShowManual(!showManual)}
              style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 12 }}
            >
              {showManual ? "▼" : "▶"} Private Key (testing only)
            </button>

            {showManual && (
              <div style={{ marginTop: 8 }}>
                <div style={{ padding: "6px 10px", background: "#2a1a0a", border: "1px solid #4a2a0a", borderRadius: 4, marginBottom: 8 }}>
                  <div style={{ color: "#ff9040", fontSize: 11, fontWeight: 600 }}>TESTING ONLY</div>
                  <div style={{ color: "#c08040", fontSize: 10 }}>Do not use keys controlling real funds.</div>
                </div>
                <input
                  type="password"
                  value={manualKey}
                  onChange={(e) => setManualKey(e.target.value)}
                  placeholder="0x private key"
                  style={{
                    width: "100%", padding: "6px 8px",
                    background: "#1a1a2e", border: "1px solid #2a2a4a",
                    borderRadius: 4, color: "#e0e0e0", fontSize: 12,
                    fontFamily: "monospace", outline: "none",
                    marginBottom: 6,
                  }}
                />
                <button
                  onClick={() => handleConnect("manual")}
                  disabled={busy || !manualKey.trim()}
                  style={{ ...secondaryBtn, width: "100%" }}
                >
                  Connect with Private Key
                </button>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "#2a0a0a", border: "1px solid #4a1a1a", borderRadius: 4, color: "#ff8080", fontSize: 12 }}>
            {error}
          </div>
        )}

        {busy && (
          <div style={{ marginTop: 12, textAlign: "center", color: "#888", fontSize: 12 }}>
            Connecting...
          </div>
        )}
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: "#1a1a3a",
  color: "#a0a0ff",
  border: "1px solid #4a4a8a",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
};

const secondaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: "#111",
  color: "#888",
  border: "1px solid #2a2a4a",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
};
