interface Props {
  state: "idle" | "pending" | "success" | "error";
  message?: string;
  hash?: string;
}

export function TransactionStatus({ state, message, hash }: Props) {
  if (state === "idle") return null;

  const modifierClass = state === "pending" ? "nano-info--warn" : state === "success" ? "nano-info--ok" : "nano-info--error";
  const icon = state === "pending" ? "⏳" : state === "success" ? "✓" : "✗";

  return (
    <div className={`nano-info ${modifierClass}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span>{icon}</span>
      <span style={{ flex: 1 }}>
        {state === "pending" && "Transaction pending..."}
        {state === "success" && (message ?? "Transaction confirmed.")}
        {state === "error" && (message ?? "Transaction failed.")}
      </span>
      {hash && (
        <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
          {hash.slice(0, 10)}...
        </span>
      )}
    </div>
  );
}
