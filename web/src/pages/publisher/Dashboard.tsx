import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { bitmaskToCategories } from "../../components/CategoryPicker";
import { CATEGORY_NAMES } from "@shared/types";
import { formatBlockDelta } from "@shared/conviction";
import { humanizeError } from "@shared/errorCodes";

export function PublisherDashboard() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const [info, setInfo] = useState<any>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const [pubData, bal, blk, blockNum] = await Promise.all([
        contracts.publishers.getPublisher(address).catch(() => null),
        contracts.paymentVault.publisherBalance(address).catch(() => 0n),
        contracts.publishers.isBlocked(address).catch(() => false),
        contracts.readProvider.getBlockNumber().catch(() => null),
      ]);
      setInfo(pubData);
      setBalance(BigInt(bal));
      setBlocked(Boolean(blk));
      if (blockNum) setCurrentBlock(blockNum);
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw() {
    if (!signer) return;
    setWithdrawing(true);
    setMsg(null);
    try {
      const vault = contracts.paymentVault.connect(signer);
      const tx = await vault.withdrawPublisher();
      await tx.wait();
      setMsg("Withdrawal successful!");
      load();
    } catch (err) {
      setMsg(humanizeError(err));
    } finally {
      setWithdrawing(false);
    }
  }

  if (!address) return <div style={{ padding: 20, color: "#666" }}>Connect your wallet to manage your publisher profile.</div>;
  if (loading) return <div style={{ color: "#555", padding: 20 }}>Loading...</div>;

  const isRegistered = info?.registered === true || info?.[0] === true;
  const takeRateBps = Number(info?.takeRateBps ?? info?.[1] ?? 0);
  const categoryBitmask = BigInt(info?.categoryBitmask ?? info?.[2] ?? 0);
  const categories = bitmaskToCategories(categoryBitmask);

  return (
    <div>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Publisher Dashboard</h1>

      {blocked && (
        <div style={{ padding: "10px 14px", background: "#2a0a0a", border: "1px solid #5a1a1a", borderRadius: 6, color: "#ff6060", fontWeight: 600, marginBottom: 16 }}>
          ⚠ This address is blocked by the protocol admin. New registrations and campaigns are restricted.
        </div>
      )}

      {!isRegistered ? (
        <div style={{ padding: 20, background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8 }}>
          <div style={{ color: "#888", marginBottom: 12 }}>You are not registered as a publisher.</div>
          <Link to="/publisher/register" style={{ padding: "8px 16px", background: "#1a1a3a", color: "#a0a0ff", border: "1px solid #4a4a8a", borderRadius: 4, fontSize: 13, textDecoration: "none" }}>
            Register as Publisher
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            <InfoCard label="Take Rate" value={`${(takeRateBps / 100).toFixed(0)}%`} />
            <InfoCard label="Categories" value={`${categories.size} selected`} />
            <InfoCard label="Status" value="Registered" color="#60c060" />
          </div>

          {categories.size > 0 && (
            <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 6, padding: 12 }}>
              <div style={{ color: "#555", fontSize: 12, marginBottom: 6 }}>Active Categories</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {[...categories].map((id) => (
                  <span key={id} style={{ padding: "2px 8px", background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 3, fontSize: 11, color: "#a0a0ff" }}>
                    {CATEGORY_NAMES[id]}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Earnings */}
          <div style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 16 }}>
            <div style={{ color: "#a0a0ff", fontWeight: 600, marginBottom: 10 }}>Earnings</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#e0e0e0", marginBottom: 10 }}>
              {balance !== null ? <DOTAmount planck={balance} /> : "—"}
            </div>
            {msg && <div style={{ color: msg.includes("successful") ? "#60c060" : "#ff8080", fontSize: 13, marginBottom: 8 }}>{msg}</div>}
            {signer && balance !== null && balance > 0n && (
              <button onClick={handleWithdraw} disabled={withdrawing} style={actionBtn}>
                {withdrawing ? "Withdrawing..." : "Withdraw Earnings"}
              </button>
            )}
          </div>

          {/* Quick links */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link to="/publisher/rate" style={navBtn}>Update Take Rate</Link>
            <Link to="/publisher/categories" style={navBtn}>Manage Categories</Link>
            <Link to="/publisher/allowlist" style={navBtn}>Allowlist</Link>
            <Link to="/publisher/earnings" style={navBtn}>Full Earnings</Link>
            <Link to="/publisher/sdk" style={navBtn}>SDK Setup</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: "#111", border: "1px solid #1a1a2e", borderRadius: 6, padding: "10px 14px" }}>
      <div style={{ color: "#555", fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ color: color ?? "#e0e0e0", fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

const actionBtn: React.CSSProperties = { padding: "8px 16px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer" };
const navBtn: React.CSSProperties = { padding: "6px 12px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, textDecoration: "none" };
