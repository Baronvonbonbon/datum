import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { getExplorerUrl } from "@shared/networks";
import { tagLabel } from "@shared/tagDictionary";
import { queryFilterAll } from "@shared/eventQuery";

interface ProfileData {
  registered: boolean;
  takeRateBps: number;
  allowlistEnabled: boolean;
  blocked: boolean;
  relaySigner: string | null;
  profileHash: string | null;
  tags: string[];
  repScore: number | null;
  repSettled: number;
  repRejected: number;
  reportCount: number;
  campaignCount: number;
  earnings: bigint | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);

export function PublisherProfile() {
  const { address: paramAddress } = useParams<{ address: string }>();
  const { address: walletAddress } = useWallet();
  const { settings } = useSettings();
  const contracts = useContracts();
  const navigate = useNavigate();
  const EXPLORER = getExplorerUrl(settings.network);

  const [data, setData] = useState<ProfileData | null>(null);
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
      const pub = await contracts.publishers.getPublisher(addr).catch(() => null);
      const registered = pub?.registered === true || pub?.[0] === true;

      const takeRateBps = registered ? Number(pub?.takeRateBps ?? pub?.[1] ?? 0) : 0;
      const allowlistEnabled = await contracts.publishers.allowlistEnabled(addr).catch(() => false);
      const blocked = await contracts.publishers.isBlocked(addr).catch(() => false);
      const relayRaw = await contracts.publishers.relaySigner(addr).catch(() => ZERO);
      const relaySigner = relayRaw && relayRaw !== ZERO ? relayRaw as string : null;
      const hashRaw = await contracts.publishers.profileHash(addr).catch(() => ZERO_HASH);
      const profileHash = hashRaw && hashRaw !== ZERO_HASH ? hashRaw as string : null;

      let tags: string[] = [];
      try {
        if (contracts.targetingRegistry) {
          const hashes: string[] = await contracts.targetingRegistry.getTags(addr);
          tags = hashes.map((h) => tagLabel(h) ?? h.slice(0, 10) + "...").filter(Boolean);
        }
      } catch { /* no targeting registry */ }

      let repScore: number | null = null;
      let repSettled = 0;
      let repRejected = 0;
      try {
        if (contracts.reputation) {
          const stats = await contracts.reputation.getPublisherStats(addr);
          repSettled = Number(stats[0]);
          repRejected = Number(stats[1]);
          const total = repSettled + repRejected;
          if (total > 0) repScore = Number(stats[2]);
        }
      } catch { /* no reputation contract */ }

      let reportCount = 0;
      try {
        if (contracts.reports) {
          reportCount = Number(await contracts.reports.publisherReports(addr));
        }
      } catch { /* no reports contract */ }

      // Count campaigns where this address is publisher
      let campaignCount = 0;
      try {
        const filter = contracts.campaigns.filters.CampaignCreated();
        const logs = await queryFilterAll(contracts.campaigns, filter);
        campaignCount = logs.filter((l: any) => {
          const pub = l.args?.publisher as string;
          return pub && pub.toLowerCase() === addr.toLowerCase();
        }).length;
      } catch { /* ignore */ }

      // Earnings balance from settlement events
      let earnings: bigint | null = null;
      try {
        const filter = contracts.settlement.filters.Settled();
        const logs = await queryFilterAll(contracts.settlement, filter);
        earnings = logs
          .filter((l: any) => {
            const p = l.args?.publisher as string;
            return p && p.toLowerCase() === addr.toLowerCase();
          })
          .reduce((sum: bigint, l: any) => sum + BigInt(l.args?.publisherPayment ?? 0), 0n);
      } catch { /* ignore */ }

      setData({
        registered,
        takeRateBps,
        allowlistEnabled: Boolean(allowlistEnabled),
        blocked: Boolean(blocked),
        relaySigner,
        profileHash,
        tags,
        repScore,
        repSettled,
        repRejected,
        reportCount,
        campaignCount,
        earnings,
      });
    } finally {
      setLoading(false);
    }
  }

  if (!paramAddress) return null;

  const explorerUrl = EXPLORER ? `${EXPLORER}/address/${paramAddress}` : null;

  return (
    <div className="nano-fade" style={{ maxWidth: 640 }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/publishers" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Publishers</Link>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Publisher Profile</h1>
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link to="/publisher" className="nano-btn" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>My Dashboard</Link>
            <Link to="/publisher/profile" className="nano-btn nano-btn-accent" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>Edit Profile</Link>
          </div>
        )}
      </div>

      {loading && <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading</div>}

      {!loading && data && (
        <>
          {/* Status badges */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
            {data.registered
              ? <span className="nano-badge nano-badge--ok">Registered</span>
              : <span className="nano-badge nano-badge--error">Not Registered</span>}
            {data.blocked && <span className="nano-badge nano-badge--error">Blocked</span>}
            {data.allowlistEnabled && <span className="nano-badge nano-badge--warn">Allowlist On</span>}
            {data.reportCount > 0 && (
              <span className="nano-badge nano-badge--warn">⚑ {data.reportCount} report{data.reportCount !== 1 ? "s" : ""}</span>
            )}
          </div>

          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
            <div className="nano-card" style={{ padding: 14 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Take Rate</div>
              <div style={{ color: "var(--text-strong)", fontSize: 18, fontWeight: 700 }}>{(data.takeRateBps / 100).toFixed(0)}%</div>
            </div>
            <div className="nano-card" style={{ padding: 14 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Campaigns Served</div>
              <div style={{ color: "var(--text-strong)", fontSize: 18, fontWeight: 700 }}>{data.campaignCount}</div>
            </div>
            {data.repScore !== null && (
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Reputation</div>
                <div style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: data.repScore >= 9000 ? "var(--ok)" : data.repScore >= 7000 ? "var(--warn)" : "var(--error)"
                }}>
                  {(data.repScore / 100).toFixed(1)}%
                </div>
              </div>
            )}
            {data.earnings !== null && (
              <div className="nano-card" style={{ padding: 14 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Total Earned</div>
                <div style={{ color: "var(--ok)", fontSize: 16, fontWeight: 600 }}>
                  <DOTAmount planck={data.earnings} />
                </div>
              </div>
            )}
          </div>

          {/* Reputation detail */}
          {(data.repSettled > 0 || data.repRejected > 0) && (
            <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Settlement Reputation</div>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Settled</div>
                  <div style={{ color: "var(--ok)", fontWeight: 700 }}>{data.repSettled}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Rejected</div>
                  <div style={{ color: "var(--error)", fontWeight: 700 }}>{data.repRejected}</div>
                </div>
              </div>
            </div>
          )}

          {/* Tags */}
          {data.tags.length > 0 && (
            <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Content Tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {data.tags.map((tag, i) => (
                  <span key={i} className="nano-badge">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Relay signer */}
          {data.relaySigner && (
            <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Relay Signer</div>
              <AddressDisplay address={data.relaySigner} explorerBase={EXPLORER} />
            </div>
          )}

          {/* Profile hash */}
          {data.profileHash && (
            <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Profile Hash (IPFS)</div>
              <code style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all" }}>{data.profileHash}</code>
            </div>
          )}

          {/* Own address management shortcuts */}
          {isOwn && (
            <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Manage</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link to="/publisher/rate" className="nano-btn" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>Take Rate</Link>
                <Link to="/publisher/categories" className="nano-btn" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>Tags</Link>
                <Link to="/publisher/allowlist" className="nano-btn" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>Allowlist</Link>
                <Link to="/publisher/earnings" className="nano-btn" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>Earnings</Link>
                <Link to="/publisher/profile" className="nano-btn" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none" }}>Profile Settings</Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
