/**
 * DOT denomination helpers for PolkaVM (native path).
 *
 * 1 DOT = 10^10 planck  (10 decimal places)
 * pallet-revive eth_getBalance returns wei (10^18/DOT), not planck.
 * Use weiToPlanck() on getBalance() results before passing to formatDOT.
 *
 * Denomination rounding: pallet-revive eth-rpc rejects value % 10^6 >= 500_000.
 * All transaction values must be multiples of 10^6 planck.
 * Use parseDOT() for display/compare; use parseDOTSafe() for transaction values.
 */

const PLANCK_PER_DOT = 10n ** 10n;
// Minimum planck granularity accepted by pallet-revive eth-rpc bridge
const PLANCK_GRID = 1_000_000n;
// pallet-revive eth_getBalance returns planck * 10^8 (standard EVM wei scaling)
export const WEI_PER_PLANCK = 10n ** 8n;

/**
 * Convert a pallet-revive eth_getBalance result (wei) to planck.
 * Must be applied before passing getBalance() values to formatDOT.
 */
export function weiToPlanck(wei: bigint): bigint {
  return wei / WEI_PER_PLANCK;
}

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
 */
export function parseDOTSafe(dot: string): bigint {
  const normalised = parseFloat(dot).toFixed(10);
  const raw = parseDOT(normalised);
  if (raw === 0n) return 0n;
  const remainder = raw % PLANCK_GRID;
  if (remainder === 0n) return raw;
  const rounded = remainder >= PLANCK_GRID / 2n ? raw - remainder + PLANCK_GRID : raw - remainder;
  return rounded === 0n ? PLANCK_GRID : rounded;
}

/**
 * Format a planck amount to a human-readable DOT string.
 * Trailing zeros are stripped; whole numbers have no decimal point.
 *
 * formatDOT(10_000_000_000n) → "1"
 * formatDOT(5_000_000_000n)  → "0.5"
 * formatDOT(100_000_000n)    → "0.01"
 * formatDOT(1n)              → "0.0000000001"
 * formatDOT(0n)              → "0"
 */
export function formatDOT(planck: bigint): string {
  if (planck < 0n) return `-${formatDOT(-planck)}`;
  if (planck === 0n) return "0";
  const whole = planck / PLANCK_PER_DOT;
  const frac = planck % PLANCK_PER_DOT;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(10, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

// 18-decimal scaling: pallet-revive eth_getBalance and EVM contract balances
// (e.g. PaymentVault.userBalance) are denominated in wei (10^18 per DOT).
const WEI_PER_DOT = 10n ** 18n;

/**
 * Format an 18-decimal wei amount as a human-readable DOT string with adaptive
 * precision. Amounts ≥ 0.0001 DOT show up to four decimals; smaller non-zero
 * "dust" amounts (which are sub-planck and would otherwise collapse to "0.0")
 * fall back to `sigFigs` significant figures so a non-zero balance is never
 * displayed as zero.
 *
 *   formatDotWei(1_500_000_000_000_000_000n)  → "1.5"
 *   formatDotWei(12_345_600_000_000_000_000n) → "12.3456"
 *   formatDotWei(10_000_000_000_000_000n)     → "0.01"
 *   formatDotWei(22_275_000n)                 → "0.00000000002227"  (dust)
 *   formatDotWei(0n)                          → "0"
 */
/**
 * Parse a human-readable PAS amount (decimal string) to 18-decimal wei.
 * Lenient: empty / invalid → 0n. Use for comparison thresholds and inputs.
 */
export function parseDotWei(pas: string): bigint {
  const [whole = "0", frac = ""] = (pas?.trim() || "0").split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return 0n;
  const fracPadded = frac.padEnd(18, "0").slice(0, 18);
  return BigInt(whole || "0") * WEI_PER_DOT + BigInt(fracPadded || "0");
}

export function formatDotWei(wei: bigint, sigFigs = 4): string {
  if (wei === 0n) return "0";
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / WEI_PER_DOT;
  const fracDigits = (v % WEI_PER_DOT).toString().padStart(18, "0");

  let out: string;
  if (whole > 0n) {
    const f = fracDigits.slice(0, 4).replace(/0+$/, "");
    out = f ? `${whole}.${f}` : whole.toString();
  } else {
    const four = fracDigits.slice(0, 4).replace(/0+$/, "");
    if (four) {
      out = `0.${four}`;
    } else {
      // Sub-0.0001 dust: show `sigFigs` digits starting at the first non-zero.
      const firstSig = fracDigits.search(/[1-9]/);
      const slice = fracDigits
        .slice(0, Math.min(18, firstSig + sigFigs))
        .replace(/0+$/, "");
      out = `0.${slice}`;
    }
  }
  return neg ? `-${out}` : out;
}
