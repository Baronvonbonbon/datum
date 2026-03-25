/**
 * DOT denomination helpers for PolkaVM (native path).
 *
 * 1 DOT = 10^10 planck  (10 decimal places)
 */

const PLANCK_PER_DOT = 10n ** 10n;

/**
 * Convert a human-readable DOT amount to planck.
 * Supports up to 10 decimal places.
 *
 * parseDOT("1")        → 10_000_000_000n
 * parseDOT("0.5")      → 5_000_000_000n
 * parseDOT("0.01")     → 100_000_000n
 */
export function parseDOT(dot: string): bigint {
  const [whole = "0", frac = ""] = dot.split(".");
  const fracPadded = frac.padEnd(10, "0").slice(0, 10);
  return BigInt(whole) * PLANCK_PER_DOT + BigInt(fracPadded);
}

/**
 * Format a planck amount to a human-readable DOT string.
 *
 * formatDOT(10_000_000_000n) → "1"
 * formatDOT(5_000_000_000n)  → "0.5"
 */
export function formatDOT(planck: bigint): string {
  const whole = planck / PLANCK_PER_DOT;
  const frac = planck % PLANCK_PER_DOT;
  const fracStr = frac.toString().padStart(10, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
