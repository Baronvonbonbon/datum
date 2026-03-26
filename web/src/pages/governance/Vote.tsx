import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { ConvictionSlider } from "../../components/ConvictionSlider";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { StatusBadge } from "../../components/StatusBadge";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CONVICTION_WEIGHTS } from "@shared/conviction";
import { parseDOT, formatDOT } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { humanizeError } from "@shared/errorCodes";

export function Vote() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const sym = getCurrencySymbol(settings.network);

  const [campaign, setCampaign] = useState<any>(null);
  const [gov, setGov] = useState<any>(null);
  const [myVote, setMyVote] = useState<any>(null);
  const [metadataHash, setMetadataHash] = useState("0x" + "0".repeat(64));
  const [loading, setLoading] = useState(true);

  const [isAye, setIsAye] = useState(true);
  const [amount, setAmount] = useState("0.1");
  const [conviction, setConviction] = useState(1);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { if (id) load(Number(id)); }, [id, address]);

  async function load(cid: number) {
    setLoading(true);
    try {
      const [c, adv, aye, nay, resolved, quorum] = await Promise.all([
        contracts.campaigns.getCampaignForSettlement(BigInt(cid)),
        contracts.campaigns.getCampaignAdvertiser(BigInt(cid)),
        contracts.governanceV2.ayeWeighted(BigInt(cid)).catch(() => 0n),
        contracts.governanceV2.nayWeighted(BigInt(cid)).catch(() => 0n),
        contracts.governanceV2.resolved(BigInt(cid)).catch(() => false),
        contracts.governanceV2.quorumWeighted().catch(() => 0n),
      ]);

      setCampaign({ id: cid, status: Number(c[0]), advertiser: adv, bidCpmPlanck: BigInt(c[2]) });
      setGov({ ayeWeighted: BigInt(aye), nayWeighted: BigInt(nay), resolved: Boolean(resolved), quorum: BigInt(quorum) });

      if (address) {
        try {
          const v = await contracts.governanceV2.getVote(BigInt(cid), address);
          const dir = Number(v.direction ?? v[0] ?? 0);
          if (dir > 0) setMyVote({ direction: dir, lockAmount: BigInt(v.lockAmount ?? v[1] ?? 0), conviction: Number(v.conviction ?? v[2] ?? 0) });
        } catch { /* no vote */ }
      }

      try {
        const filter = contracts.campaigns.filters.CampaignMetadataSet(BigInt(cid));
        const logs = await contracts.campaigns.queryFilter(filter);
        if (logs.length > 0) setMetadataHash((logs[logs.length - 1] as any).args?.metadataHash ?? "0x" + "0".repeat(64));
      } catch { /* no events */ }
    } finally {
      setLoading(false);
    }
  }

  async function handleVote(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setTxState("pending");
    try {
      const planck = parseDOT(amount);
      const c = contracts.governanceV2.connect(signer);
      const tx = await c.vote(BigInt(id!), isAye, conviction, { value: planck });
      await tx.wait();
      setTxState("success");
      setTxMsg(`Voted ${isAye ? "Aye" : "Nay"} with ${amount} ${sym} at conviction ${conviction}.`);
      load(Number(id));
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (loading) return <div style={{ color: "#555", padding: 20 }}>Loading campaign #{id}...</div>;
  if (!campaign) return <div style={{ color: "#555" }}>Campaign not found.</div>;

  const total = gov ? gov.ayeWeighted + gov.nayWeighted : 0n;
  const ayePct = total > 0n ? Number(gov!.ayeWeighted * 100n / total) : 0;
  const effectiveWeight = CONVICTION_WEIGHTS[conviction];
  const amountPlanck = (() => { try { return parseDOT(amount); } catch { return 0n; } })();

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← Governance</Link>

      <div style={{ margin: "12px 0 16px" }}>
        <span style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700 }}>Vote on Campaign #{id}</span>
        <StatusBadge status={campaign.status} style={{ marginLeft: 10 }} />
      </div>

      <IPFSPreview metadataHash={metadataHash} />

      {gov && (
        <div style={{ margin: "16px 0", padding: 12, background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#888", marginBottom: 4 }}>
            <span>Aye {ayePct}% · <DOTAmount planck={gov.ayeWeighted} /></span>
            <span>Nay {100 - ayePct}% · <DOTAmount planck={gov.nayWeighted} /></span>
          </div>
          <div style={{ background: "#1a1a1a", borderRadius: 3, height: 10, overflow: "hidden" }}>
            <div style={{ width: `${ayePct}%`, height: "100%", background: "#406040" }} />
          </div>
          <div style={{ color: "#555", fontSize: 11, marginTop: 6 }}>
            Quorum: <DOTAmount planck={gov.quorum} /> required
            {gov.resolved && <span style={{ color: "#60c060", marginLeft: 8 }}>✓ Resolved</span>}
          </div>
        </div>
      )}

      {myVote ? (
        <div style={{ padding: 12, background: "#0a1a0a", border: "1px solid #1a3a1a", borderRadius: 6, marginBottom: 16 }}>
          <div style={{ color: "#60c060", fontWeight: 600, marginBottom: 4 }}>
            You voted {myVote.direction === 1 ? "Aye" : "Nay"}
          </div>
          <div style={{ color: "#888", fontSize: 13 }}>
            <DOTAmount planck={myVote.lockAmount} /> · conviction {myVote.conviction} ({CONVICTION_WEIGHTS[myVote.conviction]}x weight)
          </div>
          <div style={{ marginTop: 8 }}>
            <Link to="/governance/my-votes" style={{ color: "#a0a0ff", fontSize: 12 }}>Manage your vote →</Link>
          </div>
        </div>
      ) : address ? (
        <form onSubmit={handleVote} style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setIsAye(true)} style={{ ...dirBtn, ...(isAye ? ayeActive : {}) }}>
              Aye (Support)
            </button>
            <button type="button" onClick={() => setIsAye(false)} style={{ ...dirBtn, ...(!isAye ? nayActive : {}) }}>
              Nay (Oppose)
            </button>
          </div>

          <div>
            <label style={labelStyle}>Stake Amount ({sym})</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="0.000001" step="0.01" style={inputStyle} required />
            {amountPlanck > 0n && (
              <div style={{ color: "#555", fontSize: 11, marginTop: 2 }}>
                Effective weight: {formatDOT(amountPlanck * BigInt(effectiveWeight))} {sym}
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>Conviction</label>
            <ConvictionSlider value={conviction} onChange={setConviction} amount={amountPlanck} />
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <button type="submit" disabled={txState === "pending" || !signer} style={submitBtn}>
            {txState === "pending" ? "Voting..." : `Vote ${isAye ? "Aye" : "Nay"} with ${amount} ${sym}`}
          </button>
        </form>
      ) : (
        <div style={{ color: "#666", padding: 12 }}>Connect your wallet to vote.</div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { color: "#888", fontSize: 13, display: "block", marginBottom: 6 };
const inputStyle: React.CSSProperties = { padding: "8px 10px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none", width: "100%" };
const dirBtn: React.CSSProperties = { flex: 1, padding: "10px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, cursor: "pointer", fontSize: 14, color: "#666" };
const ayeActive: React.CSSProperties = { background: "#0a2a0a", border: "1px solid #2a5a2a", color: "#60c060" };
const nayActive: React.CSSProperties = { background: "#2a0a0a", border: "1px solid #5a2a2a", color: "#ff8080" };
const submitBtn: React.CSSProperties = { padding: "10px 20px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 6, color: "#a0a0ff", fontSize: 14, cursor: "pointer", fontWeight: 600 };
