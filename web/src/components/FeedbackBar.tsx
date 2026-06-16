// Site-wide feedback bar. Sits fixed at the bottom and auto-hides while the
// user scrolls through the middle of a page, reappearing when they reach the
// very top or very bottom of the scroll area (or whenever the form is open).
// Three intents — Question / Compliment / Complaint — POST to /api/feedback,
// which emails datum@javcon.io. Questions require a return email; the others
// may be anonymous. The current screen is sent along as context.
import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

type FeedbackType = "question" | "compliment" | "complaint";

const TYPES: { key: FeedbackType; label: string; emoji: string; placeholder: string }[] = [
  { key: "question", label: "Question", emoji: "❓", placeholder: "What would you like to know?" },
  { key: "compliment", label: "Compliment", emoji: "💚", placeholder: "What do you like?" },
  { key: "complaint", label: "Complaint", emoji: "⚠️", placeholder: "What went wrong?" },
];

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export function FeedbackBar() {
  const location = useLocation();
  const [visible, setVisible] = useState(true);
  const [type, setType] = useState<FeedbackType | null>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  // Keep the latest "form open" flag readable inside the scroll handler without
  // re-subscribing the listener on every keystroke.
  const openRef = useRef(false);
  openRef.current = type !== null;

  useEffect(() => {
    const scroller = document.getElementById("app-scroll");
    const target: HTMLElement | Window = scroller ?? window;
    const compute = () => {
      if (openRef.current) { setVisible(true); return; }
      const el = (scroller ?? document.scrollingElement ?? document.documentElement) as HTMLElement;
      const atTop = el.scrollTop <= 8;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      setVisible(atTop || atBottom);
    };
    compute();
    target.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      target.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, []);

  // Collapse + reset when the user navigates to another screen.
  useEffect(() => { setType(null); setStatus("idle"); setError(""); }, [location.pathname]);

  const requiresEmail = type === "question";

  async function submit() {
    if (!message.trim()) { setError("Please enter a message."); return; }
    if (requiresEmail && !isEmail(email.trim())) { setError("A return email is required for questions."); return; }
    if (email.trim() && !isEmail(email.trim())) { setError("That email doesn't look valid."); return; }
    setStatus("sending"); setError("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type, message: message.trim(), email: email.trim(),
          screen: location.pathname, title: document.title, url: window.location.href,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not send.");
      setStatus("sent"); setMessage(""); setEmail("");
      setTimeout(() => { setType(null); setStatus("idle"); }, 2200);
    } catch (e) {
      setStatus("error"); setError(e instanceof Error ? e.message : "Could not send.");
    }
  }

  return (
    <div
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 60,
        display: "flex", justifyContent: "center", padding: "0 12px 12px",
        pointerEvents: "none",
        transform: visible ? "translateY(0)" : "translateY(140%)",
        transition: "transform 220ms ease",
      }}
    >
      <div
        className="nano-card"
        style={{
          pointerEvents: "auto", width: "100%", maxWidth: 520,
          padding: type ? "14px 16px" : "8px 12px",
          boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
        }}
      >
        {type === null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 2 }}>💬 Got feedback?</span>
            {TYPES.map((t) => (
              <button
                key={t.key}
                className="nano-btn"
                style={{ fontSize: 12, padding: "5px 11px" }}
                onClick={() => { setType(t.key); setStatus("idle"); setError(""); }}
              >
                {t.emoji} {t.label}
              </button>
            ))}
          </div>
        ) : status === "sent" ? (
          <div style={{ textAlign: "center", fontSize: 13, color: "var(--text-strong)", padding: "6px 0" }}>
            ✅ Thanks — your {TYPES.find((t) => t.key === type)?.label.toLowerCase()} was sent!
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>{TYPES.find((t) => t.key === type)?.label}</strong>
              <button className="nano-btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setType(null)} aria-label="Close feedback">✕</button>
            </div>
            <textarea
              className="nano-input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder={TYPES.find((t) => t.key === type)?.placeholder}
              style={{ width: "100%", resize: "vertical", fontSize: 13 }}
            />
            <input
              className="nano-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={requiresEmail ? "Your email (required so we can reply)" : "Your email (optional)"}
              style={{ width: "100%", marginTop: 8, fontSize: 13 }}
            />
            {error && <div style={{ color: "var(--danger, #e0564a)", fontSize: 12, marginTop: 6 }}>{error}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              <span style={{ flex: 1, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                about <code>{location.pathname}</code>
              </span>
              <button
                className="nano-btn nano-btn-primary"
                disabled={status === "sending"}
                onClick={submit}
                style={{ fontSize: 12, padding: "5px 14px" }}
              >
                {status === "sending" ? "Sending…" : "Send →"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
