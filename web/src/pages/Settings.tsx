import { useState } from "react";
import { useSettings } from "../context/SettingsContext";
import { useWallet } from "../context/WalletContext";
import { TransactionStatus } from "../components/TransactionStatus";
import { NETWORK_CONFIGS } from "@shared/networks";

const CONTRACT_LABELS: Record<string, string> = {
  campaigns: "Campaigns",
  publishers: "Publishers",
  governanceV2: "GovernanceV2",
  governanceSlash: "GovernanceSlash",
  settlement: "Settlement",
  relay: "Relay",
  pauseRegistry: "PauseRegistry",
  timelock: "Timelock",
  zkVerifier: "ZKVerifier",
  budgetLedger: "BudgetLedger",
  paymentVault: "PaymentVault",
  lifecycle: "CampaignLifecycle",
  attestationVerifier: "AttestationVerifier",
};

export function Settings() {
  const { settings, updateSettings, setNetwork, setContractAddress, resetToDefaults } = useSettings();
  const { disconnect } = useWallet();
  const [saved, setSaved] = useState(false);
  const [showContracts, setShowContracts] = useState(false);

  function handleNetworkChange(net: string) {
    setNetwork(net as any);
  }

  function handleSave() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    if (confirm("Reset all settings to defaults?")) {
      resetToDefaults();
      disconnect();
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Settings</h1>

      {/* Network */}
      <Section title="Network">
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Network</label>
          <select
            value={settings.network}
            onChange={(e) => handleNetworkChange(e.target.value)}
            style={{ ...inputStyle, cursor: "pointer" }}
          >
            {Object.entries(NETWORK_CONFIGS)
              .filter(([_, cfg]) => Object.values(cfg.addresses).some((a) => a !== ""))
              .map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.name} (Chain {cfg.chainId})</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>RPC URL</label>
          <input
            value={settings.rpcUrl}
            onChange={(e) => updateSettings({ rpcUrl: e.target.value })}
            placeholder="https://..."
            style={inputStyle}
          />
        </div>
      </Section>

      {/* Pinata */}
      <Section title="IPFS / Pinata">
        <div>
          <label style={labelStyle}>Pinata API Key (for uploading campaign metadata)</label>
          <input
            type="password"
            value={settings.pinataApiKey ?? ""}
            onChange={(e) => updateSettings({ pinataApiKey: e.target.value })}
            placeholder="pk_..."
            style={inputStyle}
          />
          <div style={{ color: "#444", fontSize: 11, marginTop: 4 }}>
            Required to upload metadata when creating campaigns. Leave blank to use IPFS gateways for viewing only.
          </div>
        </div>
      </Section>

      {/* Contract Addresses */}
      <Section title="Contract Addresses">
        <button
          onClick={() => setShowContracts(!showContracts)}
          style={{ background: "none", border: "none", color: "#a0a0ff", fontSize: 13, cursor: "pointer", padding: 0, marginBottom: showContracts ? 12 : 0 }}
        >
          {showContracts ? "▼ Hide addresses" : "▶ Show addresses"}
        </button>
        {showContracts && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.keys(CONTRACT_LABELS).map((key) => (
              <div key={key}>
                <label style={labelStyle}>{CONTRACT_LABELS[key]}</label>
                <input
                  value={(settings.contractAddresses as any)[key] ?? ""}
                  onChange={(e) => setContractAddress(key as any, e.target.value)}
                  placeholder="0x..."
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                />
              </div>
            ))}
            <div style={{ color: "#444", fontSize: 11 }}>
              Changing the network above auto-fills known addresses. Manual overrides are preserved.
            </div>
          </div>
        )}
      </Section>

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          onClick={handleSave}
          style={{ padding: "8px 18px", background: saved ? "#0a2a0a" : "#1a1a3a", border: `1px solid ${saved ? "#2a5a2a" : "#4a4a8a"}`, borderRadius: 4, color: saved ? "#60c060" : "#a0a0ff", fontSize: 13, cursor: "pointer" }}
        >
          {saved ? "Saved!" : "Save Settings"}
        </button>
        <button
          onClick={handleReset}
          style={{ padding: "8px 18px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 13, cursor: "pointer" }}
        >
          Reset to Defaults
        </button>
      </div>

      {/* Version info */}
      <div style={{ marginTop: 24, padding: "10px 14px", background: "#0a0a14", border: "1px solid #0f0f1a", borderRadius: 6 }}>
        <div style={{ color: "#444", fontSize: 11 }}>
          DATUM Web App · Alpha-2 · Network: {NETWORK_CONFIGS[settings.network]?.name ?? settings.network}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14, marginBottom: 12 }}>
      <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

const labelStyle: React.CSSProperties = { color: "#888", fontSize: 12, display: "block", marginBottom: 4 };
const inputStyle: React.CSSProperties = { padding: "6px 8px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" };
