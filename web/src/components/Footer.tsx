export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer style={{
      borderTop: "1px solid var(--border)",
      background: "var(--bg)",
      padding: "20px 32px 28px",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
    }}>

      {/* ── Main row ────────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "16px 40px",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: 16,
      }}>

        {/* Left — brand + company */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ color: "var(--text-strong)", fontWeight: 700, letterSpacing: "0.08em", fontSize: 13 }}>
            DATUM
          </span>
          <span style={{ color: "var(--text-muted)" }}>
            &copy; {year}{" "}
            <a
              href="https://javcon.io"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--text-muted)" }}
            >
              JAVCoN, LLC
            </a>
            . All rights reserved.
          </span>
          <a
            href="mailto:datum@javcon.io"
            style={{ color: "var(--text-muted)" }}
          >
            datum@javcon.io
          </a>
        </div>

        {/* Center — Powered by Polkadot */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          alignSelf: "center",
        }}>
          <span style={{ color: "var(--text-muted)" }}>Powered by</span>
          <a
            href="https://polkadot.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "#E6007A",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textDecoration: "none",
            }}
          >
            {/* Polkadot dot mark */}
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="9" cy="3.6" r="2.1" fill="#E6007A" />
              <circle cx="9" cy="14.4" r="2.1" fill="#E6007A" />
              <circle cx="3.6" cy="9" r="2.1" fill="#E6007A" />
              <circle cx="14.4" cy="9" r="2.1" fill="#E6007A" />
              <circle cx="5.05" cy="5.05" r="1.8" fill="#E6007A" opacity="0.6" />
              <circle cx="12.95" cy="5.05" r="1.8" fill="#E6007A" opacity="0.6" />
              <circle cx="5.05" cy="12.95" r="1.8" fill="#E6007A" opacity="0.6" />
              <circle cx="12.95" cy="12.95" r="1.8" fill="#E6007A" opacity="0.6" />
            </svg>
            Polkadot
          </a>
        </div>

        {/* Right — links */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, textAlign: "right" }}>
          <a
            href="https://github.com/Baronvonbonbon/datum"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-muted)" }}
          >
            Source / GitHub
          </a>
          <a href="/how-it-works" style={{ color: "var(--text-muted)" }}>How It Works</a>
          <a
            href="https://github.com/Baronvonbonbon/datum/blob/main/PRIVACY-POLICY.md"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-muted)" }}
          >
            Privacy Policy
          </a>
        </div>
      </div>

      {/* ── Disclaimer ──────────────────────────────────────────────── */}
      <div style={{
        borderTop: "1px solid var(--border)",
        paddingTop: 14,
        color: "var(--text-muted)",
        lineHeight: 1.7,
        opacity: 0.7,
      }}>
        <span style={{ color: "rgba(255,255,255,0.18)", fontWeight: 700, letterSpacing: "0.06em", marginRight: 6 }}>
          ⚠ DISCLAIMER:
        </span>
        This software is provided <em>as-is</em>, without warranty of any kind, expressed, implied, stated,
        unstated, whispered into the void, or otherwise conjured from the legal ether — including but not
        limited to merchantability, fitness for any particular purpose, or the assumption that any of this
        will work the way you expect it to.{" "}
        JAVCoN, LLC and the Datum Protocol contributors assume <strong style={{ color: "rgba(255,255,255,0.35)" }}>zero liability</strong>{" "}
        for any loss, damage, missed airdrop, regulatory headache, or existential crisis arising from your
        use of this software.{" "}
        Continuing to use Datum constitutes your acceptance of the{" "}
        <a
          href="https://github.com/Baronvonbonbon/datum/blob/main/PRIVACY-POLICY.md"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          privacy policy
        </a>{" "}
        and all terms, conditions, policies, and obligations — stated, implied, or otherwise — which are
        subject to change at any time without notice, for any reason, including no reason at all.{" "}
        You are solely responsible for compliance with the laws of your jurisdiction. We are not your lawyer.
        We are not your financial advisor. We are not responsible for your taxes. Good luck out there.
      </div>

    </footer>
  );
}
