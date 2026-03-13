import { useState, useEffect, useCallback, useRef } from "react";
import { JsonRpcProvider } from "ethers";
import { CampaignList } from "./CampaignList";
import { ClaimQueue } from "./ClaimQueue";
import { UserPanel } from "./UserPanel";
import { PublisherPanel } from "./PublisherPanel";
import { AdvertiserPanel } from "./AdvertiserPanel";
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
  listWallets,
  getActiveWalletName,
  switchAccount,
  deleteWallet,
  renameWallet,
  migrateIfNeeded,
} from "@shared/walletManager";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { formatDOT } from "@shared/dot";
import { humanizeError } from "@shared/errorCodes";

type Tab = "campaigns" | "claims" | "user" | "publisher" | "advertiser" | "governance" | "settings";

const TAB_LABELS: Record<Tab, string> = {
  campaigns: "Campaigns",
  claims: "Claims",
  user: "Earnings",
  publisher: "Publisher",
  advertiser: "My Ads",
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
  const [keyCopied, setKeyCopied] = useState(false); // WS-1

  // Multi-account state (MA-2)
  const [accountName, setAccountName] = useState("");
  const [accounts, setAccounts] = useState<{ name: string; address: string }[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [renamingAccount, setRenamingAccount] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  // H2: Timelock pending changes
  const [timelockWarning, setTimelockWarning] = useState<number>(0);

  // Refresh key: incremented on login/unlock to force-remount all tab components
  const [refreshKey, setRefreshKey] = useState(0);

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

      // H2: Check timelock pending changes
      try {
        const tlResp = await chrome.runtime.sendMessage({ type: "GET_TIMELOCK_PENDING" });
        setTimelockWarning(tlResp?.pending?.length ?? 0);
      } catch { /* ignore */ }
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

  async function refreshAccountList() {
    const wallets = await listWallets();
    setAccounts(wallets);
    const active = await getActiveWalletName();
    setActiveAccount(active);
  }

  async function initWalletState() {
    // MA-4: migrate legacy single-wallet to multi-wallet
    await migrateIfNeeded();

    const configured = await isConfigured();
    if (!configured) {
      setWalletState("no-wallet");
      return;
    }
    await refreshAccountList();

    // Key exists — check if already unlocked in memory
    const wallet = getUnlockedWallet();
    if (wallet) {
      setAddress(wallet.address);
      setWalletState("unlocked");
    } else {
      const storedAddr = await getStoredAddress();
      if (storedAddr) setAddress(storedAddr);
      setWalletState("locked");
    }
  }

  async function handleImport() {
    if (!keyInput.trim()) { setError("Paste your private key."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; } // WS-2
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    const name = accountName.trim() || undefined;
    setBusy(true);
    setError(null);
    try {
      const addr = await importKey(keyInput.trim(), password, name);
      setAddress(addr);
      await chrome.storage.local.set({ connectedAddress: addr });
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: addr });
      setWalletState("unlocked");
      setRefreshKey((k) => k + 1);
      setSetupMode(null);
      setKeyInput("");
      setPassword("");
      setConfirmPassword("");
      setAccountName("");
      await refreshAccountList();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; } // WS-2
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    const name = accountName.trim() || undefined;
    setBusy(true);
    setError(null);
    try {
      const result = await generateKey(password, name);
      setAddress(result.address);
      setGeneratedKey(result.privateKey);
      await chrome.storage.local.set({ connectedAddress: result.address });
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: result.address });
      setWalletState("unlocked");
      setRefreshKey((k) => k + 1);
      setPassword("");
      setConfirmPassword("");
      setAccountName("");
      setKeyCopied(false);
      await refreshAccountList();
    } catch (err) {
      setError(humanizeError(err));
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
      setRefreshKey((k) => k + 1);
      setPassword("");
      await refreshAccountList();
    } catch {
      setError("Wrong password or corrupted wallet data.");
    } finally {
      setBusy(false);
    }
  }

  function handleLock() {
    lock();
    setWalletState("locked");
    setShowAccountMenu(false);
  }

  async function handleClearWallet() {
    await clearKey();
    chrome.runtime.sendMessage({ type: "WALLET_DISCONNECTED" });
    setAddress(null);
    setWalletState("no-wallet");
    setSetupMode(null);
    setGeneratedKey(null);
    setAccounts([]);
    setActiveAccount(null);
  }

  // MA-2: Switch to a different account (locks current, requires password for new)
  async function handleSwitchAccount(name: string) {
    setShowAccountMenu(false);
    try {
      const addr = await switchAccount(name);
      setAddress(addr);
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: addr });
      setWalletState("locked"); // needs password to unlock new account
      await refreshAccountList();
    } catch (err) {
      setError(humanizeError(err));
    }
  }

  // MA-2: Delete a specific account
  async function handleDeleteAccount(name: string) {
    if (!confirm(`Delete account "${name}"? This is irreversible.`)) return;
    try {
      await deleteWallet(name);
      await refreshAccountList();
      const wallets = await listWallets();
      if (wallets.length === 0) {
        chrome.runtime.sendMessage({ type: "WALLET_DISCONNECTED" });
        setAddress(null);
        setWalletState("no-wallet");
      } else {
        const storedAddr = await getStoredAddress();
        setAddress(storedAddr);
        setWalletState("locked");
      }
    } catch (err) {
      setError(humanizeError(err));
    }
  }

  // MA-2: Rename account
  async function handleRenameAccount(oldName: string) {
    if (!renameInput.trim()) return;
    try {
      await renameWallet(oldName, renameInput.trim());
      setRenamingAccount(null);
      setRenameInput("");
      await refreshAccountList();
    } catch (err) {
      setError(humanizeError(err));
    }
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  // M3: Password strength indicator
  function getPasswordStrength(pw: string): { label: string; color: string; level: number } {
    if (pw.length === 0) return { label: "", color: "#555", level: 0 };
    if (pw.length < 8) return { label: "Too short (8+ required)", color: "#ff4040", level: 0 }; // WS-2
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    // Common weak patterns
    const weak = ["password", "12345678", "qwerty", "abcdef", "datum"];
    if (weak.some((w) => pw.toLowerCase().includes(w))) score = Math.min(score, 1);

    if (score <= 2) return { label: "Fair", color: "#c0c040", level: 2 };
    if (score <= 3) return { label: "Good", color: "#60c060", level: 3 };
    return { label: "Strong", color: "#40c080", level: 4 };
  }

  const strength = getPasswordStrength(password);

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
          <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
            {accounts.length > 0 ? "Add another account" : "Set up your wallet"}
          </div>
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

        {/* WS-1: Backup warning for freshly generated key — with copy button */}
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
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(generatedKey);
                  setKeyCopied(true);
                  // Clear clipboard after 60 seconds
                  setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), 60_000);
                }}
                style={{ ...secondaryBtn, flex: 1, fontSize: 11, padding: "6px 12px" }}
              >
                {keyCopied ? "Copied!" : "Copy to Clipboard"}
              </button>
              <button
                onClick={() => { setGeneratedKey(null); setSetupMode(null); }}
                style={{ ...primaryBtn, flex: 1, fontSize: 11, padding: "6px 12px" }}
              >
                I've saved my key
              </button>
            </div>
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
            {accounts.length > 0 && (
              <button onClick={() => { setSetupMode(null); setWalletState("locked"); }} style={secondaryBtn}>
                Back to accounts
              </button>
            )}
          </div>
        )}

        {setupMode === "import" && (
          <div>
            {/* MA-2: Account name */}
            <div style={sectionStyle}>
              <label style={labelStyle}>Account Name</label>
              <input
                type="text"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                style={inputStyle}
                placeholder={`Account ${accounts.length + 1}`}
                maxLength={32}
              />
            </div>
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
                style={inputStyle} placeholder="Encrypt key at rest (8+ chars)" />
              {strength.label && (
                <div style={{ fontSize: 10, color: strength.color, marginTop: 3 }}>
                  {strength.label}
                </div>
              )}
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
              <button onClick={() => { setSetupMode(null); setError(null); setAccountName(""); }} style={{ ...secondaryBtn, flex: 1 }}>
                Back
              </button>
            </div>
          </div>
        )}

        {setupMode === "generate" && (
          <div>
            {/* MA-2: Account name */}
            <div style={sectionStyle}>
              <label style={labelStyle}>Account Name</label>
              <input
                type="text"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                style={inputStyle}
                placeholder={`Account ${accounts.length + 1}`}
                maxLength={32}
              />
            </div>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
              A new random key will be generated. You must back it up immediately.
            </div>
            <div style={sectionStyle}>
              <label style={labelStyle}>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                style={inputStyle} placeholder="Encrypt key at rest (8+ chars)" />
              {strength.label && (
                <div style={{ fontSize: 10, color: strength.color, marginTop: 3 }}>
                  {strength.label}
                </div>
              )}
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
              <button onClick={() => { setSetupMode(null); setError(null); setAccountName(""); }} style={{ ...secondaryBtn, flex: 1 }}>
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
          {/* MA-2: Show active account name + address */}
          {activeAccount && (
            <div style={{ color: "#a0a0ff", fontSize: 12, marginTop: 4, fontWeight: 600 }}>
              {activeAccount}
            </div>
          )}
          {address && (
            <div style={{ color: "#888", fontSize: 11, marginTop: 2, fontFamily: "monospace" }}>
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

        {/* MA-2: Account list for switching */}
        {accounts.length > 1 && (
          <div style={{ marginTop: 16, borderTop: "1px solid #2a2a4a", paddingTop: 12 }}>
            <div style={{ color: "#888", fontSize: 11, marginBottom: 6 }}>Switch account</div>
            {accounts.map((acc) => (
              <div key={acc.name} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "4px 8px", marginBottom: 2, borderRadius: 3,
                background: acc.name === activeAccount ? "#1a1a3a" : "#111",
                border: acc.name === activeAccount ? "1px solid #3a3a6a" : "1px solid #222",
              }}>
                <div>
                  <span style={{ color: acc.name === activeAccount ? "#a0a0ff" : "#888", fontSize: 11, fontWeight: acc.name === activeAccount ? 600 : 400 }}>
                    {acc.name}
                  </span>
                  <span style={{ color: "#555", fontSize: 9, marginLeft: 6, fontFamily: "monospace" }}>
                    {acc.address.slice(0, 6)}...{acc.address.slice(-4)}
                  </span>
                </div>
                {acc.name !== activeAccount && (
                  <button
                    onClick={() => handleSwitchAccount(acc.name)}
                    style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#a0a0ff", fontSize: 9, padding: "2px 6px", cursor: "pointer" }}
                  >Switch</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add account + remove buttons */}
        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          <button onClick={() => { setSetupMode("import"); setError(null); }} style={{ ...secondaryBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>
            Add Account
          </button>
          <button onClick={handleClearWallet} style={{ ...dangerBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>
            Remove All
          </button>
        </div>

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
        <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
          {/* MA-2: Account name + address with dropdown */}
          <button
            onClick={() => setShowAccountMenu(!showAccountMenu)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: 0,
              display: "flex", alignItems: "center", gap: 4,
            }}
          >
            {activeAccount && (
              <span style={{ color: "#a0a0ff", fontSize: 11, fontWeight: 600 }}>{activeAccount}</span>
            )}
            <span style={{ color: "#888", fontSize: 11, fontFamily: "monospace" }}>
              {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""}
            </span>
            {accounts.length > 1 && <span style={{ color: "#555", fontSize: 8 }}>v</span>}
          </button>

          {/* MA-2: Account dropdown menu */}
          {showAccountMenu && (
            <div style={{
              position: "absolute", top: "100%", right: 0, zIndex: 20,
              background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 4,
              minWidth: 220, marginTop: 4, padding: 4,
            }}>
              {accounts.map((acc) => (
                <div key={acc.name} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "4px 8px", borderRadius: 3, marginBottom: 2,
                  background: acc.name === activeAccount ? "#2a2a4a" : "transparent",
                }}>
                  {renamingAccount === acc.name ? (
                    <div style={{ display: "flex", gap: 4, flex: 1 }}>
                      <input
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleRenameAccount(acc.name)}
                        style={{ ...inputStyle, fontSize: 10, padding: "2px 4px", flex: 1 }}
                        autoFocus
                        maxLength={32}
                      />
                      <button onClick={() => handleRenameAccount(acc.name)} style={{ background: "none", border: "none", color: "#60c060", fontSize: 9, cursor: "pointer" }}>ok</button>
                      <button onClick={() => setRenamingAccount(null)} style={{ background: "none", border: "none", color: "#888", fontSize: 9, cursor: "pointer" }}>x</button>
                    </div>
                  ) : (
                    <>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: acc.name === activeAccount ? "#a0a0ff" : "#aaa", fontSize: 11, fontWeight: acc.name === activeAccount ? 600 : 400 }}>
                          {acc.name}
                        </div>
                        <div style={{ color: "#555", fontSize: 9, fontFamily: "monospace" }}>
                          {acc.address.slice(0, 10)}...{acc.address.slice(-4)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {acc.name !== activeAccount && (
                          <button
                            onClick={() => handleSwitchAccount(acc.name)}
                            style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#a0a0ff", fontSize: 9, padding: "2px 6px", cursor: "pointer" }}
                          >Switch</button>
                        )}
                        <button
                          onClick={() => { setRenamingAccount(acc.name); setRenameInput(acc.name); }}
                          style={{ background: "none", border: "none", color: "#666", fontSize: 9, cursor: "pointer" }}
                        >edit</button>
                        <button
                          onClick={() => handleDeleteAccount(acc.name)}
                          style={{ background: "none", border: "none", color: "#ff6060", fontSize: 9, cursor: "pointer" }}
                        >x</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
              <div style={{ borderTop: "1px solid #2a2a4a", paddingTop: 4, marginTop: 2 }}>
                <button
                  onClick={() => { setShowAccountMenu(false); setSetupMode("import"); }}
                  style={{ background: "none", border: "none", color: "#a0a0ff", fontSize: 10, cursor: "pointer", padding: "4px 8px", width: "100%", textAlign: "left" }}
                >+ Add Account</button>
              </div>
            </div>
          )}

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

      {/* H2: Timelock pending change warning */}
      {timelockWarning > 0 && (
        <div style={{
          padding: "4px 16px", background: "#2a1a0a", borderBottom: "1px solid #4a2a0a",
          fontSize: 11, color: "#ff9040", display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>!</span>
          <span>{timelockWarning} pending admin change{timelockWarning > 1 ? "s" : ""} (Timelock)</span>
        </div>
      )}

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
        {tab === "campaigns" && <CampaignList key={refreshKey} />}
        {tab === "claims" && <ClaimQueue key={refreshKey} address={address} />}
        {tab === "user" && <UserPanel key={refreshKey} address={address} />}
        {tab === "publisher" && <PublisherPanel key={refreshKey} address={address} />}
        {tab === "advertiser" && <AdvertiserPanel key={refreshKey} address={address} />}
        {tab === "governance" && <GovernancePanel key={refreshKey} address={address} />}
        {tab === "settings" && <Settings key={refreshKey} />}
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
