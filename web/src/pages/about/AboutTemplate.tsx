// AboutTemplate — shared layout for the seven /about/<persona> deep-dive
// pages. Each page passes content in via props; the template handles the
// hero, the section headers, the styling, and the cross-link footer.
//
// The deep-dive pages are intentionally text-heavy. They are the place
// where DATUM's design choices get explained in narrative form, rather
// than as inline tooltips on action pages.

import { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ContractKey } from "@shared/contractCatalog";
import { ContractsTouched } from "../../components/ContractsTouched";

export interface AboutSection {
  heading: string;
  /// Optional one-line lead under the heading.
  lead?: string;
  body: ReactNode;
}

export interface AboutPersonaProps {
  icon: string;
  /// e.g. "Me", "Advertiser", "Publisher".
  persona: string;
  /// Tagline at the top of the hero, e.g. "The wallet-scoped view of your DATUM activity."
  tagline: string;
  /// Three to five bullet "what's in it for me" lines.
  whatYouGet: string[];
  /// The main body, broken into sections.
  sections: AboutSection[];
  /// Primary CTA shown at the top and bottom of the page.
  primaryCta: { label: string; to: string };
  /// Optional secondary CTA.
  secondaryCta?: { label: string; to: string };
  /// Contracts this persona interacts with (footer chips).
  contracts: ContractKey[];
  /// Cross-link to related personas.
  related?: { label: string; to: string }[];
  /// Accent colour (CSS variable). Defaults to var(--accent).
  accent?: string;
}

export function AboutTemplate({
  icon,
  persona,
  tagline,
  whatYouGet,
  sections,
  primaryCta,
  secondaryCta,
  contracts,
  related,
  accent = "var(--accent, #a0a0ff)",
}: AboutPersonaProps) {
  return (
    <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 36 }}>

      {/* Hero ─────────────────────────────────────────────────────── */}
      <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Link
          to="/"
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textDecoration: "none",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          ← Back to overview
        </Link>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 38, lineHeight: 1 }}>{icon}</span>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: "var(--text-strong)", letterSpacing: "-0.02em" }}>
            About: {persona}
          </h1>
        </div>
        <p style={{ fontSize: 15, color: "var(--text)", lineHeight: 1.6, margin: 0, maxWidth: 680 }}>
          {tagline}
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          <Link
            to={primaryCta.to}
            className="nano-btn nano-btn-accent"
            style={{ fontSize: 12, padding: "7px 16px", textDecoration: "none" }}
          >
            {primaryCta.label} →
          </Link>
          {secondaryCta && (
            <Link
              to={secondaryCta.to}
              className="nano-btn"
              style={{ fontSize: 12, padding: "7px 16px", textDecoration: "none" }}
            >
              {secondaryCta.label}
            </Link>
          )}
        </div>
      </div>

      {/* What you get ─────────────────────────────────────────────── */}
      <div className="nano-fade">
        <h2 style={{
          fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
          textTransform: "uppercase", color: "var(--text-muted)",
          margin: "0 0 12px", paddingBottom: 6, borderBottom: "1px solid var(--border)",
        }}>
          What this section is for
        </h2>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {whatYouGet.map((t, i) => (
            <li key={i} style={{
              fontSize: 13, color: "var(--text)", lineHeight: 1.6,
              display: "flex", gap: 10, alignItems: "flex-start",
            }}>
              <span style={{ color: accent, flexShrink: 0, marginTop: 2 }}>▸</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Body sections ────────────────────────────────────────────── */}
      {sections.map((sec, i) => (
        <div key={i} className="nano-fade">
          <h2 style={{
            fontSize: 13, fontWeight: 700, letterSpacing: "0.1em",
            textTransform: "uppercase", color: accent,
            margin: "0 0 14px", paddingBottom: 8,
            borderBottom: `1px solid ${accent}`,
          }}>
            {sec.heading}
          </h2>
          {sec.lead && (
            <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.65, margin: "0 0 12px", fontWeight: 500 }}>
              {sec.lead}
            </p>
          )}
          <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7 }}>
            {sec.body}
          </div>
        </div>
      ))}

      {/* Bottom CTA ───────────────────────────────────────────────── */}
      <div className="nano-fade nano-card" style={{
        padding: "20px 24px",
        background: `linear-gradient(135deg, var(--bg-raised, transparent), transparent)`,
        borderLeft: `3px solid ${accent}`,
        display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ color: "var(--text-strong)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
            Ready to dive in?
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Pick up where the walkthrough left off.
          </div>
        </div>
        <Link
          to={primaryCta.to}
          className="nano-btn nano-btn-accent"
          style={{ fontSize: 12, padding: "7px 18px", textDecoration: "none" }}
        >
          {primaryCta.label} →
        </Link>
      </div>

      {/* Related sections ─────────────────────────────────────────── */}
      {related && related.length > 0 && (
        <div className="nano-fade">
          <h2 style={{
            fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--text-muted)",
            margin: "0 0 12px",
          }}>
            Related
          </h2>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {related.map((r) => (
              <Link
                key={r.to}
                to={r.to}
                className="nano-btn"
                style={{ fontSize: 11, padding: "5px 12px", textDecoration: "none" }}
              >
                {r.label} →
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Contracts touched footer ─────────────────────────────────── */}
      <ContractsTouched contracts={contracts} note={`Contracts this section interacts with`} />
    </div>
  );
}

/// Tiny inline definition list used by several persona pages.
export function DefList({ items }: { items: { term: string; def: ReactNode }[] }) {
  return (
    <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 14 }}>
          <dt style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 600, paddingTop: 1 }}>
            {it.term}
          </dt>
          <dd style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.65 }}>{it.def}</dd>
        </div>
      ))}
    </dl>
  );
}
