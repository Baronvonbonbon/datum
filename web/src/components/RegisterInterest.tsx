// Prominent "register interest" email capture for the landing page. POSTs to
// /api/subscribe, which emails the signup to datum@javcon.io (manually managed
// list for now).
import { useState } from "react";

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export function RegisterInterest({ source = "landing" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email.trim())) { setError("Enter a valid email."); return; }
    setStatus("sending"); setError("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not register.");
      setStatus("sent"); setEmail("");
    } catch (err) {
      setStatus("error"); setError(err instanceof Error ? err.message : "Could not register.");
    }
  }

  return (
    <div
      className="nano-card nano-fade"
      style={{
        padding: "18px 20px", marginBottom: 22,
        borderColor: "var(--accent, rgba(110,231,183,0.35))",
        background: "linear-gradient(180deg, rgba(110,231,183,0.06), transparent)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <strong style={{ fontSize: 16 }}>Stay in the loop</strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>product updates &amp; early access — no spam</span>
      </div>
      {status === "sent" ? (
        <div style={{ fontSize: 14, color: "var(--text-strong)", padding: "6px 0" }}>
          ✅ Thanks — you're on the list. We'll be in touch.
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <input
            className="nano-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            style={{ flex: 1, minWidth: 220, fontSize: 14 }}
            aria-label="Email address"
          />
          <button className="nano-btn nano-btn-accent" disabled={status === "sending"} style={{ fontSize: 13, padding: "8px 16px", whiteSpace: "nowrap" }}>
            {status === "sending" ? "Registering…" : "Register interest →"}
          </button>
        </form>
      )}
      {error && <div style={{ color: "var(--danger, #e0564a)", fontSize: 12, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
