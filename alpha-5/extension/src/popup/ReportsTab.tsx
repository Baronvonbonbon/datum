import { useState, useEffect } from "react";

const REASONS = [
  { value: 1, label: "Spam" },
  { value: 2, label: "Misleading" },
  { value: 3, label: "Inappropriate" },
  { value: 4, label: "Broken" },
  { value: 5, label: "Other" },
];

export function ReportsTab() {
  const [campaignId, setCampaignId] = useState("");
  const [reason, setReason] = useState(1);
  const [status, setStatus] = useState<"idle" | "pending" | "ok" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [activeCampaigns, setActiveCampaigns] = useState<{ id: string; title?: string }[]>([]);

  useEffect(() => {
    chrome.storage.local.get("activeCampaigns").then((s) => {
      const campaigns: any[] = s.activeCampaigns ?? [];
      setActiveCampaigns(campaigns.map((c) => ({ id: c.id, title: c.title })));
      if (campaigns.length > 0) setCampaignId(campaigns[0].id);
    });
  }, []);

  async function submit(type: "REPORT_PAGE" | "REPORT_AD") {
    if (!campaignId) { setMsg("Select a campaign first."); setStatus("error"); return; }
    setStatus("pending");
    setMsg(null);
    try {
      const resp = await chrome.runtime.sendMessage({ type, campaignId, reason });
      if (resp?.ok) {
        setStatus("ok");
        setMsg(type === "REPORT_PAGE" ? "Page reported." : "Ad reported.");
      } else {
        setStatus("error");
        setMsg(resp?.error ?? "Report failed.");
      }
    } catch (err) {
      setStatus("error");
      setMsg(String(err).slice(0, 100));
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  const containerStyle: React.CSSProperties = { padding: 16 };
  const headingStyle: React.CSSProperties = { color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 };
  const mutedStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 11, marginBottom: 10 };
  const selectStyle: React.CSSProperties = { width: "100%", padding: "6px 8px", fontSize: 12, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", marginBottom: 8, fontFamily: "inherit" };
  const btnStyle: React.CSSProperties = { padding: "7px 14px", fontSize: 12, cursor: status === "pending" ? "not-allowed" : "pointer", background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontFamily: "inherit", marginRight: 8 };
  const btnSecStyle: React.CSSProperties = { ...btnStyle, background: "var(--bg-card)", color: "var(--text)", border: "1px solid var(--border)" };

  return (
    <div style={containerStyle}>
      <div style={headingStyle}>Report Content</div>
      <div style={mutedStyle}>Submit a community report for the current page or ad to the protocol.</div>

      {activeCampaigns.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No active campaigns on this page.</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Campaign</div>
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={selectStyle}>
              {activeCampaigns.map((c) => (
                <option key={c.id} value={c.id}>#{c.id}{c.title ? ` — ${c.title}` : ""}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Reason</div>
            <select value={reason} onChange={(e) => setReason(Number(e.target.value))} style={selectStyle}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button onClick={() => submit("REPORT_PAGE")} disabled={status === "pending"} style={btnStyle}>
              Report Page
            </button>
            <button onClick={() => submit("REPORT_AD")} disabled={status === "pending"} style={btnSecStyle}>
              Report Ad
            </button>
          </div>
        </>
      )}

      {msg && (
        <div style={{ fontSize: 12, color: status === "ok" ? "var(--ok)" : status === "error" ? "var(--error)" : "var(--text-muted)" }}>
          {msg}
        </div>
      )}
    </div>
  );
}
