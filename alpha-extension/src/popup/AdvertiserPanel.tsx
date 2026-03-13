import { useState, useEffect, useCallback } from "react";
import { parseUnits } from "ethers";
import { getCampaignsContract, getProvider } from "@shared/contracts";
import { formatDOT } from "@shared/dot";
import { cidToBytes32 } from "@shared/ipfs";
import { pinToIPFS } from "@shared/ipfsPin";
import { validateAndSanitize } from "@shared/contentSafety";
import { CampaignMetadata, CATEGORY_NAMES, CampaignStatus, buildCategoryHierarchy } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { getSigner } from "@shared/walletManager";
import { humanizeError } from "@shared/errorCodes";

interface Props {
  address: string | null;
}

interface MyCampaign {
  id: number;
  status: CampaignStatus;
  remainingBudget: bigint;
  bidCpmPlanck: bigint;
  publisher: string;
  snapshotTakeRateBps: number;
  metadata?: CampaignMetadata | null;
}

const STATUS_LABELS: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: "Pending", color: "#c0c060", bg: "#1a1a0a" },
  1: { label: "Active", color: "#60c060", bg: "#0a2a0a" },
  2: { label: "Paused", color: "#c09060", bg: "#1a1a0a" },
  3: { label: "Completed", color: "#60a0ff", bg: "#0a1a2a" },
  4: { label: "Terminated", color: "#ff8080", bg: "#2a0a0a" },
  5: { label: "Expired", color: "#888", bg: "#1a1a1a" },
};

