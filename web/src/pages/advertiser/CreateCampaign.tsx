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
    <div style={{ padding: 20, color: "#666" }}>Connect your wallet to create a campaign.</div>
  );

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 20 }}>
        <Link to="/advertiser" style={{ color: "#555", fontSize: 13, textDecoration: "none" }}>← My Campaigns</Link>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700, marginTop: 8 }}>Create Campaign</h1>
      </div>

      {txState === "success" && createdId !== null && (
        <div style={{ padding: 16, background: "#0a2a0a", border: "1px solid #2a5a2a", borderRadius: 6, marginBottom: 16 }}>
          <div style={{ color: "#60c060", fontWeight: 600, marginBottom: 8 }}>Campaign #{createdId} created!</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link to={`/advertiser/campaign/${createdId}/metadata`} style={{ padding: "6px 14px", background: "#1a1a3a", color: "#a0a0ff", border: "1px solid #4a4a8a", borderRadius: 4, fontSize: 13, textDecoration: "none" }}>
              Set Metadata (IPFS)
            </Link>
            <Link to="/advertiser" style={{ padding: "6px 14px", background: "#111", color: "#888", border: "1px solid #2a2a4a", borderRadius: 4, fontSize: 13, textDecoration: "none" }}>
              Back to Dashboard
            </Link>
          </div>
        </div>
      )}

      {txState !== "success" && (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Campaign type */}
          <div style={formGroup}>
            <label style={labelStyle}>Campaign Type</label>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => setIsOpen(true)} style={{ ...typeBtn, ...(isOpen ? typeBtnActive : {}) }}>
                Open (any publisher)
              </button>
              <button type="button" onClick={() => setIsOpen(false)} style={{ ...typeBtn, ...(!isOpen ? typeBtnActive : {}) }}>
                Targeted (specific publisher)
              </button>
            </div>
          </div>

          {/* Publisher address */}
          {!isOpen && (
            <div style={formGroup}>
              <label style={labelStyle}>Publisher Address</label>
              <input
                type="text"
                value={publisher}
                onChange={(e) => { setPublisher(e.target.value); checkPublisher(e.target.value); }}
                placeholder="0x..."
                style={inputStyle}
                required
              />
              {pubCheck && (
                <div style={{ fontSize: 12, marginTop: 4, color: pubCheck.startsWith("✓") ? "#60c060" : "#ff8080" }}>
                  {pubCheck}
                </div>
              )}
            </div>
          )}

          {/* Budget */}
          <div style={formGroup}>
            <label style={labelStyle}>Total Budget ({sym})</label>
            <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} min="0.0001" step="0.1" style={inputStyle} required />
            <div style={hintStyle}>This amount will be escrowed in the smart contract.</div>
          </div>

          {/* Daily cap */}
          <div style={formGroup}>
            <label style={labelStyle}>Daily Cap ({sym})</label>
            <input type="number" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} min="0.0001" step="0.01" style={inputStyle} required />
            <div style={hintStyle}>Maximum spend per 24h period (~14,400 blocks).</div>
          </div>

          {/* Bid CPM */}
          <div style={formGroup}>
            <label style={labelStyle}>Bid CPM ({sym} per 1,000 impressions)</label>
            <input type="number" value={bidCpm} onChange={(e) => setBidCpm(e.target.value)} min="0.000001" step="0.001" style={inputStyle} required />
            <div style={hintStyle}>Maximum CPM you'll pay. Actual cost is second-price (Vickrey auction).</div>
          </div>

          {/* Category */}
          <div style={formGroup}>
            <label style={labelStyle}>Category</label>
            <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))} style={{ ...inputStyle, cursor: "pointer" }}>
              {Array.from({ length: 26 }, (_, i) => i + 1).map((id) => (
                <option key={id} value={id}>{id}. {CATEGORY_NAMES[id]}</option>
              ))}
            </select>
          </div>

          <TransactionStatus state={txState} message={txMsg} />

          <button type="submit" disabled={txState === "pending" || !signer} style={submitBtn}>
            {txState === "pending" ? "Creating..." : `Create Campaign (${budget} ${sym})`}
          </button>
        </form>
      )}
    </div>
  );
}

const formGroup: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const labelStyle: React.CSSProperties = { color: "#888", fontSize: 13, fontWeight: 500 };
const inputStyle: React.CSSProperties = { padding: "8px 10px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#e0e0e0", fontSize: 13, outline: "none" };
const hintStyle: React.CSSProperties = { color: "#555", fontSize: 11 };
const typeBtn: React.CSSProperties = { padding: "8px 14px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#666", cursor: "pointer", fontSize: 13 };
const typeBtnActive: React.CSSProperties = { background: "#1a1a3a", border: "1px solid #4a4a8a", color: "#a0a0ff" };
const submitBtn: React.CSSProperties = { padding: "10px 20px", background: "#1a1a3a", border: "1px solid #4a4a8a", borderRadius: 6, color: "#a0a0ff", fontSize: 14, cursor: "pointer", fontWeight: 600 };
