import { CONVICTION_WEIGHTS, CONVICTION_LOCKUP_LABELS } from "@shared/conviction";

interface Props {
  value: number;
  onChange: (level: number) => void;
  amount?: bigint; // planck, for showing effective weight
}

export function ConvictionSlider({ value, onChange, amount }: Props) {
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
          {CONVICTION_WEIGHTS[value]}x
        </span>
      </div>
      <div style={{ color: "var(--text)", fontSize: 12, marginBottom: 8 }}>
        Lockup: <span style={{ color: "var(--accent)" }}>{CONVICTION_LOCKUP_LABELS[value]}</span>
        {amount !== undefined && amount > 0n && (
          <span style={{ marginLeft: 12, color: "var(--accent)" }}>
            Effective weight: {CONVICTION_WEIGHTS[value]}x
          </span>
        )}
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
              background: i === value ? "rgba(160,160,255,0.15)" : "var(--bg-raised)",
              color: i === value ? "var(--accent)" : "var(--text-muted)",
              border: i === value ? "1px solid rgba(160,160,255,0.3)" : "1px solid var(--border)",
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
