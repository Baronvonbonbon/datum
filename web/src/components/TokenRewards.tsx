/**
 * TokenRewards — auto-discovers ERC-20 token balances a user has earned
 * from the DatumTokenRewardVault by scanning TokenRewardCredited events,
 * then lets them withdraw or dismiss individual tokens.
 *
 * Dismissed tokens are persisted in localStorage keyed by wallet address.
 */

import { useState, useEffect, useCallback } from "react";
import { Contract, ethers } from "ethers";
import { queryFilterAll } from "@shared/eventQuery";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../hooks/useTx";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

function dismissedKey(address: string) {
  return `datum_dismissed_tokens_${address.toLowerCase()}`;
}
function loadDismissed(address: string): string[] {
  try { return JSON.parse(localStorage.getItem(dismissedKey(address)) ?? "[]"); } catch { return []; }
}
function saveDismissed(address: string, list: string[]) {
  localStorage.setItem(dismissedKey(address), JSON.stringify(list));
}

interface TokenMeta { symbol: string; decimals: number; name: string }
interface TokenEntry {
  address: string;
  balance: bigint;
  meta: TokenMeta | null;
}

interface Props {
  userAddress: string;
  vault: Contract;
  readProvider: ethers.Provider;
  signer: ethers.Signer | null;
}

