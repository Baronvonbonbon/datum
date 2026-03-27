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

  if (loading) return <div style={{ color: "var(--text-muted)", padding: 20 }}>Loading campaign #{id}...</div>;
  if (!campaign) return <div style={{ color: "var(--text-muted)" }}>Campaign not found.</div>;

  const total = gov ? gov.ayeWeighted + gov.nayWeighted : 0n;
  const ayePct = total > 0n ? Number(gov!.ayeWeighted * 100n / total) : 0;
  const effectiveWeight = CONVICTION_WEIGHTS[conviction];
  const amountPlanck = (() => { try { return parseDOT(amount); } catch { return 0n; } })();

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>

      <div style={{ margin: "12px 0 16px" }}>
        <span style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Vote on Campaign #{id}</span>
        <StatusBadge status={campaign.status} style={{ marginLeft: 10 }} />
      </div>

      <IPFSPreview metadataHash={metadataHash} />

      {gov && (
        <div className="nano-card" style={{ margin: "16px 0", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
            <span>Aye {ayePct}% · <DOTAmount planck={gov.ayeWeighted} /></span>
            <span>Nay {100 - ayePct}% · <DOTAmount planck={gov.nayWeighted} /></span>
          </div>
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 3, height: 10, overflow: "hidden" }}>
            <div style={{ width: `${ayePct}%`, height: "100%", background: "var(--ok)", opacity: 0.5 }} />
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6 }}>
            Quorum: <DOTAmount planck={gov.quorum} /> required
            {gov.resolved && <span style={{ color: "var(--ok)", marginLeft: 8 }}>✓ Resolved</span>}
          </div>
        </div>
      )}

      {myVote ? (
        <div className="nano-info nano-info--ok" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            You voted {myVote.direction === 1 ? "Aye" : "Nay"}
          </div>
          <div style={{ fontSize: 13 }}>
            <DOTAmount planck={myVote.lockAmount} /> · conviction {myVote.conviction} ({CONVICTION_WEIGHTS[myVote.conviction]}x weight)
          </div>
          <div style={{ marginTop: 8 }}>
            <Link to="/governance/my-votes" style={{ color: "var(--accent)", fontSize: 12 }}>Manage your vote →</Link>
          </div>
        </div>
      ) : address ? (
        <form onSubmit={handleVote} style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setIsAye(true)} className="nano-btn" style={{ flex: 1, padding: "10px", fontSize: 14, color: isAye ? "var(--ok)" : undefined, border: isAye ? "1px solid rgba(110,231,183,0.3)" : undefined, background: isAye ? "rgba(110,231,183,0.08)" : undefined }}>
              Aye (Support)
            </button>
            <button type="button" onClick={() => setIsAye(false)} className="nano-btn" style={{ flex: 1, padding: "10px", fontSize: 14, color: !isAye ? "var(--error)" : undefined, border: !isAye ? "1px solid rgba(252,165,165,0.3)" : undefined, background: !isAye ? "rgba(252,165,165,0.08)" : undefined }}>
              Nay (Oppose)
            </button>
          </div>

          <div>
            <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 6 }}>Stake Amount ({sym})</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="0.000001" step="0.01" className="nano-input" required />
            {amountPlanck > 0n && (
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
                Effective weight: {formatDOT(amountPlanck * BigInt(effectiveWeight))} {sym}
              </div>
            )}
          </div>

          <div>
            <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 6 }}>Conviction</label>
            <ConvictionSlider value={conviction} onChange={setConviction} amount={amountPlanck} />
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <button type="submit" disabled={txState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600 }}>
            {txState === "pending" ? "Voting..." : `Vote ${isAye ? "Aye" : "Nay"} with ${amount} ${sym}`}
          </button>
        </form>
      ) : (
        <div style={{ color: "var(--text)", padding: 12 }}>Connect your wallet to vote.</div>
      )}
    </div>
  );
}
