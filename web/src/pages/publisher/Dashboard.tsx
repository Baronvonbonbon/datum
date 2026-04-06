import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ethers, Contract } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { tagLabel } from "@shared/tagDictionary";
import { ConfirmModal } from "../../components/ConfirmModal";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

export function PublisherDashboard() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { confirmTx } = useTx();
  const [info, setInfo] = useState<any>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reputation, setReputation] = useState<{ settled: bigint; rejected: bigint; scoreBps: bigint } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);
  const [withdrawToAddress, setWithdrawToAddress] = useState("");

  // Token reward vault state
  const [tokenInput, setTokenInput] = useState("");
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [tokenCheckMsg, setTokenCheckMsg] = useState<string | null>(null);
  const [checkingToken, setCheckingToken] = useState(false);
  const [withdrawingToken, setWithdrawingToken] = useState(false);
  const [tokenWithdrawMsg, setTokenWithdrawMsg] = useState<string | null>(null);

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const [pubData, bal, blk] = await Promise.all([
        contracts.publishers.getPublisher(address).catch(() => null),
        contracts.paymentVault.publisherBalance(address).catch(() => 0n),
        contracts.publishers.isBlocked(address).catch(() => false),
      ]);
      setInfo(pubData);
      setBalance(BigInt(bal));
      setBlocked(Boolean(blk));

      // Fetch tags from TargetingRegistry
      try {
        if (contracts.targetingRegistry) {
          const hashes: string[] = await contracts.targetingRegistry.getTags(address);
          setTags(hashes.map((h) => tagLabel(h) ?? h.slice(0, 10) + "...").filter(Boolean));
        }
      } catch { /* no targeting registry */ }

      // Fetch reputation stats
      try {
        if (contracts.reputation) {
          const stats = await contracts.reputation.getPublisherStats(address);
          setReputation({
            settled: BigInt(stats[0] ?? stats.totalSettled ?? 0),
            rejected: BigInt(stats[1] ?? stats.totalRejected ?? 0),
            scoreBps: BigInt(stats[2] ?? stats.scoreBps ?? 0),
          });
        }
      } catch { /* no reputation contract */ }
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw() {
    if (!signer) return;
    setWithdrawing(true);
    setMsg(null);
    try {
      const vault = contracts.paymentVault.connect(signer);
      const dest = withdrawToAddress.trim();
      const tx = dest && ethers.isAddress(dest)
        ? await vault.withdrawPublisherTo(dest)
        : await vault.withdrawPublisher();
      await confirmTx(tx);
      setMsg(dest && ethers.isAddress(dest) ? `Sent to ${dest.slice(0, 8)}...${dest.slice(-6)}.` : "Withdrawal successful!");
      load();
    } catch (err) {
      setMsg(humanizeError(err));
    } finally {
      setWithdrawing(false);
    }
  }

  async function handleCheckToken() {
    if (!address || !ethers.isAddress(tokenInput.trim())) {
      setTokenCheckMsg("Enter a valid ERC-20 token address.");
      return;
    }
    setCheckingToken(true);
    setTokenCheckMsg(null);
    setTokenBalance(null);
    setTokenMeta(null);
    try {
      const vault = contracts.tokenRewardVault;
      if (!vault) { setTokenCheckMsg("TokenRewardVault not configured."); return; }
      const bal = await vault.userTokenBalance(address, tokenInput.trim());
      setTokenBalance(BigInt(bal));
      // Try to fetch token metadata
      try {
        const erc20 = new Contract(tokenInput.trim(), ERC20_ABI, contracts.readProvider);
        const [sym, dec] = await Promise.all([
          erc20.symbol().catch(() => "TOKEN"),
          erc20.decimals().catch(() => 18),
        ]);
        setTokenMeta({ symbol: sym, decimals: Number(dec) });
      } catch { setTokenMeta({ symbol: "TOKEN", decimals: 18 }); }
    } catch (err) {
      setTokenCheckMsg(humanizeError(err));
    } finally {
      setCheckingToken(false);
    }
  }

  async function handleTokenWithdraw() {
    if (!signer || !ethers.isAddress(tokenInput.trim())) return;
    setWithdrawingToken(true);
    setTokenWithdrawMsg(null);
    try {
      const vault = contracts.tokenRewardVault.connect(signer);
      const tx = await vault.withdraw(tokenInput.trim());
      await confirmTx(tx);
      setTokenWithdrawMsg("Token withdrawal successful!");
      setTokenBalance(0n);
    } catch (err) {
      setTokenWithdrawMsg(humanizeError(err));
    } finally {
      setWithdrawingToken(false);
    }
  }

  if (!address) return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to manage your publisher profile.</div>;
  if (loading) return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading</div>;

  const isRegistered = info?.registered === true || info?.[0] === true;
  const takeRateBps = Number(info?.takeRateBps ?? info?.[1] ?? 0);

  return (
    <div className="nano-fade">
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Publisher Dashboard</h1>

      {blocked && (
        <div className="nano-info nano-info--error" style={{ fontWeight: 600, marginBottom: 16 }}>
          This address is blocked by the protocol admin. New registrations and campaigns are restricted.
        </div>
      )}

      {!isRegistered ? (
        <div className="nano-card" style={{ padding: 20 }}>
          <div style={{ color: "var(--text)", marginBottom: 12 }}>You are not registered as a publisher.</div>
          <Link to="/publisher/register" className="nano-btn nano-btn-accent" style={{ padding: "8px 16px", fontSize: 13, textDecoration: "none" }}>
            Register as Publisher
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            <InfoCard label="Take Rate" value={`${(takeRateBps / 100).toFixed(0)}%`} />
            <InfoCard label="Tags" value={`${tags.length} active`} />
            <InfoCard label="Status" value="Registered" color="var(--ok)" />
          </div>

          {tags.length > 0 && (
            <div className="nano-card" style={{ padding: 12 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6 }}>Active Tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {tags.map((tag, i) => (
                  <span key={i} className="nano-badge" style={{ color: "var(--accent)" }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Reputation */}
          {reputation && (
            <div className="nano-card" style={{ padding: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Reputation</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Settled</div>
                  <div style={{ color: "var(--ok)", fontWeight: 700, fontSize: 18 }}>{reputation.settled.toString()}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Rejected</div>
                  <div style={{ color: reputation.rejected > 0n ? "var(--error)" : "var(--text-strong)", fontWeight: 700, fontSize: 18 }}>{reputation.rejected.toString()}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Score</div>
                  <div style={{ color: "var(--text-strong)", fontWeight: 700, fontSize: 18 }}>{(Number(reputation.scoreBps) / 100).toFixed(0)}%</div>
                </div>
              </div>
            </div>
          )}

          {/* Earnings */}
          <div className="nano-card" style={{ padding: 16 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Earnings</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
              {balance !== null ? <DOTAmount planck={balance} /> : "—"}
            </div>
            {msg && <div style={{ color: msg.includes("successful") || msg.includes("Sent") ? "var(--ok)" : "var(--error)", fontSize: 13, marginBottom: 8 }}>{msg}</div>}
            {signer && balance !== null && balance > 0n && (
              <>
                <div style={{ marginBottom: 8 }}>
                  <input
                    type="text"
                    value={withdrawToAddress}
                    onChange={(e) => setWithdrawToAddress(e.target.value.trim())}
                    placeholder="Withdraw to address (leave empty = this wallet)"
                    className="nano-input"
                    style={{ width: "100%", fontSize: 12 }}
                  />
                  {withdrawToAddress && !ethers.isAddress(withdrawToAddress) && (
                    <div style={{ color: "var(--error)", fontSize: 11, marginTop: 2 }}>Invalid address.</div>
                  )}
                </div>
                <button
                  onClick={() => setShowWithdrawConfirm(true)}
                  disabled={withdrawing || (!!withdrawToAddress && !ethers.isAddress(withdrawToAddress))}
                  className="nano-btn nano-btn-accent"
                  style={{ padding: "8px 16px", fontSize: 13 }}
                >
                  {withdrawing
                    ? "Withdrawing..."
                    : withdrawToAddress && ethers.isAddress(withdrawToAddress)
                      ? `Send to ${withdrawToAddress.slice(0, 8)}...`
                      : "Withdraw Earnings"}
                </button>
              </>
            )}
          </div>

          {/* Token Rewards */}
          <div className="nano-card" style={{ padding: 16 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Token Rewards</div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
              Check and withdraw ERC-20 token rewards earned from campaigns.
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => { setTokenInput(e.target.value); setTokenBalance(null); setTokenMeta(null); setTokenCheckMsg(null); }}
                placeholder="Token address (0x...)"
                className="nano-input"
                style={{ flex: 1, fontSize: 12 }}
              />
              <button onClick={handleCheckToken} disabled={checkingToken} className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, whiteSpace: "nowrap" }}>
                {checkingToken ? "..." : "Check"}
              </button>
            </div>
            {tokenCheckMsg && <div style={{ color: "var(--error)", fontSize: 12, marginBottom: 6 }}>{tokenCheckMsg}</div>}
            {tokenBalance !== null && tokenMeta && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: "var(--text-strong)", fontWeight: 700, marginBottom: 4 }}>
                  Balance:{" "}
                  {tokenBalance === 0n
                    ? "0"
                    : (Number(tokenBalance) / Math.pow(10, tokenMeta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{tokenMeta.symbol}</span>
                </div>
                {tokenBalance > 0n && signer && (
                  <button onClick={handleTokenWithdraw} disabled={withdrawingToken} className="nano-btn nano-btn-accent" style={{ padding: "6px 12px", fontSize: 12 }}>
                    {withdrawingToken ? "Withdrawing..." : `Withdraw ${tokenMeta.symbol}`}
                  </button>
                )}
              </div>
            )}
            {tokenWithdrawMsg && (
              <div style={{ color: tokenWithdrawMsg.includes("successful") ? "var(--ok)" : "var(--error)", fontSize: 12 }}>
                {tokenWithdrawMsg}
              </div>
            )}
          </div>

          {/* Quick links */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link to="/publisher/rate" className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>Update Take Rate</Link>
            <Link to="/publisher/categories" className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>Manage Tags</Link>
            <Link to="/publisher/allowlist" className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>Allowlist</Link>
            <Link to="/publisher/earnings" className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>Full Earnings</Link>
            <Link to="/publisher/sdk" className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>SDK Setup</Link>
            <Link to="/publisher/profile" className="nano-btn" style={{ padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>Profile</Link>
          </div>
        </div>
      )}

      {showWithdrawConfirm && (
        <ConfirmModal
          title="Withdraw Earnings?"
          message="This will transfer your full available balance to your wallet."
          confirmLabel="Withdraw"
          onConfirm={() => { setShowWithdrawConfirm(false); handleWithdraw(); }}
          onCancel={() => setShowWithdrawConfirm(false)}
        />
      )}
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="nano-card" style={{ padding: "10px 14px" }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ color: color ?? "var(--text-strong)", fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
