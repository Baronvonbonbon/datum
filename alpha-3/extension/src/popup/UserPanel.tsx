import { useState, useEffect, useCallback } from "react";
import { Contract, isAddress } from "ethers";
import { getPaymentVaultContract, getTokenRewardVaultContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS, getCurrencySymbol } from "@shared/networks";
import { getSigner } from "@shared/walletManager";
import { BehaviorChainState } from "@shared/types";
import { humanizeError } from "@shared/errorCodes";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

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
  const [sym, setSym] = useState("DOT");

  // Sweep config
  const [sweepAddress, setSweepAddress] = useState("");

  // Token reward state
  const [tokenInput, setTokenInput] = useState("");
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [tokenCheckMsg, setTokenCheckMsg] = useState<string | null>(null);
  const [checkingToken, setCheckingToken] = useState(false);
  const [withdrawingToken, setWithdrawingToken] = useState(false);
  const [tokenWithdrawMsg, setTokenWithdrawMsg] = useState<string | null>(null);

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
      if (!settings.contractAddresses.paymentVault) return;
      const provider = getProvider(settings.rpcUrl);
      const vault = getPaymentVaultContract(settings.contractAddresses, provider);
      const bal = await vault.userBalance(address);
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
    chrome.storage.local.get("settings").then((s) => {
      const network = (s.settings ?? DEFAULT_SETTINGS).network;
      setSym(getCurrencySymbol(network));
    });
    chrome.runtime.sendMessage({ type: "GET_USER_PREFERENCES" }).then((resp) => {
      if (resp?.preferences?.sweepAddress) setSweepAddress(resp.preferences.sweepAddress);
    });
  }, [loadBalance, loadBehaviorChains]);

  async function withdraw() {
    if (!address) return;
    setWithdrawing(true);
    setTxResult(null);
    setError(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const provider = signer.provider!;
      const vault = getPaymentVaultContract(settings.contractAddresses, signer);

      const dest = sweepAddress && isAddress(sweepAddress) ? sweepAddress : null;
      const nonceBefore = await provider.getTransactionCount(signer.address);
      const tx = dest ? await vault.withdrawUserTo(dest) : await vault.withdrawUser();
      // Paseo: getTransactionReceipt always returns null — poll nonce instead.
      void tx;
      for (let i = 0; i < 60; i++) {
        const cur = await provider.getTransactionCount(signer.address);
        if (cur > nonceBefore) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      setTxResult(dest ? `Swept to ${dest.slice(0, 8)}...${dest.slice(-6)}.` : "Withdrawal successful.");
      loadBalance();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setWithdrawing(false);
    }
  }

  async function handleCheckToken() {
    if (!address || !isAddress(tokenInput.trim())) {
      setTokenCheckMsg("Enter a valid ERC-20 token address.");
      return;
    }
    setCheckingToken(true);
    setTokenCheckMsg(null);
    setTokenBalance(null);
    setTokenMeta(null);
    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.tokenRewardVault) {
        setTokenCheckMsg("TokenRewardVault not configured.");
        return;
      }
      const provider = getProvider(settings.rpcUrl);
      const vault = getTokenRewardVaultContract(settings.contractAddresses, provider);
      const bal = await vault.userTokenBalance(address, tokenInput.trim());
      setTokenBalance(BigInt(bal));
      try {
        const erc20 = new Contract(tokenInput.trim(), ERC20_ABI, provider);
        const [sym, dec] = await Promise.all([
          erc20.symbol().catch(() => "TOKEN"),
          erc20.decimals().catch(() => 18),
        ]);
        setTokenMeta({ symbol: sym as string, decimals: Number(dec) });
      } catch {
        setTokenMeta({ symbol: "TOKEN", decimals: 18 });
      }
    } catch (err) {
      setTokenCheckMsg(humanizeError(err));
    } finally {
      setCheckingToken(false);
    }
  }

  async function handleTokenWithdraw() {
    if (!address || !isAddress(tokenInput.trim())) return;
    setWithdrawingToken(true);
    setTokenWithdrawMsg(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const vault = getTokenRewardVaultContract(settings.contractAddresses, signer);
      const dest = sweepAddress && isAddress(sweepAddress) ? sweepAddress : null;
      const provider = signer.provider!;
      const nonceBefore = await provider.getTransactionCount(signer.address);
      const tx = dest
        ? await vault.withdrawTo(tokenInput.trim(), dest)
        : await vault.withdraw(tokenInput.trim());
      // Paseo: getTransactionReceipt always returns null — poll nonce instead.
      void tx;
      for (let i = 0; i < 60; i++) {
        const cur = await provider.getTransactionCount(signer.address);
        if (cur > nonceBefore) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      setTokenWithdrawMsg(dest ? `Swept to ${dest.slice(0, 8)}...${dest.slice(-6)}.` : "Token withdrawal successful.");
      setTokenBalance(0n);
    } catch (err) {
      setTokenWithdrawMsg(humanizeError(err));
    } finally {
      setWithdrawingToken(false);
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
        <span style={{ color: "var(--accent)", fontWeight: 600 }}>Your Earnings</span>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
      ) : (
        <>
          <div style={cardStyle}>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Withdrawable balance</div>
            <div style={{ color: "var(--text-strong)", fontSize: 18, fontWeight: 600 }}>
              {balance !== null ? formatDOT(balance) : "--"} {sym}
            </div>
            <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 11, marginTop: 4 }}>
              75% of settled impressions
            </div>
          </div>

          {/* EA-4: Withdrawal minimum display (denomination rounding: value % 10^6 >= 500k rejected) */}
          {balance !== null && balance > 0n && balance < 1_000_000n && (
            <div style={{ color: "var(--warn)", fontSize: 11, marginTop: 8, padding: "4px 8px", background: "rgba(252,211,77,0.07)", border: "1px solid rgba(252,211,77,0.2)", borderRadius: "var(--radius-sm)" }}>
              Balance below minimum withdrawal (0.0001 {sym} / 1M planck).
            </div>
          )}
          {balance !== null && balance >= 1_000_000n && (
            <>
              {sweepAddress && isAddress(sweepAddress) && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                  → cold wallet: <span style={{ fontFamily: "monospace" }}>{sweepAddress.slice(0, 8)}...{sweepAddress.slice(-6)}</span>
                </div>
              )}
              <button
                onClick={withdraw}
                disabled={withdrawing}
                style={{ ...primaryBtn, marginTop: 6 }}
              >
                {withdrawing
                  ? "Withdrawing..."
                  : sweepAddress && isAddress(sweepAddress)
                    ? `Sweep ${formatDOT(balance)} ${sym} → cold wallet`
                    : `Withdraw ${formatDOT(balance)} ${sym}`}
              </button>
            </>
          )}

          <button onClick={loadBalance} style={{ ...secondaryBtn, marginTop: 8 }}>
            Refresh
          </button>
        </>
      )}

      {/* Engagement Stats */}
      {totalEvents > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            Engagement
          </div>

          <div style={{ ...cardStyle, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Total impressions tracked</span>
              <span style={{ color: "var(--text)", fontSize: 12 }}>{totalEvents}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Avg dwell time</span>
              <span style={{ color: "var(--text)", fontSize: 12 }}>
                {totalEvents > 0 ? (totalDwell / totalEvents / 1000).toFixed(1) : "0"}s
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Avg viewable time</span>
              <span style={{ color: "var(--text)", fontSize: 12 }}>
                {totalEvents > 0 ? (totalViewable / totalEvents / 1000).toFixed(1) : "0"}s
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Viewability rate</span>
              <span style={{ color: "var(--text)", fontSize: 12 }}>
                {totalEvents > 0 ? ((totalIabViewable / totalEvents) * 100).toFixed(1) : "0"}%
              </span>
            </div>
          </div>

          {/* Per-campaign breakdown */}
          {behaviorChains.length > 1 && (
            <div style={{ maxHeight: 120, overflowY: "auto" }}>
              {behaviorChains.map((c) => (
                <div key={c.campaignId} style={{
                  padding: "4px 8px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
                  marginBottom: 2, fontSize: 11, color: "var(--text-muted)",
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
            <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, marginTop: 4, fontFamily: "monospace", wordBreak: "break-all" }}>
              Chain head: {behaviorChains[0].headHash.slice(0, 18)}...
            </div>
          )}
        </div>
      )}

      {/* Token Rewards */}
      <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Token Rewards</div>
        <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 8 }}>
          Check and withdraw ERC-20 token rewards earned from campaigns.
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            type="text"
            value={tokenInput}
            onChange={(e) => { setTokenInput(e.target.value); setTokenBalance(null); setTokenMeta(null); setTokenCheckMsg(null); }}
            placeholder="Token address (0x...)"
            style={{ ...inputStyle, flex: 1, fontSize: 11 }}
          />
          <button onClick={handleCheckToken} disabled={checkingToken} style={{ ...secondaryBtn, width: "auto", padding: "6px 10px", fontSize: 11, whiteSpace: "nowrap" }}>
            {checkingToken ? "..." : "Check"}
          </button>
        </div>
        {tokenCheckMsg && <div style={{ color: "var(--error)", fontSize: 11, marginBottom: 4 }}>{tokenCheckMsg}</div>}
        {tokenBalance !== null && tokenMeta && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 12, color: "var(--text-strong)", fontWeight: 600, marginBottom: 4 }}>
              Balance:{" "}
              {tokenBalance === 0n
                ? "0"
                : (Number(tokenBalance) / Math.pow(10, tokenMeta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
              <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{tokenMeta.symbol}</span>
            </div>
            {tokenBalance > 0n && (
              <button onClick={handleTokenWithdraw} disabled={withdrawingToken} style={{ ...primaryBtn, fontSize: 12 }}>
                {withdrawingToken
                  ? "Withdrawing..."
                  : sweepAddress && isAddress(sweepAddress)
                    ? `Sweep ${tokenMeta.symbol} → cold wallet`
                    : `Withdraw ${tokenMeta.symbol}`}
              </button>
            )}
          </div>
        )}
        {tokenWithdrawMsg && (
          <div style={{ fontSize: 11, color: tokenWithdrawMsg.includes("successful") ? "var(--ok)" : "var(--error)" }}>
            {tokenWithdrawMsg}
          </div>
        )}
      </div>

      {txResult && (
        <div style={{ marginTop: 8, padding: 10, background: "rgba(110,231,183,0.08)", border: "1px solid rgba(110,231,183,0.2)", borderRadius: "var(--radius-sm)", fontSize: 13, color: "var(--ok)" }}>
          {txResult}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, padding: 8, background: "rgba(252,165,165,0.08)", border: "1px solid rgba(252,165,165,0.2)", borderRadius: "var(--radius-sm)", color: "var(--error)", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "var(--bg-raised)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  background: "rgba(160,160,255,0.1)",
  color: "var(--accent)",
  border: "1px solid rgba(160,160,255,0.3)",
  borderRadius: "var(--radius-sm)",
  padding: "8px 14px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
  fontWeight: 500,
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "var(--bg-raised)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 13,
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 8px",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 12,
  outline: "none",
};
