import { useState } from "react";
import { formatEther, parseEther } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { AdminNav } from "../../components/AdminNav";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";

export function ChallengeBondsAdmin() {
  const contracts = useContracts();
  const { signer } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  // Campaign bond lookup
  const [lookupCampaign, setLookupCampaign] = useState("");
  const [bondInfo, setBondInfo] = useState<{
    owner: string; publisher: string; bond: bigint; claimed: boolean;
  } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // Publisher pool lookup
  const [lookupPublisher, setLookupPublisher] = useState("");
  const [poolInfo, setPoolInfo] = useState<{ totalBonds: bigint; bonusPool: bigint } | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);

  // Claim bonus
  const [claimCampaign, setClaimCampaign] = useState("");
  const [claimTxState, setClaimTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [claimTxMsg, setClaimTxMsg] = useState("");

  // Add to pool (manual, for testing)
  const [poolPublisher, setPoolPublisher] = useState("");
  const [poolAmount, setPoolAmount] = useState("");
  const [poolTxState, setPoolTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [poolTxMsg, setPoolTxMsg] = useState("");

  async function handleCampaignLookup() {
    if (!contracts.challengeBonds) return;
    setLookupLoading(true);
    setBondInfo(null);
    try {
      const id = BigInt(lookupCampaign);
      const [owner, publisher, bond, claimed] = await Promise.all([
        contracts.challengeBonds.bondOwner(id),
        contracts.challengeBonds.bondPublisher(id),
        contracts.challengeBonds.bond(id),
        contracts.challengeBonds.bonusClaimed(id),
      ]);
      setBondInfo({ owner, publisher, bond, claimed });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setLookupLoading(false);
    }
  }

  async function handlePublisherLookup() {
    if (!contracts.challengeBonds) return;
    setPoolLoading(true);
    setPoolInfo(null);
    try {
      const [totalBonds, bonusPool] = await Promise.all([
        contracts.challengeBonds.totalBonds(lookupPublisher),
        contracts.challengeBonds.bonusPool(lookupPublisher),
      ]);
      setPoolInfo({ totalBonds, bonusPool });
    } catch (err) {
      push({ message: humanizeError(err), type: "error" });
    } finally {
      setPoolLoading(false);
    }
  }

  async function handleClaimBonus() {
    if (!contracts.challengeBonds || !signer) return;
    setClaimTxState("pending");
    setClaimTxMsg("Claiming bonus…");
    try {
      const bonds = contracts.challengeBonds.connect(signer);
      const tx = await confirmTx(() => bonds.claimBonus(BigInt(claimCampaign)));
      if (!tx) { setClaimTxState("idle"); return; }
      await tx.wait();
      setClaimTxState("success");
      setClaimTxMsg("Bonus claimed.");
    } catch (err) {
      setClaimTxState("error");
      setClaimTxMsg(humanizeError(err));
    }
  }

  async function handleAddToPool() {
    if (!contracts.challengeBonds || !signer) return;
    setPoolTxState("pending");
    setPoolTxMsg("Adding to pool…");
    try {
      const bonds = contracts.challengeBonds.connect(signer);
      const tx = await confirmTx(() =>
        bonds.addToPool(poolPublisher, { value: parseEther(poolAmount) })
      );
      if (!tx) { setPoolTxState("idle"); return; }
      await tx.wait();
      setPoolTxState("success");
      setPoolTxMsg("Added to pool.");
    } catch (err) {
      setPoolTxState("error");
      setPoolTxMsg(humanizeError(err));
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <AdminNav />
      <h1 style={{ marginBottom: "0.25rem" }}>Challenge Bonds</h1>
      <p style={{ color: "#888", marginBottom: "2rem", fontSize: "0.85rem" }}>
        FP-2 — Advertiser challenge bonds. Locked at campaign creation, returned on clean end.
        Proportional bonus from slash pool when fraud upheld.
      </p>

      {/* Campaign bond lookup */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Campaign Bond Lookup</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input placeholder="Campaign ID" value={lookupCampaign} onChange={e => setLookupCampaign(e.target.value)} style={{ width: 140 }} />
          <button onClick={handleCampaignLookup} disabled={lookupLoading || !lookupCampaign}>
            {lookupLoading ? "Loading…" : "Fetch"}
          </button>
        </div>
        {bondInfo && (
          <div style={{ marginTop: "0.75rem", background: "var(--surface)", padding: "1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div><b>Advertiser:</b> {bondInfo.owner}</div>
            <div><b>Publisher:</b> {bondInfo.publisher}</div>
            <div><b>Bond:</b> {formatEther(bondInfo.bond)} DOT</div>
            <div><b>Bonus claimed:</b> {bondInfo.claimed ? "Yes" : "No"}</div>
          </div>
        )}
      </section>

      {/* Publisher pool lookup */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Publisher Pool Lookup</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input placeholder="Publisher address" value={lookupPublisher} onChange={e => setLookupPublisher(e.target.value)} style={{ flex: 1 }} />
          <button onClick={handlePublisherLookup} disabled={poolLoading || !lookupPublisher}>
            {poolLoading ? "Loading…" : "Fetch"}
          </button>
        </div>
        {poolInfo && (
          <div style={{ marginTop: "0.75rem", background: "var(--surface)", padding: "1rem", borderRadius: 8, fontSize: "0.85rem" }}>
            <div><b>Total challenge bonds against publisher:</b> {formatEther(poolInfo.totalBonds)} DOT</div>
            <div><b>Bonus pool (from slashes):</b> {formatEther(poolInfo.bonusPool)} DOT</div>
          </div>
        )}
      </section>

      {/* Claim bonus */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Claim Bonus</h2>
        <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          Advertiser claims proportional bonus from publisher slash pool after fraud upheld.
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input placeholder="Campaign ID" value={claimCampaign} onChange={e => setClaimCampaign(e.target.value)} style={{ width: 140 }} />
          <button onClick={handleClaimBonus} disabled={claimTxState === "pending" || !claimCampaign}>
            {claimTxState === "pending" ? "Claiming…" : "Claim Bonus"}
          </button>
        </div>
        <TransactionStatus state={claimTxState} message={claimTxMsg} />
      </section>

      {/* Add to pool */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Add to Bonus Pool (governance only)</h2>
        <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          Called automatically by PublisherGovernance on slash. Manual use for debugging.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <input placeholder="Publisher address" value={poolPublisher} onChange={e => setPoolPublisher(e.target.value)} />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input placeholder="Amount (DOT)" value={poolAmount} onChange={e => setPoolAmount(e.target.value)} style={{ width: 140 }} />
            <button onClick={handleAddToPool} disabled={poolTxState === "pending" || !poolPublisher}>
              {poolTxState === "pending" ? "Adding…" : "Add to Pool"}
            </button>
          </div>
        </div>
        <TransactionStatus state={poolTxState} message={poolTxMsg} />
      </section>
    </div>
  );
}
