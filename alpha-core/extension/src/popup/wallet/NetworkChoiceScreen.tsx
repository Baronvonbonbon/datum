// One-time onboarding choice: how should the extension read the chain?
// Shown right after the wallet is created/imported, before the dashboard.
// Writes the user's pick into settings (usePine / rpcEnabled). Changeable later
// in Settings → Network.
import { useState } from "react";
import { BrandMark } from "../BrandMark";
import { setDataPath, type DataPath } from "./dataPath";
import { screen, heading, subText } from "./styles";

export function NetworkChoiceScreen({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState<DataPath | null>(null);

  async function pick(mode: DataPath) {
    setBusy(mode);
    try {
      await setDataPath(mode);
    } finally {
      onDone();
    }
  }

  const card = (mode: DataPath, title: string, tagline: string, points: string[]) => (
    <button
      onClick={() => pick(mode)}
      disabled={busy !== null}
      style={{
        textAlign: "left",
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 13px",
        cursor: busy ? "default" : "pointer",
        opacity: busy && busy !== mode ? 0.5 : 1,
        display: "block",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>{title}</span>
        {busy === mode && (
          <span
            style={{
              width: 11, height: 11, borderRadius: "50%",
              border: "2px solid var(--border)", borderTopColor: "var(--accent)",
              display: "inline-block", animation: "datum-spin 0.7s linear infinite",
            }}
          />
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{tagline}</div>
      <ul style={{ margin: "7px 0 0", paddingLeft: 16, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {points.map((p, i) => <li key={i}>{p}</li>)}
      </ul>
    </button>
  );

  return (
    <div style={screen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--text-muted)" }}><BrandMark size={18} /></span>
        <div style={{ ...heading, marginBottom: 0, fontSize: 16 }}>How should DATUM connect?</div>
      </div>
      <div style={subText}>You can change this anytime in Settings → Network.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
        {card(
          "pine",
          "Private — light client",
          "Validate the chain in your browser (Pine / smoldot).",
          ["No gateway ever sees your reads", "First sync takes ~10–30s, then it's cached", "Recommended for privacy"],
        )}
        {card(
          "rpc",
          "Fast — RPC gateway",
          "Read through a public gateway for instant results.",
          ["Campaigns + balances load immediately", "The gateway sees your query metadata", "Switch to the light client later in Settings"],
        )}
      </div>

      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.4 }}>
        Either way, transactions you sign are always broadcast via RPC — the light
        client can't broadcast.
      </div>

      <style>{`@keyframes datum-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
