/**
 * DOT denomination helpers for PolkaVM (native path).
 *
 * 1 DOT = 10^10 planck  (10 decimal places)
 *
 * Denomination rounding: pallet-revive eth-rpc rejects value % 10^6 >= 500_000.
 * All transaction values must be multiples of 10^6 planck.
 * Use parseDOT() for display/compare; use parseDOTSafe() for transaction values.
 */

const PLANCK_PER_DOT = 10n ** 10n;
// Minimum planck granularity accepted by pallet-revive eth-rpc bridge
const PLANCK_GRID = 1_000_000n;

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
 * Like parseDOT but rounds to the nearest 10^6 planck grid so the value
 * passes pallet-revive's eth-rpc denomination check (value % 10^6 < 500_000).
 * Use this for all on-chain transaction `value:` fields.
 *
 * parseDOTSafe("100")    → 1_000_000_000_000n  (unchanged — already on grid)
 * parseDOTSafe("0.1")    → 1_000_000_000n      (unchanged)
 * parseDOTSafe("0.0001") → 1_000_000n          (min billable unit)
 */
export function parseDOTSafe(dot: string): bigint {
  // Normalise float noise (e.g. "0.09999999999" from browser number input → "0.1")
  // toFixed(10) avoids scientific notation for values >= 1e-10
  const normalised = parseFloat(dot).toFixed(10);
  const raw = parseDOT(normalised);
  if (raw === 0n) return 0n;
  const remainder = raw % PLANCK_GRID;
  if (remainder === 0n) return raw;
  // Round to nearest grid point (round half-up)
  const rounded = remainder >= PLANCK_GRID / 2n ? raw - remainder + PLANCK_GRID : raw - remainder;
  // Ensure at least PLANCK_GRID if original was positive
  return rounded === 0n ? PLANCK_GRID : rounded;
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
