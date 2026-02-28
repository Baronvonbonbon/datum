import { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Eip1193Provider } from "ethers";
import { getSettlementContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS } from "@shared/networks";

interface Props {
  address: string | null;
}

export function UserPanel({ address }: Props) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [txResult, setTxResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  async function withdraw() {
    if (!address) return;
    setWithdrawing(true);
    setTxResult(null);
    setError(null);
    try {
      if (!window.ethereum) throw new Error("No EIP-1193 provider found.");
      const settings = await getSettings();
      const provider = new BrowserProvider(window.ethereum as Eip1193Provider);
      const signer = await provider.getSigner();
      const settlement = getSettlementContract(settings.contractAddresses, signer);

      const tx = await settlement.withdrawUser();
      await tx.wait();
      setTxResult("Withdrawal successful.");
      loadBalance();
    } catch (err) {
      setError(String(err));
    } finally {
      setWithdrawing(false);
    }
  }

  if (!address) {
    return <div style={emptyStyle}>Connect wallet to view your earnings.</div>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>Your Earnings</span>
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={cardStyle}>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>Withdrawable balance</div>
            <div style={{ color: "#e0e0e0", fontSize: 18, fontWeight: 600 }}>
              {balance !== null ? formatDOT(balance) : "—"} DOT
            </div>
            <div style={{ color: "#555", fontSize: 11, marginTop: 4 }}>
              75% of settled impressions
            </div>
          </div>

          {balance !== null && balance > 0n && (
            <button
              onClick={withdraw}
              disabled={withdrawing}
              style={{ ...primaryBtn, marginTop: 12 }}
            >
              {withdrawing ? "Withdrawing…" : `Withdraw ${formatDOT(balance)} DOT`}
            </button>
          )}

          <button onClick={loadBalance} style={{ ...secondaryBtn, marginTop: 8 }}>
            Refresh
          </button>
        </>
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

declare global {
  interface Window {
    ethereum?: unknown;
  }
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
