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
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Settings</h1>

      {/* Network */}
      <Section title="Network">
        <div style={{ marginBottom: 12 }}>
          <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Network</label>
          <select
            value={settings.network}
            onChange={(e) => handleNetworkChange(e.target.value)}
            className="nano-select"
            style={{ cursor: "pointer" }}
          >
            {Object.entries(NETWORK_CONFIGS)
              .filter(([_, cfg]) => Object.values(cfg.addresses).some((a) => a !== ""))
              .map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.name} (Chain {cfg.chainId})</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>RPC URL</label>
          <input
            value={settings.rpcUrl}
            onChange={(e) => updateSettings({ rpcUrl: e.target.value })}
            placeholder="https://..."
            className="nano-input"
          />
        </div>
      </Section>

      {/* Pinata */}
      <Section title="IPFS / Pinata">
        <div>
          <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Pinata API Key (for uploading campaign metadata)</label>
          <input
            type="password"
            value={settings.pinataApiKey ?? ""}
            onChange={(e) => updateSettings({ pinataApiKey: e.target.value })}
            placeholder="pk_..."
            className="nano-input"
          />
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>
            Required to upload metadata when creating campaigns. Leave blank to use IPFS gateways for viewing only.
          </div>
        </div>
      </Section>

      {/* Contract Addresses */}
      <Section title="Contract Addresses">
        <button
          onClick={() => setShowContracts(!showContracts)}
          style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 13, cursor: "pointer", padding: 0, marginBottom: showContracts ? 12 : 0 }}
        >
          {showContracts ? "▼ Hide addresses" : "▶ Show addresses"}
        </button>
        {showContracts && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.keys(CONTRACT_LABELS).map((key) => (
              <div key={key}>
                <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>{CONTRACT_LABELS[key]}</label>
                <input
                  value={(settings.contractAddresses as any)[key] ?? ""}
                  onChange={(e) => setContractAddress(key as any, e.target.value)}
                  placeholder="0x..."
                  className="nano-input"
                  style={{ fontFamily: "monospace" }}
                />
              </div>
            ))}
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Changing the network above auto-fills known addresses. Manual overrides are preserved.
            </div>
          </div>
        )}
      </Section>

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          onClick={handleSave}
          className={saved ? "nano-btn" : "nano-btn nano-btn-accent"}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            color: saved ? "var(--ok)" : undefined,
            border: saved ? "1px solid rgba(110,231,183,0.3)" : undefined,
          }}
        >
          {saved ? "Saved!" : "Save Settings"}
        </button>
        <button
          onClick={handleReset}
          className="nano-btn"
          style={{ padding: "8px 18px", fontSize: 13 }}
        >
          Reset to Defaults
        </button>
      </div>

      {/* Version info */}
      <div className="nano-card" style={{ marginTop: 24, padding: "10px 14px" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
          DATUM Web App · Alpha-2 · Network: {NETWORK_CONFIGS[settings.network]?.name ?? settings.network}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
      <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}
