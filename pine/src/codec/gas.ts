// ── Gas ↔ Weight conversion ──
//
// Substrate uses "weight" (ref_time component in picoseconds of execution).
// pallet-revive's eth-rpc maps weight to gas roughly as:
//   gas = weight / WEIGHT_PER_GAS
//
// The exact ratio depends on the chain's WeightToGas config.
// For Asset Hub: 1 gas ≈ 1_000 weight (ref_time).

/** Default weight per gas unit — matches pallet-revive's typical config */
const DEFAULT_WEIGHT_PER_GAS = 1_000n;

let weightPerGas = DEFAULT_WEIGHT_PER_GAS;

/** Set the weight-per-gas ratio (can be queried from runtime if needed) */
export function setWeightPerGas(w: bigint): void {
  weightPerGas = w;
}

/** Convert substrate weight (ref_time) to EVM gas units */
export function weightToGas(weight: bigint): bigint {
  return weight / weightPerGas;
}

/** Convert EVM gas units to substrate weight (ref_time) */
export function gasToWeight(gas: bigint): bigint {
  return gas * weightPerGas;
}
