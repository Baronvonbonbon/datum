// useHeroStat — fetches one big-number card's value, delta, and
// sparkline on a block-tick cadence.
//
// Design doc §6.1: hero stats poll on block intervals but only
// re-render when the value actually changes. We achieve that by
// keeping the previous value in component state and skipping a
// setState when the new fetch returns the same value.
//
// The three callbacks are independent and may resolve at different
// rates. Each cycles independently: a stable value but a changing
// delta still updates the delta card, etc.

import { useEffect, useState } from "react";
import { onPineStatus, type PineStatus } from "../lib/provider";

export type HeroStatDelta = {
  value: number | bigint;
  sign: "up" | "down" | "flat";
};

export type HeroStat = {
  /// Card heading.
  label: string;
  /// Async fetcher for the canonical value. Required.
  value: () => Promise<number | bigint | string>;
  /// 24-hour change. The hook calls this in parallel with `value`;
  /// the card renders a `+12%` / `−4%` chip when provided.
  delta24h?: () => Promise<HeroStatDelta>;
  /// 24 hourly buckets for the sparkline. The hook fetches once per
  /// poll cycle and feeds the array straight to the SVG renderer.
  sparkline?: () => Promise<number[]>;
  /// Optional formatter applied to `value` before display. Default
  /// stringifies bigints and numbers naively.
  formatter?: (v: number | bigint | string) => string;
  /// Optional `<Link to={...}>` target when the card is clicked.
  link?: string;
};

export type HeroStatState = {
  value: number | bigint | string | null;
  formatted: string;
  delta: HeroStatDelta | null;
  sparkline: number[] | null;
  loading: boolean;
  /// Populated when any of the three fetchers rejects; the card
  /// renders a muted "—" instead of stale data.
  error: string | null;
};

/// Subscribe to a single hero stat. Returns the latest snapshot;
/// re-renders only when one of the three values changes.
export function useHeroStat(stat: HeroStat): HeroStatState {
  const [state, setState] = useState<HeroStatState>(() => ({
    value: null,
    formatted: "—",
    delta: null,
    sparkline: null,
    loading: true,
    error: null,
  }));

  useEffect(() => {
    let cancelled = false;
    let lastFetchedAt = 0;

    async function fetchOnce() {
      try {
        const [value, delta, sparkline] = await Promise.all([
          stat.value(),
          stat.delta24h?.() ?? Promise.resolve(null),
          stat.sparkline?.() ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setState((prev) => {
          // Skip rerender when nothing changed. Compare primitives
          // by Object.is; arrays/objects shallow-compare by length
          // + first/last so a stable 24-hour bucket array doesn't
          // ping the renderer every block.
          if (
            prev.value === value &&
            prev.error === null &&
            sameDelta(prev.delta, delta) &&
            sameSparkline(prev.sparkline, sparkline)
          ) {
            return prev;
          }
          return {
            value,
            formatted: stat.formatter ? stat.formatter(value) : defaultFormat(value),
            delta,
            sparkline,
            loading: false,
            error: null,
          };
        });
      } catch (err: any) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: String(err?.message ?? err),
        }));
      }
    }

    // Initial fetch as soon as pine is ready.
    const unsub = onPineStatus((status: PineStatus) => {
      if (status.state !== "ready") return;
      if (status.finalizedHead === lastFetchedAt) return;
      lastFetchedAt = status.finalizedHead;
      void fetchOnce();
    });

    return () => {
      cancelled = true;
      unsub();
    };
    // Re-subscribe whenever the stat's identity changes. Callers
    // usually memo the object; we depend on its top-level fields
    // so accidental new references don't churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat.label, stat.formatter, stat.link]);

  return state;
}

function defaultFormat(v: number | bigint | string): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

function sameDelta(a: HeroStatDelta | null, b: HeroStatDelta | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.sign === b.sign && a.value === b.value;
}

function sameSparkline(a: number[] | null, b: number[] | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  // Strict full compare is overkill for sparklines but cheap (≤24
  // entries) — render-skip is more valuable than a couple extra
  // comparisons.
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
