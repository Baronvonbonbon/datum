// Webapp /me/history — deeper earnings history view.
// Reuses the pure earningsIndex module from the extension via the @ext alias.
// Defaults to a Pine-friendly 50k-block scan; users can extend via a "scan
// last N days" input with a warning that wide scans take longer.

import { useEffect, useMemo, useState } from "react";
import { JsonRpcProvider } from "ethers";
import { useSettings } from "../../context/SettingsContext";
import { useWallet } from "../../context/WalletContext";
import { formatDOT } from "@shared/dot";
// @ts-ignore — @ext resolves to alpha-4/extension/src
import {
  emptyIndex,
  scanRange,
  topCampaigns,
  TopSortKey,
  EarningsIndex,
  DEFAULT_BACKFILL_BLOCKS,
} from "@ext/shared/earningsIndex";

const SORT_LABELS: Record<TopSortKey, string> = {
  totalUserPlanck: "Total earned",
  claimCount: "Claims",
  totalEvents: "Events",
  lastBlock: "Recently active",
};

// Polkadot Hub block time: 6 seconds → 14,400 blocks/day
const BLOCKS_PER_DAY = 14_400;

export function History() {
  const { settings } = useSettings();
  const { address } = useWallet();

  const [index, setIndex] = useState<EarningsIndex>(emptyIndex());
  const [sortBy, setSortBy] = useState<TopSortKey>("totalUserPlanck");

  // Scan controls
  const [days, setDays] = useState<number>(Math.round(DEFAULT_BACKFILL_BLOCKS / BLOCKS_PER_DAY));
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null);
  const [scanRangeInfo, setScanRangeInfo] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function runScan() {
    if (!address) return;
    if (!settings.contractAddresses.settlement) {
      setError("Settlement contract address not configured.");
      return;
    }
    setScanning(true);
    setError(null);
    setProgress({ scanned: 0, total: 0 });
    try {
      const provider = new JsonRpcProvider(settings.rpcUrl);
      const head = await provider.getBlockNumber();
      const window = days * BLOCKS_PER_DAY;
      const fromBlock = Math.max(0, head - window);
      const toBlock = head;
      setScanRangeInfo(`Scanning blocks ${fromBlock.toLocaleString()} → ${toBlock.toLocaleString()} (${days} day${days === 1 ? "" : "s"})`);

      const fresh = emptyIndex();
      await scanRange({
        provider,
        settlementAddress: settings.contractAddresses.settlement,
        user: address,
        fromBlock,
        toBlock,
        index: fresh,
        enrichTimestamp: true,
        onProgress: (scanned, total) => setProgress({ scanned, total }),
      });
      setIndex(fresh);
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  // Auto-scan default window once we have a wallet + addresses
  useEffect(() => {
    if (address && settings.contractAddresses.settlement && index.recent.length === 0 && !scanning) {
      runScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, settings.contractAddresses.settlement]);

  const top = useMemo(() => topCampaigns(index, sortBy, 20), [index, sortBy]);
  const recent = useMemo(() => index.recent, [index]);

  if (!address) {
    return (
      <div className="nano-fade" style={{ maxWidth: 720 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
          Earnings history
        </h1>
        <div className="nano-card" style={{ padding: 14, color: "var(--text-dim)" }}>
          Connect a wallet to view your settled-claims history.
        </div>
      </div>
    );
  }

  return (
    <div className="nano-fade" style={{ maxWidth: 920 }}>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
        Earnings history
      </h1>
      <div style={{ color: "var(--text-dim)", fontSize: 12, marginBottom: 16 }}>
        Wallet: <code style={{ fontSize: 11 }}>{address}</code>
      </div>

      {/* Scan controls */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          Scan window
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ color: "var(--text)", fontSize: 12 }}>Last</label>
          <input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
            disabled={scanning}
            className="nano-input"
            style={{ width: 80 }}
          />
          <label style={{ color: "var(--text)", fontSize: 12 }}>days</label>
          <button
            onClick={runScan}
            disabled={scanning}
            className="nano-btn nano-btn-accent"
            style={{ fontSize: 12, padding: "6px 14px" }}
          >
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
        {days > 14 && (
          <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 8 }}>
            Wide scans take longer and may hit RPC rate limits.{" "}
            {days > 60 && "60+ days can take several minutes on a centralized RPC."}
          </div>
        )}
        {scanRangeInfo && (
          <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 8, fontFamily: "monospace" }}>
            {scanRangeInfo}
          </div>
        )}
        {progress && progress.total > 0 && (
          <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 4 }}>
            {progress.scanned.toLocaleString()} / {progress.total.toLocaleString()} blocks
            {" — "}
            {Math.round((progress.scanned / progress.total) * 100)}%
          </div>
        )}
        {error && (
          <div style={{ color: "var(--error)", fontSize: 11, marginTop: 8, wordBreak: "break-all" }}>
            {error}
          </div>
        )}
      </div>

      {/* Recent */}
      <div className="nano-card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          Recent settles ({recent.length})
        </div>
        {recent.length === 0 && !scanning && (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
            No settled claims found in the scanned window.
          </div>
        )}
        {recent.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "120px 1fr 100px 60px 80px",
              gap: 8, fontSize: 10, color: "var(--text-muted)",
              padding: "4px 0", borderBottom: "1px solid var(--border)"
            }}>
              <span>Date</span>
              <span>Campaign</span>
              <span style={{ textAlign: "right" }}>Earned</span>
              <span>Type</span>
              <span>Tx</span>
            </div>
            {recent.map((r) => (
              <div
                key={`${r.txHash}:${r.logIndex}`}
                style={{
                  display: "grid", gridTemplateColumns: "120px 1fr 100px 60px 80px",
                  gap: 8, fontSize: 12, padding: "6px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ color: "var(--text-dim)", fontFamily: "monospace" }}>
                  {r.blockTimestamp ? new Date(r.blockTimestamp * 1000).toLocaleString() : `#${r.blockNumber}`}
                </span>
                <span style={{ color: "var(--text)" }}>Campaign #{r.campaignId}</span>
                <span style={{ color: "var(--ok)", fontFamily: "monospace", textAlign: "right" }}>
                  +{formatDOT(BigInt(r.userPaymentPlanck))}
                </span>
                <span style={{ color: "var(--text-muted)" }}>
                  {r.actionType === 0 ? "view" : r.actionType === 1 ? "click" : "action"}
                </span>
                <span style={{ fontFamily: "monospace", fontSize: 10 }}>
                  <code style={{ color: "var(--text-dim)" }}>{r.txHash.slice(0, 8)}…</code>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top campaigns */}
      <div className="nano-card" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13 }}>
            Top campaigns
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as TopSortKey)}
            className="nano-select"
            style={{ fontSize: 12, padding: "4px 8px" }}
          >
            {Object.entries(SORT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>Sort by {label.toLowerCase()}</option>
            ))}
          </select>
        </div>
        {top.length === 0 && !scanning && (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
            No earnings in the scanned window.
          </div>
        )}
        {top.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {top.map((row, i) => (
              <div
                key={row.campaignId}
                style={{
                  display: "grid", gridTemplateColumns: "30px 1fr 100px 100px 100px",
                  gap: 8, fontSize: 12, padding: "6px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>
                  {i + 1}.
                </span>
                <span style={{ color: "var(--text)" }}>Campaign #{row.campaignId}</span>
                <span style={{ color: "var(--ok)", fontFamily: "monospace", textAlign: "right" }}>
                  {formatDOT(BigInt(row.totals.totalUserPlanck))}
                </span>
                <span style={{ color: "var(--text-dim)", fontFamily: "monospace", textAlign: "right" }}>
                  {row.totals.claimCount} claims
                </span>
                <span style={{ color: "var(--text-dim)", fontFamily: "monospace", textAlign: "right" }}>
                  {row.totals.totalEvents} evts
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 12, padding: "0 4px" }}>
        Indexed up to block {index.lastScannedBlock.toLocaleString()}.{" "}
        Tracking {Object.keys(index.byCampaign).length} campaigns.
      </div>
    </div>
  );
}
