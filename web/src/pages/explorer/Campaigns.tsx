import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useSettings } from "../../context/SettingsContext";
import { CampaignStatus, CATEGORY_NAMES } from "@shared/types";
import { StatusBadge } from "../../components/StatusBadge";
import { AddressDisplay } from "../../components/AddressDisplay";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { bytes32ToCid } from "@shared/ipfs";
import { ethers } from "ethers";

interface CampaignRow {
  id: number;
  status: number;
  advertiser: string;
  publisher: string;
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: number;
  categoryId: number;
  metadataHash: string;
}

const ZERO_ADDR = ethers.ZeroAddress;
const PAGE_SIZE = 20;

export function Campaigns() {
  const contracts = useContracts();
  const { settings } = useSettings();
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCampaigns, setTotalCampaigns] = useState(0);
  const [page, setPage] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState<number | -1>(-1);
  const [filterCategory, setFilterCategory] = useState<number | 0>(0);
  const [filterType, setFilterType] = useState<"all" | "open" | "targeted">("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!settings.contractAddresses.campaigns) return;
    setLoading(true);
    setError(null);
    try {
      const nextId = Number(await contracts.campaigns.nextCampaignId());
      setTotalCampaigns(nextId);

      const start = Math.max(0, nextId - PAGE_SIZE * (page + 1));
      const end = nextId - PAGE_SIZE * page;
      const ids = Array.from({ length: end - start }, (_, i) => end - 1 - i);

      const results = await Promise.all(ids.map(async (id) => {
        try {
          const [c, adv] = await Promise.all([
            contracts.campaigns.getCampaignForSettlement(BigInt(id)),
            contracts.campaigns.getCampaignAdvertiser(BigInt(id)),
          ]);

          // Try to get metadata hash from events (scan recent logs)
          let metadataHash = "0x" + "0".repeat(64);
          try {
            const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(id));
            const logs = await contracts.campaigns.queryFilter(filter);
            if (logs.length > 0) {
              const last = logs[logs.length - 1] as any;
              metadataHash = last.args?.metadataHash ?? metadataHash;
            }
          } catch { /* events unavailable */ }

          return {
            id,
            status: Number(c[0]),
            publisher: c[1] as string,
            bidCpmPlanck: BigInt(c[2]),
            snapshotTakeRateBps: Number(c[3]),
            advertiser: adv as string,
            categoryId: 0,
            metadataHash,
          } as CampaignRow;
        } catch {
          return null;
        }
      }));

      setRows(results.filter(Boolean) as CampaignRow[]);
    } catch (err) {
      setError(String(err).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }, [settings.contractAddresses.campaigns, page]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter((r) => {
    if (filterStatus !== -1 && r.status !== filterStatus) return false;
    if (filterCategory !== 0 && r.categoryId !== filterCategory) return false;
    if (filterType === "open" && r.publisher !== ZERO_ADDR) return false;
    if (filterType === "targeted" && r.publisher === ZERO_ADDR) return false;
    return true;
  });

  const totalPages = Math.ceil(totalCampaigns / PAGE_SIZE);

  return (
    <div className="nano-fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Campaigns</h1>
        <Link to="/advertiser/create" className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
          + Create Campaign
        </Link>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
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
        <button onClick={() => load()} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
      </div>

      {!settings.contractAddresses.campaigns && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 12 }}>
          No contracts configured. Go to <Link to="/settings" style={{ color: "var(--accent)" }}>Settings</Link>.
        </div>
      )}

      {error && <div className="nano-info nano-info--error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && <div style={{ color: "var(--text-muted)", padding: 12 }}>Loading campaigns...</div>}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)" }}>
          <table className="nano-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                {["ID", "Status", "Advertiser", "Publisher", "Bid CPM", "Take Rate", ""].map((h) => (
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
                    <td>
                      <Link to={`/campaigns/${row.id}`} onClick={(e) => e.stopPropagation()} style={{ color: "var(--accent)" }}>
                        #{row.id}
                      </Link>
                    </td>
                    <td><StatusBadge status={row.status} /></td>
                    <td><AddressDisplay address={row.advertiser} chars={4} style={{ fontSize: 12 }} /></td>
                    <td>
                      {row.publisher === ZERO_ADDR
                        ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Open</span>
                        : <AddressDisplay address={row.publisher} chars={4} style={{ fontSize: 12 }} />}
                    </td>
                    <td><DOTAmount planck={row.bidCpmPlanck} style={{ fontSize: 12 }} /></td>
                    <td><span style={{ fontSize: 12, color: "var(--text)" }}>{(row.snapshotTakeRateBps / 100).toFixed(0)}%</span></td>
                    <td>
                      <Link to={`/campaigns/${row.id}`} style={{ color: "var(--accent-dim)", fontSize: 12 }}>Detail →</Link>
                    </td>
                  </tr>
                  {expandedId === row.id && (
                    <tr key={`${row.id}-expanded`} style={{ background: "var(--bg-raised)" }}>
                      <td colSpan={7} style={{ padding: "12px 16px" }}>
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
    </div>
  );
}
