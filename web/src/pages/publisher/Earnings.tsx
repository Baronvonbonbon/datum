import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { queryFilterAll } from "@shared/eventQuery";
import { ConfirmModal } from "../../components/ConfirmModal";
import { RequirePublisher } from "../../components/RequirePublisher";
import { toCSV, downloadCSV } from "@shared/csvExport";
import { formatDOT } from "@shared/dot";
import { MiniBarChart } from "../../components/MiniBarChart";

interface CampaignEarnings {
  campaignId: string;
  totalPublisherPayment: bigint;
  totalImpressions: bigint;
  settlementCount: number;
}

export function Earnings() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { confirmTx } = useTx();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [campaignBreakdown, setCampaignBreakdown] = useState<CampaignEarnings[]>([]);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const bal = await contracts.paymentVault.publisherBalance(address).catch(() => 0n);
      setBalance(BigInt(bal));

      // Fetch all ClaimSettled events for this publisher
      const filter = contracts.settlement.filters.ClaimSettled();
      const logs = await queryFilterAll(contracts.settlement, filter).catch(() => []);
      const mine = logs
        .filter((l: any) => (l.args?.publisher ?? "").toLowerCase() === address.toLowerCase())
        .reverse();
      setEvents(mine.slice(0, 50));

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
      await confirmTx(tx);
      setTxState("success");
      setTxMsg("Withdrawal successful!");
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <RequirePublisher>
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Publisher Earnings</h1>
        <div style={{ display: "flex", gap: 6 }}>
          {campaignBreakdown.length > 0 && (
            <button
              onClick={() => {
                const rows = campaignBreakdown.map((c) => ({
                  Campaign: `#${c.campaignId}`,
                  "Total Paid": formatDOT(c.totalPublisherPayment),
                  Impressions: c.totalImpressions.toString(),
                  Settlements: c.settlementCount,
                }));
                downloadCSV("datum-earnings.csv", toCSV(["Campaign", "Total Paid", "Impressions", "Settlements"], rows));
              }}
              className="nano-btn"
              style={{ fontSize: 12 }}
            >
              Export CSV
            </button>
          )}
          <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
        </div>
      </div>

      {loading ? <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading</div> : (
        <>
          <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Available to Withdraw</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
              {balance !== null ? <DOTAmount planck={balance} /> : "—"}
            </div>
            <TransactionStatus state={txState} message={txMsg} />
            {signer && balance !== null && balance > 0n && (
              <button onClick={() => setShowWithdrawConfirm(true)} disabled={txState === "pending"} className="nano-btn nano-btn-accent" style={{ marginTop: 8, padding: "8px 16px", fontSize: 13 }}>
                {txState === "pending" ? "Withdrawing..." : "Withdraw"}
              </button>
            )}
          </div>

          {campaignBreakdown.length > 1 && (
            <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Earnings Distribution</div>
              <MiniBarChart
                bars={campaignBreakdown.slice(0, 12).map((c) => ({
                  label: `#${c.campaignId}`,
                  value: Number(c.totalPublisherPayment) / 1e10,
                  color: "rgba(110,231,183,0.6)",
                }))}
                height={120}
                formatValue={(v) => v >= 1 ? `${v.toFixed(1)}` : v >= 0.01 ? `${v.toFixed(3)}` : `${v.toFixed(4)}`}
              />
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 6 }}>
                Earnings in DOT per campaign (top {Math.min(12, campaignBreakdown.length)})
              </div>
            </div>
          )}

          {campaignBreakdown.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Earnings by Campaign</div>
              <div style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)" }}>
                <table className="nano-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      {["Campaign", "Total Paid", "Impressions", "Settlements"].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {campaignBreakdown.map((c) => (
                      <tr key={c.campaignId}>
                        <td>#{c.campaignId}</td>
                        <td><DOTAmount planck={c.totalPublisherPayment} /></td>
                        <td>{c.totalImpressions.toLocaleString()}</td>
                        <td>{c.settlementCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Recent Settlements ({events.length > 0 ? `${events.length} found` : "all time"})</div>
            {events.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No recent settlements found.</div>
            ) : (
              <div style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)" }}>
                <table className="nano-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      {["Campaign", "User", "Paid"].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e: any, i) => (
                      <tr key={i}>
                        <td>#{String(e.args?.campaignId ?? "?")}</td>
                        <td style={{ fontFamily: "monospace", fontSize: 11 }}>
                          {(e.args?.user ?? "")?.slice(0, 10)}...
                        </td>
                        <td><DOTAmount planck={BigInt(e.args?.publisherPayment ?? 0)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {showWithdrawConfirm && (
        <ConfirmModal
          title="Withdraw Earnings?"
          message="This will transfer your full available balance to your wallet."
          confirmLabel="Withdraw"
          onConfirm={() => { setShowWithdrawConfirm(false); handleWithdraw(); }}
          onCancel={() => setShowWithdrawConfirm(false)}
        />
      )}
    </div>
    </RequirePublisher>
  );
}
