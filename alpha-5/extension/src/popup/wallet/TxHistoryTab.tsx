// Wallet TX history tab — last 50 broadcast TXs for the active
// account. Live-updates via chrome.storage.onChanged.
//
// Each row shows the kind ("send" vs "dapp"), the recipient
// blockie, a truncated address, optional label, value (when
// non-zero), and a relative timestamp. Hash is rendered as a
// small mono chip that links out to the testnet explorer for
// the live network.

import { useEffect, useState } from "react";
import type { WalletStatus } from "./walletClient";
import { getWalletTxHistory, type WalletTxEntry } from "@shared/walletTxHistory";
import { Blockie } from "./Blockie";
import { card, heading, subText, mono } from "./styles";
import { formatDOT, weiToPlanck } from "@shared/dot";

const EXPLORER_BASE = "https://blockscout-testnet.polkadot.io/tx/";

export function TxHistoryTab({ status }: { status: WalletStatus }) {
  const [entries, setEntries] = useState<WalletTxEntry[]>([]);

  useEffect(() => {
    if (!status.activeAddress) return;
    let cancelled = false;
    const refresh = async () => {
      const list = await getWalletTxHistory(status.activeAddress);
      if (!cancelled) setEntries(list);
    };
    refresh();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      const myKey = `wallet:tx-history:${status.activeAddress.toLowerCase()}`;
      if (changes[myKey]) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [status.activeAddress]);

  if (!status.activeAddress) {
    return <div style={subText}>No active account.</div>;
  }

  if (entries.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ ...heading, fontSize: 13 }}>Transactions</div>
        <div style={subText}>
          No transactions yet. Sends and dApp signatures will appear here once
          you broadcast.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ ...heading, fontSize: 13 }}>Transactions</div>
      {entries.map((e) => (
        <TxRow key={e.hash} entry={e} />
      ))}
    </div>
  );
}

function TxRow({ entry }: { entry: WalletTxEntry }) {
  const truncated = `${entry.to.slice(0, 6)}…${entry.to.slice(-4)}`;
  const value =
    entry.valueWei && entry.valueWei !== "0"
      ? `${formatDOT(weiToPlanck(BigInt(entry.valueWei)))} PAS`
      : null;
  const hashShort = `${entry.hash.slice(0, 10)}…${entry.hash.slice(-6)}`;
  return (
    <div style={{ ...card, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Blockie address={entry.to} size={20} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
            <span style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 500 }}>
              {entry.label ?? (entry.kind === "send" ? "Send" : "dApp signature")}
            </span>
            <span style={{ ...mono, color: "var(--text-muted)", fontSize: 10 }}>
              {relativeTime(entry.ts)}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
            <span style={{ ...mono, color: "var(--text-muted)", fontSize: 10 }}>{truncated}</span>
            {value && (
              <span style={{ ...mono, color: "var(--text-strong)", fontSize: 10 }}>
                {value}
              </span>
            )}
          </div>
        </div>
      </div>
      <a
        href={`${EXPLORER_BASE}${entry.hash}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...mono, color: "var(--text-muted)", fontSize: 10, textDecoration: "none" }}
      >
        {hashShort} ↗
      </a>
      {entry.origin && (
        <div style={{ ...subText, fontSize: 10 }}>via {entry.origin}</div>
      )}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
