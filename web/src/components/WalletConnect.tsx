import { useState, useEffect } from "react";
import { Wallet } from "ethers";
import { useWallet } from "../context/WalletContext";
import { useSettings } from "../context/SettingsContext";
import { NETWORK_CONFIGS } from "@shared/networks";

interface Props {
  onClose: () => void;
}

interface SavedWallet {
  label: string;
  address: string;
  privateKey: string;
}

const STORAGE_KEY = "datum_saved_wallets";

function loadSaved(): SavedWallet[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { return []; }
}

function saveToDisk(wallets: SavedWallet[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletConnect({ onClose }: Props) {
  const { connect, isDatumAvailable, isInjectedAvailable, error, clearError } = useWallet();
  const { settings } = useSettings();
  const [manualKey, setManualKey] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);

  // Generated wallet
  const [generated, setGenerated] = useState<{ address: string; privateKey: string } | null>(null);
  const [genLabel, setGenLabel] = useState("");
  const [showGenKey, setShowGenKey] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Saved wallets
  const [saved, setSaved] = useState<SavedWallet[]>([]);
  const [showKey, setShowKey] = useState<Record<number, boolean>>({});

  useEffect(() => { setSaved(loadSaved()); }, []);

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  function generateWallet() {
    const w = Wallet.createRandom();
    const next = loadSaved().length + 1;
    setGenerated({ address: w.address, privateKey: w.privateKey });
    setGenLabel(`Test Wallet ${next}`);
    setShowGenKey(false);
  }

  function saveGenerated() {
    if (!generated) return;
    const entry: SavedWallet = { label: genLabel.trim() || `Test Wallet ${saved.length + 1}`, address: generated.address, privateKey: generated.privateKey };
    const updated = [...saved, entry];
    saveToDisk(updated);
    setSaved(updated);
    setGenerated(null);
  }

  function deleteSaved(i: number) {
    const updated = saved.filter((_, idx) => idx !== i);
    saveToDisk(updated);
    setSaved(updated);
    setShowKey((prev) => { const n = { ...prev }; delete n[i]; return n; });
  }

  async function handleConnect(method: "datum" | "injected" | "manual", key?: string) {
    setBusy(true);
    clearError();
    const pk = key ?? manualKey;
    setManualKey("");
    try {
      const rpcUrl = settings.rpcUrl || NETWORK_CONFIGS[settings.network]?.rpcUrl || "";
      await connect(method, method === "manual" ? { privateKey: pk, rpcUrl } : undefined);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function connectGenerated() {
    if (!generated) return;
    await handleConnect("manual", generated.privateKey);
  }

  const monoBtnStyle: React.CSSProperties = {
    background: "var(--bg-surface)", border: "1px solid var(--border)",
    borderRadius: 4, padding: "2px 7px", fontSize: 11,
    color: "var(--text-muted)", cursor: "pointer", fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nano-card"
        style={{ padding: 24, width: 400, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto" }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 15 }}>Connect Wallet</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Extension wallets */}
          {isDatumAvailable && (
            <button onClick={() => handleConnect("datum")} disabled={busy} className="nano-btn nano-btn-accent" style={{ justifyContent: "center", padding: "10px 16px" }}>
              DATUM Extension
              <span style={{ fontSize: 11, opacity: 0.7 }}>Detected ✓</span>
            </button>
          )}
          {isInjectedAvailable && (
            <button onClick={() => handleConnect("injected")} disabled={busy} className="nano-btn" style={{ justifyContent: "center", padding: "10px 16px" }}>
              MetaMask / Browser Wallet
            </button>
          )}
          {!isDatumAvailable && !isInjectedAvailable && (
            <div className="nano-info nano-info--warn" style={{ fontSize: 12 }}>
              No wallet detected. Install the{" "}
              <a href="https://github.com/Baronvonbonbon/datum" target="_blank" rel="noopener noreferrer">DATUM extension</a>
              {" "}or use a private key below.
            </div>
          )}

          {/* Testing section */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
            <button
              onClick={() => setShowManual(!showManual)}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontFamily: "inherit", padding: 0 }}
            >
              {showManual ? "▼" : "▶"} Test Wallets <span style={{ opacity: 0.5 }}>(Paseo only)</span>
            </button>

            {showManual && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>

                {/* ── Security warning ── */}
                <div style={{ border: "1px solid rgba(248,113,113,0.3)", borderRadius: 6, padding: "10px 12px", background: "rgba(248,113,113,0.06)", fontSize: 11, lineHeight: 1.6, color: "var(--text)" }}>
                  <div style={{ fontWeight: 700, color: "var(--error)", marginBottom: 4, letterSpacing: "0.04em" }}>Security notice</div>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                    <li>· Keys are stored <strong>unencrypted</strong> in browser localStorage. Anyone with access to this browser profile or device can read them.</li>
                    <li>· Chrome does <strong>not</strong> sync localStorage to Google — saved keys stay on this device only.</li>
                    <li>· Use <em>Connect</em> without saving if you don't need the key to persist.</li>
                    <li>· <strong>Paseo testnet only.</strong> Never save keys that control real funds.</li>
                  </ul>
                </div>

                {/* ── Generate new wallet ── */}
                <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", borderBottom: generated ? "1px solid var(--border)" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--text)" }}>Generate new address</span>
                    <button onClick={generateWallet} disabled={busy} className="nano-btn nano-btn-ok" style={{ fontSize: 11, padding: "3px 10px" }}>
                      Generate
                    </button>
                  </div>

                  {generated && (
                    <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, background: "rgba(74,222,128,0.03)" }}>
                      {/* Address row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 56 }}>Address</span>
                        <code style={{ fontSize: 11, color: "var(--text-strong)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {generated.address}
                        </code>
                        <button style={monoBtnStyle} onClick={() => copy(generated.address, "addr")}>
                          {copied === "addr" ? "✓" : "Copy"}
                        </button>
                      </div>

                      {/* Private key row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 56 }}>Key</span>
                        <code style={{ fontSize: 11, color: "var(--text-strong)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: showGenKey ? undefined : "0.15em" }}>
                          {showGenKey ? generated.privateKey : "••••••••••••••••••••••••"}
                        </code>
                        <button style={monoBtnStyle} onClick={() => setShowGenKey(!showGenKey)}>{showGenKey ? "Hide" : "Show"}</button>
                        <button style={monoBtnStyle} onClick={() => copy(generated.privateKey, "genkey")}>{copied === "genkey" ? "✓" : "Copy"}</button>
                      </div>

                      {/* Label + save/connect */}
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          value={genLabel}
                          onChange={(e) => setGenLabel(e.target.value)}
                          placeholder="Label (optional)"
                          className="nano-input"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                        />
                        <button onClick={saveGenerated} className="nano-btn" style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }}>Save</button>
                        <button onClick={connectGenerated} disabled={busy} className="nano-btn nano-btn-ok" style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }}>Connect</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Saved wallets ── */}
                {saved.length > 0 && (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
                        Saved ({saved.length})
                      </span>
                      <button
                        onClick={() => { saveToDisk([]); setSaved([]); setShowKey({}); }}
                        style={{ ...monoBtnStyle, color: "var(--error)", borderColor: "rgba(248,113,113,0.25)", fontSize: 10 }}
                      >
                        Delete all
                      </button>
                    </div>
                    {saved.map((w, i) => (
                      <div key={i} style={{ padding: "8px 12px", borderBottom: i < saved.length - 1 ? "1px solid var(--border)" : "none", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12, color: "var(--text-strong)", fontWeight: 500 }}>{w.label}</span>
                          <div style={{ display: "flex", gap: 4 }}>
                            <button onClick={() => handleConnect("manual", w.privateKey)} disabled={busy} className="nano-btn nano-btn-ok" style={{ fontSize: 11, padding: "2px 8px" }}>Connect</button>
                            <button
                              onClick={() => deleteSaved(i)}
                              style={{ ...monoBtnStyle, color: "var(--error)", borderColor: "rgba(248,113,113,0.25)" }}
                              title="Delete this wallet"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {showKey[i] ? w.privateKey : shortAddr(w.address)}
                          </code>
                          <button style={monoBtnStyle} onClick={() => setShowKey((p) => ({ ...p, [i]: !p[i] }))}>{showKey[i] ? "Hide key" : "Show key"}</button>
                          <button style={monoBtnStyle} onClick={() => copy(w.privateKey, `key-${i}`)}>{copied === `key-${i}` ? "✓" : "Copy key"}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Manual key entry ── */}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Or paste an existing key:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input
                      type="password"
                      value={manualKey}
                      onChange={(e) => setManualKey(e.target.value)}
                      placeholder="0x private key"
                      className="nano-input"
                      style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                    />
                    <button
                      onClick={() => handleConnect("manual")}
                      disabled={busy || !manualKey.trim()}
                      className="nano-btn"
                      style={{ justifyContent: "center" }}
                    >
                      Connect with Key
                    </button>
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="nano-info nano-info--error" style={{ marginTop: 12, fontSize: 12 }}>{error}</div>
        )}
        {busy && (
          <div style={{ marginTop: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>Connecting…</div>
        )}
      </div>
    </div>
  );
}
