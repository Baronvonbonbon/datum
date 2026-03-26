import { useState, useEffect, useCallback, useRef } from "react";
import { JsonRpcProvider, formatEther } from "ethers";
import { CampaignList } from "./CampaignList";
import { ClaimQueue } from "./ClaimQueue";
import { UserPanel } from "./UserPanel";
import { PublisherPanel } from "./PublisherPanel";
import { GovernancePanel } from "./GovernancePanel";
import { Settings } from "./Settings";
import {
  isConfigured,
  importKey,
  generateKey,
  unlock,
  lock,
  clearKey,
  getUnlockedWallet,
  getStoredAddress,
} from "@shared/walletManager";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { formatDOT } from "@shared/dot";

type Tab = "campaigns" | "claims" | "user" | "publisher" | "governance" | "settings";

const TAB_LABELS: Record<Tab, string> = {
  campaigns: "Campaigns",
  claims: "Claims",
  user: "Earnings",
  publisher: "Publisher",
  governance: "Govern",
  settings: "Settings",
};

type WalletState = "loading" | "no-wallet" | "locked" | "unlocked";

export function App() {
  const [tab, setTab] = useState<Tab>("claims");
  const [address, setAddress] = useState<string | null>(null);
  const [walletState, setWalletState] = useState<WalletState>("loading");
  const [error, setError] = useState<string | null>(null);

  // Setup form state
  const [setupMode, setSetupMode] = useState<"import" | "generate" | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Chain heartbeat state
  const [chainStatus, setChainStatus] = useState<{
    connected: boolean;
    blockNumber: number | null;
    blockHash: string | null;
    nativeBalance: bigint | null;
    rpcUrl: string;
    lastUpdated: number | null;
    error: string | null;
  }>({
    connected: false, blockNumber: null, blockHash: null,
    nativeBalance: null, rpcUrl: "", lastUpdated: null, error: null,
  });
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollChainStatus = useCallback(async () => {
    try {
      const stored = await chrome.storage.local.get("settings");
      const settings = stored.settings ?? DEFAULT_SETTINGS;
      const rpcUrl = settings.rpcUrl;
      if (!rpcUrl) return;

      const provider = new JsonRpcProvider(rpcUrl);
      const block = await provider.getBlock("latest");
      let nativeBalance: bigint | null = null;
      if (address) {
        nativeBalance = await provider.getBalance(address);
      }

      setChainStatus({
        connected: true,
        blockNumber: block?.number ?? null,
        blockHash: block?.hash ?? null,
        nativeBalance,
        rpcUrl,
        lastUpdated: Date.now(),
        error: null,
      });
    } catch (err) {
      setChainStatus((prev) => ({
        ...prev,
        connected: false,
        error: String(err).slice(0, 100),
        lastUpdated: Date.now(),
      }));
    }
  }, [address]);

  useEffect(() => {
    initWalletState();
  }, []);

  // Start/stop heartbeat polling when wallet is unlocked
  useEffect(() => {
    if (walletState === "unlocked") {
      pollChainStatus(); // immediate first poll
      heartbeatRef.current = setInterval(pollChainStatus, 10_000);
    } else {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    }
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [walletState, pollChainStatus]);

  async function initWalletState() {
    const configured = await isConfigured();
    if (!configured) {
      setWalletState("no-wallet");
      return;
    }
    // Key exists — check if already unlocked in memory
    const wallet = getUnlockedWallet();
    if (wallet) {
      setAddress(wallet.address);
      setWalletState("unlocked");
    } else {
      // Try to restore address from storage for display (still locked)
      const storedAddr = await getStoredAddress();
      if (storedAddr) setAddress(storedAddr);
      setWalletState("locked");
    }
  }

  async function handleImport() {
    if (!keyInput.trim()) { setError("Paste your private key."); return; }
    if (password.length < 4) { setError("Password must be at least 4 characters."); return; }
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    setBusy(true);
    setError(null);
    try {
      const addr = await importKey(keyInput.trim(), password);
      setAddress(addr);
      await chrome.storage.local.set({ connectedAddress: addr });
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: addr });
      setWalletState("unlocked");
      setSetupMode(null);
      setKeyInput("");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    if (password.length < 4) { setError("Password must be at least 4 characters."); return; }
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await generateKey(password);
      setAddress(result.address);
      setGeneratedKey(result.privateKey);
      await chrome.storage.local.set({ connectedAddress: result.address });
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: result.address });
      setWalletState("unlocked");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock() {
    if (!password) { setError("Enter your password."); return; }
    setBusy(true);
    setError(null);
    try {
      const settings = await getSettings();
      const wallet = await unlock(password, settings.rpcUrl);
      setAddress(wallet.address);
      await chrome.storage.local.set({ connectedAddress: wallet.address });
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: wallet.address });
      setWalletState("unlocked");
      setPassword("");
    } catch {
      setError("Wrong password or corrupted wallet data.");
    } finally {
      setBusy(false);
    }
  }

  function handleLock() {
    lock();
    setWalletState("locked");
  }

  async function handleClearWallet() {
    await clearKey();
    chrome.runtime.sendMessage({ type: "WALLET_DISCONNECTED" });
    setAddress(null);
    setWalletState("no-wallet");
    setSetupMode(null);
    setGeneratedKey(null);
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  // --- Render ---

  // Setup / unlock screens
  if (walletState === "loading") {
    return <div style={{ padding: 24, color: "#666", textAlign: "center" }}>Loading...</div>;
  }

  if (walletState === "no-wallet" || setupMode) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, color: "#a0a0ff", fontSize: 16 }}>DATUM</span>
          <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>Set up your wallet</div>
        </div>

        {/* Testing warning */}
        <div style={{
          padding: 10, marginBottom: 12, borderRadius: 6,
          background: "#2a1a0a", border: "1px solid #4a2a0a",
        }}>
          <div style={{ color: "#ff9040", fontSize: 11, fontWeight: 600, marginBottom: 2 }}>
            TESTING ONLY — NO SECURITY GUARANTEES
          </div>
          <div style={{ color: "#c08040", fontSize: 10, lineHeight: 1.4 }}>
            This wallet is for development and testing only.
            Do NOT use keys that control real funds.
            No independent security audit has been performed.
            Use at your own risk.
          </div>
        </div>

        {/* Backup warning for freshly generated key */}
        {generatedKey && (
          <div style={{ padding: 10, background: "#2a2a0a", border: "1px solid #4a4a2a", borderRadius: 6, marginBottom: 12 }}>
            <div style={{ color: "#c0c060", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Back up your private key now!
            </div>
            <div style={{
              fontFamily: "monospace", fontSize: 11, color: "#e0e0e0",
              background: "#1a1a1a", padding: 8, borderRadius: 4, wordBreak: "break-all",
              userSelect: "all",
            }}>
              {generatedKey}
            </div>
            <div style={{ color: "#888", fontSize: 11, marginTop: 4 }}>
              This key controls your DATUM earnings. Copy it somewhere safe. It will not be shown again.
            </div>
            <button
              onClick={() => setGeneratedKey(null)}
              style={{ ...primaryBtn, marginTop: 8, fontSize: 11, padding: "6px 12px" }}
            >
              I've saved my key
            </button>
          </div>
        )}

        {!setupMode && !generatedKey && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={() => setSetupMode("import")} style={primaryBtn}>
              Import Private Key
            </button>
            <button onClick={() => setSetupMode("generate")} style={secondaryBtn}>
              Generate New Key
            </button>
          </div>
        )}

        {setupMode === "import" && (
          <div>
            <div style={sectionStyle}>
              <label style={labelStyle}>Private Key (hex)</label>
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11 }}
                placeholder="0x..."
              />
              <div style={{ color: "#666", fontSize: 10, marginTop: 2 }}>
                Paste a Hardhat/substrate dev account key for testing
              </div>
            </div>
            <div style={sectionStyle}>
              <label style={labelStyle}>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                style={inputStyle} placeholder="Encrypt key at rest" />
            </div>
            <div style={sectionStyle}>
              <label style={labelStyle}>Confirm Password</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                style={inputStyle} placeholder="Confirm password" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={handleImport} disabled={busy} style={{ ...primaryBtn, flex: 1 }}>
                {busy ? "Encrypting..." : "Import"}
              </button>
              <button onClick={() => { setSetupMode(null); setError(null); }} style={{ ...secondaryBtn, flex: 1 }}>
                Back
              </button>
            </div>
          </div>
        )}

        {setupMode === "generate" && (
          <div>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
              A new random key will be generated. You must back it up immediately.
            </div>
            <div style={sectionStyle}>
              <label style={labelStyle}>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                style={inputStyle} placeholder="Encrypt key at rest" />
            </div>
            <div style={sectionStyle}>
              <label style={labelStyle}>Confirm Password</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                style={inputStyle} placeholder="Confirm password" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={handleGenerate} disabled={busy} style={{ ...primaryBtn, flex: 1 }}>
                {busy ? "Generating..." : "Generate"}
              </button>
              <button onClick={() => { setSetupMode(null); setError(null); }} style={{ ...secondaryBtn, flex: 1 }}>
                Back
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 8, padding: 8, background: "#3a1a1a", color: "#ff8080", fontSize: 12, borderRadius: 4 }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  if (walletState === "locked") {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, color: "#a0a0ff", fontSize: 16 }}>DATUM</span>
          {address && (
            <div style={{ color: "#888", fontSize: 11, marginTop: 4, fontFamily: "monospace" }}>
              {address.slice(0, 6)}...{address.slice(-4)}
            </div>
          )}
          <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>Wallet locked</div>
        </div>
        <div style={sectionStyle}>
          <label style={labelStyle}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
            style={inputStyle}
            placeholder="Enter password to unlock"
            autoFocus
          />
        </div>
        <button onClick={handleUnlock} disabled={busy} style={{ ...primaryBtn, marginTop: 4 }}>
          {busy ? "Unlocking..." : "Unlock"}
        </button>
        <button onClick={handleClearWallet} style={{ ...dangerBtn, marginTop: 12, fontSize: 11 }}>
          Remove Wallet
        </button>
        {error && (
          <div style={{ marginTop: 8, padding: 8, background: "#3a1a1a", color: "#ff8080", fontSize: 12, borderRadius: 4 }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  // --- Main app (unlocked) ---
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        background: "#1a1a2e",
        borderBottom: "1px solid #2a2a4a",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <span style={{ fontWeight: 700, color: "#a0a0ff", fontSize: 16 }}>DATUM</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#888", fontSize: 12 }}>
            {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""}
          </span>
          <button onClick={handleLock} style={btnStyle("#333", "#888")}>
            Lock
          </button>
        </div>
      </div>

      {/* Chain heartbeat */}
      <div style={{
        padding: "4px 16px",
        background: chainStatus.connected ? "#0a1a0a" : "#2a0a0a",
        borderBottom: "1px solid #2a2a4a",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 10,
        fontFamily: "monospace",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%", display: "inline-block",
            background: chainStatus.connected ? "#40c040" : "#c04040",
          }} />
          {chainStatus.connected ? (
            <span style={{ color: "#608060" }}>
              #{chainStatus.blockNumber}
              {chainStatus.blockHash && (
                <span style={{ color: "#405040", marginLeft: 4 }}>
                  {chainStatus.blockHash.slice(0, 10)}...
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: "#c06060" }}>
              {chainStatus.error ? "RPC error" : "Disconnected"}
            </span>
          )}
        </div>
        <div>
          {chainStatus.nativeBalance !== null ? (
            <span style={{ color: "#60a060" }}>
              {formatDOT(chainStatus.nativeBalance)} DOT
            </span>
          ) : chainStatus.connected ? (
            <span style={{ color: "#555" }}>...</span>
          ) : (
            <span style={{ color: "#804040", fontSize: 9 }}>
              {chainStatus.rpcUrl || "No RPC"}
            </span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid #2a2a4a" }}>
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: "8px 4px",
              background: tab === t ? "#1a1a2e" : "transparent",
              color: tab === t ? "#a0a0ff" : "#666",
              border: "none",
              borderBottom: tab === t ? "2px solid #a0a0ff" : "2px solid transparent",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: tab === t ? 600 : 400,
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "campaigns" && <CampaignList />}
        {tab === "claims" && <ClaimQueue address={address} />}
        {tab === "user" && <UserPanel address={address} />}
        {tab === "publisher" && <PublisherPanel address={address} />}
        {tab === "governance" && <GovernancePanel address={address} />}
        {tab === "settings" && <Settings />}
      </div>
    </div>
  );
}

function btnStyle(bg: string, color: string) {
  return {
    background: bg,
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  } as const;
}

const primaryBtn: React.CSSProperties = {
  background: "#2a2a5a",
  color: "#a0a0ff",
  border: "1px solid #4a4a8a",
  borderRadius: 6,
  padding: "10px 16px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#1a1a1a",
  color: "#666",
  border: "1px solid #333",
};

const dangerBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#2a0a0a",
  color: "#ff8080",
  border: "1px solid #4a1a1a",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  color: "#888",
  fontSize: 12,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  background: "#1a1a2e",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  color: "#e0e0e0",
  fontSize: 12,
  outline: "none",
};
