import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { CATEGORY_NAMES } from "@shared/types";
import { parseDOT } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { humanizeError } from "@shared/errorCodes";
import { ethers } from "ethers";

export function CreateCampaign() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const sym = getCurrencySymbol(settings.network);

  const [isOpen, setIsOpen] = useState(true);
  const [publisher, setPublisher] = useState("");
  const [budget, setBudget] = useState("1");
  const [dailyCap, setDailyCap] = useState("0.1");
  const [bidCpm, setBidCpm] = useState("0.001");
  const [categoryId, setCategoryId] = useState(26);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Pre-flight checks
  const [pubCheck, setPubCheck] = useState<string | null>(null);

  async function checkPublisher(addr: string) {
    if (!addr || !ethers.isAddress(addr)) { setPubCheck(null); return; }
    try {
      const blocked = await contracts.publishers.isBlocked(addr);
      if (blocked) { setPubCheck("This address is blocked."); return; }
      const data = await contracts.publishers.getPublisher(addr);
      if (!data.registered) { setPubCheck("Publisher not registered."); return; }
      setPubCheck(`✓ Registered · Take rate: ${(Number(data.takeRateBps) / 100).toFixed(0)}%`);
    } catch {
      setPubCheck("Could not verify publisher.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signer || !address) return;

    const pubAddr = isOpen ? ethers.ZeroAddress : publisher.trim();
    if (!isOpen && !ethers.isAddress(pubAddr)) {
      setTxMsg("Invalid publisher address.");
      setTxState("error");
      return;
    }

    setTxState("pending");
    setTxMsg("");
    try {
      const budgetPlanck = parseDOT(budget);
      const dailyCapPlanck = parseDOT(dailyCap);
      const bidCpmPlanck = parseDOT(bidCpm);

      const c = contracts.campaigns.connect(signer);
      const tx = await c.createCampaign(pubAddr, dailyCapPlanck, bidCpmPlanck, categoryId, {
        value: budgetPlanck,
      });
      const receipt = await tx.wait();

      // Find campaign ID from CampaignCreated event
      let newId: number | null = null;
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = contracts.campaigns.interface.parseLog(log);
          if (parsed?.name === "CampaignCreated") {
            newId = Number(parsed.args.campaignId ?? parsed.args[0]);
            break;
          }
        } catch { /* skip */ }
      }

      setCreatedId(newId);
      setTxState("success");
      setTxMsg(`Campaign #${newId ?? "?"} created!`);
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  if (!address) return (
    <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to create a campaign.</div>
  );

  return (
    <div className="nano-fade" style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/advertiser" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← My Campaigns</Link>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, marginTop: 8 }}>Create Campaign</h1>
      </div>

      {txState === "success" && createdId !== null && (
        <div className="nano-info nano-info--ok" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Campaign #{createdId} created!</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link to={`/advertiser/campaign/${createdId}/metadata`} className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
              Set Metadata (IPFS)
            </Link>
            <Link to="/advertiser" className="nano-btn" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
              Back to Dashboard
            </Link>
          </div>
        </div>
      )}

      {txState !== "success" && (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Campaign type */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Campaign Type</label>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => setIsOpen(true)} className={isOpen ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "8px 14px", fontSize: 13 }}>
                Open (any publisher)
              </button>
              <button type="button" onClick={() => setIsOpen(false)} className={!isOpen ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "8px 14px", fontSize: 13 }}>
                Targeted (specific publisher)
              </button>
            </div>
          </div>

          {/* Publisher address */}
          {!isOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Publisher Address</label>
              <input
                type="text"
                value={publisher}
                onChange={(e) => { setPublisher(e.target.value); checkPublisher(e.target.value); }}
                placeholder="0x..."
                className="nano-input"
                required
              />
              {pubCheck && (
                <div style={{ fontSize: 12, marginTop: 4, color: pubCheck.startsWith("✓") ? "var(--ok)" : "var(--error)" }}>
                  {pubCheck}
                </div>
              )}
            </div>
          )}

          {/* Budget */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Total Budget ({sym})</label>
            <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} min="0.0001" step="0.1" className="nano-input" required />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>This amount will be escrowed in the smart contract.</div>
          </div>

          {/* Daily cap */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Daily Cap ({sym})</label>
            <input type="number" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} min="0.0001" step="0.01" className="nano-input" required />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Maximum spend per 24h period (~14,400 blocks).</div>
          </div>

          {/* Bid CPM */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Bid CPM ({sym} per 1,000 impressions)</label>
            <input type="number" value={bidCpm} onChange={(e) => setBidCpm(e.target.value)} min="0.000001" step="0.001" className="nano-input" required />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Maximum CPM you'll pay. Actual cost is second-price (Vickrey auction).</div>
          </div>

          {/* Category */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Category</label>
            <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))} className="nano-select" style={{ cursor: "pointer" }}>
              {Array.from({ length: 26 }, (_, i) => i + 1).map((id) => (
                <option key={id} value={id}>{id}. {CATEGORY_NAMES[id]}</option>
              ))}
            </select>
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <button type="submit" disabled={txState === "pending" || !signer} className="nano-btn nano-btn-accent" style={{ padding: "10px 20px", fontSize: 14, fontWeight: 600 }}>
            {txState === "pending" ? "Creating..." : `Create Campaign (${budget} ${sym})`}
          </button>
        </form>
      )}
    </div>
  );
}
