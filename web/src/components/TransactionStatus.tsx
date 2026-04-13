import { useEffect, useState } from "react";
import { useToast } from "../context/ToastContext";

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

export function BouncingText({ text }: { text: string }) {
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
  const { push } = useToast();
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

  // Fire toast on error
  useEffect(() => {
    if (state === "error" && message) {
      push(message, "error");
    }
  }, [state, message]);

  if (state === "idle" || !visible) return null;

  // Error state is handled entirely by the toast — don't render inline
  if (state === "error") return null;

  const modifierClass = state === "pending" ? "nano-info--warn" : "nano-info--ok";

  return (
    <div className={`nano-info ${modifierClass}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {state === "pending" ? (
        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <Spinner />
          <BouncingText text="Transaction pending" />
        </span>
      ) : (
        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <span style={{ fontSize: 14 }}>✓</span>
          <span>{message ?? "Transaction confirmed."}</span>
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
