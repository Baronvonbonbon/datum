import { useState, useEffect } from "react";
import { StoredSettings, NetworkName, ContractAddresses } from "@shared/types";
import { NETWORK_CONFIGS, DEFAULT_SETTINGS } from "@shared/networks";

export function Settings() {
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  useEffect(() => {
    chrome.storage.local.get("settings", (stored) => {
      if (stored.settings) setSettings(stored.settings);
    });
  }, []);

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
        <div style={{ ...labelStyle, marginBottom: 6 }}>Contract Addresses</div>
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
      )}

      {/* Save */}
      <button onClick={save} style={{ ...primaryBtn, marginTop: 4, marginBottom: 16 }}>
        {saved ? "Saved ✓" : "Save Settings"}
      </button>

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
