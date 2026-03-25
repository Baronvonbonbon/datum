import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

interface PendingChange {
  target: string;
  data: string;
  effectiveTime: number;
  decoded?: string;
}

export function TimelockAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  // Propose form
  const [target, setTarget] = useState("");
  const [calldata, setCalldata] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [pendingTarget, pendingData, pendingTs, delayBlocks] = await Promise.all([
        contracts.timelock.pendingTarget().catch(() => null),
        contracts.timelock.pendingData().catch(() => null),
        contracts.timelock.pendingTimestamp().catch(() => null),
        contracts.timelock.TIMELOCK_DELAY().catch(() => null),
      ]);

      setDelay(delayBlocks !== null ? Number(delayBlocks) : null);

      const t = String(pendingTarget ?? "");
      const isNonEmpty = t && t !== ethers.ZeroAddress;
      if (isNonEmpty) {
        const data = String(pendingData ?? "0x");
        setPending({
          target: t,
          data,
          effectiveTime: Number(pendingTs ?? 0),
          decoded: tryDecodeCalldata(data),
        });
      } else {
        setPending(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function tryDecodeCalldata(data: string): string {
    if (!data || data === "0x" || data.length < 10) return "";
    const selector = data.slice(0, 10);
    const known: Record<string, string> = {
      "0x8456cb59": "pause()",
      "0x3f4ba83a": "unpause()",
      "0xf2fde38b": "transferOwnership(address)",
      "0x715018a6": "renounceOwnership()",
    };
    return known[selector] ? known[selector] : `selector:${selector}`;
  }

  async function propose() {
    if (!signer || !ethers.isAddress(target)) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const data = calldata || "0x";
      const tx = await c.propose(target, data);
      await tx.wait();
      setTxState("success");
      setTxMsg("Proposal submitted. Execute after the timelock delay.");
      setTarget(""); setCalldata("");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function execute() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const tx = await c.execute();
      await tx.wait();
      setTxState("success");
      setTxMsg("Proposal executed.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function cancel() {
    if (!signer) return;
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.timelock.connect(signer);
      const tx = await c.cancel();
      await tx.wait();
      setTxState("success");
      setTxMsg("Proposal cancelled.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const ready = pending !== null && now >= pending.effectiveTime;

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Timelock</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>
        Single-slot timelock: one pending proposal at a time. Propose a call, wait for the delay, then execute.
        {delay !== null && <span style={{ color: "#555" }}> Delay: {delay.toLocaleString()} blocks.</span>}
      </p>

      <TransactionStatus state={txState} message={txMsg} />

      {/* Pending proposal */}
      {loading ? (
        <div style={{ color: "#555" }}>Loading...</div>
      ) : pending ? (
        <div style={{ background: "#0d0d18", border: `1px solid ${ready ? "#2a5a2a" : "#1a1a2e"}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14 }}>Pending Proposal</div>
            <span style={{ fontSize: 11, color: ready ? "#60c060" : "#888", background: ready ? "#0a2a0a" : "#111", padding: "2px 8px", borderRadius: 10, border: `1px solid ${ready ? "#2a5a2a" : "#1a1a2e"}` }}>
              {ready ? "Ready to Execute" : `ETA: ${new Date(pending.effectiveTime * 1000).toLocaleString()}`}
            </span>
          </div>
          <div style={{ marginBottom: 6 }}>
            <div style={{ color: "#555", fontSize: 11 }}>Target</div>
            <div style={{ color: "#e0e0e0", fontSize: 13, fontFamily: "monospace" }}>{pending.target}</div>
          </div>
          {pending.decoded && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: "#555", fontSize: 11 }}>Decoded</div>
              <div style={{ color: "#888", fontSize: 12, fontFamily: "monospace" }}>{pending.decoded}</div>
            </div>
          )}
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: "#555", fontSize: 11 }}>Calldata</div>
            <div style={{ color: "#444", fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>
              {pending.data.length > 66 ? pending.data.slice(0, 66) + "..." : pending.data}
            </div>
          </div>
          {signer && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={execute}
                disabled={!ready || txState === "pending"}
                style={{ padding: "5px 14px", background: ready ? "#1a1a3a" : "#111", border: `1px solid ${ready ? "#4a4a8a" : "#1a1a2e"}`, borderRadius: 4, color: ready ? "#a0a0ff" : "#444", fontSize: 12, cursor: ready ? "pointer" : "not-allowed" }}
              >
                Execute
              </button>
              <button
                onClick={cancel}
                disabled={txState === "pending"}
                style={{ padding: "5px 14px", background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 4, color: "#ff8080", fontSize: 12, cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: "#555", fontSize: 13, marginBottom: 16, padding: "10px 14px", background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 6 }}>
          No pending proposal.
        </div>
      )}

      {/* Propose new */}
      {signer && !pending && (
        <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14 }}>
          <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 14, marginBottom: 12 }}>New Proposal</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>Target Contract Address</label>
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x..." style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Calldata (hex)</label>
              <input value={calldata} onChange={(e) => setCalldata(e.target.value)} placeholder="0x..." style={inputStyle} />
              <div style={{ color: "#444", fontSize: 11, marginTop: 3 }}>
                Use ABI encoder or Blockscout to generate calldata for the target function.
              </div>
            </div>
            <button
              onClick={propose}
              disabled={!ethers.isAddress(target) || txState === "pending"}
              style={{ padding: "7px 16px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer", alignSelf: "flex-start" }}
            >
              Propose
            </button>
          </div>
        </div>
      )}
      {signer && pending && (
        <div style={{ color: "#444", fontSize: 12, marginTop: 8 }}>
          Cancel the current proposal before submitting a new one.
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { color: "#888", fontSize: 12, display: "block", marginBottom: 4 };
const inputStyle: React.CSSProperties = { padding: "6px 8px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none", width: "100%", fontFamily: "monospace" };
