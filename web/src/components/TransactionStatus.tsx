import { useEffect, useState } from "react";

interface Props {
  state: "idle" | "pending" | "success" | "error";
  message?: string;
  hash?: string;
  /** Auto-dismiss success after this many ms (0 = never). Default 4000. */
  autoDismiss?: number;
  onDismiss?: () => void;
}

function BounceDots() {
  return (
    <span className="nano-pending-dots" style={{ marginLeft: 2 }}>
      <span>.</span><span>.</span><span>.</span>
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
        <span className="nano-pending-text" style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <span style={{ fontSize: 14 }}>⏳</span>
          <span>Transaction pending<BounceDots /></span>
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
