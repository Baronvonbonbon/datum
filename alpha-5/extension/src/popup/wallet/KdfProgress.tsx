// KdfProgress — shown while the wallet runs its argon2id key-derivation
// (unlock / create / import). The KDF is intentionally slow (memory-hard, 64 MiB)
// so a stolen vault can't be brute-forced; this turns that unavoidable wait into
// visible, reassuring progress instead of a frozen button. argon2id here is
// pure-JS (@noble/hashes) and runs in the offscreen document, so the popup stays
// responsive and the timer/animation are smooth.
import { useEffect, useState } from "react";

export function KdfProgress({ label = "Deriving your encryption key" }: { label?: string }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setMs(Date.now() - t0), 100);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ marginTop: 10 }} aria-live="polite">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 13,
            height: 13,
            borderRadius: "50%",
            border: "2px solid var(--border)",
            borderTopColor: "var(--accent)",
            display: "inline-block",
            animation: "datum-spin 0.7s linear infinite",
            flex: "0 0 auto",
          }}
        />
        <span style={{ fontSize: 12.5, color: "var(--text-strong)", fontWeight: 500 }}>{label}…</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {(ms / 1000).toFixed(1)}s
        </span>
      </div>

      {/* indeterminate progress sweep */}
      <div
        style={{
          height: 3,
          borderRadius: 3,
          background: "var(--border)",
          marginTop: 9,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            height: "100%",
            width: "40%",
            background: "var(--accent)",
            borderRadius: 3,
            animation: "datum-kdf-sweep 1.15s ease-in-out infinite",
          }}
        />
      </div>

      <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 7, lineHeight: 1.45 }}>
        Stretching your password with a memory-hard function (argon2id) so a stolen
        vault can't be brute-forced. This is intentional and only takes a moment.
      </div>

      <style>{`
        @keyframes datum-spin { to { transform: rotate(360deg); } }
        @keyframes datum-kdf-sweep { 0% { left: -40%; } 100% { left: 100%; } }
      `}</style>
    </div>
  );
}
