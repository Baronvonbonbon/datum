import { useToast, ToastLevel } from "../context/ToastContext";

const LEVEL_STYLES: Record<ToastLevel, { bg: string; border: string; color: string; icon: string }> = {
  error: { bg: "rgba(25,8,8,0.97)",  border: "#f87171", color: "#fca5a5", icon: "✕" },
  warn:  { bg: "rgba(24,18,4,0.97)", border: "#fbbf24", color: "#fde68a", icon: "!" },
  ok:    { bg: "rgba(4,20,10,0.97)", border: "#4ade80", color: "#86efac", icon: "✓" },
  info:  { bg: "rgba(12,12,20,0.97)",border: "rgba(255,255,255,0.25)", color: "rgba(255,255,255,0.85)", icon: "i" },
};

export function ToastContainer() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: 24,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 9999,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10,
      pointerEvents: "none",
      width: "min(480px, calc(100vw - 32px))",
    }}>
      {toasts.map((t) => {
        const s = LEVEL_STYLES[t.level];
        return (
          <div
            key={t.id}
            className={t.leaving ? "toast-leave" : "toast-enter"}
            style={{
              width: "100%",
              pointerEvents: "all",
              background: s.bg,
              border: `1px solid ${s.border}`,
              borderRadius: 8,
              boxShadow: `0 4px 24px rgba(0,0,0,0.7), 0 0 0 1px ${s.border}33`,
              padding: "12px 14px",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            {/* Icon */}
            <span style={{
              flexShrink: 0,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: s.border,
              color: "#000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 800,
              lineHeight: 1,
              marginTop: 1,
            }}>
              {s.icon}
            </span>

            {/* Message */}
            <span style={{
              flex: 1,
              color: s.color,
              fontSize: 13,
              lineHeight: 1.5,
              fontFamily: "var(--font-sans)",
              wordBreak: "break-word",
            }}>
              {t.message}
            </span>

            {/* Dismiss */}
            <button
              onClick={() => dismiss(t.id)}
              style={{
                flexShrink: 0,
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.3)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: "0 2px",
                marginTop: -1,
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
