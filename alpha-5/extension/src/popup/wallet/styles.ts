// Shared inline-style helpers for the wallet popup screens.
//
// The popup's CSS lives inline in popup/index.html (no external CSS
// file). Each screen here uses these helpers + inline style overrides
// so the visual language stays consistent without introducing a CSS
// pipeline. Color values come from the CSS custom properties declared
// in index.html — referencing `var(--text-strong)` etc. so a future
// theme toggle can flip them without touching this file.

import type { CSSProperties } from "react";

export const screen: CSSProperties = {
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minHeight: 400,
};

export const heading: CSSProperties = {
  color: "var(--text-strong)",
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "0.02em",
  marginBottom: 4,
};

export const subText: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.5,
};

export const button = (variant: "primary" | "secondary" | "danger" = "primary"): CSSProperties => {
  const base: CSSProperties = {
    display: "block",
    width: "100%",
    padding: "10px 12px",
    borderRadius: "var(--radius)",
    fontSize: 13,
    fontWeight: 500,
    border: "1px solid var(--border)",
    fontFamily: "var(--font-sans)",
    cursor: "pointer",
    transition: "background 80ms",
  };
  if (variant === "primary") {
    return {
      ...base,
      background: "var(--text-strong)",
      color: "var(--bg)",
      border: "1px solid var(--text-strong)",
    };
  }
  if (variant === "danger") {
    return {
      ...base,
      background: "transparent",
      color: "var(--error)",
      borderColor: "var(--error)",
    };
  }
  return {
    ...base,
    background: "transparent",
    color: "var(--text-strong)",
  };
};

export const input: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "9px 10px",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-strong)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
};

export const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--text-strong)",
  letterSpacing: "0.01em",
};

export const card: CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 12,
};

export const errorText: CSSProperties = {
  color: "var(--error)",
  fontSize: 11,
  marginTop: 6,
};

export const okText: CSSProperties = {
  color: "var(--ok)",
  fontSize: 11,
  marginTop: 6,
};

export const fieldLabel: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 4,
};
