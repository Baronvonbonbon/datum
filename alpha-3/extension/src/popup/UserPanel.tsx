import { useState, useEffect, useCallback } from "react";
import { Contract, ZeroAddress, isAddress } from "ethers";
import { getPaymentVaultContract, getTokenRewardVaultContract, getCampaignsContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { DEFAULT_SETTINGS, getCurrencySymbol } from "@shared/networks";
import { getSigner } from "@shared/walletManager";
import { BehaviorChainState } from "@shared/types";
import { humanizeError } from "@shared/errorCodes";
import { getAssetMetadata } from "@shared/assetRegistry";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

interface TokenReward {
  token: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  campaigns: string[]; // campaign IDs that use this token
}

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
  const [tokenRewards, setTokenRewards] = useState<TokenReward[]>([]);
  const [scanningTokens, setScanningTokens] = useState(false);
  const [tokenScanMsg, setTokenScanMsg] = useState<string | null>(null);
  const [withdrawingToken, setWithdrawingToken] = useState<string | null>(null); // token address being withdrawn
  const [withdrawingAll, setWithdrawingAll] = useState(false);
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

  async function scanTokenRewards() {
    if (!address) return;
    setScanningTokens(true);
    setTokenScanMsg(null);
    setTokenRewards([]);
    setTokenWithdrawMsg(null);
    try {
      const settings = await getSettings();
      if (!settings.contractAddresses.tokenRewardVault || !settings.contractAddresses.campaigns) {
        setTokenScanMsg("Contracts not configured.");
        return;
      }
      const provider = getProvider(settings.rpcUrl);
      const campaigns = getCampaignsContract(settings.contractAddresses, provider);
      const vault = getTokenRewardVaultContract(settings.contractAddresses, provider);

      // Fetch active campaigns list from background
      let campaignList: Array<{ id: string }> = [];
      try {
        const resp = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_CAMPAIGNS" });
        campaignList = (resp?.campaigns ?? []).filter((c: any) => Number(c.status) <= 1);
      } catch { /* */ }

      if (campaignList.length === 0) {
        setTokenScanMsg("No active campaigns found.");
        return;
      }

      // Discover reward tokens per campaign
      const tokenToCampaigns = new Map<string, string[]>();
      await Promise.all(campaignList.map(async (c) => {
        try {
          const token: string = await campaigns.getCampaignRewardToken(c.id);
          if (token && token !== ZeroAddress) {
            const key = token.toLowerCase();
            if (!tokenToCampaigns.has(key)) tokenToCampaigns.set(key, []);
            tokenToCampaigns.get(key)!.push(c.id);
          }
        } catch { /* campaign may not exist yet */ }
      }));

      if (tokenToCampaigns.size === 0) {
        setTokenScanMsg("No token rewards configured on active campaigns.");
        return;
      }

      // Fetch balance + metadata for each token
      const results: TokenReward[] = await Promise.all(
        [...tokenToCampaigns.entries()].map(async ([tokenLow, cids]) => {
          // Recover original-case address (use the first campaign's value)
          let tokenAddr = tokenLow;
          try {
            const first = campaignList.find((c) => cids.includes(c.id));
            if (first) tokenAddr = await campaigns.getCampaignRewardToken(first.id);
          } catch { /* */ }

          const bal = await vault.userTokenBalance(address, tokenAddr).then((v: bigint) => BigInt(v)).catch(() => 0n);
          // Use native asset registry for metadata if available, else fall back to ERC-20 ABI
          const known = getAssetMetadata(tokenAddr);
          let sym: string;
          let dec: number;
          if (known) {
            sym = known.symbol;
            dec = known.decimals;
          } else {
            const erc20 = new Contract(tokenAddr, ERC20_ABI, provider);
            [sym, dec] = await Promise.all([
              erc20.symbol().catch(() => "TOKEN"),
              erc20.decimals().catch(() => 18),
            ]) as [string, number];
            dec = Number(dec);
          }
          return { token: tokenAddr, symbol: sym, decimals: dec, balance: bal, campaigns: cids };
        })
      );

      setTokenRewards(results);
      if (results.every((r) => r.balance === 0n)) {
        setTokenScanMsg("No token balances to withdraw yet.");
      }
    } catch (err) {
      setTokenScanMsg(humanizeError(err));
    } finally {
      setScanningTokens(false);
    }
  }

  async function withdrawToken(tokenAddr: string) {
    if (!address) return;
    setWithdrawingToken(tokenAddr);
    setTokenWithdrawMsg(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const vault = getTokenRewardVaultContract(settings.contractAddresses, signer);
      const dest = sweepAddress && isAddress(sweepAddress) ? sweepAddress : null;
      const provider = signer.provider!;
      const nonceBefore = await provider.getTransactionCount(signer.address);
      const tx = dest
        ? await vault.withdrawTo(tokenAddr, dest)
        : await vault.withdraw(tokenAddr);
      void tx;
      for (let i = 0; i < 60; i++) {
        const cur = await provider.getTransactionCount(signer.address);
        if (cur > nonceBefore) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      setTokenWithdrawMsg(dest ? `Swept to ${dest.slice(0, 8)}...${dest.slice(-6)}.` : "Withdrawn.");
      // Clear balance for this token optimistically
      setTokenRewards((prev) => prev.map((r) => r.token.toLowerCase() === tokenAddr.toLowerCase() ? { ...r, balance: 0n } : r));
    } catch (err) {
      setTokenWithdrawMsg(humanizeError(err));
    } finally {
      setWithdrawingToken(null);
    }
  }

  async function withdrawAllTokens() {
    const pending = tokenRewards.filter((r) => r.balance > 0n);
    if (pending.length === 0) return;
    setWithdrawingAll(true);
    setTokenWithdrawMsg(null);
    const errors: string[] = [];
    for (const r of pending) {
      try {
        await withdrawToken(r.token);
      } catch (err) {
        errors.push(`${r.symbol}: ${humanizeError(err)}`);
      }
    }
    setWithdrawingAll(false);
    if (errors.length > 0) setTokenWithdrawMsg(errors.join("; "));
    else setTokenWithdrawMsg(`All tokens withdrawn.`);
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

        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <button
            onClick={scanTokenRewards}
            disabled={scanningTokens}
            style={{ ...secondaryBtn, width: "auto", padding: "6px 10px", fontSize: 11, whiteSpace: "nowrap" }}
          >
            {scanningTokens ? "Scanning..." : "Scan campaigns"}
          </button>
          {tokenRewards.filter((r) => r.balance > 0n).length > 1 && (
            <button
              onClick={withdrawAllTokens}
              disabled={withdrawingAll || !!withdrawingToken}
              style={{ ...primaryBtn, width: "auto", padding: "6px 10px", fontSize: 11, whiteSpace: "nowrap" }}
            >
              {withdrawingAll ? "Withdrawing..." : "Withdraw all"}
            </button>
          )}
        </div>

        {tokenScanMsg && (
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 6 }}>{tokenScanMsg}</div>
        )}

        {tokenRewards.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {tokenRewards.map((r) => (
              <div key={r.token} style={{
                ...cardStyle,
                display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px",
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)" }}>
                    {(Number(r.balance) / Math.pow(10, r.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                    <span style={{ color: "var(--accent)" }}>{r.symbol}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                    campaigns: {r.campaigns.join(", ")}
                  </div>
                </div>
                {r.balance > 0n && (
                  <button
                    onClick={() => withdrawToken(r.token)}
                    disabled={!!withdrawingToken || withdrawingAll}
                    style={{ ...secondaryBtn, width: "auto", padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    {withdrawingToken === r.token
                      ? "..."
                      : sweepAddress && isAddress(sweepAddress)
                        ? `Sweep ${r.symbol}`
                        : `Withdraw`}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {tokenWithdrawMsg && (
          <div style={{ fontSize: 11, marginTop: 6, color: tokenWithdrawMsg.toLowerCase().includes("err") || tokenWithdrawMsg.toLowerCase().includes("fail") ? "var(--error)" : "var(--ok)" }}>
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
