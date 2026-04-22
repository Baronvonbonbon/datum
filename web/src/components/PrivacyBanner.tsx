import { useState, useEffect } from "react";

const STORAGE_KEY = "datumPrivacyAccepted";

export function PrivacyBanner() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true);
    }
  }, []);

  function handleAccept() {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: "var(--nano-surface, #1a1a1a)",
        borderTop: "1px solid var(--nano-border, #333)",
        padding: expanded ? "16px 24px" : "10px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxShadow: "0 -4px 24px rgba(0,0,0,0.4)",
        fontSize: 12,
        fontFamily: "var(--font-mono, monospace)",
        transition: "padding 0.2s",
      }}
    >
      {expanded && (
        <div
          style={{
            color: "var(--nano-text-muted, #888)",
            lineHeight: 1.7,
            maxWidth: 860,
          }}
        >
          <p style={{ color: "var(--nano-text, #eee)", fontWeight: 600, marginBottom: 6 }}>
            Datum Data &amp; Privacy Notice
          </p>

          <p style={{ marginBottom: 6 }}>
            <strong style={{ color: "var(--nano-text, #eee)" }}>Stays on your device:</strong>{" "}
            Your interest profile, ZK user secret, and private keys never leave your browser.
          </p>

          <p style={{ marginBottom: 6 }}>
            <strong style={{ color: "var(--nano-text, #eee)" }}>Sent when you submit claims:</strong>{" "}
            Your wallet address, claim hashes, nullifiers, and nonces are transmitted to the relay server and
            forwarded to the publisher's attestation endpoint for fraud verification.
          </p>

          <p style={{ marginBottom: 6 }}>
            <strong style={{ color: "var(--nano-text, #eee)" }}>Permanently on-chain (public):</strong>{" "}
            Your wallet address appears in every <code>ClaimSettled</code> event alongside payment amounts and
            campaign IDs. On-chain records are immutable and cannot be deleted. Campaign budgets, CPMs, and
            creative metadata are also publicly readable by anyone.
          </p>

          <p style={{ marginBottom: 6 }}>
            <strong style={{ color: "var(--nano-text, #eee)" }}>Your responsibility:</strong>{" "}
            You are solely responsible for ensuring your use of Datum complies with the laws and regulations
            of your jurisdiction, including any tax obligations arising from earnings. Datum is provided
            as-is with no warranties. No independent security audit has been performed on this alpha build.
          </p>

          <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
            Full policy: <code>PRIVACY-POLICY.md</code> in the Datum repository.
          </p>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ color: "var(--nano-text-muted, #888)", flex: 1, minWidth: 200 }}>
          Datum records your wallet address on-chain when claims settle. Continuing implies consent to our{" "}
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{
              background: "none",
              border: "none",
              color: "var(--nano-accent, #a0a0ff)",
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
              fontFamily: "inherit",
              textDecoration: "underline",
            }}
          >
            data &amp; privacy policy
          </button>
          . No guarantees. Compliance with your local laws is your responsibility.
        </span>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{
              background: "none",
              border: "1px solid var(--nano-border, #333)",
              borderRadius: 4,
              color: "var(--nano-text-muted, #888)",
              cursor: "pointer",
              padding: "5px 12px",
              fontSize: 11,
              fontFamily: "inherit",
            }}
          >
            {expanded ? "Collapse" : "Details"}
          </button>
          <button
            onClick={handleAccept}
            style={{
              background: "rgba(160,160,255,0.12)",
              border: "1px solid rgba(160,160,255,0.3)",
              borderRadius: 4,
              color: "var(--nano-accent, #a0a0ff)",
              cursor: "pointer",
              padding: "5px 14px",
              fontSize: 11,
              fontFamily: "inherit",
              fontWeight: 600,
            }}
          >
            Got it, I understand
          </button>
        </div>
      </div>
    </div>
  );
}
