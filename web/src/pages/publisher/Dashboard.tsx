import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { tagLabel } from "@shared/tagDictionary";
import { ConfirmModal } from "../../components/ConfirmModal";

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
      const tx = await vault.withdrawPublisher();
      await confirmTx(tx);
      setMsg("Withdrawal successful!");
      load();
    } catch (err) {
      setMsg(humanizeError(err));
    } finally {
      setWithdrawing(false);
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
            {msg && <div style={{ color: msg.includes("successful") ? "var(--ok)" : "var(--error)", fontSize: 13, marginBottom: 8 }}>{msg}</div>}
            {signer && balance !== null && balance > 0n && (
              <button onClick={() => setShowWithdrawConfirm(true)} disabled={withdrawing} className="nano-btn nano-btn-accent" style={{ padding: "8px 16px", fontSize: 13 }}>
                {withdrawing ? "Withdrawing..." : "Withdraw Earnings"}
              </button>
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