export function AdvertiserPanel({ address }: Props) {
  const [campaigns, setCampaigns] = useState<MyCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [txResult, setTxResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ id: number; action: string } | null>(null);
  const [hideResolved, setHideResolved] = useState(true); // CL-1

  async function getSettings() {
    const stored = await chrome.storage.local.get("settings");
    return stored.settings ?? DEFAULT_SETTINGS;
  }

  const loadCampaigns = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const settings = await getSettings();
      const provider = getProvider(settings.rpcUrl);
      const contract = getCampaignsContract(settings.contractAddresses, provider);

      const nextId = Number(await contract.nextCampaignId());
      const mine: MyCampaign[] = [];

      for (let i = 0; i < nextId; i += 10) {
        const batch = Array.from({ length: Math.min(10, nextId - i) }, (_, j) => i + j);
        const results = await Promise.all(
          batch.map(async (id) => {
            try {
              const adv = await contract.getCampaignAdvertiser(BigInt(id));
              if (adv.toLowerCase() !== address.toLowerCase()) return null;
              // getCampaignForSettlement: (status, publisher, bidCpmPlanck, remainingBudget, snapshotTakeRateBps)
              const settlement = await contract.getCampaignForSettlement(BigInt(id));
              return {
                id,
                status: Number(settlement[0]) as CampaignStatus,
                remainingBudget: BigInt(settlement[3]),
                bidCpmPlanck: BigInt(settlement[2]),
                publisher: settlement[1] ?? "",
                snapshotTakeRateBps: Number(settlement[4]),
              } as MyCampaign;
            } catch {
              return null;
            }
          })
        );
        for (const r of results) if (r) mine.push(r);
      }

      // Load cached IPFS metadata for each campaign
      if (mine.length > 0) {
        const metaKeys = mine.map((c) => `metadata:${c.id}`);
        const stored = await chrome.storage.local.get(metaKeys);
        for (const c of mine) {
          const key = `metadata:${c.id}`;
          if (stored[key]) c.metadata = stored[key] as CampaignMetadata;
        }
      }

      setCampaigns(mine);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  async function doAction(id: number, action: string) {
    setActionBusy(true);
    setTxResult(null);
    setError(null);
    setConfirmAction(null);
    try {
      const settings = await getSettings();
      const signer = getSigner(settings.rpcUrl);
      const contract = getCampaignsContract(settings.contractAddresses, signer);

      let tx;
      switch (action) {
        case "pause":
          tx = await contract.togglePause(BigInt(id), true);
          break;
        case "resume":
          tx = await contract.togglePause(BigInt(id), false);
          break;
        case "complete":
          tx = await contract.completeCampaign(BigInt(id));
          break;
        case "expire":
          tx = await contract.expirePendingCampaign(BigInt(id));
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
      await tx.wait();
      setTxResult(`Campaign #${id}: ${action} successful.`);
      loadCampaigns();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setActionBusy(false);
    }
  }

  if (!address) {
    return <div style={emptyStyle}>Connect wallet to manage your campaigns.</div>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: "#a0a0ff", fontWeight: 600 }}>My Campaigns</span>
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 13 }}>Loading...</div>
      ) : campaigns.length === 0 ? (
        <div style={{ color: "#555", fontSize: 12, marginBottom: 12 }}>
          No campaigns found for your address.
        </div>
      ) : (
        <div style={{ marginBottom: 12, maxHeight: 320, overflowY: "auto" }}>
          {/* CL-1: Toggle for resolved campaigns */}
          {campaigns.some((c) => c.status >= CampaignStatus.Completed) && (
            <button
              onClick={() => setHideResolved(!hideResolved)}
              style={{ background: "none", border: "1px solid #2a2a4a", borderRadius: 3, color: "#888", fontSize: 10, padding: "2px 8px", cursor: "pointer", marginBottom: 6 }}
            >
              {hideResolved ? "Show" : "Hide"} resolved ({campaigns.filter((c) => c.status >= CampaignStatus.Completed).length})
            </button>
          )}
          {campaigns.filter((c) => !hideResolved || c.status < CampaignStatus.Completed).map((c) => {
            const s = STATUS_LABELS[c.status] ?? STATUS_LABELS[5];
            const meta = c.metadata;
            return (
              <div key={c.id} style={{ ...rowStyle, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ color: "#a0a0ff", fontWeight: 600, fontSize: 12 }}>
                    {meta?.title ? `${meta.title}` : `Campaign #${c.id}`}
                    <span style={{ color: "#666", fontWeight: 400, marginLeft: 4, fontSize: 10 }}>#{c.id}</span>
                  </span>
                  <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: s.bg, color: s.color }}>
                    {s.label}
                  </span>
                </div>
                {meta?.description && (
                  <div style={{ color: "#aaa", fontSize: 11, marginBottom: 3 }}>{meta.description}</div>
                )}
                <div style={{ color: "#888", fontSize: 11, marginBottom: 2 }}>
                  Budget: {formatDOT(c.remainingBudget)} DOT remaining
                </div>
                <div style={{ color: "#888", fontSize: 11, marginBottom: 2 }}>
                  Bid: {formatDOT(c.bidCpmPlanck)} DOT/1000 views
                </div>
                {/* Creative preview */}
                {meta?.creative && (
                  <div style={{ marginTop: 4, padding: 6, background: "#0a0a1a", borderRadius: 3, border: "1px solid #1a1a2e" }}>
                    <div style={{ color: "#666", fontSize: 9, marginBottom: 3 }}>CREATIVE PREVIEW</div>
                    {meta.creative.text && (
                      <div style={{ color: "#bbb", fontSize: 11, marginBottom: 3 }}>{meta.creative.text}</div>
                    )}
                    {meta.creative.ctaUrl && (
                      <div style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{
                          padding: "1px 6px", borderRadius: 2,
                          background: "#1a2a3a", color: "#60a0ff", fontSize: 10,
                        }}>{meta.creative.cta || "Learn More"}</span>
                        <span style={{ color: "#555", fontFamily: "monospace", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                          {meta.creative.ctaUrl}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {!meta && (
                  <div style={{ color: "#555", fontSize: 10, fontStyle: "italic", marginTop: 2 }}>
                    No metadata — pin creative to IPFS and set metadata on-chain
                  </div>
                )}

                {/* Actions based on status */}
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {c.status === CampaignStatus.Active && (
                    <>
                      <button onClick={() => setConfirmAction({ id: c.id, action: "pause" })}
                        disabled={actionBusy} style={actionBtn("#1a1a3a", "#c09060")}>
                        Pause
                      </button>
                      <button onClick={() => setConfirmAction({ id: c.id, action: "complete" })}
                        disabled={actionBusy} style={actionBtn("#1a0a0a", "#ff8080")}>
                        Complete
                      </button>
                    </>
                  )}
                  {c.status === CampaignStatus.Paused && (
                    <>
                      <button onClick={() => doAction(c.id, "resume")}
                        disabled={actionBusy} style={actionBtn("#0a1a0a", "#60c060")}>
                        Resume
                      </button>
                      <button onClick={() => setConfirmAction({ id: c.id, action: "complete" })}
                        disabled={actionBusy} style={actionBtn("#1a0a0a", "#ff8080")}>
                        Complete
                      </button>
                    </>
                  )}
                  {c.status === CampaignStatus.Pending && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <button onClick={() => doAction(c.id, "expire")}
                        disabled={actionBusy} style={actionBtn("#1a1a1a", "#888")}>
                        Expire
                      </button>
                      <span style={{ color: "#555", fontSize: 9 }}>
                        Available after ~7 day timeout, or vote active via Govern tab
                      </span>
                    </div>
                  )}
                </div>

                {/* Confirmation dialog */}
                {confirmAction?.id === c.id && (
                  <div style={{ marginTop: 6, padding: 8, background: "#2a1a0a", borderRadius: 4, border: "1px solid #4a2a0a" }}>
                    <div style={{ color: "#ff9040", fontSize: 11, marginBottom: 6 }}>
                      {confirmAction.action === "complete"
                        ? `Complete campaign? This will refund ${formatDOT(c.remainingBudget)} DOT and permanently end this campaign.`
                        : `Pause campaign #${c.id}?`}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => doAction(c.id, confirmAction.action)}
                        disabled={actionBusy}
                        style={{ ...actionBtn("#2a0a0a", "#ff8080"), flex: 1 }}
                      >
                        {actionBusy ? "..." : "Confirm"}
                      </button>
                      <button
                        onClick={() => setConfirmAction(null)}
                        style={{ ...actionBtn("#1a1a1a", "#888"), flex: 1 }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button onClick={loadCampaigns} disabled={loading} style={{ ...secondaryBtn, marginBottom: 16 }}>
        {loading ? "Loading..." : "Refresh"}
      </button>

      {/* Campaign creation form */}
      <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: 12 }}>
        <div style={{ color: "#a0a0ff", fontWeight: 600, marginBottom: 8 }}>Create Campaign</div>
        <CreateCampaignForm address={address} onCreated={loadCampaigns} />
      </div>

      {txResult && (
        <div style={{ marginTop: 8, padding: 10, background: "#0a2a0a", borderRadius: 6, fontSize: 13, color: "#60c060" }}>
          {txResult}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, color: "#ff8080", fontSize: 12 }}>{error}</div>
      )}
    </div>
  );
}

function CreateCampaignForm({ address, onCreated }: { address: string; onCreated: () => void }) {
  const [budget, setBudget] = useState("1");
  const [dailyCap, setDailyCap] = useState("0.1");
  const [bidCpm, setBidCpm] = useState("0.01");
  const [categoryId, setCategoryId] = useState(0);
  const [openCampaign, setOpenCampaign] = useState(false);
  const [publisherAddr, setPublisherAddr] = useState("");
  const [metadataCid, setMetadataCid] = useState("");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // H3: IPFS pinning fields — full creative
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [creativeText, setCreativeText] = useState("");
  const [creativeCta, setCreativeCta] = useState("");
  const [creativeCtaUrl, setCreativeCtaUrl] = useState("");
  const [pinning, setPinning] = useState(false);
  const [pinResult, setPinResult] = useState<string | null>(null);

  async function handlePin() {
    setPinning(true);
    setPinResult(null);
    try {
      const stored = await chrome.storage.local.get("settings");
      const settings = stored.settings ?? DEFAULT_SETTINGS;
      if (!settings.pinataApiKey) {
        setPinResult("No Pinata API key. Add it in Settings.");
        return;
      }
      const catName = CATEGORY_NAMES[categoryId] ?? "Uncategorized";
      const raw: CampaignMetadata = {
        title: metaTitle || "Untitled Campaign",
        description: metaDescription,
        category: catName,
        creative: {
          type: "text",
          text: creativeText,
          cta: creativeCta || "Learn More",
          ctaUrl: creativeCtaUrl,
        },
        version: 1,
      };

      // Pre-pin validation: schema, URL scheme, blocklist
      const validated = validateAndSanitize(raw);
      if (!validated) {
        setPinResult("Rejected: invalid fields, non-HTTPS URL, or blocked content");
        return;
      }

      const res = await pinToIPFS(settings.pinataApiKey, validated);
      if (res.ok && res.cid) {
        setMetadataCid(res.cid);
        setPinResult(`Pinned: ${res.cid.slice(0, 12)}...`);
      } else {
        setPinResult(res.error ?? "Pin failed");
      }
    } catch (err) {
      setPinResult(String(err).slice(0, 100));
    } finally {
      setPinning(false);
    }
  }

  async function create() {
    setCreating(true);
    setResult(null);
    setFormError(null);
    try {
      const stored = await chrome.storage.local.get("settings");
      const settings = stored.settings ?? DEFAULT_SETTINGS;

      const signer = getSigner(settings.rpcUrl);
      const campaigns = getCampaignsContract(settings.contractAddresses, signer);

      const budgetPlanck = parseUnits(budget, 10);
      const dailyCapPlanck = parseUnits(dailyCap, 10);
      const bidCpmPlanck = parseUnits(bidCpm, 10);

      const publisher = openCampaign
        ? "0x0000000000000000000000000000000000000000"
        : (publisherAddr.trim() || address); // default to self if no publisher specified
      const tx = await campaigns.createCampaign(
        publisher,
        dailyCapPlanck,
        bidCpmPlanck,
        categoryId,
        { value: budgetPlanck }
      );
      const receipt = await tx.wait();

      let campaignId: bigint | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = campaigns.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "CampaignCreated") campaignId = parsed.args.campaignId;
        } catch { /* log from different contract */ }
      }

      if (metadataCid.trim()) {
        if (campaignId === undefined) throw new Error("Could not parse campaign ID from receipt");
        const metadataHash = cidToBytes32(metadataCid.trim());
        const metaTx = await campaigns.setMetadata(campaignId, metadataHash);
        await metaTx.wait();
      }

      const idStr = campaignId !== undefined ? ` (ID: ${campaignId})` : "";
      setResult(`Campaign created${idStr}. Status: Pending.`);
      onCreated();
    } catch (err) {
      setFormError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Budget (DOT)</label>
        <input type="text" value={budget} onChange={(e) => setBudget(e.target.value)}
          style={formInput} placeholder="1.0" />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Daily Cap (DOT)</label>
        <input type="text" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)}
          style={formInput} placeholder="0.1" />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Bid CPM (DOT per 1000 impressions)</label>
        <input type="text" value={bidCpm} onChange={(e) => setBidCpm(e.target.value)}
          style={formInput} placeholder="0.01" />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={{ ...formLabel, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={openCampaign}
            onChange={(e) => setOpenCampaign(e.target.checked)}
            style={{ accentColor: "#a0a0ff" }}
          />
          <span>Open Campaign <span style={{ color: "#555", fontSize: 10 }}>(any matching publisher)</span></span>
        </label>
      </div>
      {!openCampaign && (
        <div style={{ marginBottom: 6 }}>
          <label style={formLabel}>Publisher Address</label>
          <input type="text" value={publisherAddr} onChange={(e) => setPublisherAddr(e.target.value)}
            style={{ ...formInput, fontFamily: "monospace", fontSize: 11 }}
            placeholder="0x... (leave empty to use your own address)" />
        </div>
      )}
      <div style={{ marginBottom: 6 }}>
        <label style={formLabel}>Category</label>
        <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}
          style={{ ...formInput, cursor: "pointer" }}>
          <option value={0}>Uncategorized</option>
          {buildCategoryHierarchy().map((group) => (
            <optgroup key={group.id} label={group.name}>
              <option value={group.id}>{group.name} (general)</option>
              {group.children.map((child) => (
                <option key={child.id} value={child.id}>{child.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {/* H3: Metadata + IPFS pinning — full creative */}
      <div style={{ marginBottom: 6, borderTop: "1px solid #1a1a2e", paddingTop: 6 }}>
        <label style={{ ...formLabel, color: "#a0a0ff", fontSize: 11 }}>Ad Creative (optional — pinned to IPFS)</label>
        <div style={{ marginBottom: 4 }}>
          <input type="text" value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)}
            style={formInput} placeholder="Campaign title" maxLength={128} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <input type="text" value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)}
            style={formInput} placeholder="Description" maxLength={256} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <input type="text" value={creativeText} onChange={(e) => setCreativeText(e.target.value)}
            style={formInput} placeholder="Ad body text (shown in ad slot)" maxLength={512} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <input type="text" value={creativeCta} onChange={(e) => setCreativeCta(e.target.value)}
            style={formInput} placeholder="CTA button label (e.g. Learn More)" maxLength={64} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <input type="text" value={creativeCtaUrl} onChange={(e) => setCreativeCtaUrl(e.target.value)}
            style={{ ...formInput, fontFamily: "monospace", fontSize: 11 }}
            placeholder="https://example.com (HTTPS only)" maxLength={2048} />
        </div>
        <button onClick={handlePin} disabled={pinning || !metaTitle.trim()}
          style={{ ...actionBtn("#0a1a2a", "#60a0ff"), marginBottom: 4, padding: "4px 10px", fontSize: 11 }}>
          {pinning ? "Pinning..." : "Pin to IPFS"}
        </button>
        {pinResult && (
          <div style={{ fontSize: 10, color: pinResult.startsWith("Pinned") ? "#60c060" : "#ff8080", marginBottom: 4 }}>
            {pinResult}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={formLabel}>Metadata CID (IPFS CIDv0)</label>
        <input type="text" value={metadataCid} onChange={(e) => setMetadataCid(e.target.value)}
          style={{ ...formInput, fontFamily: "monospace", fontSize: 11 }}
          placeholder="QmXyz... (auto-filled after pinning)" />
      </div>
      <button onClick={create} disabled={creating} style={primaryBtn}>
        {creating ? "Creating..." : "Create Campaign"}
      </button>
      {result && (
        <div style={{ marginTop: 6, color: "#60c060", fontSize: 12 }}>{result}</div>
      )}
      {formError && (
        <div style={{ marginTop: 6, color: "#ff8080", fontSize: 12 }}>{formError}</div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "#111122",
  borderRadius: 4,
  border: "1px solid #1a1a2e",
};

const primaryBtn: React.CSSProperties = {
  background: "#2a2a5a",
  color: "#a0a0ff",
  border: "1px solid #4a4a8a",
  borderRadius: 6,
  padding: "10px 16px",
  fontSize: 13,
  cursor: "pointer",
  width: "100%",
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#1a1a1a",
  color: "#666",
  border: "1px solid #333",
};

const actionBtn = (bg: string, color: string): React.CSSProperties => ({
  background: bg,
  color,
  border: `1px solid ${color}33`,
  borderRadius: 3,
  padding: "3px 8px",
  fontSize: 10,
  cursor: "pointer",
});

const formLabel: React.CSSProperties = {
  display: "block",
  color: "#888",
  fontSize: 11,
  marginBottom: 2,
};

const formInput: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  background: "#1a1a2e",
  border: "1px solid #2a2a4a",
  borderRadius: 4,
  color: "#e0e0e0",
  fontSize: 12,
  outline: "none",
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#666",
  fontSize: 13,
};
