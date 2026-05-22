// PageExplainer — collapsable banner at the top of each page.
//
// Behaviour: first visit shows expanded; subsequent visits show the
// compact chip. State is persisted per `slug` in localStorage so a
// user who has read the explainer doesn't see it again.
//
// Usage:
//   <PageExplainer
//     slug="me-dashboard"
//     title="What is the Me dashboard?"
//   >
//     <p>...</p>
//   </PageExplainer>

import { useState, useEffect, ReactNode } from "react";

const STORAGE_PREFIX = "datum_explainer_seen:";

export function PageExplainer({
  slug,
  title,
  children,
}: {
  slug: string;
  title: string;
  children: ReactNode;
}) {
  const storageKey = `${STORAGE_PREFIX}${slug}`;
  // Start collapsed during SSR/first paint; hydrate from localStorage
  // in an effect to avoid hydration mismatch. We expand if the user
  // hasn't seen this explainer before.
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const seen = localStorage.getItem(storageKey) === "1";
      setOpen(!seen);
    } catch {
      setOpen(true);
    }
    setHydrated(true);
  }, [storageKey]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // First-time open → first-time close: mark seen so future visits
    // start collapsed. We mark on close so the user has actually had
    // the chance to read the content before we hide it on next load.
    if (!next) {
      try {
        localStorage.setItem(storageKey, "1");
      } catch {
        /* localStorage disabled — explainer just stays expanded each visit */
      }
    }
  }

  if (!hydrated) return null;

  return (
    <div
      className="nano-fade"
      style={{
        marginBottom: 22,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius, 6px)",
        background: "var(--bg-raised, var(--bg-surface, transparent))",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: open ? "12px 16px" : "8px 14px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
          fontSize: 12,
          letterSpacing: "0.04em",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: "1px solid var(--text-muted)",
            color: "var(--text-muted)",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: "var(--font-mono, ui-monospace)",
            flexShrink: 0,
          }}
        >
          ?
        </span>
        <span
          style={{
            color: "var(--text-strong)",
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            transition: "transform 200ms ease-in-out",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            display: "inline-block",
            flexShrink: 0,
          }}
        >
          ▶
        </span>
      </button>
      <div
        style={{
          maxHeight: open ? 1200 : 0,
          overflow: "hidden",
          transition: "max-height 300ms ease-in-out",
        }}
      >
        <div
          style={{
            padding: "0 18px 16px 44px",
            fontSize: 13,
            color: "var(--text)",
            lineHeight: 1.65,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
