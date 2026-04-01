import { useState, useRef, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useSettings } from "../../context/SettingsContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { parseDOTSafe } from "@shared/dot";
import { getCurrencySymbol } from "@shared/networks";
import { humanizeError } from "@shared/errorCodes";
import { TAG_DICTIONARY, TAG_LABELS, tagHash, validateCustomTag, tagDisplayLabel } from "@shared/tagDictionary";
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
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [showTags, setShowTags] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [customTag, setCustomTag] = useState("");
  const [customTagError, setCustomTagError] = useState<string | null>(null);
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Pre-flight checks (debounced to avoid RPC flood on keystrokes)
  const [pubCheck, setPubCheck] = useState<string | null>(null);
  const [pubChecking, setPubChecking] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkPublisher = useCallback((addr: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!addr || !ethers.isAddress(addr)) { setPubCheck(null); setPubChecking(false); return; }
    setPubChecking(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const blocked = await contracts.publishers.isBlocked(addr);
        if (blocked) { setPubCheck("This address is blocked."); setPubChecking(false); return; }
        const data = await contracts.publishers.getPublisher(addr);
        if (!data.registered) { setPubCheck("Publisher not registered."); setPubChecking(false); return; }
        setPubCheck(`Registered · Take rate: ${(Number(data.takeRateBps) / 100).toFixed(0)}%`);
      } catch {
        setPubCheck("Could not verify publisher.");
      }
      setPubChecking(false);
    }, 400);
  }, [contracts]);

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
      const budgetPlanck = parseDOTSafe(budget);
      const dailyCapPlanck = parseDOTSafe(dailyCap);
      const bidCpmPlanck = parseDOTSafe(bidCpm);

      const tagHashes = [...selectedTags].map((t) => tagHash(t));
      const c = contracts.campaigns.connect(signer);
      // categoryId=0 (deprecated — targeting is tag-based now)
      const tx = await c.createCampaign(pubAddr, dailyCapPlanck, bidCpmPlanck, 0, tagHashes, {
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
      // Auto-navigate to metadata page after 3 seconds
      if (newId !== null) {
        setTimeout(() => navigate(`/advertiser/campaign/${newId}/metadata`), 3000);
      }
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
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Campaign #{createdId} created!</div>
          <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 10 }}>
            Your campaign is now Pending. Set metadata so governance voters can review your creative.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link to={`/advertiser/campaign/${createdId}/metadata`} className="nano-btn nano-btn-accent" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
              Set Metadata (IPFS) — Recommended
            </Link>
            <Link to="/advertiser" className="nano-btn" style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}>
              Dashboard
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
              {pubChecking && <div style={{ fontSize: 12, marginTop: 4, color: "var(--text-muted)" }}>Checking...</div>}
              {!pubChecking && pubCheck && (
                <div style={{ fontSize: 12, marginTop: 4, color: pubCheck.startsWith("Registered") ? "var(--ok)" : "var(--error)" }}>
                  {pubCheck}
                </div>
              )}
            </div>
          )}

          {/* Budget */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Total Budget ({sym})</label>
            <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>This amount will be escrowed in the smart contract.</div>
          </div>

          {/* Daily cap */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Daily Cap ({sym})</label>
            <input type="number" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Maximum spend per 24h period (~14,400 blocks).</div>
            {Number(dailyCap) > Number(budget) && (
              <div style={{ fontSize: 11, color: "var(--warn)" }}>Daily cap exceeds total budget — contract will reject this.</div>
            )}
          </div>

          {/* Bid CPM */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Bid CPM ({sym} per 1,000 impressions)</label>
            <input type="number" value={bidCpm} onChange={(e) => setBidCpm(e.target.value)} min="0.0001" step="0.0001" className="nano-input" required />
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Maximum CPM you'll pay. Actual cost is second-price (Vickrey auction).</div>
          </div>

          {/* Tag-based targeting */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Targeting Tags</label>
              <button type="button" onClick={() => setShowTags(!showTags)} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 12, cursor: "pointer", padding: 0 }}>
                {showTags ? "▼ Hide" : "▶ Configure"}
              </button>
              {selectedTags.size > 0 && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{selectedTags.size} tag{selectedTags.size !== 1 ? "s" : ""} selected</span>
              )}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Publishers must declare all selected tags to serve your ad. Leave empty for maximum reach.
            </div>
            {selectedTags.size > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                {[...selectedTags].map((tag) => (
                  <span key={tag} className="nano-badge" style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {tagDisplayLabel(tag)}
                    <button type="button" onClick={() => { const s = new Set(selectedTags); s.delete(tag); setSelectedTags(s); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}
            {showTags && (
              <div className="nano-card" style={{ padding: 10, marginTop: 4 }}>
                <input
                  type="text"
                  value={tagSearch}
                  onChange={(e) => setTagSearch(e.target.value)}
                  placeholder="Search tags..."
                  className="nano-input"
                  style={{ marginBottom: 8, fontSize: 12 }}
                />
                <div style={{ maxHeight: 200, overflow: "auto" }}>
                  {Object.entries(TAG_DICTIONARY).map(([dimension, tags]) => {
                    const filtered = tags.filter((t) => {
                      if (!tagSearch) return true;
                      const label = (TAG_LABELS[t] ?? t).toLowerCase();
                      return label.includes(tagSearch.toLowerCase()) || t.includes(tagSearch.toLowerCase());
                    });
                    if (filtered.length === 0) return null;
                    return (
                      <div key={dimension} style={{ marginBottom: 8 }}>
                        <div style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{dimension}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {filtered.map((tag) => {
                            const active = selectedTags.has(tag);
                            return (
                              <button key={tag} type="button" onClick={() => {
                                const s = new Set(selectedTags);
                                if (active) s.delete(tag); else if (s.size < 8) s.add(tag);
                                setSelectedTags(s);
                              }} className={active ? "nano-btn nano-btn-accent" : "nano-btn"} style={{ padding: "3px 8px", fontSize: 11 }}>
                                {TAG_LABELS[tag] ?? tag}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Custom tag input */}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input
                    type="text"
                    value={customTag}
                    onChange={(e) => { setCustomTag(e.target.value); setCustomTagError(null); }}
                    placeholder="Custom: dimension:value"
                    className="nano-input"
                    style={{ flex: 1, fontSize: 11 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const tag = validateCustomTag(customTag);
                      if (!tag) { setCustomTagError("Format: dimension:value"); return; }
                      if (selectedTags.size >= 8) { setCustomTagError("Max 8 tags"); return; }
                      const s = new Set(selectedTags);
                      s.add(tag);
                      setSelectedTags(s);
                      setCustomTag("");
                      setCustomTagError(null);
                    }}
                    className="nano-btn nano-btn-accent"
                    style={{ padding: "3px 8px", fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    + Add
                  </button>
                </div>
                {customTagError && <div style={{ color: "var(--error)", fontSize: 10, marginTop: 2 }}>{customTagError}</div>}
                <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 4 }}>
                  Max 8 tags. Publishers must declare all selected tags to serve your ad.
                </div>
              </div>
            )}
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
