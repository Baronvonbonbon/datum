import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { ethers } from "ethers";
import { queryFilterBounded } from "@shared/eventQuery";
import { useToast } from "../../context/ToastContext";

interface BlockedEntry {
  address: string;
  blockedAt: number; // block number
}

interface PendingProposal {
  target: string;
  data: string;
  effectiveTime: number;
  decoded: string;
  action: "block" | "unblock" | "other";
  subject: string; // address being blocked/unblocked
}

export function BlocklistAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingProposal | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [newAddr, setNewAddr] = useState("");
  const [action, setAction] = useState<"block" | "unblock">("block");
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [blockFilter, unblockFilter, pendingTarget, pendingData, pendingTs, delayVal] = await Promise.all([
        Promise.resolve(contracts.publishers.filters.AddressBlocked()),
        Promise.resolve(contracts.publishers.filters.AddressUnblocked()),
        contracts.timelock.pendingTarget().catch(() => null),
        contracts.timelock.pendingData().catch(() => null),
        contracts.timelock.pendingTimestamp().catch(() => null),
        contracts.timelock.TIMELOCK_DELAY().catch(() => null),
      ]);

      setDelay(delayVal !== null ? Number(delayVal) : null);

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

      // Parse pending timelock proposal
      const t = String(pendingTarget ?? "");
      const publishersAddr = contracts.publishers.target as string;
      if (t && t !== ethers.ZeroAddress) {
        const data = String(pendingData ?? "0x");
        const { action: act, subject } = decodeBlocklistCall(data);
        setPending({
          target: t,
          data,
          effectiveTime: Number(pendingTs ?? 0),
          decoded: act === "block" ? `blockAddress(${subject})` : act === "unblock" ? `unblockAddress(${subject})` : `selector: ${data.slice(0, 10)}`,
          action: act,
          subject,
        });
      } else {
        setPending(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function decodeBlocklistCall(data: string): { action: "block" | "unblock" | "other"; subject: string } {
    if (!data || data.length < 10) return { action: "other", subject: "" };
    const selector = data.slice(0, 10).toLowerCase();
    // blockAddress(address):   0xad2bb1b3
    // unblockAddress(address): 0x186d9d88
    try {
      if (selector === "0xad2bb1b3" || selector === "0x186d9d88") {
        const [addr] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], "0x" + data.slice(10));
        return { action: selector === "0xad2bb1b3" ? "block" : "unblock", subject: String(addr) };
      }
    } catch {/* ignore */}
    return { action: "other", subject: "" };
  }

  async function propose() {
    if (!signer || !ethers.isAddress(newAddr)) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const calldata = action === "block"
        ? contracts.publishers.interface.encodeFunctionData("blockAddress", [newAddr])
        : contracts.publishers.interface.encodeFunctionData("unblockAddress", [newAddr]);
      const c = contracts.timelock.connect(signer);
      const publishersAddr = contracts.publishers.target as string;
      const tx = await confirmTx(() => c.propose(publishersAddr, calldata));
      if (tx) await tx.wait?.().catch(() => null);
      setNewAddr("");
      setTxState("success");
      setTxMsg(`Proposal submitted. Execute after the timelock delay (${delay?.toLocaleString() ?? "?"} blocks).`);
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxState("error");
    }
  }

  async function execute() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const tx = await confirmTx(() => c.execute());
      if (tx) await tx.wait?.().catch(() => null);
      setTxState("success");
      setTxMsg("Proposal executed.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxState("error");
    }
  }

  async function cancel() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const tx = await confirmTx(() => c.cancel());
      if (tx) await tx.wait?.().catch(() => null);
      setTxState("success");
      setTxMsg("Proposal cancelled.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setTxState("error");
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const ready = pending !== null && now >= pending.effectiveTime;

  return (
    <div className="nano-fade" style={{ maxWidth: 560 }}>
      <AdminNav />
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Address Blocklist</h1>
      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 16 }}>
        Blocked addresses cannot register as publishers or create campaigns. Existing claims from blocked publishers are rejected at settlement (code 11).
        Changes go through the 48-hour timelock for transparency.
        {delay !== null && <span style={{ color: "var(--text-muted)" }}> Delay: {delay.toLocaleString()} blocks.</span>}
      </p>

      <TransactionStatus state={txState} message={txMsg} />

      {/* Pending timelock proposal */}
      {!loading && pending && (
        <div className="nano-card" style={{
          border: `1px solid ${ready ? "rgba(74,222,128,0.3)" : "var(--border)"}`,
          padding: 14, marginBottom: 16,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14 }}>
              Pending: {pending.action === "block" ? "Block" : pending.action === "unblock" ? "Unblock" : "Proposal"}
            </div>
            <span className="nano-badge" style={{
              color: ready ? "var(--ok)" : "var(--text)",
              border: `1px solid ${ready ? "rgba(74,222,128,0.3)" : "var(--border)"}`,
              borderRadius: 10,
            }}>
              {ready ? "Ready to Execute" : `ETA: ${new Date(pending.effectiveTime * 1000).toLocaleString()}`}
            </span>
          </div>
          {pending.subject && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Address</div>
              <div style={{ color: "var(--text-strong)", fontSize: 13, fontFamily: "var(--font-mono)" }}>{pending.subject}</div>
            </div>
          )}
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Decoded</div>
            <div style={{ color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}>{pending.decoded}</div>
          </div>
          {signer && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={execute}
                disabled={!ready || txState === "pending"}
                className="nano-btn"
                style={{
                  padding: "5px 14px", fontSize: 12,
                  color: ready ? "var(--accent)" : "var(--text-muted)",
                  cursor: ready ? "pointer" : "not-allowed",
                  opacity: ready ? 1 : 0.5,
                }}
              >
                Execute
              </button>
              <button
                onClick={cancel}
                disabled={txState === "pending"}
                className="nano-btn"
                style={{ padding: "5px 14px", fontSize: 12, color: "var(--error)", border: "1px solid rgba(248,113,113,0.3)" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* Propose new block/unblock */}
      {signer && !pending && !loading && (
        <div className="nano-card" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Propose Change</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => setAction("block")}
              className={action === "block" ? "nano-btn nano-btn-accent" : "nano-btn"}
              style={{ padding: "5px 14px", fontSize: 12, color: action === "block" ? "var(--error)" : "var(--text-muted)", border: action === "block" ? "1px solid rgba(248,113,113,0.4)" : undefined, background: action === "block" ? "rgba(248,113,113,0.08)" : undefined }}
            >
              Block
            </button>
            <button
              onClick={() => setAction("unblock")}
              className={action === "unblock" ? "nano-btn nano-btn-accent" : "nano-btn"}
              style={{ padding: "5px 14px", fontSize: 12 }}
            >
              Unblock
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={newAddr}
              onChange={(e) => setNewAddr(e.target.value)}
              placeholder="0x address"
              className="nano-input"
              style={{ flex: 1, fontFamily: "var(--font-mono)" }}
            />
            <button
              onClick={propose}
              disabled={!ethers.isAddress(newAddr) || txState === "pending"}
              className="nano-btn nano-btn-accent"
              style={{ padding: "6px 14px", fontSize: 13 }}
            >
              Propose
            </button>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6 }}>
            Submits a timelock proposal. The call executes after the delay has passed and you call Execute.
          </div>
        </div>
      )}

      {signer && pending && !loading && (
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 16 }}>
          Cancel the current proposal before submitting a new one.
        </div>
      )}

      {/* Blocked addresses list */}
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
                {signer && !pending && (
                  <button
                    onClick={() => { setNewAddr(entry.address); setAction("unblock"); }}
                    style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12 }}
                  >
                    Propose unblock
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
