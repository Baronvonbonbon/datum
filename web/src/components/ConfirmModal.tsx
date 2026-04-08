import { useEffect, useRef } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Lightweight confirm dialog with backdrop. Traps focus and closes on Escape. */
export function ConfirmModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: 24,
          maxWidth: 400, width: "90%",
        }}
      >
        <div style={{ color: "var(--text-strong)", fontWeight: 700, fontSize: 16, marginBottom: 10 }}>{title}</div>
        <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>{message}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onCancel} className="nano-btn" style={{ padding: "6px 14px", fontSize: 13 }}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="nano-btn"
            style={{
              padding: "6px 14px", fontSize: 13, fontWeight: 600,
              color: danger ? "var(--error)" : "var(--accent)",
              borderColor: danger ? "rgba(248,113,113,0.3)" : "rgba(255,255,255,0.25)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