export function TokenRewards({ userAddress, vault, readProvider, signer }: Props) {
  const { confirmTx } = useTx();

  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [manualInput, setManualInput] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const discover = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Find all token addresses credited to this user
      const filter = vault.filters.TokenRewardCredited(null, null, userAddress, null);
      const logs = await queryFilterAll(vault, filter);
      const seen = new Set<string>();
      for (const log of logs) {
        const tok = log.args?.token ?? log.args?.[1];
        if (tok && ethers.isAddress(tok)) seen.add(tok.toLowerCase());
      }

      // 2. Also include any manually-tracked tokens stored in localStorage
      const manualKey = `datum_tracked_tokens_${userAddress.toLowerCase()}`;
      try {
        const manual: string[] = JSON.parse(localStorage.getItem(manualKey) ?? "[]");
        for (const a of manual) if (ethers.isAddress(a)) seen.add(a.toLowerCase());
      } catch { /* ignore */ }

      // 3. Load balance + metadata for each
      const entries = await Promise.all(
        Array.from(seen).map(async (addr): Promise<TokenEntry> => {
          const checksummed = ethers.getAddress(addr);
          let balance = 0n;
          let meta: TokenMeta | null = null;
          try {
            balance = BigInt(await vault.userTokenBalance(checksummed, userAddress));
          } catch { /* rpc error */ }
          try {
            const erc20 = new Contract(checksummed, ERC20_ABI, readProvider);
            const [sym, dec, nm] = await Promise.all([
              erc20.symbol().catch(() => "???"),
              erc20.decimals().catch(() => 18),
              erc20.name().catch(() => "Unknown Token"),
            ]);
            meta = { symbol: sym, decimals: Number(dec), name: nm };
          } catch { /* unreadable token */ }
          return { address: checksummed, balance, meta };
        })
      );

      // Sort: non-zero first, then by address
      entries.sort((a, b) => (b.balance > 0n ? 1 : 0) - (a.balance > 0n ? 1 : 0) || a.address.localeCompare(b.address));
      setTokens(entries);
    } finally {
      setLoading(false);
    }
  }, [userAddress, vault, readProvider]);

  useEffect(() => {
    setDismissed(loadDismissed(userAddress));
    discover();
  }, [userAddress, discover]);

  function dismiss(tokenAddr: string) {
    const updated = [...dismissed, tokenAddr.toLowerCase()];
    setDismissed(updated);
    saveDismissed(userAddress, updated);
  }

  function undismiss(tokenAddr: string) {
    const updated = dismissed.filter((a) => a !== tokenAddr.toLowerCase());
    setDismissed(updated);
    saveDismissed(userAddress, updated);
  }

  async function withdraw(entry: TokenEntry) {
    if (!signer) return;
    setWithdrawing(entry.address);
    setMsgs((m) => ({ ...m, [entry.address]: "" }));
    try {
      const connected = vault.connect(signer) as Contract;
      const tx = await connected.withdraw(entry.address);
      await confirmTx(tx);
      setMsgs((m) => ({ ...m, [entry.address]: "Withdrawn!" }));
      // Update balance locally
      setTokens((prev) => prev.map((t) => t.address === entry.address ? { ...t, balance: 0n } : t));
    } catch (err) {
      setMsgs((m) => ({ ...m, [entry.address]: humanizeError(err) }));
    } finally {
      setWithdrawing(null);
    }
  }

  async function addManual() {
    const addr = manualInput.trim();
    if (!ethers.isAddress(addr)) return;
    setAddingManual(true);
    try {
      const checksummed = ethers.getAddress(addr);
      // Persist to manual-tracking list
      const manualKey = `datum_tracked_tokens_${userAddress.toLowerCase()}`;
      const existing: string[] = JSON.parse(localStorage.getItem(manualKey) ?? "[]");
      if (!existing.map((a) => a.toLowerCase()).includes(checksummed.toLowerCase())) {
        localStorage.setItem(manualKey, JSON.stringify([...existing, checksummed]));
      }
      setManualInput("");
      await discover();
    } finally {
      setAddingManual(false);
    }
  }

  const visible = tokens.filter((t) => !dismissed.includes(t.address.toLowerCase()));
  const hiddenCount = tokens.filter((t) => dismissed.includes(t.address.toLowerCase())).length;
  const dismissedEntries = tokens.filter((t) => dismissed.includes(t.address.toLowerCase()));

  function formatBalance(entry: TokenEntry) {
    if (!entry.meta) return entry.balance.toString();
    const val = Number(entry.balance) / Math.pow(10, entry.meta.decimals);
    return val.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }

  return (
    <div>
      {loading && tokens.length === 0 && (
        <div className="nano-pending-text" style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
          Scanning for token rewards…
        </div>
      )}

      {!loading && tokens.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
          No token rewards found. Token rewards appear here when campaigns credit ERC-20 tokens to your address.
        </div>
      )}

      {/* Active token list */}
      {visible.length > 0 && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
          {visible.map((entry, i) => {
            const busy = withdrawing === entry.address;
            const msg = msgs[entry.address];
            return (
              <div
                key={entry.address}
                style={{
                  padding: "10px 12px",
                  borderBottom: i < visible.length - 1 ? "1px solid var(--border)" : "none",
                  display: "flex", flexDirection: "column", gap: 4,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  {/* Token identity */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                      {entry.meta?.symbol ?? "???"}
                      {entry.meta?.name && entry.meta.name !== entry.meta.symbol && (
                        <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6, fontSize: 11 }}>{entry.meta.name}</span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.address}
                    </span>
                  </div>

                  {/* Balance + actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: entry.balance > 0n ? "var(--text-strong)" : "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {formatBalance(entry)}
                    </span>
                    {entry.balance > 0n && signer && (
                      <button
                        onClick={() => withdraw(entry)}
                        disabled={!!withdrawing}
                        className="nano-btn nano-btn-ok"
                        style={{ fontSize: 11, padding: "3px 10px", whiteSpace: "nowrap" }}
                      >
                        {busy ? "…" : "Withdraw"}
                      </button>
                    )}
                    <button
                      onClick={() => dismiss(entry.address)}
                      style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}
                      title="Dismiss from list"
                    >
                      ×
                    </button>
                  </div>
                </div>

                {msg && (
                  <div style={{ fontSize: 11, color: msg === "Withdrawn!" ? "var(--ok)" : "var(--error)" }}>{msg}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Dismissed tokens */}
      {hiddenCount > 0 && (
        <div style={{ marginBottom: 10 }}>
          <button
            onClick={() => setShowDismissed(!showDismissed)}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontFamily: "inherit", padding: 0 }}
          >
            {showDismissed ? "▼" : "▶"} {hiddenCount} dismissed token{hiddenCount !== 1 ? "s" : ""}
          </button>
          {showDismissed && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", marginTop: 6 }}>
              {dismissedEntries.map((entry, i) => (
                <div
                  key={entry.address}
                  style={{ padding: "8px 12px", borderBottom: i < dismissedEntries.length - 1 ? "1px solid var(--border)" : "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, opacity: 0.6 }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: "var(--text-strong)" }}>{entry.meta?.symbol ?? "???"}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.address}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{formatBalance(entry)}</span>
                    <button
                      onClick={() => undismiss(entry.address)}
                      style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 7px", fontFamily: "inherit" }}
                    >
                      Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Refresh */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={discover}
          disabled={loading}
          className="nano-btn"
          style={{ fontSize: 11, padding: "3px 10px" }}
        >
          {loading ? "Scanning…" : "Refresh"}
        </button>

        {/* Manual add */}
        <button
          onClick={() => setShowManual(!showManual)}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontFamily: "inherit", padding: 0 }}
        >
          {showManual ? "▼" : "▶"} Add token manually
        </button>
      </div>

      {showManual && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="Token address (0x…)"
            className="nano-input"
            style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-mono)" }}
          />
          <button
            onClick={addManual}
            disabled={addingManual || !ethers.isAddress(manualInput.trim())}
            className="nano-btn"
            style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
          >
            {addingManual ? "…" : "Track"}
          </button>
        </div>
      )}
    </div>
  );
}
