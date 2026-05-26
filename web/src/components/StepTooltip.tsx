// StepTooltip — inline explainer for a single form field or action step.
//
// Renders a small ⓘ chip next to a label that, on hover or focus, reveals
// a tooltip with: a mandatory/optional badge, a one-line summary, and an
// optional details block. Tooltips dismiss on Escape and on click-outside.
//
// Usage:
//   <label>
//     Budget <StepTooltip required summary="..." details="..." />
//   </label>
//
// Accessibility:
//   - Trigger is a <button> so keyboard users can tab to it and toggle.
//   - aria-describedby links the trigger to the tooltip body so screen
//     readers announce the content alongside the field.

import { useState, useRef, useEffect, useId, ReactNode } from "react";

interface StepTooltipProps {
  /** One-sentence summary shown at the top of the tooltip. Plain text. */
  summary: string;
  /** Optional longer details. ReactNode so you can include <code>, links, lists. */
  details?: ReactNode;
  /** Marks the step as required. Mutually exclusive with `optional`. */
  required?: boolean;
  /** Marks the step as optional. Default if neither flag is set. */
  optional?: boolean;
  /** Side of the trigger to show the tooltip; defaults to "right". */
  side?: "right" | "left" | "below" | "above";
  /** Inline label preceding the chip — convenience so callers don't have
   *  to wrap their own label. If omitted, only the chip renders. */
  label?: ReactNode;
}

export function StepTooltip({
  summary,
  details,
  required,
  optional,
  side = "right",
  label,
}: StepTooltipProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();

  // Status badge — required wins if both flags are set; otherwise default optional.
  const status = required ? "required" : (optional ?? !required) ? "optional" : "optional";

  // Dismiss on Escape + click-outside.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // Geometry: tooltip placement relative to the chip.
  const tooltipPos: React.CSSProperties = (() => {
    switch (side) {
      case "left":  return { right: "calc(100% + 8px)", top: "50%", transform: "translateY(-50%)" };
      case "below": return { left: 0, top: "calc(100% + 6px)" };
      case "above": return { left: 0, bottom: "calc(100% + 6px)" };
      case "right":
      default:      return { left: "calc(100% + 8px)", top: "50%", transform: "translateY(-50%)" };
    }
  })();

  const badge = (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        marginRight: 6,
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: status === "required" ? "#fff" : "var(--text-muted)",
        background: status === "required" ? "rgba(248,113,113,0.55)" : "rgba(160,160,255,0.10)",
        border: status === "required" ? "1px solid rgba(248,113,113,0.7)" : "1px solid var(--border)",
        verticalAlign: "middle",
      }}
    >
      {status === "required" ? "Required" : "Optional"}
    </span>
  );

  return (
    <span
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {label}
      <button
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: "1px solid var(--text-muted)",
          background: "transparent",
          color: "var(--text-muted)",
          fontSize: 9,
          fontWeight: 700,
          fontFamily: "var(--font-mono, ui-monospace)",
          cursor: "help",
          padding: 0,
          lineHeight: 1,
        }}
        // Compact unicode info glyph — “ⓘ” renders inconsistently across
        // monospace fonts, so we use a styled “?” to match the explainer.
        title=""
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          id={tooltipId}
          style={{
            position: "absolute",
            zIndex: 30,
            ...tooltipPos,
            minWidth: 240,
            maxWidth: 360,
            padding: "10px 12px",
            background: "var(--bg-card, #1c1a19)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            color: "var(--text)",
            fontSize: 12,
            lineHeight: 1.5,
            textAlign: "left",
            fontWeight: 400,
            // Prevent the tooltip from inheriting label styling like
            // letterSpacing or all-caps from a parent.
            letterSpacing: "normal",
            textTransform: "none",
          }}
        >
          <div style={{ marginBottom: details ? 6 : 0 }}>
            {badge}
            <span style={{ color: "var(--text-strong)" }}>{summary}</span>
          </div>
          {details && (
            <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.55 }}>
              {details}
            </div>
          )}
        </span>
      )}
    </span>
  );
}
