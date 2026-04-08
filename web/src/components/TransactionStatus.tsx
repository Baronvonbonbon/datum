import { useEffect, useState } from "react";

interface Props {
  state: "idle" | "pending" | "success" | "error";
  message?: string;
  hash?: string;
  /** Auto-dismiss success after this many ms (0 = never). Default 4000. */
  autoDismiss?: number;
  onDismiss?: () => void;
}

const SPINNER_FRAMES = ["|", "/", "—", "\\"];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, display: "inline-block", width: "1ch", textAlign: "center" }}>
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

function BouncingText({ text }: { text: string }) {
  return (
    <span className="nano-bouncing-text">
      {text.split("").map((ch, i) => (
        <span
          key={i}
          className={ch === " " ? undefined : "nano-bounce-char"}
          style={ch === " " ? { display: "inline-block", width: "0.3em" } : { animationDelay: `${i * 0.05}s` }}
        >
          {ch === " " ? "\u00a0" : ch}
        </span>
      ))}
    </span>
  );
}

export function TransactionStatus({ state, message, hash, autoDismiss = 4000, onDismiss }: Props) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    if (state === "success" && autoDismiss > 0) {
      const t = setTimeout(() => {
        setVisible(false);
        onDismiss?.();
      }, autoDismiss);
      return () => clearTimeout(t);
    }
  }, [state, autoDismiss, onDismiss]);

  if (state === "idle" || !visible) return null;

  const modifierClass = state === "pending" ? "nano-info--warn" : state === "success" ? "nano-info--ok" : "nano-info--error";

  return (
    <div className={`nano-info ${modifierClass}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {state === "pending" ? (
        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <Spinner />
          <BouncingText text="Transaction pending" />
        </span>
      ) : state === "success" ? (
        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <span style={{ fontSize: 14 }}>✓</span>
          <span>{message ?? "Transaction confirmed."}</span>
        </span>
      ) : (
        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <span style={{ fontSize: 14 }}>✗</span>
          <span>{message ?? "Transaction failed."}</span>
        </span>
      )}
      {hash && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
          {hash.slice(0, 10)}...
        </span>
      )}
    </div>
  );
}
