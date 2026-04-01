import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { TransactionStatus } from "../../components/TransactionStatus";
import { humanizeError } from "@shared/errorCodes";
import { TAG_DICTIONARY, TAG_LABELS, tagHash, tagLabel } from "@shared/tagDictionary";

export function Categories() {
  const contracts = useContracts();
  const { address, signer } = useWallet();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [tagSearch, setTagSearch] = useState("");
  const [txState, setTxState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [txMsg, setTxMsg] = useState("");

  useEffect(() => { if (address) load(); }, [address]);

  async function load() {
    if (!address) return;
    setLoading(true);
    try {
      if (contracts.targetingRegistry) {
        const hashes: string[] = await contracts.targetingRegistry.getTags(address);
        const tags = new Set<string>();
        for (const h of hashes) {
          const label = tagLabel(h);
          if (label) {
            // Find the tag string that produces this hash
            for (const dimension of Object.values(TAG_DICTIONARY)) {
              for (const t of dimension) {
                if (tagHash(t) === h.toLowerCase() || tagHash(t) === h) {
                  tags.add(t);
                  break;
                }
              }
            }
          }
        }
        setSelected(tags);
      }
    } catch { /* not registered or no targeting registry */ }
    setLoading(false);
  }

  function toggle(tag: string) {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else if (next.size < 32) next.add(tag);
    setSelected(next);
  }

  async function handleSave() {
    if (!signer || !contracts.targetingRegistry) return;
    setTxState("pending");
    try {
      const hashes = [...selected].map((t) => tagHash(t));
      const registry = contracts.targetingRegistry.connect(signer);
      const tx = await registry.setTags(hashes);
      await tx.wait();
      setTxState("success");
      setTxMsg(`Tags updated (${selected.size} selected).`);
      load();
    } catch (err) {
      setTxMsg(humanizeError(err));
      setTxState("error");
    }
  }

  return (
    <div className="nano-fade">
      <Link to="/publisher" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 16px" }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Publisher Tags</h1>
        <span style={{ color: "var(--text)", fontSize: 13 }}>{selected.size} / 32 selected</span>
      </div>
      <p style={{ color: "var(--text)", fontSize: 13, marginBottom: 16 }}>
        Select the tags that describe your site. Campaigns targeting these tags will be eligible to serve ads on your site.
      </p>

      {!contracts.targetingRegistry && (
        <div className="nano-info nano-info--warn" style={{ marginBottom: 16 }}>
          TargetingRegistry contract not configured. Check Settings.
        </div>
      )}

      {loading ? <div style={{ color: "var(--text-muted)" }}>Loading...</div> : (
        <>
          <input
            type="text"
            value={tagSearch}
            onChange={(e) => setTagSearch(e.target.value)}
            placeholder="Search tags..."
            className="nano-input"
            style={{ marginBottom: 12, fontSize: 12 }}
          />
          {Object.entries(TAG_DICTIONARY).map(([dimension, tags]) => {
            const filtered = tags.filter((t) => {
              if (!tagSearch) return true;
              const label = (TAG_LABELS[t] ?? t).toLowerCase();
              return label.includes(tagSearch.toLowerCase()) || t.includes(tagSearch.toLowerCase());
            });
            if (filtered.length === 0) return null;
            return (
              <div key={dimension} style={{ marginBottom: 12 }}>
                <div style={{ color: "var(--accent)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{dimension}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {filtered.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggle(tag)}
                      className={selected.has(tag) ? "nano-btn nano-btn-accent" : "nano-btn"}
                      style={{ padding: "5px 10px", fontSize: 12 }}
                    >
                      {TAG_LABELS[tag] ?? tag}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 16 }}>
            <TransactionStatus state={txState} message={txMsg} />
            <button onClick={handleSave} disabled={txState === "pending" || !signer || !contracts.targetingRegistry} className="nano-btn nano-btn-accent" style={{ marginTop: 12, padding: "8px 16px", fontSize: 13 }}>
              {txState === "pending" ? "Saving..." : "Save Tags"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
