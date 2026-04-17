import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { StatusBadge } from "../../components/StatusBadge";
import { getExplorerUrl } from "@shared/networks";
import { queryFilterAll } from "@shared/eventQuery";
import { CampaignStatus } from "@shared/types";

interface CampaignSummary {
  id: number;
  status: number;
  budgetPlanck: bigint;
  publisher: string;
}

interface AdvertiserStats {
  total: number;
  active: number;
  pending: number;
  completed: number;
  totalBudget: bigint;
  totalSpent: bigint;
  campaigns: CampaignSummary[];
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function AdvertiserProfile() {
  const { address: paramAddress } = useParams<{ address: string }>();
  const { address: walletAddress } = useWallet();
  const { settings } = useSettings();
  const contracts = useContracts();
  const EXPLORER = getExplorerUrl(settings.network);

  const [stats, setStats] = useState<AdvertiserStats | null>(null);
  const [loading, setLoading] = useState(true);

  const isOwn = walletAddress && paramAddress &&
    walletAddress.toLowerCase() === paramAddress.toLowerCase();

  useEffect(() => {
    if (!paramAddress) return;
    load(paramAddress);
  }, [paramAddress, contracts]);

  async function load(addr: string) {
    setLoading(true);
    try {
      // Find all campaigns by this advertiser via events
      const filter = contracts.campaigns.filters.CampaignCreated();
      const logs = await queryFilterAll(contracts.campaigns, filter);
      const ids = logs
        .filter((l: any) => {
          const adv = l.args?.advertiser as string;
          return adv && adv.toLowerCase() === addr.toLowerCase();
        })
        .map((l: any) => Number(l.args?.campaignId ?? l.args?.id ?? 0));

      // Fetch details for each campaign
      const campaigns: CampaignSummary[] = [];
      await Promise.all(ids.map(async (id) => {
        try {
          const c = await contracts.campaigns.getCampaign(BigInt(id));
          campaigns.push({
            id,
            status: Number(c.status ?? c[4] ?? 0),
            budgetPlanck: BigInt(c.budget ?? c[2] ?? 0),
            publisher: (c.publisher ?? c[1] ?? ZERO) as string,
          });
        } catch { /* skip */ }
      }));

      campaigns.sort((a, b) => b.id - a.id);

      // Settlement totals for this advertiser
      let totalSpent = 0n;
      try {
        const settleFilter = contracts.settlement.filters.Settled();
        const settleLogs = await queryFilterAll(contracts.settlement, settleFilter);
        totalSpent = settleLogs
          .filter((l: any) => {
            const campaignId = Number(l.args?.campaignId ?? 0);
            return ids.includes(campaignId);
          })
          .reduce((sum: bigint, l: any) => {
            const user = BigInt(l.args?.userPayment ?? 0);
            const pub = BigInt(l.args?.publisherPayment ?? 0);
            return sum + user + pub;
          }, 0n);
      } catch { /* ignore */ }

      const totalBudget = campaigns.reduce((s, c) => s + c.budgetPlanck, 0n);

      setStats({
        total: campaigns.length,
        active: campaigns.filter((c) => c.status === CampaignStatus.Active).length,
        pending: campaigns.filter((c) => c.status === CampaignStatus.Pending).length,
        completed: campaigns.filter((c) => c.status === CampaignStatus.Completed).length,
        totalBudget,
        totalSpent,
        campaigns,
      });
    } finally {
      setLoading(false);
    }
  }

  if (!paramAddress) return null;

  const explorerUrl = EXPLORER ? `${EXPLORER}/address/${paramAddress}` : null;

  return (
    <div className="nano-fade" style={{ maxWidth: 700 }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/campaigns" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Campaigns</Link>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Advertiser Profile</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <AddressDisplay address={paramAddress} chars={10} style={{ fontSize: 14, color: "var(--text)" }} />
            {explorerUrl && (
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "2px 8px" }}>
                Block Explorer ↗
              </a>
            )}
          </div>
        </div>
        {isOwn && (
          <Link to="/advertiser" className="nano-btn nano-btn-accent" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>
            My Dashboard
          </Link>
        )}
      </div>

      {loading && <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading</div>}

      {!loading && stats && (
        <>
          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
            <div className="nano-card" style={{ padding: 14 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Total Campaigns</div>
              <div style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>{stats.total}</div>
            </div>
            {stats.active > 0 && (
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Active</div>
                <div style={{ color: "var(--ok)", fontSize: 20, fontWeight: 700 }}>{stats.active}</div>
              </div>
            )}
            {stats.pending > 0 && (
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Pending</div>
                <div style={{ color: "var(--warn)", fontSize: 20, fontWeight: 700 }}>{stats.pending}</div>
              </div>
            )}
            {stats.completed > 0 && (
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Completed</div>
                <div style={{ color: "var(--text-muted)", fontSize: 20, fontWeight: 700 }}>{stats.completed}</div>
              </div>
            )}
            <div className="nano-card" style={{ padding: 14 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Total Budget</div>
              <div style={{ color: "var(--text-strong)", fontSize: 14, fontWeight: 600 }}>
                <DOTAmount planck={stats.totalBudget} />
              </div>
            </div>
            {stats.totalSpent > 0n && (
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Total Spent</div>
                <div style={{ color: "var(--ok)", fontSize: 14, fontWeight: 600 }}>
                  <DOTAmount planck={stats.totalSpent} />
                </div>
              </div>
            )}
          </div>

          {/* Campaign list */}
          {stats.campaigns.length > 0 && (
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>
                Campaigns
              </div>
              {stats.campaigns.map((c) => (
                <Link
                  key={c.id}
                  to={`/campaigns/${c.id}`}
                  style={{ textDecoration: "none", display: "block", marginBottom: 8 }}
                >
                  <div className="nano-card" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ color: "var(--text-strong)", fontWeight: 600 }}>#{c.id}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
                      {c.publisher !== ZERO && (
                        <span>
                          Publisher:{" "}
                          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                            {c.publisher.slice(0, 8)}…
                          </span>
                        </span>
                      )}
                      {c.publisher === ZERO && <span style={{ color: "var(--text-muted)" }}>Open</span>}
                      <span style={{ color: "var(--accent)", fontSize: 11 }}>View →</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {stats.campaigns.length === 0 && (
            <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40 }}>No campaigns found.</div>
          )}
        </>
      )}
    </div>
  );
}
