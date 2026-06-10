/**
 * DOT/PAS denomination helpers (EVM 18-decimal wei path).
 *
 * 1 DOT/PAS = 10^18 wei  (18 decimal places)
 *
 * alpha-core runs on pallet-revive's EVM path, where msg.value is denominated
 * in 18-decimal wei (the 2026-06 "denominate everything in 18-dec wei"
 * migration: contract minimums/CPM are now 10^18-scaled, e.g.
 * MINIMUM_BUDGET_WEI = 10^17). All amounts that would have been
 * `ethers.parseEther(x)` are equivalently `parseDOT(x)`. The legacy planck
 * (10^10) scaling was retired with that migration — keeping this helper at
 * 10^10 silently under-funded every campaign below MINIMUM_BUDGET_WEI (E11).
 */

const WEI_PER_DOT = 10n ** 18n;
const DECIMALS = 18;

/**
 * Convert a human-readable DOT/PAS amount to 18-decimal wei.
 * Supports up to 18 decimal places.
 *
 * parseDOT("1")     → 1_000000000000000000n  (10^18)
 * parseDOT("0.5")   →   500000000000000000n  (5·10^17)
 * parseDOT("0.001") →     1000000000000000n  (10^15)
 */
export function parseDOT(dot: string): bigint {
  const [whole = "0", frac = ""] = dot.split(".");
  const fracPadded = frac.padEnd(DECIMALS, "0").slice(0, DECIMALS);
  return BigInt(whole) * WEI_PER_DOT + BigInt(fracPadded);
}

/**
 * Format an 18-decimal wei amount back to a human-readable DOT/PAS string
 * (for assertion messages). Trailing zeros in the fraction are trimmed.
 */
export function formatDOT(wei: bigint): string {
  const whole = wei / WEI_PER_DOT;
  const frac = wei % WEI_PER_DOT;
  const fracStr = frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
