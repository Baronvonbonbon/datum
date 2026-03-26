import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { DOTAmount } from "../../components/DOTAmount";
import { StatusBadge } from "../../components/StatusBadge";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CONVICTION_WEIGHTS, CONVICTION_LOCKUP_BLOCKS, formatBlockDelta } from "@shared/conviction";
import { humanizeError } from "@shared/errorCodes";
import { useBlock } from "../../hooks/useBlock";

interface MyVote {
  campaignId: number;
  direction: number; // 1=aye, 2=nay
  lockAmount: bigint;
  conviction: number;
  unlockBlock: number;
  campaignStatus: number;
  campaignResolved: boolean;
  slashFinalized: boolean;
  claimable: bigint;
}

export function MyVotes() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { blockNumber } = useBlock();

  const [votes, setVotes] = useState<MyVote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      const filter = contracts.governanceV2.filters.VoteCast(null, address);
      const logs = await contracts.governanceV2.queryFilter(filter).catch(() => []);

      // Deduplicate by campaignId (last vote wins)
      const campaignIds = new Set<number>();
      for (const log of logs) {
        const args = (log as any).args ?? {};
        campaignIds.add(Number(args.campaignId ?? 0));
      }

      const results: MyVote[] = [];
      await Promise.all([...campaignIds].map(async (cid) => {
        try {
          const [v, c, resolved] = await Promise.all([
            contracts.governanceV2.getVote(BigInt(cid), address),
            contracts.campaigns.getCampaignForSettlement(BigInt(cid)),
            contracts.governanceV2.resolved(BigInt(cid)).catch(() => false),
          ]);

          const dir = Number(v.direction ?? v[0] ?? 0);
          if (dir === 0) return;

          const lockAmt = BigInt(v.lockAmount ?? v[1] ?? 0);
          const conv = Number(v.conviction ?? v[2] ?? 0);
          const unlockBlk = Number(v.lockedUntilBlock ?? v[3] ?? 0);

          // Check slash state per campaign
          let slashFinalized = false;
          let claimable = 0n;
          if (Boolean(resolved)) {
            try {
              slashFinalized = Boolean(await contracts.governanceSlash.finalized(BigInt(cid)));
            } catch { /* no slash contract */ }
            if (slashFinalized) {
              try {
                claimable = BigInt(await contracts.governanceSlash.getClaimable(BigInt(cid), address));
              } catch { /* no claimable */ }
            }
          }

          results.push({
            campaignId: cid,
            direction: dir,
            lockAmount: lockAmt,
            conviction: conv,
            unlockBlock: unlockBlk,
            campaignStatus: Number(c[0]),
            campaignResolved: Boolean(resolved),
            slashFinalized,
            claimable,
          });
        } catch { /* skip */ }
      }));

      setVotes(results.sort((a, b) => b.campaignId - a.campaignId));
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw(campaignId: number) {
    if (!signer) return;
    setBusyId(campaignId);
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceV2.connect(signer);
      const tx = await c.withdraw(BigInt(campaignId));
      await tx.wait();
      setTxState("success");
      setTxMsg(`Withdrawal for campaign #${campaignId} complete.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleFinalizeSlash(campaignId: number) {
    if (!signer) return;
    setBusyId(campaignId);
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceSlash.connect(signer);
      const tx = await c.finalizeSlash(BigInt(campaignId));
      await tx.wait();
      setTxState("success");
      setTxMsg(`Slash finalized for campaign #${campaignId}. You can now claim rewards.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleClaimSlashReward(campaignId: number) {
    if (!signer) return;
    setBusyId(campaignId);
    setTxState("pending");
    setTxMsg("");
    try {
      const c = contracts.governanceSlash.connect(signer);
      const tx = await c.claimSlashReward(BigInt(campaignId));
      await tx.wait();
      setTxState("success");
      setTxMsg(`Slash reward claimed for campaign #${campaignId}.`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    } finally {
      setBusyId(null);
    }
  }

  if (!address) {
    return (
      <div style={{ maxWidth: 640 }}>
        <Link to="/governance" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>My Votes</h1>
        <div style={{ color: "#666", padding: 20 }}>Connect your wallet to view your votes.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Governance</Link>
      <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, margin: "12px 0" }}>My Votes</h1>

      <TransactionStatus state={txState} message={txMsg} />

      {loading ? (
        <div style={{ color: "#555" }}>Loading your votes...</div>
      ) : votes.length === 0 ? (
        <div style={{ color: "#555", padding: 20, textAlign: "center" }}>
          You haven't voted on any campaigns yet.{" "}
          <Link to="/governance" style={{ color: "#a0a0ff" }}>Browse governance →</Link>
        </div>
      ) : (
        <div>
          {votes.map((v) => {
            const lockup = CONVICTION_LOCKUP_BLOCKS[v.conviction];
            const weight = CONVICTION_WEIGHTS[v.conviction];
            const canWithdraw = lockup === 0 || (blockNumber !== null && blockNumber >= v.unlockBlock);
            const blocksLeft = blockNumber && v.unlockBlock > 0 ? Math.max(0, v.unlockBlock - blockNumber) : 0;

            return (
              <div key={v.campaignId} style={{ background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 8, padding: 14, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Link to={`/governance/vote/${v.campaignId}`} style={{ color: "#a0a0ff", fontWeight: 700, textDecoration: "none" }}>
                      Campaign #{v.campaignId}
                    </Link>
                    <StatusBadge status={v.campaignStatus} />
                    {v.campaignResolved && <span style={{ fontSize: 11, color: "#555" }}>Resolved</span>}
                  </div>
                  <span style={{
                    padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                    background: v.direction === 1 ? "#0a2a0a" : "#2a0a0a",
                    color: v.direction === 1 ? "#60c060" : "#ff8080",
                    border: `1px solid ${v.direction === 1 ? "#2a5a2a" : "#5a2a2a"}`,
                  }}>
                    {v.direction === 1 ? "Aye" : "Nay"}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12, fontSize: 12 }}>
                  <div style={{ color: "#555" }}>
                    Staked: <span style={{ color: "#888" }}><DOTAmount planck={v.lockAmount} /></span>
                  </div>
                  <div style={{ color: "#555" }}>
                    Conviction: <span style={{ color: "#888" }}>{v.conviction} ({weight}x weight)</span>
                  </div>
                  <div style={{ color: "#555" }}>
                    Effective: <span style={{ color: "#888" }}><DOTAmount planck={v.lockAmount * BigInt(weight)} /></span>
                  </div>
                  <div style={{ color: "#555" }}>
                    {lockup === 0 ? (
                      <span style={{ color: "#60c060" }}>No lockup</span>
                    ) : canWithdraw ? (
                      <span style={{ color: "#60c060" }}>Unlocked</span>
                    ) : (
                      <span>Locked: <span style={{ color: "#888" }}>{formatBlockDelta(blocksLeft)} left</span></span>
                    )}
                  </div>
                </div>

                {/* Slash info for resolved campaigns */}
                {v.campaignResolved && v.lockAmount > 0n && (
                  <div style={{ padding: "8px 10px", background: "#0a0a14", border: "1px solid #1a1a2e", borderRadius: 4, fontSize: 12, marginBottom: 10 }}>
                    {!v.slashFinalized ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "#888" }}>Slash not yet finalized for this campaign.</span>
                        {signer && (
                          <button
                            onClick={() => handleFinalizeSlash(v.campaignId)}
                            disabled={busyId === v.campaignId}
                            style={smallActionBtn}
                          >
                            {busyId === v.campaignId ? "Finalizing..." : "Finalize Slash"}
                          </button>
                        )}
                      </div>
                    ) : v.claimable > 0n ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ color: "#60c060" }}>
                          Slash reward: <DOTAmount planck={v.claimable} />
                        </span>
                        {signer && (
                          <button
                            onClick={() => handleClaimSlashReward(v.campaignId)}
                            disabled={busyId === v.campaignId}
                            style={{ ...smallActionBtn, color: "#60c060", border: "1px solid #2a5a2a" }}
                          >
                            {busyId === v.campaignId ? "Claiming..." : "Claim Reward"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: "#555" }}>Slash finalized — no reward (losing side penalized).</span>
                    )}
                  </div>
                )}

                {/* Withdraw button */}
                {signer && v.lockAmount > 0n && (
                  <button
                    onClick={() => handleWithdraw(v.campaignId)}
                    disabled={busyId === v.campaignId || !canWithdraw}
                    title={!canWithdraw ? `Locked for ${formatBlockDelta(blocksLeft)}` : ""}
                    style={{
                      padding: "6px 14px",
                      background: canWithdraw ? "#1a1a3a" : "#111",
                      border: `1px solid ${canWithdraw ? "#4a4a8a" : "#1a1a2e"}`,
                      borderRadius: 4,
                      color: canWithdraw ? "#a0a0ff" : "#444",
                      fontSize: 12,
                      cursor: canWithdraw ? "pointer" : "not-allowed",
                    }}
                  >
                    {busyId === v.campaignId ? "Withdrawing..." : "Withdraw Stake"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const smallActionBtn: React.CSSProperties = { padding: "4px 10px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, cursor: "pointer" };
