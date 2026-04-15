// ── Denomination conversion: planck ↔ wei ──
//
// 1 DOT = 10^10 planck (substrate smallest unit)
// 1 DOT = 10^18 wei   (eth-rpc representation)
// Therefore: 1 planck = 10^8 wei

const PLANCK_PER_DOT = 10n ** 10n;
const WEI_PER_DOT = 10n ** 18n;
const WEI_PER_PLANCK = WEI_PER_DOT / PLANCK_PER_DOT; // 10^8

/**
 * Convert planck (substrate) to wei (eth-rpc).
 * This is a lossless upscaling.
 */
export function planckToWei(planck: bigint): bigint {
  return planck * WEI_PER_PLANCK;
}

/**
 * Convert wei (eth-rpc) to planck (substrate).
 * Truncates fractional planck (lossy for sub-planck amounts).
 */
export function weiToPlanck(wei: bigint): bigint {
  return wei / WEI_PER_PLANCK;
}

/**
 * Paseo quirk: pallet-revive eth-rpc rejects values where
 * `value % 10^6 >= 500_000` due to a denomination rounding bug.
 * Round down to nearest safe multiple of 10^6.
 */
export function roundToSafePlanck(planck: bigint): bigint {
  const remainder = planck % 1_000_000n;
  if (remainder >= 500_000n) {
    return planck - remainder;
  }
  return planck;
}

/** Format planck as a "0x..." hex string (for eth-rpc responses after conversion) */
export function toHex(value: bigint): string {
  if (value === 0n) return "0x0";
  return "0x" + value.toString(16);
}

/** Parse a hex string or decimal string to bigint */
export function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return BigInt(value);
  }
  return BigInt(value);
}
