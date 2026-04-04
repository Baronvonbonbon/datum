import { useState, useEffect } from "react";
import { TAG_DICTIONARY, TAG_LABELS } from "@shared/tagDictionary";
import { UserPreferences } from "@shared/types";

const TOPIC_TAGS = TAG_DICTIONARY.topic ?? [];

export function FiltersTab() {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_USER_PREFERENCES" }).then((resp) => {
      if (resp?.preferences) setPrefs(resp.preferences);
    });
  }, []);

  async function update(partial: Partial<UserPreferences>) {
    if (!prefs) return;
    const updated = { ...prefs, ...partial };
    setPrefs(updated);
    await chrome.runtime.sendMessage({ type: "UPDATE_USER_PREFERENCES", preferences: updated });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function toggleTopic(tag: string) {
    if (!prefs) return;
    if (prefs.filterMode === "all") {
      // In "all" mode: toggle drives blockedTags
      const blocked = prefs.blockedTags ?? [];
      update({
        blockedTags: blocked.includes(tag)
          ? blocked.filter((t) => t !== tag)
          : [...blocked, tag],
      });
    } else {
      // In "selected" mode: toggle drives allowedTopics
      const allowed = prefs.allowedTopics ?? [];
      update({
        allowedTopics: allowed.includes(tag)
          ? allowed.filter((t) => t !== tag)
          : [...allowed, tag],
      });
    }
  }

  if (!prefs) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>Loading...</div>;
  }

  const containerStyle: React.CSSProperties = { padding: 16 };
  const headingStyle: React.CSSProperties = { color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 };
  const mutedStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 11, marginBottom: 8 };

  return (
    <div style={containerStyle}>
      <div style={{ marginBottom: 14 }}>
        <div style={headingStyle}>Ad Topics</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
            <input
              type="radio"
              checked={prefs.filterMode !== "selected"}
              onChange={() => update({ filterMode: "all" })}
              style={{ accentColor: "var(--accent)" }}
            />
            <span style={{ color: "var(--text)" }}>Show all</span>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>(opt-out mode — uncheck topics to hide them)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
            <input
              type="radio"
              checked={prefs.filterMode === "selected"}
              onChange={() => update({ filterMode: "selected" })}
              style={{ accentColor: "var(--accent)" }}
            />
            <span style={{ color: "var(--text)" }}>Selected topics only</span>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>(opt-in mode — check topics to allow them)</span>
          </label>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {TOPIC_TAGS.map((tag) => {
            const label = TAG_LABELS[tag] ?? tag.replace("topic:", "");
            let active: boolean;
            if (prefs.filterMode === "selected") {
              active = (prefs.allowedTopics ?? []).includes(tag);
            } else {
              active = !(prefs.blockedTags ?? []).includes(tag);
            }
            return (
              <button
                key={tag}
                onClick={() => toggleTopic(tag)}
                style={{
                  background: active ? "rgba(160,160,255,0.12)" : "var(--bg-raised)",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${active ? "rgba(160,160,255,0.35)" : "var(--border)"}`,
                  borderRadius: "var(--radius-sm)",
                  padding: "3px 8px",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {active ? "✓ " : ""}{label}
              </button>
            );
          })}
        </div>
        {saved && <div style={{ color: "var(--ok)", fontSize: 10, marginTop: 4 }}>Saved</div>}
      </div>

      {prefs.blockedCampaigns.length > 0 && (
        <div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginBottom: 6 }}>
            <span style={headingStyle}>Silenced Campaigns</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {prefs.blockedCampaigns.map((id) => (
              <span
                key={id}
                style={{
                  background: "rgba(252,165,165,0.08)", color: "var(--error)", fontSize: 11,
                  padding: "2px 8px", borderRadius: "var(--radius-sm)",
                  border: "1px solid rgba(252,165,165,0.2)",
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}
              >
                #{id}
                <button
                  onClick={() => update({ blockedCampaigns: prefs.blockedCampaigns.filter((c) => c !== id) })}
                  style={{ background: "none", border: "none", color: "var(--error)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1, fontFamily: "inherit" }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {prefs.blockedCampaigns.length === 0 && (
        <div style={{ ...mutedStyle, fontStyle: "italic" }}>
          None silenced — campaigns you dismiss will appear here.
        </div>
      )}
    </div>
  );
}
