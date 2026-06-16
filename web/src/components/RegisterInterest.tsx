// Prominent "register interest" email capture for the landing page. POSTs to
// /api/subscribe, which emails the signup to datum@javcon.io (manually managed
// list for now).
import { useState } from "react";

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

const ROLES = [
  { value: "publisher", label: "Publisher" },
  { value: "advertiser", label: "Advertiser" },
  { value: "user", label: "User (earn rewards)" },
  { value: "developer", label: "Developer" },
] as const;

export function RegisterInterest({ source = "landing" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const toggleRole = (value: string) =>
    setRoles((prev) => (prev.includes(value) ? prev.filter((r) => r !== value) : [...prev, value]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email.trim())) { setError("Enter a valid email."); return; }
    setStatus("sending"); setError("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source, roles }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not register.");
      setStatus("sent"); setEmail(""); setRoles([]);
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
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
          <fieldset style={{ border: "none", margin: 0, padding: 0, minInlineSize: "auto" }}>
            <legend style={{ fontSize: 12, color: "var(--text-muted)", padding: 0, marginBottom: 6 }}>
              I'm interested as <span style={{ opacity: 0.7 }}>(optional — select all that apply)</span>
            </legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {ROLES.map((r) => {
                const checked = roles.includes(r.value);
                return (
                  <label
                    key={r.value}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      fontSize: 13, cursor: "pointer", userSelect: "none",
                      padding: "5px 10px", borderRadius: 999,
                      border: `1px solid ${checked ? "var(--accent, rgba(110,231,183,0.55))" : "var(--border, rgba(255,255,255,0.14))"}`,
                      background: checked ? "rgba(110,231,183,0.10)" : "transparent",
                      color: checked ? "var(--text-strong)" : "var(--text-muted)",
                      transition: "background 0.15s, border-color 0.15s, color 0.15s",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRole(r.value)}
                      style={{ accentColor: "var(--accent, #6ee7b7)", margin: 0 }}
                    />
                    {r.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
          </div>
        </form>
      )}
      {error && <div style={{ color: "var(--danger, #e0564a)", fontSize: 12, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
