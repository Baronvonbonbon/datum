import { useState } from "react";
import { useSettings } from "../context/SettingsContext";
import { useWallet } from "../context/WalletContext";
import { TransactionStatus } from "../components/TransactionStatus";
import { NETWORK_CONFIGS, getExplorerUrl } from "@shared/networks";
import { IPFS_PROVIDERS, testPinConfig } from "@shared/ipfsPin";
import { IpfsProvider } from "@shared/types";

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
  targetingRegistry: "TargetingRegistry",
  campaignValidator: "CampaignValidator",
  claimValidator: "ClaimValidator",
  governanceHelper: "GovernanceHelper",
};

export function Settings() {
  const { settings, updateSettings, setNetwork, setContractAddress, resetToDefaults } = useSettings();
  const { disconnect } = useWallet();
  const [saved, setSaved] = useState(false);
  const [showContracts, setShowContracts] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMsg, setTestMsg] = useState("");

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

  async function handleTestPin() {
    setTestStatus("testing");
    setTestMsg("");
    const result = await testPinConfig({
      provider: settings.ipfsProvider ?? "pinata",
      apiKey: settings.ipfsApiKey ?? settings.pinataApiKey ?? "",
      endpoint: settings.ipfsApiEndpoint,
    });
    setTestStatus(result.ok ? "ok" : "error");
    setTestMsg(result.ok ? "Connection successful." : result.error ?? "Test failed.");
  }

  const provider = settings.ipfsProvider ?? "pinata";
  const providerInfo = IPFS_PROVIDERS[provider];

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
          {settings.rpcUrl && settings.rpcUrl.startsWith("http://") && !settings.rpcUrl.startsWith("http://localhost") && !settings.rpcUrl.startsWith("http://127.0.0.1") && (
            <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 4 }}>
              Warning: Using unencrypted HTTP. Transactions and wallet data may be intercepted. Use HTTPS.
            </div>
          )}
        </div>
      </Section>

      {/* IPFS Pinning */}
      <Section title="IPFS Pinning">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>Pinning Service</label>
            <select
              value={provider}
              onChange={(e) => {
                updateSettings({ ipfsProvider: e.target.value as IpfsProvider });
                setTestStatus("idle");
                setTestMsg("");
              }}
              className="nano-select"
              style={{ cursor: "pointer" }}
            >
              {(Object.keys(IPFS_PROVIDERS) as IpfsProvider[]).map((p) => (
                <option key={p} value={p}>{IPFS_PROVIDERS[p].label}</option>
              ))}
            </select>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>
              Required to upload metadata when creating campaigns. Leave blank to use IPFS gateways for viewing only.
            </div>
          </div>

          {providerInfo.needsEndpoint && (
            <div>
              <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>
                Endpoint URL
              </label>
              <input
                value={settings.ipfsApiEndpoint ?? ""}
                onChange={(e) => updateSettings({ ipfsApiEndpoint: e.target.value })}
                placeholder="https://your-node/api/v0/add"
                className="nano-input"
              />
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>
                POST endpoint that accepts JSON and returns a CID in <code style={{ background: "var(--bg-raised)", padding: "1px 4px", borderRadius: 3 }}>IpfsHash</code>, <code style={{ background: "var(--bg-raised)", padding: "1px 4px", borderRadius: 3 }}>cid</code>, or <code style={{ background: "var(--bg-raised)", padding: "1px 4px", borderRadius: 3 }}>Hash</code> field.
              </div>
            </div>
          )}

          <div>
            <label style={{ color: "var(--text)", fontSize: 12, display: "block", marginBottom: 4 }}>
              {providerInfo.keyLabel}
              {providerInfo.docsUrl && (
                <a href={providerInfo.docsUrl} target="_blank" rel="noreferrer"
                  style={{ color: "var(--accent-dim)", fontSize: 11, marginLeft: 8, fontWeight: 400 }}>
                  Get key ↗
                </a>
              )}
            </label>
            <input
              type="password"
              value={settings.ipfsApiKey ?? settings.pinataApiKey ?? ""}
              onChange={(e) => updateSettings({ ipfsApiKey: e.target.value, pinataApiKey: provider === "pinata" ? e.target.value : settings.pinataApiKey })}
              placeholder={providerInfo.placeholder}
              className="nano-input"
            />
            <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>
              Session-only — not persisted to disk. You'll re-enter this after closing the browser.
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={handleTestPin}
              disabled={testStatus === "testing"}
              className="nano-btn"
              style={{ fontSize: 12, padding: "4px 12px" }}
            >
              {testStatus === "testing" ? "Testing..." : "Test Connection"}
            </button>
            {testStatus === "ok" && <span style={{ fontSize: 12, color: "var(--ok)" }}>{testMsg}</span>}
            {testStatus === "error" && <span style={{ fontSize: 12, color: "var(--error)" }}>{testMsg}</span>}
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
            {Object.keys(CONTRACT_LABELS).map((key) => {
              const addr = (settings.contractAddresses as any)[key] ?? "";
              const explorer = getExplorerUrl(settings.network);
              return (
                <div key={key}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <label style={{ color: "var(--text)", fontSize: 12 }}>{CONTRACT_LABELS[key]}</label>
                    {explorer && addr && (
                      <a
                        href={`${explorer}/address/${addr}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`View ${CONTRACT_LABELS[key]} on block explorer`}
                        style={{ color: "var(--accent-dim)", fontSize: 10, textDecoration: "none", lineHeight: 1 }}
                      >
                        ↗
                      </a>
                    )}
                  </div>
                  <input
                    value={addr}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      if (v === "" || /^0x[0-9a-fA-F]{0,40}$/.test(v)) setContractAddress(key as any, v);
                    }}
                    placeholder="0x..."
                    className="nano-input"
                    style={{ fontFamily: "monospace" }}
                  />
                  {addr && !/^0x[0-9a-fA-F]{40}$/.test(addr) && (
                    <div style={{ color: "var(--warn)", fontSize: 10, marginTop: 2 }}>Invalid address format</div>
                  )}
                </div>
              );
            })}
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
          DATUM Web App · Alpha-3 · Network: {NETWORK_CONFIGS[settings.network]?.name ?? settings.network}
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
