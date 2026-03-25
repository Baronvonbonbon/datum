interface Props {
  state: "idle" | "pending" | "success" | "error";
  message?: string;
  hash?: string;
}

export function TransactionStatus({ state, message, hash }: Props) {
  if (state === "idle") return null;

  const config = {
    pending: { bg: "#1a1a0a", border: "#4a4a0a", color: "#c0c060", icon: "⏳" },
    success: { bg: "#0a2a0a", border: "#2a5a2a", color: "#60c060", icon: "✓" },
    error:   { bg: "#2a0a0a", border: "#5a2a2a", color: "#ff8080", icon: "✗" },
  }[state];

  return (
    <div style={{
      padding: "8px 12px",
      background: config.bg,
      border: `1px solid ${config.border}`,
      borderRadius: 6,
      color: config.color,
      fontSize: 13,
      display: "flex",
      alignItems: "center",
      gap: 8,
    }}>
      <span>{config.icon}</span>
      <span style={{ flex: 1 }}>
        {state === "pending" && "Transaction pending..."}
        {state === "success" && (message ?? "Transaction confirmed.")}
        {state === "error" && (message ?? "Transaction failed.")}
      </span>
      {hash && (
        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#666" }}>
          {hash.slice(0, 10)}...
        </span>
      )}
    </div>
  );
}
