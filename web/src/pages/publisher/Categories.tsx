import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { CategoryPicker, bitmaskToCategories, categoriesToBitmask } from "../../components/CategoryPicker";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";

export function Categories() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const data = await contracts.publishers.getPublisher(address);
      const bitmask = BigInt(data.categoryBitmask ?? data[2] ?? 0);
      setSelected(bitmaskToCategories(bitmask));
    } catch { /* not registered */ }
    setLoading(false);
  }

  async function handleSave() {
    if (!signer) return;
    setTxState("pending");
    try {
      const bitmask = categoriesToBitmask(selected);
      const c = contracts.publishers.connect(signer);
      const tx = await c.setCategories(bitmask);
      await tx.wait();
      setTxState("success");
      setTxMsg(`Categories updated (${selected.size} selected).`);
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div>
      <Link to="/publisher" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 16px" }}>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700 }}>Ad Categories</h1>
        <span style={{ color: "#666", fontSize: 13 }}>{selected.size} / 26 selected</span>
      </div>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>
        Select the content categories your site covers. Only matching campaigns will be shown.
      </p>

      {loading ? <div style={{ color: "#555" }}>Loading...</div> : (
        <>
          <CategoryPicker value={selected} onChange={setSelected} />
          <div style={{ marginTop: 16 }}>
            <TransactionStatus state={txState} message={txMsg} />
            <button onClick={handleSave} disabled={txState === "pending" || !signer} style={{ marginTop: 12, padding: "8px 16px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer" }}>
              {txState === "pending" ? "Saving..." : "Save Categories"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
