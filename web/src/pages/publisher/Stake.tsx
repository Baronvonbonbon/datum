import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { useBlock } from "../../hooks/useBlock";
import { DOTAmount } from "../../components/DOTAmount";
import { TransactionStatus } from "../../components/TransactionStatus";
import { RequirePublisher } from "../../components/RequirePublisher";
import { humanizeError } from "@shared/errorCodes";
import { parseDOTSafe } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { formatBlockDelta } from "@shared/conviction";

type TxState = "idle" | "pending" | "success" | "error";

export function PublisherStake() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const { blockNumber } = useBlock();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const sym = getCurrencySymbol(settings.network);

  const [staked, setStaked] = useState<bigint | null>(null);
  const [required, setRequired] = useState<bigint | null>(null);
  const [cumulative, setCumulative] = useState<bigint | null>(null);
  const [adequate, setAdequate] = useState<boolean | null>(null);
  const [pending, setPending] = useState<{ amount: bigint; availableBlock: bigint } | null>(null);
  const [params, setParams] = useState<{ base: bigint; perImp: bigint; delay: bigint } | null>(null);
  const [loading, setLoading] = useState(true);

  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [stakeTxState, setStakeTxState] = useState<TxState>("idle");
  const [stakeTxMsg, setStakeTxMsg] = useState("");
  const [unstakeTxState, setUnstakeTxState] = useState<TxState>("idle");
  const [unstakeTxMsg, setUnstakeTxMsg] = useState("");
  const [claimTxState, setClaimTxState] = useState<TxState>("idle");
  const [claimTxMsg, setClaimTxMsg] = useState("");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address || !contracts.publisherStake) return;
    setLoading(true);
    try {
      const [s, r, c, a, p, base, perImp, delay] = await Promise.all([
        contracts.publisherStake.staked(address),
        contracts.publisherStake.requiredStake(address),
        contracts.publisherStake.cumulativeImpressions(address),
        contracts.publisherStake.isAdequatelyStaked(address),
        contracts.publisherStake.pendingUnstake(address),
        contracts.publisherStake.baseStakePlanck(),
        contracts.publisherStake.planckPerImpression(),
        contracts.publisherStake.unstakeDelayBlocks(),
      ]);
      setStaked(BigInt(s));
      setRequired(BigInt(r));
      setCumulative(BigInt(c));
      setAdequate(Boolean(a));
      const amt = BigInt(p.amount ?? p[0] ?? 0);
      const blk = BigInt(p.availableBlock ?? p[1] ?? 0);
      setPending(amt > 0n ? { amount: amt, availableBlock: blk } : null);
      setParams({ base: BigInt(base), perImp: BigInt(perImp), delay: BigInt(delay) });
    } catch { /* contract not deployed */ }
    finally { setLoading(false); }
  }

  async function handleStake(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setStakeTxState("pending");
    setStakeTxMsg("");
    try {
      const planck = parseDOTSafe(stakeAmount);
      const c = contracts.publisherStake.connect(signer);
      const tx = await c.stake({ value: planck });
      await confirmTx(tx);
      setStakeTxState("success");
      setStakeTxMsg(`Staked ${stakeAmount} ${sym}.`);
      setStakeAmount("");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setStakeTxMsg(humanizeError(err));
      setStakeTxState("error");
    }
  }

  async function handleRequestUnstake(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setUnstakeTxState("pending");
    setUnstakeTxMsg("");
    try {
      const planck = parseDOTSafe(unstakeAmount);
      const c = contracts.publisherStake.connect(signer);
      const tx = await c.requestUnstake(planck);
      await confirmTx(tx);
      setUnstakeTxState("success");
      setUnstakeTxMsg(`Unstake request queued for ${unstakeAmount} ${sym}.`);
      setUnstakeAmount("");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setUnstakeTxMsg(humanizeError(err));
      setUnstakeTxState("error");
    }
  }

  async function handleClaim() {
    if (!signer) return;
    setClaimTxState("pending");
    setClaimTxMsg("");
    try {
      const c = contracts.publisherStake.connect(signer);
      const tx = await c.unstake();
      await confirmTx(tx);
      setClaimTxState("success");
      setClaimTxMsg("Unstake claimed.");
      load();
    } catch (err) {
      push(humanizeError(err), "error");
      setClaimTxMsg(humanizeError(err));
      setClaimTxState("error");
    }
  }

  const canClaim = pending && blockNumber ? BigInt(blockNumber) >= pending.availableBlock : false;
  const blocksRemaining = pending && blockNumber ? Math.max(0, Number(pending.availableBlock) - blockNumber) : null;
  const surplus = staked !== null && required !== null ? staked - required : null;
  const maxUnstake = surplus !== null && surplus > 0n ? surplus : 0n;

  if (!contracts.publisherStake) {
    return (
      <RequirePublisher>
        <div className="nano-fade" style={{ maxWidth: 520 }}>
          <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
          <div className="nano-info nano-info--warn" style={{ marginTop: 16 }}>Publisher staking contract not configured.</div>
        </div>
      </RequirePublisher>
    );
  }

  return (
    <RequirePublisher>
    <div className="nano-fade" style={{ maxWidth: 520 }}>
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0 4px" }}>Publisher Stake</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 20 }}>
        Stake {sym} to unlock settlement eligibility. Required stake grows with impression volume.
        Settlement rejects claims from under-staked publishers.
      </p>

      {loading ? (
        <div className="nano-pending-text" style={{ color: "var(--text-muted)" }}>Loading</div>
      ) : (
        <>
          {/* Status card */}
          <div className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Staked</div>
                <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text-strong)" }}>
                  {staked !== null ? <DOTAmount planck={staked} /> : "—"}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Required</div>
                <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text-strong)" }}>
                  {required !== null ? <DOTAmount planck={required} /> : "—"}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>Status</div>
                <div style={{ fontWeight: 700, fontSize: 16, color: adequate ? "var(--ok)" : "var(--error)" }}>
                  {adequate === null ? "—" : adequate ? "Eligible" : "Under-staked"}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)" }}>
              <span>Impressions settled: <strong style={{ color: "var(--text)" }}>{cumulative?.toLocaleString() ?? "—"}</strong></span>
              {surplus !== null && surplus > 0n && (
                <span>Withdrawable surplus: <strong style={{ color: "var(--ok)" }}><DOTAmount planck={surplus} /></strong></span>
              )}
            </div>
            {params && (
              <div style={{ marginTop: 8, padding: "6px 8px", background: "var(--bg-raised)", borderRadius: 4, fontSize: 11, color: "var(--text-muted)" }}>
                Base: <DOTAmount planck={params.base} /> + {params.perImp.toString()} planck/impression · Delay: {formatBlockDelta(Number(params.delay))}
              </div>
            )}
          </div>

          {/* Under-staked warning */}
          {adequate === false && (
            <div className="nano-info nano-info--error" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Settlement blocked (E15)</div>
              <div style={{ fontSize: 12 }}>
                Your stake is below the required minimum. Deposit at least{" "}
                <strong><DOTAmount planck={(required ?? 0n) - (staked ?? 0n)} /></strong> more to resume settlement.
              </div>
            </div>
          )}

          {/* Pending unstake */}
          {pending && (
            <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Pending unstake: <DOTAmount planck={pending.amount} />
              </div>
              <div style={{ fontSize: 12 }}>
                Available at block #{pending.availableBlock.toString()}
                {blocksRemaining !== null && blocksRemaining > 0 && (
                  <span> · {formatBlockDelta(blocksRemaining)} remaining</span>
                )}
              </div>
              {canClaim && (
                <>
                  <button
                    onClick={handleClaim}
                    disabled={claimTxState === "pending"}
                    className="nano-btn"
                    style={{ marginTop: 10, padding: "6px 14px", fontSize: 13, color: "var(--ok)", border: "1px solid rgba(74,222,128,0.3)" }}
                  >
                    {claimTxState === "pending" ? "Claiming..." : "Claim Unstake"}
                  </button>
                  <TransactionStatus state={claimTxState} message={claimTxMsg} />
                </>
              )}
            </div>
          )}

          {/* Stake form */}
          <div className="nano-card" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Deposit Stake</div>
            <form onSubmit={handleStake} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
                  Amount ({sym})
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="number"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    min="0.0001"
                    step="0.0001"
                    className="nano-input"
                    required
                    placeholder="e.g. 10"
                    style={{ flex: 1 }}
                  />
                  {required !== null && staked !== null && adequate === false && required > staked && (
                    <button
                      type="button"
                      onClick={() => setStakeAmount(ethers.formatEther(required - staked))}
                      className="nano-btn"
                      style={{ padding: "6px 12px", fontSize: 12, whiteSpace: "nowrap" }}
                      title="Fill the exact amount needed to reach the required stake"
                    >
                      Fill deficit
                    </button>
                  )}
                </div>
                {required !== null && staked !== null && adequate === false && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                    Minimum to become eligible: <DOTAmount planck={required - staked} />
                  </div>
                )}
              </div>
              <TransactionStatus state={stakeTxState} message={stakeTxMsg} />
              <button
                type="submit"
                disabled={stakeTxState === "pending" || !signer || !stakeAmount}
                className="nano-btn nano-btn-accent"
                style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600 }}
              >
                {stakeTxState === "pending" ? "Staking..." : `Stake ${stakeAmount || "..."} ${sym}`}
              </button>
            </form>
          </div>

          {/* Request unstake form */}
          {!pending && staked !== null && staked > 0n && (
            <div className="nano-card" style={{ padding: 16 }}>
              <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>Request Unstake</div>
              <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
                Only the surplus above your required stake can be withdrawn. Funds are locked for{" "}
                {params ? formatBlockDelta(Number(params.delay)) : "the delay period"} after requesting.
              </div>
              {maxUnstake === 0n ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>
                  No surplus available — your full stake is needed to meet the requirement.
                </div>
              ) : (
                <form onSubmit={handleRequestUnstake} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 4 }}>
                      Amount to unstake ({sym})
                    </label>
                    <input
                      type="number"
                      value={unstakeAmount}
                      onChange={(e) => setUnstakeAmount(e.target.value)}
                      min="0.0001"
                      step="0.0001"
                      className="nano-input"
                      required
                      placeholder={`max ${ethers.formatEther(maxUnstake)} ${sym}`}
                    />
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                      Max withdrawable: <DOTAmount planck={maxUnstake} />
                    </div>
                  </div>
                  <TransactionStatus state={unstakeTxState} message={unstakeTxMsg} />
                  <button
                    type="submit"
                    disabled={unstakeTxState === "pending" || !signer || !unstakeAmount}
                    className="nano-btn"
                    style={{ padding: "8px 16px", fontSize: 13, color: "var(--warn)", border: "1px solid rgba(248,178,0,0.3)" }}
                  >
                    {unstakeTxState === "pending" ? "Requesting..." : "Request Unstake"}
                  </button>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </div>
    </RequirePublisher>
  );
}
