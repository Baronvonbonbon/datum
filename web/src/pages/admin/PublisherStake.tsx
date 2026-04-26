import { useState } from "react";
import { formatEther, parseEther } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

export function PublisherStakeAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Lookup
  const [lookupAddr, setLookupAddr] = useState("");
  const [stakeInfo, setStakeInfo] = useState<{
    staked: bigint; cumulative: bigint; required: bigint; adequate: boolean;
    pendingAmount: bigint; pendingBlock: bigint;
  } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // Global params
  const [params, setParams] = useState({ base: "", perImp: "", delay: "" });
  const [paramsTxState, setParamsTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [paramsTxMsg, setParamsTxMsg] = useState("");

  // Slash
  const [slashAddr, setSlashAddr] = useState("");
  const [slashAmount, setSlashAmount] = useState("");
  const [slashRecipient, setSlashRecipient] = useState("");
  const [slashTxState, setSlashTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [slashTxMsg, setSlashTxMsg] = useState("");

  // Stake gate
  const [gateInfo, setGateInfo] = useState<{ contract: string; threshold: bigint } | null>(null);
  const [gateContract, setGateContract] = useState("");
  const [gateThreshold, setGateThreshold] = useState("");
  const [gateTxState, setGateTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [gateTxMsg, setGateTxMsg] = useState("");

  async function handleLookup() {
    if (!contracts.publisherStake) return;
    setLookupLoading(true);
    setStakeInfo(null);
    try {
      const [staked, cumulative, required, adequate, pending] = await Promise.all([
        contracts.publisherStake.staked(lookupAddr),
        contracts.publisherStake.cumulativeImpressions(lookupAddr),
        contracts.publisherStake.requiredStake(lookupAddr),
        contracts.publisherStake.isAdequatelyStaked(lookupAddr),
        contracts.publisherStake.pendingUnstake(lookupAddr),
      ]);
      setStakeInfo({
        staked, cumulative, required, adequate,
        pendingAmount: pending.amount ?? pending[0],
        pendingBlock: pending.releaseBlock ?? pending[1],
      });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setLookupLoading(false);
    }
  }

  async function loadParams() {
    if (!contracts.publisherStake) return;
    try {
      const [base, perImp, delay] = await Promise.all([
        contracts.publisherStake.baseStakePlanck(),
        contracts.publisherStake.planckPerImpression(),
        contracts.publisherStake.unstakeDelayBlocks(),
      ]);
      setParams({ base: base.toString(), perImp: perImp.toString(), delay: delay.toString() });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    }
  }

  async function handleSetParams() {
    if (!contracts.publisherStake || !signer) return;
    setParamsTxState("pending");
    setParamsTxMsg("Updating params…");
    try {
      const stake = contracts.publisherStake.connect(signer);
      const tx = await confirmTx(() =>
        stake.setParams(BigInt(params.base), BigInt(params.perImp), BigInt(params.delay))
      );
      if (!tx) { setParamsTxState("idle"); return; }
      await tx.wait();
      setParamsTxState("success");
      setParamsTxMsg("Params updated.");
    } catch (err) {
      setParamsTxState("error");
      setParamsTxMsg(humanizeError(err));
    }
  }

  async function loadGate() {
    if (!contracts.publishers) return;
    try {
      const [contractAddr, threshold] = await Promise.all([
        contracts.publishers.publisherStake(),
        contracts.publishers.stakeGate(),
      ]);
      setGateInfo({ contract: contractAddr, threshold });
      setGateContract(contractAddr);
      setGateThreshold(threshold.toString());
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    }
  }

  async function handleSetGate() {
    if (!contracts.publishers || !signer) return;
    setGateTxState("pending");
    setGateTxMsg("Setting stake gate…");
    try {
      const pub = contracts.publishers.connect(signer);
      const tx = await confirmTx(() =>
        pub.setStakeGate(gateContract, BigInt(gateThreshold || "0"))
      );
      if (!tx) { setGateTxState("idle"); return; }
      await tx.wait();
      setGateTxState("success");
      setGateTxMsg("Stake gate updated.");
      await loadGate();
    } catch (err) {
      setGateTxState("error");
      setGateTxMsg(humanizeError(err));
    }
  }

  async function handleSlash() {
    if (!contracts.publisherStake || !signer) return;
    setSlashTxState("pending");
    setSlashTxMsg("Slashing…");
    try {
      const stake = contracts.publisherStake.connect(signer);
      const tx = await confirmTx(() =>
        stake.slash(slashAddr, parseEther(slashAmount), slashRecipient)
      );
      if (!tx) { setSlashTxState("idle"); return; }
      await tx.wait();
      setSlashTxState("success");
      setSlashTxMsg("Slash executed.");
    } catch (err) {
      setSlashTxState("error");
      setSlashTxMsg(humanizeError(err));
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <AdminNav />
      <h1 style={{ marginBottom: "0.25rem" }}>Publisher Stake</h1>
      <p style={{ color: "#888", marginBottom: "2rem", fontSize: "0.85rem" }}>
        FP-1+FP-4 — Publisher bonding curve staking. requiredStake = base + cumulativeImpressions × perImp.
        Settlement rejects under-staked publishers.
      </p>

      {/* Lookup */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Publisher Lookup</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            placeholder="Publisher address (0x…)"
            value={lookupAddr}
            onChange={e => setLookupAddr(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={handleLookup} disabled={lookupLoading || !lookupAddr}>
            {lookupLoading ? "Loading…" : "Fetch"}
          </button>
        </div>
        {stakeInfo && (
          <div style={{ marginTop: "0.75rem", background: "var(--surface)", padding: "1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div>
              <b>Staked:</b> {formatEther(stakeInfo.staked)} DOT &nbsp;
              <b>Required:</b> {formatEther(stakeInfo.required)} DOT &nbsp;
              <span style={{ color: stakeInfo.adequate ? "var(--ok)" : "var(--error)", fontWeight: 700 }}>
                {stakeInfo.adequate ? "Adequately staked" : "UNDER-STAKED"}
              </span>
            </div>
            <div><b>Cumulative impressions:</b> {stakeInfo.cumulative.toLocaleString()}</div>
            {stakeInfo.pendingAmount > 0n && (
              <div><b>Pending unstake:</b> {formatEther(stakeInfo.pendingAmount)} DOT (release block {stakeInfo.pendingBlock.toString()})</div>
            )}
          </div>
        )}
      </section>

      {/* Params */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Staking Parameters (owner only)</h2>
        <button onClick={loadParams} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>Load current values</button>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.4rem" }}>
          <input placeholder="Base stake (planck)" value={params.base} onChange={e => setParams(p => ({ ...p, base: e.target.value }))} />
          <input placeholder="Per impression (planck)" value={params.perImp} onChange={e => setParams(p => ({ ...p, perImp: e.target.value }))} />
          <input placeholder="Unstake delay (blocks)" value={params.delay} onChange={e => setParams(p => ({ ...p, delay: e.target.value }))} />
        </div>
        <button onClick={handleSetParams} disabled={paramsTxState === "pending"} style={{ marginTop: "0.5rem" }}>
          {paramsTxState === "pending" ? "Updating…" : "setParams"}
        </button>
        <TransactionStatus state={paramsTxState} message={paramsTxMsg} />
      </section>

      {/* Registration Gate */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.25rem" }}>Registration Gate (owner only)</h2>
        <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          When whitelist mode is on, publishers who have staked at least <b>threshold</b> planck bypass the
          manual approval list and can register freely. Set threshold to 0 or contract to zero address to disable.
        </p>
        <button onClick={loadGate} style={{ marginBottom: "0.5rem", fontSize: "0.8rem" }}>Load current values</button>
        {gateInfo && (
          <div style={{ marginBottom: "0.5rem", background: "var(--surface)", padding: "0.75rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div><b>Stake contract:</b> {gateInfo.contract === "0x0000000000000000000000000000000000000000" ? "not set" : gateInfo.contract}</div>
            <div><b>Threshold:</b> {gateInfo.threshold === 0n ? "disabled (0)" : `${formatEther(gateInfo.threshold)} DOT`}</div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input
            placeholder="Stake contract address (0x… or zero to disable)"
            value={gateContract}
            onChange={e => setGateContract(e.target.value)}
          />
          <input
            placeholder="Threshold (planck, 0 = disabled)"
            value={gateThreshold}
            onChange={e => setGateThreshold(e.target.value)}
          />
          <button onClick={handleSetGate} disabled={gateTxState === "pending" || !gateContract}>
            {gateTxState === "pending" ? "Updating…" : "setStakeGate"}
          </button>
        </div>
        <TransactionStatus state={gateTxState} message={gateTxMsg} />
      </section>

      {/* Slash */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Manual Slash (slash contract only)</h2>
        <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          Only the registered slash contract (PublisherGovernance) can call this. Use for debugging only.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input placeholder="Publisher address" value={slashAddr} onChange={e => setSlashAddr(e.target.value)} />
          <input placeholder="Amount (DOT)" value={slashAmount} onChange={e => setSlashAmount(e.target.value)} />
          <input placeholder="Recipient address" value={slashRecipient} onChange={e => setSlashRecipient(e.target.value)} />
          <button onClick={handleSlash} disabled={slashTxState === "pending" || !slashAddr}
            style={{ background: "var(--error)" }}>
            {slashTxState === "pending" ? "Slashing…" : "Slash"}
          </button>
        </div>
        <TransactionStatus state={slashTxState} message={slashTxMsg} />
      </section>
    </div>
  );
}
