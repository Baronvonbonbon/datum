import { useState } from "react";
import { CONVICTION_WEIGHTS, CONVICTION_LOCKUP_LABELS } from "@shared/conviction";
import { formatDOT } from "@shared/dot";

interface Props {
  value: number;
  onChange: (level: number) => void;
  amount?: bigint; // planck, for showing effective weight
  symbol?: string; // currency symbol (e.g. "PAS", "DOT")
}

export function ConvictionSlider({ value, onChange, amount, symbol }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  const weight = CONVICTION_WEIGHTS[value];
  const sym = symbol || "DOT";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <input
          type="range"
          min={0}
          max={8}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: "var(--accent)" }}
        />
        <span style={{ color: "var(--accent)", fontWeight: 700, minWidth: 32, textAlign: "right" }}>
          {weight}x
        </span>
        {/* UB-7: Conviction tooltip */}
        <span
          style={{ position: "relative", cursor: "help", fontSize: 12, color: "var(--text-muted)", userSelect: "none" }}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
        >
          ?
          {showTooltip && (
            <div style={{
              position: "absolute", right: 0, top: 20, zIndex: 10, width: 260,
              background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "10px 12px", fontSize: 11, color: "var(--text)", lineHeight: 1.5,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text-strong)" }}>Conviction Voting</div>
              Higher conviction multiplies your vote weight but locks your stake for longer.
              <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
                0x = no lockup (instant withdraw)<br />
                1x-2x = low risk (1-3 day lock)<br />
                3x-9x = moderate (7-90 days)<br />
                14x-21x = max influence (180-365 days)
              </div>
              <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
                If your side loses, a slash penalty applies on withdrawal.
              </div>
            </div>
          )}
        </span>
      </div>

      {/* UB-10: Conviction preview */}
      {amount !== undefined && amount > 0n && (
        <div style={{
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 4, padding: "8px 10px", marginBottom: 8, fontSize: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
            <span style={{ color: "var(--text)" }}>Stake</span>
            <span style={{ color: "var(--text-strong)", fontWeight: 600 }}>{formatDOT(amount)} {sym}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
            <span style={{ color: "var(--text)" }}>Conviction</span>
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>{weight}x</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
            <span style={{ color: "var(--text)" }}>Effective vote power</span>
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>{formatDOT(amount * BigInt(weight))} {sym}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text)" }}>Lock period</span>
            <span style={{ color: value === 0 ? "var(--ok)" : "var(--text-strong)", fontWeight: 500 }}>
              {CONVICTION_LOCKUP_LABELS[value]}
            </span>
          </div>
        </div>
      )}

      <div style={{ color: "var(--text)", fontSize: 12, marginBottom: 8 }}>
        Lockup: <span style={{ color: "var(--accent)" }}>{CONVICTION_LOCKUP_LABELS[value]}</span>
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(9, 1fr)",
        gap: 2,
        fontSize: 9,
        color: "var(--text-muted)",
      }}>
        {CONVICTION_WEIGHTS.map((w, i) => (
          <div
            key={i}
            onClick={() => onChange(i)}
            style={{
              textAlign: "center",
              padding: "3px 0",
              borderRadius: 2,
              cursor: "pointer",
              background: i === value ? "rgba(255,255,255,0.06)" : "var(--bg-raised)",
              color: i === value ? "var(--accent)" : "var(--text-muted)",
              border: i === value ? "1px solid rgba(255,255,255,0.18)" : "1px solid var(--border)",
            }}
          >
            <div style={{ fontWeight: 600 }}>{w}x</div>
            <div style={{ fontSize: 8 }}>{CONVICTION_LOCKUP_LABELS[i].replace("~", "").replace(" ", "")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
