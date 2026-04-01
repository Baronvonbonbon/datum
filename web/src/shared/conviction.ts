// Alpha-3 escalating conviction curve (9 levels: 0-8)
// Source: DatumGovernanceV2 hardcoded if/else chains
// Weights: [1, 2, 3, 4, 6, 9, 14, 18, 21]
// Lockups:  0, 1d, 3d, 7d, 21d, 90d, 180d, 270d, 365d (at 6s/block)

export const CONVICTION_WEIGHTS = [1, 2, 3, 4, 6, 9, 14, 18, 21];

// Lockup in blocks (6s/block)
export const CONVICTION_LOCKUP_BLOCKS = [
  0,
  14_400,     // 1 day
  43_200,     // 3 days
  100_800,    // 7 days
  302_400,    // 21 days
  1_296_000,  // 90 days
  2_592_000,  // 180 days
  3_888_000,  // 270 days
  5_256_000,  // 365 days
];

export const CONVICTION_LOCKUP_LABELS = [
  "No lockup",
  "~1 day",
  "~3 days",
  "~7 days",
  "~21 days",
  "~90 days",
  "~180 days",
  "~270 days",
  "~365 days",
];

export function convictionWeight(level: number): number {
  return CONVICTION_WEIGHTS[level] ?? 1;
}

export function convictionLockupBlocks(level: number): number {
  return CONVICTION_LOCKUP_BLOCKS[level] ?? 0;
}

export function convictionLabel(level: number): string {
  const w = CONVICTION_WEIGHTS[level] ?? 1;
  const l = CONVICTION_LOCKUP_LABELS[level] ?? "unknown";
  return `${w}x weight — ${l}`;
}

/** Format block delta to human-readable duration (6s/block) */
export function formatBlockDelta(blocks: number): string {
  const secs = blocks * 6;
  if (secs < 120) return `${secs}s`;
  if (secs < 7200) return `${Math.round(secs / 60)}m`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}
