import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { getExplorerUrl } from "@shared/networks";
import { ConvictionSlider } from "../../components/ConvictionSlider";
import { DOTAmount } from "../../components/DOTAmount";
import { IPFSPreview } from "../../components/IPFSPreview";
import { StatusBadge } from "../../components/StatusBadge";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CONVICTION_WEIGHTS } from "@shared/conviction";
import { parseDOT, parseDOTSafe } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { humanizeError } from "@shared/errorCodes";
import { useTx } from "../../hooks/useTx";
import { queryFilterAll } from "@shared/eventQuery";
import { useToast } from "../../context/ToastContext";
import { tagLabel } from "@shared/tagDictionary";

export function Vote() {
  const { id } = useParams<{ id: string }>();
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const sym = getCurrencySymbol(settings.network);
  const EXPLORER = getExplorerUrl(settings.network);

  const [campaign, setCampaign] = useState<any>(null);
  const [gov, setGov] = useState<any>(null);
  const [myVote, setMyVote] = useState<any>(null);
  const [metadataHash, setMetadataHash] = useState("0x" + "0".repeat(64));
  const [tokenReward, setTokenReward] = useState<{ token: string; rewardPerImpression: bigint; remainingBudget: bigint; meta: { symbol: string; decimals: number } | null } | null>(null);
  const [requiredTags, setRequiredTags] = useState<string[]>([]);
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
      const [c, adv, aye, nay, resolved, quorum, viewBid] = await Promise.all([
        contracts.campaigns.getCampaignForSettlement(BigInt(cid)),
        contracts.campaigns.getCampaignAdvertiser(BigInt(cid)),
        contracts.governanceV2.ayeWeighted(BigInt(cid)).catch(() => 0n),
        contracts.governanceV2.nayWeighted(BigInt(cid)).catch(() => 0n),
        contracts.governanceV2.resolved(BigInt(cid)).catch(() => false),
        contracts.governanceV2.quorumWeighted().catch(() => 0n),
        contracts.campaigns.getCampaignViewBid(BigInt(cid)).catch(() => 0n),
      ]);

      setCampaign({ id: cid, status: Number(c[0]), advertiser: adv, bidCpmPlanck: BigInt(viewBid) });
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
        const logs = await queryFilterAll(contracts.campaigns, filter);
        if (logs.length > 0) setMetadataHash((logs[logs.length - 1] as any).args?.metadataHash ?? "0x" + "0".repeat(64));
      } catch { /* no events */ }

      // Required tags
      try {
        const rawTags: string[] = await contracts.campaigns.getCampaignTags(BigInt(cid));
        setRequiredTags(rawTags.map((h) => tagLabel(h) ?? h.slice(0, 10) + "..."));
      } catch { /* not deployed */ }

      // Token reward sidecar
      try {
        const [rewardTok, rewardPerImp] = await Promise.all([
          contracts.campaigns.getCampaignRewardToken(BigInt(cid)).catch(() => ethers.ZeroAddress),
          contracts.campaigns.getCampaignRewardPerImpression(BigInt(cid)).catch(() => 0n),
        ]);
        if (rewardTok && rewardTok !== ethers.ZeroAddress) {
          const erc20 = new ethers.Contract(rewardTok, [
            "function symbol() view returns (string)",
            "function decimals() view returns (uint8)",
          ], contracts.readProvider);
          const [sym2, dec] = await Promise.all([erc20.symbol().catch(() => "TOKEN"), erc20.decimals().catch(() => 18)]);
          let remainingBudget = 0n;
          try { remainingBudget = BigInt(await contracts.tokenRewardVault.campaignTokenBudget(rewardTok, BigInt(cid))); } catch { /* ok */ }
          setTokenReward({ token: rewardTok as string, rewardPerImpression: BigInt(rewardPerImp), remainingBudget, meta: { symbol: sym2 as string, decimals: Number(dec) } });
        }
      } catch { /* no token reward */ }
    } finally {
      setLoading(false);
    }
  }

  async function handleVote(e: React.FormEvent) {
    e.preventDefault();
    if (!signer) return;
    setTxState("pending");
    try {
      const planck = parseDOTSafe(amount);
      const c = contracts.governanceV2.connect(signer);
      const tx = await c.vote(BigInt(id!), isAye, conviction, { value: planck });
      await confirmTx(tx);
      setTxState("success");
      setTxMsg(`Voted ${isAye ? "Aye" : "Nay"} with ${amount} ${sym} at conviction ${conviction}.`);
      load(Number(id));
    } catch (err) {
      push(humanizeError(err), "error");
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (loading) return <div className="nano-pending-text" style={{ color: "var(--text-muted)", padding: 20 }}>Loading campaign #{id}</div>;
  if (!campaign) return <div style={{ color: "var(--text-muted)" }}>Campaign not found.</div>;

  const total = gov ? gov.ayeWeighted + gov.nayWeighted : 0n;
  const ayePct = total > 0n ? Number(gov!.ayeWeighted * 100n / total) : 0;
  const amountPlanck = (() => { try { return parseDOT(amount); } catch { return 0n; } })();

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to="/governance" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Governance</Link>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 16px" }}>
        <div>
          <span style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Vote on Campaign #{id}</span>
          <StatusBadge status={campaign.status} style={{ marginLeft: 10 }} />
        </div>
        <Link to={`/campaigns/${id}`} className="nano-btn" style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none" }}>Campaign Detail</Link>
      </div>

      <IPFSPreview metadataHash={metadataHash} />

      {/* Required Tags */}
      {requiredTags.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
          <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>Required publisher tags:</span>
          {requiredTags.map((tag, i) => (
            <span key={i} className="nano-badge" style={{ color: "var(--accent)" }}>{tag}</span>
          ))}
        </div>
      )}

      {/* Token Reward Sidecar — relevant for voters evaluating the campaign */}
      {tokenReward && tokenReward.meta && (
        <div className="nano-card" style={{ margin: "12px 0", padding: 12, borderLeft: "2px solid var(--role-advertiser)" }}>
          <div style={{ color: "var(--role-advertiser)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Token Rewards</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 6 }}>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 1 }}>Token</div>
              <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600 }}>{tokenReward.meta.symbol}</div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 1 }}>Per Impression</div>
              <div style={{ color: "var(--text-strong)", fontSize: 13, fontFamily: "var(--font-mono)" }}>
                {(Number(tokenReward.rewardPerImpression) / Math.pow(10, tokenReward.meta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {tokenReward.meta.symbol}
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 1 }}>Vault Budget</div>
              <div style={{ color: tokenReward.remainingBudget > 0n ? "var(--ok)" : "var(--text-muted)", fontSize: 13, fontFamily: "var(--font-mono)" }}>
                {(Number(tokenReward.remainingBudget) / Math.pow(10, tokenReward.meta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 3 })} {tokenReward.meta.symbol}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{tokenReward.token.slice(0, 10)}…{tokenReward.token.slice(-8)}</code>
            {EXPLORER && (
              <a href={`${EXPLORER}/address/${tokenReward.token}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 10, color: "var(--accent-dim)", textDecoration: "none" }}>
                Explorer ↗
              </a>
            )}
          </div>
        </div>
      )}

      {gov && (
        <div className="nano-card" style={{ margin: "16px 0", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
            <span style={{ color: "var(--ok)" }}>Aye {ayePct}% · <DOTAmount planck={gov.ayeWeighted} /></span>
            <span style={{ color: "var(--error)" }}>Nay {100 - ayePct}% · <DOTAmount planck={gov.nayWeighted} /></span>
          </div>
          <div style={{ position: "relative", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 3, height: 10, overflow: "hidden", display: "flex" }}>
            <div style={{ width: `${ayePct}%`, height: "100%", background: "rgba(74,222,128,0.35)" }} />
            <div style={{ width: `${100 - ayePct}%`, height: "100%", background: "rgba(248,113,113,0.35)" }} />
            <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "var(--text-muted)", opacity: 0.4 }} />
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
            <button type="button" onClick={() => setIsAye(true)} className="nano-btn" style={{ flex: 1, padding: "10px", fontSize: 14, color: isAye ? "var(--ok)" : undefined, border: isAye ? "1px solid rgba(74,222,128,0.3)" : undefined, background: isAye ? "rgba(74,222,128,0.08)" : undefined }}>
              Aye (Support)
            </button>
            <button type="button" onClick={() => setIsAye(false)} className="nano-btn" style={{ flex: 1, padding: "10px", fontSize: 14, color: !isAye ? "var(--error)" : undefined, border: !isAye ? "1px solid rgba(248,113,113,0.3)" : undefined, background: !isAye ? "rgba(248,113,113,0.08)" : undefined }}>
              Nay (Oppose)
            </button>
          </div>

          <div>
            <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 6 }}>Stake Amount ({sym})</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
          </div>

          <div>
            <label style={{ color: "var(--text)", fontSize: 13, display: "block", marginBottom: 6 }}>Conviction</label>
            <ConvictionSlider value={conviction} onChange={setConviction} amount={amountPlanck} symbol={sym} />
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
