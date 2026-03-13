import { useState, useEffect, useCallback } from "react";
import { getSettlementContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { getSigner } from "@shared/walletManager";
import { BehaviorChainState } from "@shared/types";
import { humanizeError } from "@shared/errorCodes";

interface Props {
  address: string | null;
}

export function UserPanel({ address }: Props) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [txResult, setTxResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [behaviorChains, setBehaviorChains] = useState<BehaviorChainState[]>([]);

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  const loadBalance = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.settlement) return;
      const provider = getProvider(settings.rpcUrl);
      const settlement = getSettlementContract(settings.contractAddresses, provider);
      const bal = await settlement.userBalance(address);
      setBalance(bal as bigint);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  const loadBehaviorChains = useCallback(async () => {
    if (!address) return;
    // Read all behaviorChain:address:* keys from storage
    const all = await chrome.storage.local.get(null);
    const prefix = `behaviorChain:${address}:`;
    const chains: BehaviorChainState[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        chains.push(value as BehaviorChainState);
      }
    }
    setBehaviorChains(chains);
  }, [address]);

  useEffect(() => {
    loadBalance();
    loadBehaviorChains();
  }, [loadBalance, loadBehaviorChains]);

  async function withdraw() {
    if (!address) return;
    setWithdrawing(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const settlement = getSettlementContract(settings.contractAddresses, signer);

      const tx = await settlement.withdrawUser();
      await tx.wait();
      setTxResult("Withdrawal successful.");
      loadBalance();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setWithdrawing(false);
    }
  }

  if (!address) {
    return <div style={emptyStyle}>Connect wallet to view your earnings.</div>;
  }

  // Aggregate engagement stats
  const totalEvents = behaviorChains.reduce((s, c) => s + c.eventCount, 0);
  const totalDwell = behaviorChains.reduce((s, c) => s + c.cumulativeDwellMs, 0);
  const totalViewable = behaviorChains.reduce((s, c) => s + c.cumulativeViewableMs, 0);
  const totalIabViewable = behaviorChains.reduce((s, c) => s + c.iabViewableCount, 0);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Your Earnings</span>
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 13 }}>Loading...</div>
      ) : (
        <>
          <div style={cardStyle}>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>Withdrawable balance</div>
            <div style={{ color: "#e0e0e0", fontSize: 18, fontWeight: 600 }}>
              {balance !== null ? formatDOT(balance) : "--"} DOT
            </div>
            <div style={{ color: "#555", fontSize: 11, marginTop: 4 }}>
              75% of settled impressions
            </div>
          </div>

          {/* EA-4: Withdrawal minimum display (denomination rounding: value % 10^6 >= 500k rejected) */}
          {balance !== null && balance > 0n && balance < 1_000_000n && (
            <div style={{ color: "#c09060", fontSize: 11, marginTop: 8, padding: "4px 8px", background: "#1a1a0a", borderRadius: 3 }}>
              Balance below minimum withdrawal (0.0001 DOT / 1M planck).
            </div>
          )}
          {balance !== null && balance >= 1_000_000n && (
            <button
              onClick={withdraw}
              disabled={withdrawing}
              style={{ ...primaryBtn, marginTop: 12 }}
            >
              {withdrawing ? "Withdrawing..." : `Withdraw ${formatDOT(balance)} DOT`}
            </button>
          )}

          <button onClick={loadBalance} style={{ ...secondaryBtn, marginTop: 8 }}>
            Refresh
          </button>
        </>
      )}

      {/* Engagement Stats */}
      {totalEvents > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid #2a2a2a", paddingTop: 12 }}>
          <div style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            Engagement
          </div>

          <div style={{ ...cardStyle, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "#888", fontSize: 12 }}>Total impressions tracked</span>
              <span style={{ color: "#e0e0e0", fontSize: 12 }}>{totalEvents}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "#888", fontSize: 12 }}>Avg dwell time</span>
              <span style={{ color: "#e0e0e0", fontSize: 12 }}>
                {totalEvents > 0 ? (totalDwell / totalEvents / 1000).toFixed(1) : "0"}s
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "#888", fontSize: 12 }}>Avg viewable time</span>
              <span style={{ color: "#e0e0e0", fontSize: 12 }}>
                {totalEvents > 0 ? (totalViewable / totalEvents / 1000).toFixed(1) : "0"}s
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#888", fontSize: 12 }}>Viewability rate</span>
              <span style={{ color: "#e0e0e0", fontSize: 12 }}>
                {totalEvents > 0 ? ((totalIabViewable / totalEvents) * 100).toFixed(1) : "0"}%
              </span>
            </div>
          </div>

          {/* Per-campaign breakdown */}
          {behaviorChains.length > 1 && (
            <div style={{ maxHeight: 120, overflowY: "auto" }}>
              {behaviorChains.map((c) => (
                <div key={c.campaignId} style={{
                  padding: "4px 8px", background: "#111122", borderRadius: 3,
                  marginBottom: 2, fontSize: 11, color: "#888",
                  display: "flex", justifyContent: "space-between",
                }}>
                  <span>Campaign #{c.campaignId}</span>
                  <span>
                    {c.eventCount} events &middot;
                    {(c.eventCount > 0 ? c.cumulativeDwellMs / c.eventCount / 1000 : 0).toFixed(1)}s avg
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Behavior chain head hash */}
          {behaviorChains.length > 0 && (
            <div style={{ color: "#555", fontSize: 10, marginTop: 4, fontFamily: "monospace", wordBreak: "break-all" }}>
              Chain head: {behaviorChains[0].headHash.slice(0, 18)}...
            </div>
          )}
        </div>
      )}

      {txResult && (
        <div style={{ marginTop: 8, padding: 10, background: "#0a2a0a", borderRadius: 6, fontSize: 13, color: "#60c060" }}>
          {txResult}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, color: "#ff8080", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "#1a1a2e",
  borderRadius: 6,
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  background: "#2a2a5a",
  color: "#a0a0ff",
  border: "1px solid #4a4a8a",
  borderRadius: 6,
  padding: "10px 16px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#1a1a1a",
  color: "#666",
  border: "1px solid #333",
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
  fontSize: 13,
};
