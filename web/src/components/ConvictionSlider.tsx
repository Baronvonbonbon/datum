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
          style={{ flex: 1, accentColor: "#a0a0ff" }}
        />
        <span style={{ color: "#a0a0ff", fontWeight: 700, minWidth: 32, textAlign: "right" }}>
          {CONVICTION_WEIGHTS[value]}x
        </span>
      </div>
      <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
        Lockup: <span style={{ color: "#c0c0ff" }}>{CONVICTION_LOCKUP_LABELS[value]}</span>
        {amount !== undefined && amount > 0n && (
          <span style={{ marginLeft: 12, color: "#a0a0ff" }}>
            Effective weight: {CONVICTION_WEIGHTS[value]}x
          </span>
        )}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(9, 1fr)",
        gap: 2,
        fontSize: 9,
        color: "#555",
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
              background: i === value ? "#2a2a5a" : "#111",
              color: i === value ? "#a0a0ff" : "#555",
              border: i === value ? "1px solid #4a4a8a" : "1px solid #222",
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
