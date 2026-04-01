import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { ethers } from "ethers";
import { queryFilterBounded } from "@shared/eventQuery";

interface BlockedEntry {
  address: string;
  blockedAt: number; // block number
}

export function BlocklistAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
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
        queryFilterBounded(contracts.publishers, blockFilter),
        queryFilterBounded(contracts.publishers, unblockFilter),
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
      await confirmTx(tx);
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
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`${addr.slice(0, 10)}... removed from blocklist.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Address Blocklist</h1>
      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 16 }}>
        Blocked addresses cannot register as publishers or create campaigns. Existing claims from blocked publishers are also rejected at settlement (reason code 11).
      </p>
      <div className="nano-info nano-info--warn" style={{ marginBottom: 16, fontSize: 11 }}>
        Note: blocklist is currently owner-gated. Governance-managed blocklist (via Timelock) is planned before mainnet.
      </div>

      {signer && (
        <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
          <input
            value={newAddr}
            onChange={(e) => setNewAddr(e.target.value)}
            placeholder="0x address to block"
            className="nano-input"
            style={{ flex: 1, fontFamily: "monospace" }}
          />
          <button
            onClick={blockAddress}
            disabled={!ethers.isAddress(newAddr) || txState === "pending"}
            className="nano-btn"
            style={{ padding: "6px 14px", fontSize: 13, color: "var(--error)", border: "1px solid rgba(252,165,165,0.3)" }}
          >
            Block
          </button>
        </div>
      )}

      <TransactionStatus state={txState} message={txMsg} />

      {loading ? (
        <div style={{ color: "var(--text-muted)" }}>Loading blocklist...</div>
      ) : blocked.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13, fontStyle: "italic" }}>No blocked addresses.</div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          <div style={{ background: "var(--bg-raised)", padding: "6px 12px", display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Address</span>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Block #</span>
          </div>
          {blocked.map((entry) => (
            <div key={entry.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
              <AddressDisplay address={entry.address} chars={10} style={{ fontSize: 13 }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{entry.blockedAt}</span>
                {signer && (
                  <button
                    onClick={() => unblockAddress(entry.address)}
                    style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12 }}
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
