import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

export function Allowlist() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const [enabled, setEnabled] = useState(false);
  const [allowedAddresses, setAllowedAddresses] = useState<string[]>([]);
  const [newAddr, setNewAddr] = useState("");
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const [isEnabled] = await Promise.all([
        contracts.publishers.allowlistEnabled(address).catch(() => false),
      ]);
      setEnabled(Boolean(isEnabled));

      // Get allowlist from AdvertiserAllowlistUpdated events
      const filter = contracts.publishers.filters.AdvertiserAllowlistUpdated(address);
      const logs = await contracts.publishers.queryFilter(filter).catch(() => []);
      const current = new Map<string, boolean>();
      for (const log of logs) {
        const { advertiser, allowed } = (log as any).args ?? {};
        if (advertiser) current.set(advertiser.toLowerCase(), Boolean(allowed));
      }
      setAllowedAddresses([...current.entries()].filter(([, v]) => v).map(([k]) => k));
    } finally {
      setLoading(false);
    }
  }

  async function toggleAllowlist() {
    if (!signer) return;
    setTxState("pending");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.setAllowlistEnabled(!enabled);
      await tx.wait();
      setEnabled(!enabled);
      setTxState("success");
      setTxMsg(`Allowlist ${!enabled ? "enabled" : "disabled"}.`);
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function addAddress() {
    if (!signer || !ethers.isAddress(newAddr)) return;
    setTxState("pending");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.setAllowedAdvertiser(newAddr, true);
      await tx.wait();
      setNewAddr("");
      setTxState("success");
      setTxMsg(`${newAddr.slice(0, 10)}... added.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function removeAddress(addr: string) {
    if (!signer) return;
    setTxState("pending");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.setAllowedAdvertiser(addr, false);
      await tx.wait();
      setTxState("success");
      setTxMsg(`${addr.slice(0, 10)}... removed.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <Link to="/publisher" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Advertiser Allowlist</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>
        When enabled, only listed advertisers can create campaigns targeting your publisher address.
        Open campaigns (publisher=0x0) always bypass the allowlist.
      </p>

      {loading ? <div style={{ color: "#555" }}>Loading...</div> : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 6, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: "#888", fontSize: 13 }}>Allowlist Status</div>
              <div style={{ color: enabled ? "#c0c060" : "#555", fontWeight: 600 }}>{enabled ? "Enabled" : "Disabled"}</div>
            </div>
            {signer && (
              <button onClick={toggleAllowlist} disabled={txState === "pending"} style={{ padding: "6px 14px", background: enabled ? "#2a1a0a" : "#1a1a3a", border: `1px solid ${enabled ? "#5a3a0a" : "#4a4a8a"}`, borderRadius: 4, color: enabled ? "#ff9040" : "#a0a0ff", fontSize: 13, cursor: "pointer" }}>
                {enabled ? "Disable" : "Enable"}
              </button>
            )}
          </div>

          {enabled && (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={newAddr} onChange={(e) => setNewAddr(e.target.value)}
                    placeholder="0x advertiser address"
                    style={{ flex: 1, padding: "6px 8px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none", fontFamily: "monospace" }}
                  />
                  <button onClick={addAddress} disabled={!ethers.isAddress(newAddr) || txState === "pending"} style={{ padding: "6px 14px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer" }}>
                    Add
                  </button>
                </div>
              </div>

              {allowedAddresses.length === 0 ? (
                <div style={{ color: "#555", fontSize: 13, fontStyle: "italic" }}>No advertisers allowed yet.</div>
              ) : (
                <div style={{ border: "1px solid #1a1a2e", borderRadius: 6, overflow: "hidden" }}>
                  {allowedAddresses.map((addr) => (
                    <div key={addr} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #0f0f1a" }}>
                      <AddressDisplay address={addr} chars={8} style={{ fontSize: 13 }} />
                      {signer && (
                        <button onClick={() => removeAddress(addr)} style={{ background: "none", border: "none", color: "#ff6060", cursor: "pointer", fontSize: 12 }}>Remove</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: 12 }}>
            <TransactionStatus state={txState} message={txMsg} />
          </div>
        </>
      )}
    </div>
  );
}
