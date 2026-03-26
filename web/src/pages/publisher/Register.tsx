import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";

export function Register() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
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
      await tx.wait();
      setTxState("success");
      setTxMsg("Registered successfully!");
      setTimeout(() => navigate("/publisher"), 1500);
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (!address) return <div style={{ padding: 20, color: "#666" }}>Connect your wallet to register.</div>;

  return (
    <div style={{ maxWidth: 480 }}>
      <Link to="/publisher" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Publisher Dashboard</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Register as Publisher</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 20 }}>
        Set your take rate (30–80%). Campaigns targeting you will snapshot this rate at creation time.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label style={{ color: "#888", fontSize: 13, display: "block", marginBottom: 6 }}>
            Take Rate: <span style={{ color: "#a0a0ff", fontWeight: 700 }}>{takeRate}%</span>
          </label>
          <input
            type="range" min={30} max={80} value={takeRate}
            onChange={(e) => setTakeRate(Number(e.target.value))}
            style={{ width: "100%", accentColor: "#a0a0ff" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", color: "#444", fontSize: 11 }}>
            <span>30% (min)</span>
            <span>80% (max)</span>
          </div>
          <div style={{ color: "#555", fontSize: 12, marginTop: 6 }}>
            Publisher share per impression: {takeRate}% · User share: {Math.round((100 - takeRate) * 0.75)}% · Protocol: {Math.round((100 - takeRate) * 0.25)}%
          </div>
        </div>

        <TransactionStatus state={txState} message={txMsg} />

        <button type="submit" disabled={txState === "pending" || !signer} style={{ padding: "10px 20px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 6, color: "#a0a0ff", fontSize: 14, cursor: "pointer", fontWeight: 600 }}>
          {txState === "pending" ? "Registering..." : "Register Publisher"}
        </button>
      </form>
    </div>
  );
}
