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
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700 }}>Campaigns</h1>
        <Link to="/advertiser/create" style={{
          padding: "6px 14px", background: "#1a1a3a", color: "#a0a0ff",
          border: "1px solid #4a4a8a", borderRadius: 4, fontSize: 13,
          textDecoration: "none",
        }}>
          + Create Campaign
        </Link>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(Number(e.target.value))}
          style={selectStyle}
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
          style={selectStyle}
        >
          <option value="all">All Types</option>
          <option value="open">Open Campaigns</option>
          <option value="targeted">Targeted Campaigns</option>
        </select>
        <button onClick={() => load()} style={btnStyle}>Refresh</button>
      </div>

      {!settings.contractAddresses.campaigns && (
        <div style={warningBox}>No contracts configured. Go to <Link to="/settings" style={{ color: "#a0a0ff" }}>Settings</Link>.</div>
      )}

      {error && <div style={errorBox}>{error}</div>}
      {loading && <div style={{ color: "#555", padding: 12 }}>Loading campaigns...</div>}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div style={{ border: "1px solid #1a1a2e", borderRadius: 6, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#0f0f1a", borderBottom: "1px solid #1a1a2e" }}>
                {["ID", "Status", "Advertiser", "Publisher", "Bid CPM", "Take Rate", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 12px", color: "#555", fontSize: 11, fontWeight: 600, textAlign: "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <>
                  <tr
                    key={row.id}
                    style={{
                      borderBottom: "1px solid #0f0f1a",
                      background: i % 2 === 0 ? "#0a0a12" : "#0c0c16",
                      cursor: "pointer",
                    }}
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <td style={tdStyle}>
                      <Link to={`/campaigns/${row.id}`} onClick={(e) => e.stopPropagation()} style={{ color: "#a0a0ff" }}>
                        #{row.id}
                      </Link>
                    </td>
                    <td style={tdStyle}><StatusBadge status={row.status} /></td>
                    <td style={tdStyle}><AddressDisplay address={row.advertiser} chars={4} style={{ fontSize: 12 }} /></td>
                    <td style={tdStyle}>
                      {row.publisher === ZERO_ADDR
                        ? <span style={{ color: "#555", fontSize: 12 }}>Open</span>
                        : <AddressDisplay address={row.publisher} chars={4} style={{ fontSize: 12 }} />}
                    </td>
                    <td style={tdStyle}><DOTAmount planck={row.bidCpmPlanck} style={{ fontSize: 12 }} /></td>
                    <td style={tdStyle}><span style={{ fontSize: 12, color: "#888" }}>{(row.snapshotTakeRateBps / 100).toFixed(0)}%</span></td>
                    <td style={tdStyle}>
                      <Link to={`/campaigns/${row.id}`} style={{ color: "#4a4a8a", fontSize: 12 }}>Detail →</Link>
                    </td>
                  </tr>
                  {expandedId === row.id && (
                    <tr key={`${row.id}-expanded`} style={{ background: "#0d0d18" }}>
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
        <div style={{ color: "#555", padding: 20, textAlign: "center" }}>No campaigns found.</div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={btnStyle}>← Prev</button>
          <span style={{ color: "#666", fontSize: 12 }}>Page {page + 1} / {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} style={btnStyle}>Next →</button>
        </div>
      )}
    </div>
  );
}

const tdStyle: React.CSSProperties = { padding: "8px 12px", verticalAlign: "middle" };
const selectStyle: React.CSSProperties = { padding: "5px 8px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, cursor: "pointer" };
const btnStyle: React.CSSProperties = { padding: "5px 12px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, cursor: "pointer" };
const warningBox: React.CSSProperties = { padding: "10px 14px", background: "#1a1a0a", border: "1px solid #3a3a0a", borderRadius: 6, color: "#c0c060", fontSize: 13, marginBottom: 12 };
const errorBox: React.CSSProperties = { padding: "10px 14px", background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 6, color: "#ff8080", fontSize: 13, marginBottom: 12 };
