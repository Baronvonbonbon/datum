import { useState, useEffect } from "react";
import { web3Enable, web3Accounts } from "@polkadot/extension-dapp";
import { CampaignList } from "./CampaignList";
import { ClaimQueue } from "./ClaimQueue";
import { PublisherPanel } from "./PublisherPanel";
import { Settings } from "./Settings";

type Tab = "campaigns" | "claims" | "publisher" | "settings";

const TAB_LABELS: Record<Tab, string> = {
  campaigns: "Campaigns",
  claims: "Claims",
  publisher: "Publisher",
  settings: "Settings",
};

export function App() {
  const [tab, setTab] = useState<Tab>("claims");
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore connected address from storage on popup open
  useEffect(() => {
    chrome.storage.local.get("connectedAddress", (stored) => {
      if (stored.connectedAddress) setAddress(stored.connectedAddress);
    });
  }, []);

  async function connectWallet() {
    setConnecting(true);
    setError(null);
    try {
      const extensions = await web3Enable("DATUM");
      if (extensions.length === 0) {
        setError("No Polkadot wallet found. Install Polkadot.js or SubWallet.");
        return;
      }
      const accounts = await web3Accounts();
      if (accounts.length === 0) {
        setError("No accounts found. Create an account in your wallet.");
        return;
      }
      // Use the first account for now; Settings can allow switching
      const addr = accounts[0].address;
      setAddress(addr);
      chrome.storage.local.set({ connectedAddress: addr });
      chrome.runtime.sendMessage({ type: "WALLET_CONNECTED", address: addr });
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  function disconnect() {
    setAddress(null);
    chrome.storage.local.remove("connectedAddress");
    chrome.runtime.sendMessage({ type: "WALLET_DISCONNECTED" });
  }

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
        {address ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#888", fontSize: 12 }}>
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            <button onClick={disconnect} style={btnStyle("#333", "#888")}>
              Disconnect
            </button>
          </div>
        ) : (
          <button onClick={connectWallet} disabled={connecting} style={btnStyle("#4a4a8a", "#a0a0ff")}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: "8px 16px", background: "#3a1a1a", color: "#ff8080", fontSize: 12 }}>
          {error}
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
        {tab === "campaigns" && <CampaignList />}
        {tab === "claims" && <ClaimQueue address={address} />}
        {tab === "publisher" && <PublisherPanel address={address} />}
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
