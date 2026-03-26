import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";

interface CampaignEarnings {
  campaignId: string;
  totalPublisherPayment: bigint;
  totalImpressions: bigint;
  settlementCount: number;
}

export function Earnings() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [campaignBreakdown, setCampaignBreakdown] = useState<CampaignEarnings[]>([]);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const bal = await contracts.paymentVault.publisherBalance(address).catch(() => 0n);
      setBalance(BigInt(bal));

      // Fetch ClaimSettled events for this publisher
      const filter = contracts.settlement.filters.ClaimSettled();
      const logs = await contracts.settlement.queryFilter(filter, -5000).catch(() => []);
      const mine = logs
        .filter((l: any) => (l.args?.publisher ?? "").toLowerCase() === address.toLowerCase())
        .slice(-20)
        .reverse();
      setEvents(mine);

      // EA-2: Group by campaignId for per-campaign breakdown
      const byCampaign = new Map<string, CampaignEarnings>();
      for (const e of mine) {
        const id = String(e.args?.campaignId ?? "?");
        const existing = byCampaign.get(id);
        const payment = BigInt(e.args?.publisherPayment ?? 0);
        const impressions = BigInt(e.args?.impressionCount ?? 0);
        if (existing) {
          existing.totalPublisherPayment += payment;
          existing.totalImpressions += impressions;
          existing.settlementCount += 1;
        } else {
          byCampaign.set(id, { campaignId: id, totalPublisherPayment: payment, totalImpressions: impressions, settlementCount: 1 });
        }
      }
      const sorted = Array.from(byCampaign.values()).sort((a, b) =>
        a.totalPublisherPayment > b.totalPublisherPayment ? -1 : a.totalPublisherPayment < b.totalPublisherPayment ? 1 : 0
      );
      setCampaignBreakdown(sorted);
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw() {
    if (!signer) return;
    setTxState("pending");
    try {
      const vault = contracts.paymentVault.connect(signer);
      const tx = await vault.withdrawPublisher();
      await tx.wait();
      setTxState("success");
      setTxMsg("Withdrawal successful!");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/publisher" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>Publisher Earnings</h1>

      {loading ? <div style={{ color: "#555" }}>Loading...</div> : (
        <>
          <div style={{ padding: 16, background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, marginBottom: 16 }}>
            <div style={{ color: "#555", fontSize: 12, marginBottom: 4 }}>Available to Withdraw</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#e0e0e0", marginBottom: 10 }}>
              {balance !== null ? <DOTAmount planck={balance} /> : "—"}
            </div>
            <TransactionStatus state={txState} message={txMsg} />
            {signer && balance !== null && balance > 0n && (
              <button onClick={handleWithdraw} disabled={txState === "pending"} style={{ marginTop: 8, padding: "8px 16px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 4, color: "#a0a0ff", fontSize: 13, cursor: "pointer" }}>
                {txState === "pending" ? "Withdrawing..." : "Withdraw"}
              </button>
            )}
          </div>

          {campaignBreakdown.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: "#a0a0ff", fontWeight: 600, marginBottom: 10 }}>Earnings by Campaign</div>
              <div style={{ border: "1px solid #1a1a2e", borderRadius: 6, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#0f0f1a" }}>
                      {["Campaign", "Total Paid", "Impressions", "Settlements"].map((h) => (
                        <th key={h} style={{ padding: "6px 10px", color: "#555", fontSize: 11, textAlign: "left" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {campaignBreakdown.map((c) => (
                      <tr key={c.campaignId} style={{ borderTop: "1px solid #0f0f1a" }}>
                        <td style={{ padding: "6px 10px", color: "#888", fontSize: 12 }}>#{c.campaignId}</td>
                        <td style={{ padding: "6px 10px", fontSize: 12 }}>
                          <DOTAmount planck={c.totalPublisherPayment} />
                        </td>
                        <td style={{ padding: "6px 10px", color: "#888", fontSize: 12 }}>{c.totalImpressions.toLocaleString()}</td>
                        <td style={{ padding: "6px 10px", color: "#888", fontSize: 12 }}>{c.settlementCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <div style={{ color: "#a0a0ff", fontWeight: 600, marginBottom: 10 }}>Recent Settlements (last 5000 blocks)</div>
            {events.length === 0 ? (
              <div style={{ color: "#555", fontSize: 13 }}>No recent settlements found.</div>
            ) : (
              <div style={{ border: "1px solid #1a1a2e", borderRadius: 6, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#0f0f1a" }}>
                      {["Campaign", "User", "Paid"].map((h) => (
                        <th key={h} style={{ padding: "6px 10px", color: "#555", fontSize: 11, textAlign: "left" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e: any, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #0f0f1a" }}>
                        <td style={{ padding: "6px 10px", color: "#888", fontSize: 12 }}>#{String(e.args?.campaignId ?? "?")}</td>
                        <td style={{ padding: "6px 10px", fontFamily: "monospace", fontSize: 11, color: "#666" }}>
                          {(e.args?.user ?? "")?.slice(0, 10)}...
                        </td>
                        <td style={{ padding: "6px 10px", fontSize: 12 }}>
                          <DOTAmount planck={BigInt(e.args?.publisherPayment ?? 0)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
