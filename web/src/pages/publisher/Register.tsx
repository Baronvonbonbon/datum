import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

export function Register() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const navigate = useNavigate();
  const [takeRate, setTakeRate] = useState(50);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setTxState("pending");
    try {
      const bps = Math.round(takeRate * 100);
      const c = contracts.publishers.connect(signer);
      const tx = await c.registerPublisher(bps);
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Registered successfully!");
      setTimeout(() => navigate("/publisher"), 1500);
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (!address) return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to register.</div>;

  return (
    <div className="nano-fade" style={{ maxWidth: 480 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Publisher Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Register as Publisher</h1>
      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 20 }}>
        Set your take rate (30–80%). Campaigns targeting you will snapshot this rate at creation time.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 6 }}>
            Take Rate: <span style={{ color: "var(--accent)", fontWeight: 700 }}>{takeRate}%</span>
          </label>
          <input
            type="range" min={30} max={80} value={takeRate}
            onChange={(e) => setTakeRate(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", fontSize: 11 }}>
            <span>30% (min)</span>
            <span>80% (max)</span>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
            Publisher share per impression: {takeRate}% · User share: {Math.round((100 - takeRate) * 0.75)}% · Protocol: {Math.round((100 - takeRate) * 0.25)}%
          </div>
        </div>

        <TransactionStatus state={txState} message={txMsg} />

        <button type="submit" disabled={txState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600 }}>
          {txState === "pending" ? "Registering..." : "Register Publisher"}
        </button>
      </form>
    </div>
  );
}
