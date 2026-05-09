import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { MiniBarChart } from "../../components/MiniBarChart";
import { StatusBadge } from "../../components/StatusBadge";
import { formatDOT } from "@shared/dot";
import { queryFilterAll } from "@shared/eventQuery";
import { toCSV, downloadCSV } from "@shared/csvExport";

interface CampaignStats {
  id: number;
  status: number;
  totalImpressions: bigint;
  totalUserPaid: bigint;
  totalPublisherPaid: bigint;
  totalProtocolFees: bigint;
  remaining: bigint;
  originalBudget: bigint;
  uniqueUsers: number;
  settlementCount: number;
  bidCpmPlanck: bigint;
}

export function CampaignAnalytics() {
  const contracts = useContracts();
  const { address } = useWallet();
  const [campaigns, setCampaigns] = useState<CampaignStats[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      // Discover via indexed CampaignCreated event; fall back to ID scan when the
      // event filter returns nothing (Paseo gateway intermittently drops topic filters).
      let candidateIds: number[] = [];
      try {
        const filter = contracts.campaigns.filters.CampaignCreated(null, address);
        const logs = await queryFilterAll(contracts.campaigns, filter);
        candidateIds = logs
          .map((l: any) => Number(l.args?.campaignId ?? l.args?.[0]))
          .filter((n) => Number.isFinite(n));
      } catch { /* indexed filter unsupported */ }
      if (candidateIds.length === 0) {
        const nextId = Number(await contracts.campaigns.nextCampaignId());
        candidateIds = Array.from({ length: Math.min(nextId, 500) }, (_, i) => nextId - 1 - i).filter((i) => i >= 0);
      }

      const results: CampaignStats[] = [];
      await Promise.all(candidateIds.map(async (id) => {
        try {
          const adv = await contracts.campaigns.getCampaignAdvertiser(BigInt(id));
          if ((adv as string).toLowerCase() !== address.toLowerCase()) return;

          const [c, viewBid] = await Promise.all([
            contracts.campaigns.getCampaignForSettlement(BigInt(id)),
            contracts.campaigns.getCampaignViewBid(BigInt(id)).catch(() => 0n),
          ]);
          let remaining = 0n, originalBudget = 0n;
          try {
            remaining = BigInt(await contracts.budgetLedger.getTotalRemainingBudget(BigInt(id)));
            const bFilter = contracts.budgetLedger.filters.BudgetInitialized(BigInt(id));
            const bLogs = await queryFilterAll(contracts.budgetLedger, bFilter);
            if (bLogs.length > 0) originalBudget = BigInt((bLogs[0] as any).args?.budget ?? 0);
          } catch { /* no budget */ }

          // Fetch settlements for this campaign
          let totalImpressions = 0n, totalUserPaid = 0n, totalPublisherPaid = 0n, uniqueUsers = 0, settlementCount = 0;
          try {
            const sFilter = contracts.settlement.filters.ClaimSettled(BigInt(id));
            const sLogs = await queryFilterAll(contracts.settlement, sFilter);
            const userSet = new Set<string>();
            for (const log of sLogs) {
              const args = (log as any).args;
              totalImpressions += BigInt(args?.impressionCount ?? 0);
              totalUserPaid += BigInt(args?.userPayment ?? 0);
              totalPublisherPaid += BigInt(args?.publisherPayment ?? 0);
              userSet.add((args?.user ?? "").toLowerCase());
              settlementCount++;
            }
            uniqueUsers = userSet.size;
          } catch { /* no settlements */ }

          const totalSpent = originalBudget > 0n ? originalBudget - remaining : 0n;
          const totalProtocolFees = totalSpent > totalUserPaid + totalPublisherPaid
            ? totalSpent - totalUserPaid - totalPublisherPaid : 0n;

          results.push({
            id, status: Number(c[0]),
            totalImpressions, totalUserPaid, totalPublisherPaid, totalProtocolFees,
            remaining, originalBudget, uniqueUsers, settlementCount,
            bidCpmPlanck: BigInt(viewBid),
          });
        } catch { /* skip */ }
      }));

      setCampaigns(results.sort((a, b) => b.id - a.id));
    } finally {
      setLoading(false);
    }
  }, [address, contracts]);

  useEffect(() => { load(); }, [load]);

  if (!address) return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to view analytics.</div>;

  // Aggregate stats
  const totalSpent = campaigns.reduce((s, c) => s + (c.originalBudget > 0n ? c.originalBudget - c.remaining : 0n), 0n);
  const totalImpressions = campaigns.reduce((s, c) => s + c.totalImpressions, 0n);
  const totalUsers = campaigns.reduce((s, c) => s + c.uniqueUsers, 0);
  const activeCampaigns = campaigns.filter((c) => c.status === 1).length;

  // Effective CPM = totalSpent / (totalImpressions / 1000)
  const effectiveCpm = totalImpressions > 0n ? (totalSpent * 1000n) / totalImpressions : 0n;

  // Chart data: impressions per campaign
  const impressionBars = campaigns
    .filter((c) => c.totalImpressions > 0n)
    .slice(0, 12)
    .map((c) => ({
      label: `#${c.id}`,
      value: Number(c.totalImpressions),
      color: c.status === 1 ? "rgba(74,222,128,0.5)" : "rgba(255,255,255,0.25)",
    }));

  // Chart data: spend per campaign
  const spendBars = campaigns
    .filter((c) => c.originalBudget > 0n)
    .slice(0, 12)
    .map((c) => {
      const spent = c.originalBudget - c.remaining;
      return {
        label: `#${c.id}`,
        value: Number(spent) / 1e10,
        color: c.status === 1 ? "rgba(74,222,128,0.5)" : "rgba(255,255,255,0.25)",
      };
    });

  return (
    <div className="nano-fade" style={{ maxWidth: 800 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <Link to="/advertiser" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← My Campaigns</Link>
          <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginTop: 8 }}>Campaign Analytics</h1>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {campaigns.length > 0 && (
            <button onClick={() => {
              const rows = campaigns.map((c) => ({
                Campaign: c.id,
                Status: ["Pending","Active","Paused","Completed","Terminated","Expired"][c.status] ?? String(c.status),
                Impressions: c.totalImpressions.toString(),
                "Unique Users": c.uniqueUsers,
                Settlements: c.settlementCount,
                "Original Budget": c.originalBudget > 0n ? formatDOT(c.originalBudget) : "",
                Remaining: formatDOT(c.remaining),
                Spent: c.originalBudget > 0n ? formatDOT(c.originalBudget - c.remaining) : "",
                "User Payments": formatDOT(c.totalUserPaid),
                "Publisher Payments": formatDOT(c.totalPublisherPaid),
                "Bid CPM": formatDOT(c.bidCpmPlanck),
              }));
              downloadCSV("campaign-analytics.csv", toCSV(["Campaign","Status","Impressions","Unique Users","Settlements","Original Budget","Remaining","Spent","User Payments","Publisher Payments","Bid CPM"], rows));
            }} className="nano-btn" style={{ fontSize: 12 }}>Export CSV</button>
          )}
          <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
        </div>
      </div>

      {loading ? <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading analytics</div> : (
        <>
          {/* Aggregate stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 20 }}>
            <StatCard label="Total Spent" value={<DOTAmount planck={totalSpent} />} />
            <StatCard label="Total Impressions" value={totalImpressions.toLocaleString()} />
            <StatCard label="Effective CPM" value={effectiveCpm > 0n ? <DOTAmount planck={effectiveCpm} /> : "—"} />
            <StatCard label="Unique Users" value={String(totalUsers)} />
            <StatCard label="Active Campaigns" value={String(activeCampaigns)} color="var(--ok)" />
            <StatCard label="Total Campaigns" value={String(campaigns.length)} />
          </div>

          {/* Charts */}
          {impressionBars.length > 0 && (
            <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Impressions by Campaign</div>
              <MiniBarChart bars={impressionBars} height={140} formatValue={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v)} />
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 6 }}>Green = Active, Blue = Completed/Other</div>
            </div>
          )}

          {spendBars.length > 0 && (
            <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Spend by Campaign (DOT)</div>
              <MiniBarChart bars={spendBars} height={140} formatValue={(v) => v.toFixed(2)} />
            </div>
          )}

          {/* Per-campaign table */}
          {campaigns.length > 0 && (
            <div className="nano-card" style={{ padding: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Per-Campaign Breakdown</div>
              <div style={{ overflowX: "auto" }}>
                <table className="nano-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th>Impressions</th>
                      <th>Users</th>
                      <th>Spent</th>
                      <th>Eff. CPM</th>
                      <th>Budget Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => {
                      const spent = c.originalBudget > 0n ? c.originalBudget - c.remaining : 0n;
                      const cpm = c.totalImpressions > 0n ? (spent * 1000n) / c.totalImpressions : 0n;
                      const pct = c.originalBudget > 0n ? Number((c.originalBudget - c.remaining) * 100n / c.originalBudget) : 0;
                      return (
                        <tr key={c.id}>
                          <td><Link to={`/advertiser/campaign/${c.id}`} style={{ color: "var(--accent)", fontWeight: 600 }}>#{c.id}</Link></td>
                          <td><StatusBadge status={c.status} /></td>
                          <td>{c.totalImpressions.toLocaleString()}</td>
                          <td>{c.uniqueUsers}</td>
                          <td><DOTAmount planck={spent} /></td>
                          <td>{c.totalImpressions > 0n ? <DOTAmount planck={cpm} /> : "—"}</td>
                          <td>
                            {c.originalBudget > 0n ? (
                              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 80 }}>
                                <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-raised)", overflow: "hidden" }}>
                                  <div style={{ width: `${pct}%`, height: "100%", background: pct > 80 ? "var(--warn)" : "var(--ok)", borderRadius: 2 }} />
                                </div>
                                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{pct}%</span>
                              </div>
                            ) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {campaigns.length === 0 && (
            <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40 }}>
              No campaigns found. <Link to="/advertiser/create" style={{ color: "var(--accent)" }}>Create your first campaign.</Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="nano-card" style={{ padding: "10px 14px" }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ color: color ?? "var(--text-strong)", fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
