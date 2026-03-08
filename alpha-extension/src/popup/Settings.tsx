import { useState, useEffect } from "react";
import { StoredSettings, NetworkName, ContractAddresses } from "@shared/types";
import { NETWORK_CONFIGS, DEFAULT_SETTINGS } from "@shared/networks";
import { unlock, isConfigured } from "@shared/walletManager";

interface InterestProfileData {
  weights: Record<string, number>;
  visitCounts: Record<string, number>;
}

export function Settings() {
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetProfileConfirm, setResetProfileConfirm] = useState(false);
  const [interestProfile, setInterestProfile] = useState<InterestProfileData | null>(null);
  const [autoSubmitPassword, setAutoSubmitPassword] = useState("");
  const [autoSubmitKeySet, setAutoSubmitKeySet] = useState(false);
  const [autoSubmitError, setAutoSubmitError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get(["settings", "autoSubmitKey"], (stored) => {
      if (stored.settings) setSettings(stored.settings);
      if (stored.autoSubmitKey) setAutoSubmitKeySet(true);
    });
    loadInterestProfile();
  }, []);

  async function loadInterestProfile() {
    const response = await chrome.runtime.sendMessage({ type: "GET_INTEREST_PROFILE" });
    if (response?.profile) {
      setInterestProfile({
        weights: response.profile.weights ?? {},
        visitCounts: response.profile.visitCounts ?? {},
      });
    }
  }

  async function resetInterestProfile() {
    await chrome.runtime.sendMessage({ type: "RESET_INTEREST_PROFILE" });
    setInterestProfile(null);
    setResetProfileConfirm(false);
  }

  async function save() {
    await chrome.storage.local.set({ settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED", settings });
  }

  function handleNetworkChange(network: NetworkName) {
    const config = NETWORK_CONFIGS[network];
    setSettings((s) => ({
      ...s,
      network,
      rpcUrl: config.rpcUrl,
      // Only overwrite addresses if the user hasn't customised them
      contractAddresses: config.addresses,
    }));
  }

  function handleAddressChange(key: keyof ContractAddresses, value: string) {
    setSettings((s) => ({
      ...s,
      contractAddresses: { ...s.contractAddresses, [key]: value },
    }));
  }

  async function clearQueue() {
    await chrome.runtime.sendMessage({ type: "CLEAR_QUEUE" });
    setClearConfirm(false);
  }

  async function resetChainState() {
    // Background handles clearing all chainState:* keys and the claim queue
    await chrome.runtime.sendMessage({ type: "RESET_CHAIN_STATE" });
    setResetConfirm(false);
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Settings</span>
      </div>

      {/* Network */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Network</label>
        <select
          value={settings.network}
          onChange={(e) => handleNetworkChange(e.target.value as NetworkName)}
          style={selectStyle}
        >
          <option value="local">Local (dev)</option>
          <option value="westend">Westend Asset Hub</option>
          <option value="kusama">Kusama Asset Hub</option>
          <option value="polkadotHub">Polkadot Hub</option>
        </select>
      </div>

      {/* RPC URL */}
      <div style={sectionStyle}>
        <label style={labelStyle}>RPC URL</label>
        <input
          type="text"
          value={settings.rpcUrl}
          onChange={(e) => setSettings((s) => ({ ...s, rpcUrl: e.target.value }))}
          style={inputStyle}
          placeholder="http://localhost:8545"
        />
      </div>

      {/* Contract addresses */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={labelStyle}>Contract Addresses</div>
          <button
            onClick={async () => {
              try {
                const url = chrome.runtime.getURL("deployed-addresses.json");
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("No deployed-addresses.json found in extension bundle");
                const addrs = await resp.json();
                setSettings((s) => ({
                  ...s,
                  contractAddresses: {
                    campaigns: addrs.campaigns ?? "",
                    publishers: addrs.publishers ?? "",
                    governanceVoting: addrs.governanceVoting ?? "",
                    governanceRewards: addrs.governanceRewards ?? "",
                    settlement: addrs.settlement ?? "",
                    relay: addrs.relay ?? "",
                  },
                }));
              } catch (err) {
                alert("Could not load deployed addresses. Run deploy.ts first, then rebuild the extension.");
              }
            }}
            style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#a0a0ff", fontSize: 10, padding: "2px 8px", cursor: "pointer" }}
          >
            Load Deployed
          </button>
        </div>
        {(Object.keys(settings.contractAddresses) as (keyof ContractAddresses)[]).map((key) => (
          <div key={key} style={{ marginBottom: 6 }}>
            <label style={{ ...labelStyle, fontSize: 11, color: "#555", fontFamily: "monospace" }}>
              {key}
            </label>
            <input
              type="text"
              value={settings.contractAddresses[key]}
              onChange={(e) => handleAddressChange(key, e.target.value)}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11 }}
              placeholder="0x…"
            />
          </div>
        ))}
      </div>

      {/* Publisher address */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Publisher Address (override)</label>
        <input
          type="text"
          value={settings.publisherAddress}
          onChange={(e) => setSettings((s) => ({ ...s, publisherAddress: e.target.value }))}
          style={{ ...inputStyle, fontFamily: "monospace" }}
          placeholder="Leave blank to use connected wallet"
        />
        {!settings.publisherAddress && (
          <div style={{ color: "#888060", fontSize: 11, marginTop: 4 }}>
            ⚠ No publisher address set — ad matching uses your connected wallet.
            Set this if you're not the publisher for active campaigns.
          </div>
        )}
      </div>

      {/* IPFS Gateway */}
      <div style={sectionStyle}>
        <label style={labelStyle}>IPFS Gateway</label>
        <input
          type="text"
          value={settings.ipfsGateway}
          onChange={(e) => setSettings((s) => ({ ...s, ipfsGateway: e.target.value }))}
          style={inputStyle}
          placeholder="https://dweb.link/ipfs/"
        />
      </div>

      {/* Auto-submit */}
      <div style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <label style={labelStyle}>Auto-submit claims</label>
        <input
          type="checkbox"
          checked={settings.autoSubmit}
          onChange={(e) => setSettings((s) => ({ ...s, autoSubmit: e.target.checked }))}
          style={{ width: 16, height: 16 }}
        />
      </div>

      {settings.autoSubmit && (
        <div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Auto-submit interval (minutes)</label>
            <input
              type="number"
              value={settings.autoSubmitIntervalMinutes}
              min={1}
              max={60}
              onChange={(e) => setSettings((s) => ({
                ...s,
                autoSubmitIntervalMinutes: Math.max(1, parseInt(e.target.value) || 10),
              }))}
              style={{ ...inputStyle, width: 80 }}
            />
          </div>
          {autoSubmitKeySet ? (
            <div style={{ ...sectionStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#60c060", fontSize: 11 }}>Auto-submit key authorized</span>
              <button
                onClick={async () => {
                  await chrome.storage.local.remove("autoSubmitKey");
                  setAutoSubmitKeySet(false);
                }}
                style={{ ...secondaryBtn, width: "auto", padding: "4px 8px", fontSize: 11 }}
              >
                Revoke
              </button>
            </div>
          ) : (
            <div style={sectionStyle}>
              <div style={{ color: "#888", fontSize: 11, marginBottom: 4 }}>
                Enter your wallet password to authorize auto-submit. The decrypted key will be stored locally
                so the background can sign transactions without your interaction.
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={autoSubmitPassword}
                  onChange={(e) => setAutoSubmitPassword(e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="Wallet password"
                />
                <button
                  onClick={async () => {
                    setAutoSubmitError(null);
                    try {
                      const wallet = await unlock(autoSubmitPassword);
                      await chrome.storage.local.set({ autoSubmitKey: wallet.privateKey });
                      setAutoSubmitKeySet(true);
                      setAutoSubmitPassword("");
                    } catch {
                      setAutoSubmitError("Wrong password.");
                    }
                  }}
                  style={{ ...primaryBtn, width: "auto", padding: "6px 12px", fontSize: 11 }}
                >
                  Authorize
                </button>
              </div>
              {autoSubmitError && (
                <div style={{ color: "#ff8080", fontSize: 11, marginTop: 4 }}>{autoSubmitError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Save */}
      <button onClick={save} style={{ ...primaryBtn, marginTop: 4, marginBottom: 16 }}>
        {saved ? "Saved ✓" : "Save Settings"}
      </button>

      {/* Interest Profile */}
      <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: 12, marginBottom: 16 }}>
        <div style={{ ...labelStyle, fontSize: 13, color: "#a0a0ff", marginBottom: 8, fontWeight: 600 }}>
          Your Interest Profile
        </div>
        <div style={{ color: "#666", fontSize: 11, marginBottom: 8 }}>
          This data never leaves your browser. It personalizes ad selection based on your browsing.
        </div>
        {interestProfile && Object.keys(interestProfile.weights).length > 0 ? (
          <div>
            {Object.entries(interestProfile.weights)
              .sort(([, a], [, b]) => b - a)
              .map(([cat, weight]) => (
                <div key={cat} style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#aaa", marginBottom: 2 }}>
                    <span>{cat}</span>
                    <span>{weight.toFixed(2)} ({interestProfile.visitCounts[cat] ?? 0} visits)</span>
                  </div>
                  <div style={{ background: "#1a1a2e", borderRadius: 3, height: 8 }}>
                    <div style={{
                      width: `${Math.round(weight * 100)}%`,
                      background: "#4a4a8a",
                      height: "100%",
                      borderRadius: 3,
                      minWidth: 2,
                    }} />
                  </div>
                </div>
              ))}
            {!resetProfileConfirm ? (
              <button onClick={() => setResetProfileConfirm(true)} style={{ ...secondaryBtn, marginTop: 8, fontSize: 11 }}>
                Reset Profile
              </button>
            ) : (
              <div style={{ marginTop: 8 }}>
                <div style={{ color: "#ff8080", fontSize: 11, marginBottom: 4 }}>Clear all interest data?</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={resetInterestProfile} style={{ ...dangerBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>Yes</button>
                  <button onClick={() => setResetProfileConfirm(false)} style={{ ...secondaryBtn, flex: 1, fontSize: 11, padding: "6px 8px" }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "#555", fontSize: 11, fontStyle: "italic" }}>
            No browsing data yet. Visit pages matching campaign categories to build your profile.
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: 12 }}>
        <div style={{ color: "#555", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
          Danger zone
        </div>

        {!clearConfirm ? (
          <button onClick={() => setClearConfirm(true)} style={dangerBtn}>
            Clear claim queue
          </button>
        ) : (
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "#ff8080", fontSize: 12, marginBottom: 6 }}>
              This discards all pending unsettled claims. Continue?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={clearQueue} style={{ ...dangerBtn, flex: 1 }}>Yes, clear</button>
              <button onClick={() => setClearConfirm(false)} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
            </div>
          </div>
        )}

        {!resetConfirm ? (
          <button onClick={() => setResetConfirm(true)} style={{ ...dangerBtn, marginTop: 8 }}>
            Reset chain state
          </button>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "#ff8080", fontSize: 12, marginBottom: 6 }}>
              Wipes local nonce/hash chain. Claims will re-sync from chain. Continue?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={resetChainState} style={{ ...dangerBtn, flex: 1 }}>Yes, reset</button>
              <button onClick={() => setResetConfirm(false)} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

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
  background: "#2a0a0a",
  color: "#ff8080",
  border: "1px solid #4a1a1a",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 12,
  cursor: "pointer",
  width: "100%",
};
