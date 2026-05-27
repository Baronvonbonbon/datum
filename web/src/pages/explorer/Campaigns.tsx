import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useSettings } from "../../context/SettingsContext";
import { getProvider } from "@shared/contracts";
import { CampaignStatus } from "@shared/types";
import { StatusBadge } from "../../components/StatusBadge";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { bytes32ToCid } from "@shared/ipfs";
import { ethers } from "ethers";
import { queryFilterAll } from "@shared/eventQuery";
import { humanizeError } from "@shared/errorCodes";
import { useToast } from "../../context/ToastContext";
import { PageExplainer } from "../../components/PageExplainer";
import { CampaignChip } from "../../components/CampaignChip";
import { BrandChip } from "../../components/BrandChip";
import { ContractsTouched } from "../../components/ContractsTouched";

interface CampaignRow {
  id: number;
  status: number;
  advertiser: string;
  publisher: string;
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: number;
  metadataHash: string;
}

const ZERO_ADDR = ethers.ZeroAddress;
const PAGE_SIZE = 20;

export function Campaigns() {
  const contracts = useContracts();
  const { settings } = useSettings();
  const { push } = useToast();
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCampaigns, setTotalCampaigns] = useState(0);
  const [page, setPage] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState<number | -1>(-1);
  const [filterType, setFilterType] = useState<"all" | "open" | "targeted">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const campaignsAddr = contracts.campaigns?.target as string | undefined;

  // Fetch the campaign count once per address change. Pagination must not
  // re-issue this call -- whatever read provider is active (pine or
  // centralized RPC) occasionally returns 0x for eth_call mid-navigation,
  // and rewinding totalCampaigns to 0 blanks the table and breaks the page
  // math. On empty response retry, then fall back to the centralized RPC
  // directly so a half-synced pine light client can't lock the page out.
  useEffect(() => {
    if (!campaignsAddr) return;
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const n = Number(await contracts.campaigns.nextCampaignId());
          if (!Number.isFinite(n) || n <= 0) throw new Error("empty response");
          if (!cancelled) setTotalCampaigns(n);
          return;
        } catch {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      // Final attempt: skip whatever provider is wired to the contract and
      // hit the centralized RPC directly. Works even when pine is mid-sync.
      try {
        const rpc = getProvider(settings.rpcUrl);
        const c = new ethers.Contract(
          campaignsAddr,
          ["function nextCampaignId() view returns (uint256)"],
          rpc,
        );
        const n = Number(await c.nextCampaignId());
        if (!Number.isFinite(n) || n <= 0) throw new Error("empty response");
        if (!cancelled) setTotalCampaigns(n);
      } catch (err) {
        if (!cancelled) push(humanizeError(err), "error");
      }
    })();
    return () => { cancelled = true; };
  }, [campaignsAddr, settings.rpcUrl]);

  const loadPage = useCallback(async () => {
    if (!campaignsAddr || totalCampaigns <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const start = Math.max(1, totalCampaigns - PAGE_SIZE * (page + 1));
      const end = totalCampaigns - PAGE_SIZE * page;
      if (end <= start) { setRows([]); return; }
      const ids = Array.from({ length: end - start }, (_, i) => end - 1 - i);

      const results = await Promise.all(ids.map(async (id) => {
        try {
          const [c, adv, viewBid] = await Promise.all([
            contracts.campaigns.getCampaignForSettlement(BigInt(id)),
            contracts.campaigns.getCampaignAdvertiser(BigInt(id)),
            contracts.campaigns.getCampaignViewBid(BigInt(id)).catch(() => 0n),
          ]);

          let metadataHash = "0x" + "0".repeat(64);
          if (contracts.campaignCreative) {
            try {
              metadataHash = await contracts.campaignCreative.campaignMetadata(BigInt(id));
            } catch { /* contract unavailable */ }
          }

          return {
            id,
            status: Number(c[0]),
            publisher: c[1] as string,
            bidCpmPlanck: BigInt(viewBid),
            snapshotTakeRateBps: Number(c[2]),
            advertiser: adv as string,
            metadataHash,
          } as CampaignRow;
        } catch {
          return null;
        }
      }));

      setRows(results.filter(Boolean) as CampaignRow[]);
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setLoading(false);
    }
  }, [campaignsAddr, page, totalCampaigns]);

  useEffect(() => { loadPage(); }, [loadPage]);

  const searchId = searchQuery.match(/^\d+$/) ? Number(searchQuery) : null;
  const searchAddr = searchQuery.length >= 6 ? searchQuery.toLowerCase() : "";

  const filtered = rows.filter((r) => {
    if (filterStatus !== -1 && r.status !== filterStatus) return false;
    if (filterType === "open" && r.publisher !== ZERO_ADDR) return false;
    if (filterType === "targeted" && r.publisher === ZERO_ADDR) return false;
    if (searchId !== null) return r.id === searchId;
    if (searchAddr) {
      return r.advertiser.toLowerCase().includes(searchAddr) ||
             r.publisher.toLowerCase().includes(searchAddr);
    }
    return true;
  });

  // Campaign IDs start at 1, so "live" count is totalCampaigns - 1.
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalCampaigns - 1) / PAGE_SIZE));

  return (
    <div className="nano-fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Campaigns</h1>
        <Link to="/advertiser/create" className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
          + Create Campaign
        </Link>
      </div>
      <PageExplainer slug="explorer-campaigns" title="What you're looking at">
        <p style={{ margin: 0 }}>
          Every campaign ever created on this network, paginated by ID. The
          status badge shows where it sits in the lifecycle: Pending
          (awaiting governance vote), Active (currently serving), Paused,
          Completed, Terminated, or Expired. Click any row for the full
          campaign detail including creative preview, vote tallies, and
          settlement history.
        </p>
      </PageExplainer>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search ID or address…"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
            className="nano-input"
            style={{ fontSize: 12, width: 200, paddingRight: searchQuery ? 24 : undefined }}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} style={{ position: "absolute", right: 6, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          )}
        </div>
        {searchId !== null && searchId >= 0 && searchId < totalCampaigns && (
          <Link to={`/campaigns/${searchId}`} className="nano-btn nano-btn-accent" style={{ padding: "5px 12px", fontSize: 12, textDecoration: "none" }}>
            Go to #{searchId} →
          </Link>
        )}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(Number(e.target.value))}
          className="nano-select"
          style={{ fontSize: 12 }}
        >
          <option value={-1}>All Statuses</option>
          <option value={0}>Pending</option>
          <option value={1}>Active</option>
          <option value={2}>Paused</option>
          <option value={3}>Completed</option>
          <option value={4}>Terminated</option>
          <option value={5}>Expired</option>
        </select>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as "all" | "open" | "targeted")}
          className="nano-select"
          style={{ fontSize: 12 }}
        >
          <option value="all">All Types</option>
          <option value="open">Open Campaigns</option>
          <option value="targeted">Targeted Campaigns</option>
        </select>
        <button onClick={() => loadPage()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
      </div>

      {!settings.contractAddresses.campaigns && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 12 }}>
          No contracts configured. Go to <Link to="/settings" style={{ color: "var(--accent)" }}>Settings</Link>.
        </div>
      )}

      {loading && <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 12 }}>Loading campaigns</div>}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)" }}>
          <table className="nano-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                {["Campaign", "Status", "Publisher", "Bid CPM", "Take Rate", ""].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <>
                  <tr
                    key={row.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <CampaignChip campaignId={row.id} size="sm" />
                    </td>
                    <td><StatusBadge status={row.status} /></td>
                    <td>
                      {row.publisher === ZERO_ADDR
                        ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Open</span>
                        : <BrandChip address={row.publisher} size="sm" role="publisher" />}
                    </td>
                    <td><DOTAmount planck={row.bidCpmPlanck} style={{ fontSize: 12 }} /></td>
                    <td><span style={{ fontSize: 12, color: "var(--text)" }}>{(row.snapshotTakeRateBps / 100).toFixed(0)}%</span></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <Link to={`/campaigns/${row.id}`} style={{ color: "var(--accent-dim)", fontSize: 12 }}>Detail</Link>
                      {row.status <= 1 && (
                        <Link to={`/governance/vote/${row.id}`} style={{ color: "var(--accent)", fontSize: 12, marginLeft: 8 }}>Vote</Link>
                      )}
                    </td>
                  </tr>
                  {expandedId === row.id && (
                    <tr key={`${row.id}-expanded`} style={{ background: "var(--bg-raised)" }}>
                      <td colSpan={6} style={{ padding: "12px 16px" }}>
                        <IPFSPreview metadataHash={row.metadataHash} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length === 0 && !error && (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>No campaigns found.</div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="nano-btn" style={{ fontSize: 12 }}>← Prev</button>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Page {page + 1} / {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="nano-btn" style={{ fontSize: 12 }}>Next →</button>
        </div>
      )}
      <ContractsTouched contracts={["campaigns", "campaignCreative", "tagSystem"]} />
    </div>
  );
}
