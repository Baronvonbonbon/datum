import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

interface BlockedEntry {
  address: string;
  blockedAt: number; // block number
}

export function BlocklistAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAddr, setNewAddr] = useState("");
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const blockFilter = contracts.publishers.filters.AddressBlocked();
      const unblockFilter = contracts.publishers.filters.AddressUnblocked();
      const [blockLogs, unblockLogs] = await Promise.all([
        contracts.publishers.queryFilter(blockFilter).catch(() => []),
        contracts.publishers.queryFilter(unblockFilter).catch(() => []),
      ]);

      const current = new Map<string, BlockedEntry>();
      for (const log of blockLogs) {
        const args = (log as any).args ?? {};
        const addr = String(args.account ?? args[0] ?? "").toLowerCase();
        if (addr) current.set(addr, { address: addr, blockedAt: (log as any).blockNumber ?? 0 });
      }
      for (const log of unblockLogs) {
        const args = (log as any).args ?? {};
        const addr = String(args.account ?? args[0] ?? "").toLowerCase();
        current.delete(addr);
      }

      setBlocked([...current.values()].sort((a, b) => b.blockedAt - a.blockedAt));
    } finally {
      setLoading(false);
    }
  }

  async function blockAddress() {
    if (!signer || !ethers.isAddress(newAddr)) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.blockAddress(newAddr);
      await tx.wait();
      setNewAddr("");
      setTxState("success");
      setTxMsg(`${newAddr.slice(0, 10)}... added to blocklist.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function unblockAddress(addr: string) {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.unblockAddress(addr);
      await tx.wait();
      setTxState("success");
      setTxMsg(`${addr.slice(0, 10)}... removed from blocklist.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Address Blocklist</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>
        Blocked addresses cannot register as publishers or create campaigns. Existing claims from blocked publishers are also rejected at settlement (reason code 11).
      </p>
      <div style={{ padding: "6px 10px", background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 4, color: "#ff9040", fontSize: 11, marginBottom: 16 }}>
        Note: blocklist is currently owner-gated. Governance-managed blocklist (via Timelock) is planned before mainnet.
      </div>

      {signer && (
        <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
          <input
            value={newAddr}
            onChange={(e) => setNewAddr(e.target.value)}
            placeholder="0x address to block"
            style={{ flex: 1, padding: "6px 8px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none", fontFamily: "monospace" }}
          />
          <button
            onClick={blockAddress}
            disabled={!ethers.isAddress(newAddr) || txState === "pending"}
            style={{ padding: "6px 14px", background: "#2a0a0a", border: "1px solid #5a2a2a", borderRadius: 4, color: "#ff8080", fontSize: 13, cursor: "pointer" }}
          >
            Block
          </button>
        </div>
      )}

      <TransactionStatus state={txState} message={txMsg} />

      {loading ? (
        <div style={{ color: "#555" }}>Loading blocklist...</div>
      ) : blocked.length === 0 ? (
        <div style={{ color: "#555", fontSize: 13, fontStyle: "italic" }}>No blocked addresses.</div>
      ) : (
        <div style={{ border: "1px solid #1a1a2e", borderRadius: 6, overflow: "hidden" }}>
          <div style={{ background: "#0f0f1a", padding: "6px 12px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#555", fontSize: 11 }}>Address</span>
            <span style={{ color: "#555", fontSize: 11 }}>Block #</span>
          </div>
          {blocked.map((entry) => (
            <div key={entry.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderTop: "1px solid #0f0f1a" }}>
              <AddressDisplay address={entry.address} chars={10} style={{ fontSize: 13 }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ color: "#444", fontSize: 11 }}>{entry.blockedAt}</span>
                {signer && (
                  <button
                    onClick={() => unblockAddress(entry.address)}
                    style={{ background: "none", border: "none", color: "#a0a0ff", cursor: "pointer", fontSize: 12 }}
                  >
                    Unblock
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
