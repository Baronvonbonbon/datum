import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useBlock } from "../../hooks/useBlock";
import { TransactionStatus } from "../../components/TransactionStatus";
import { formatBlockDelta } from "@shared/conviction";
import { humanizeError } from "@shared/errorCodes";

export function TakeRate() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();
  const [current, setCurrent] = useState<number | null>(null);
  const [pending, setPending] = useState<{ rate: number; effectiveBlock: number } | null>(null);
  const [newRate, setNewRate] = useState(50);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    try {
      const data = await contracts.publishers.getPublisher(address);
      setCurrent(Number(data.takeRateBps ?? data[1] ?? 0));
      const pendingRate = Number(data.pendingTakeRateBps ?? data[3] ?? 0);
      const effectiveBlock = Number(data.takeRateEffectiveBlock ?? data[4] ?? 0);
      if (pendingRate > 0 && effectiveBlock > 0) {
        setPending({ rate: pendingRate, effectiveBlock });
      } else {
        setPending(null);
      }
    } catch { /* not registered */ }
  }

  async function handleQueue(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setTxState("pending");
    try {
      const bps = Math.round(newRate * 100);
      const c = contracts.publishers.connect(signer);
      const tx = await c.updateTakeRate(bps);
      await tx.wait();
      setTxState("success");
      setTxMsg("Take rate update queued.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  async function handleApply() {
    if (!signer) return;
    setTxState("pending");
    try {
      const c = contracts.publishers.connect(signer);
      const tx = await c.applyTakeRateUpdate();
      await tx.wait();
      setTxState("success");
      setTxMsg("Take rate applied.");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  const canApply = pending && blockNumber && blockNumber >= pending.effectiveBlock;
  const blocksRemaining = pending && blockNumber ? Math.max(0, pending.effectiveBlock - blockNumber) : null;

  return (
    <div style={{ maxWidth: 480 }}>
      <Link to="/publisher" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Take Rate</h1>

      {current !== null && (
        <div style={{ padding: 12, background: "#111", border: "1px solid #1a1a2e", borderRadius: 6, marginBottom: 16 }}>
          <div style={{ color: "#555", fontSize: 12 }}>Current Rate</div>
          <div style={{ color: "#a0a0ff", fontSize: 24, fontWeight: 700 }}>{(current / 100).toFixed(0)}%</div>
        </div>
      )}

      {pending && (
        <div style={{ padding: 12, background: "#1a1a0a", border: "1px solid #3a3a0a", borderRadius: 6, marginBottom: 16 }}>
          <div style={{ color: "#c0c060", fontWeight: 600, marginBottom: 4 }}>Pending Update: {(pending.rate / 100).toFixed(0)}%</div>
          <div style={{ color: "#888", fontSize: 12 }}>
            Effective block: #{pending.effectiveBlock}
            {blocksRemaining !== null && blocksRemaining > 0 && (
              <span> · {formatBlockDelta(blocksRemaining)} remaining</span>
            )}
          </div>
          {canApply && (
            <button onClick={handleApply} disabled={txState === "pending"} style={{ marginTop: 10, padding: "6px 14px", background: "#1a3a1a", border: "1px solid #2a5a2a", borderRadius: 4, color: "#60c060", fontSize: 13, cursor: "pointer" }}>
              Apply Update Now
            </button>
          )}
        </div>
      )}

      {!pending && (
        <form onSubmit={handleQueue} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ color: "#888", fontSize: 13, display: "block", marginBottom: 6 }}>
              New Rate: <span style={{ color: "#a0a0ff", fontWeight: 700 }}>{newRate}%</span>
            </label>
            <input type="range" min={30} max={80} value={newRate} onChange={(e) => setNewRate(Number(e.target.value))} style={{ width: "100%", accentColor: "#a0a0ff" }} />
          </div>
          <div style={{ color: "#555", fontSize: 12 }}>Rate changes are delayed by the configured timelock period (~7 days).</div>
          <TransactionStatus state={txState} message={txMsg} />
          <button type="submit" disabled={txState === "pending" || !signer} style={{ padding: "8px 16px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer" }}>
            Queue Rate Change
          </button>
        </form>
      )}

      {(txState === "success" || txState === "error") && pending && (
        <TransactionStatus state={txState} message={txMsg} />
      )}
    </div>
  );
}
