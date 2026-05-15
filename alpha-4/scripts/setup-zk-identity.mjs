#!/usr/bin/env node
/**
 * setup-zk-identity.mjs — Trusted setup for the identity proof circuit
 *
 * Mirrors setup-zk.mjs but for the smaller identity circuit (1 public
 * input: commitment; 1 private witness: secret; one Poseidon hash).
 *
 * Outputs:
 *   circuits/identity_js/identity.wasm         — witness calculator
 *   circuits/identity.zkey                     — circuit-specific proving key
 *   circuits/identity_vk.json                  — verification key
 *   circuits/identity-setVK-calldata.json      — setVerifyingKey() args for deploy.ts
 *
 * Prerequisites:
 *   - circom on PATH (or at alpha-4/circom)
 *   - snarkjs (already in package.json)
 *   - Internet access on first run (downloads ptau12 from Hermez)
 *
 * Usage:
 *   node scripts/setup-zk-identity.mjs
 *
 * For mainnet: replace single-party contribution with an MPC ceremony.
 * Single-party is acceptable for testnet because no real value rides
 * on the identity proof's soundness during the testing window.
 */

import { execSync }    from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash }  from "crypto";
import path            from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const CIRCUITS  = path.join(ROOT, "circuits");
// Identity circuit is tiny (~213 constraints). ptau12 (4096) is plenty.
const PTAU_URL  = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau";
const PTAU_PATH = path.join(CIRCUITS, "ptau12.ptau");
const R1CS      = path.join(CIRCUITS, "identity.r1cs");
const WASM_DIR  = path.join(CIRCUITS, "identity_js");
const ZKEY0     = path.join(CIRCUITS, "identity_0000.zkey");
const ZKEY      = path.join(CIRCUITS, "identity.zkey");
const VK_PATH   = path.join(CIRCUITS, "identity_vk.json");

mkdirSync(CIRCUITS, { recursive: true });

// -----------------------------------------------------------------------
// Step 1: Compile
// -----------------------------------------------------------------------
const CIRCOM_BIN = (() => {
  try { execSync("circom --version", { stdio: "pipe" }); return "circom"; } catch {}
  const local = path.join(ROOT, "circom");
  if (existsSync(local)) return local;
  throw new Error("circom not found — install it or place binary at alpha-4/circom");
})();

if (!existsSync(R1CS)) {
  console.log("→ Compiling identity.circom ...");
  execSync(
    `${CIRCOM_BIN} ${path.join(CIRCUITS, "identity.circom")} --r1cs --wasm --sym -o ${CIRCUITS}`,
    { stdio: "inherit" }
  );
} else {
  console.log("✓ identity.r1cs exists, skipping compile");
}

// -----------------------------------------------------------------------
// Step 2: Download ptau (shared with impression circuit if it's level 12)
// -----------------------------------------------------------------------
if (!existsSync(PTAU_PATH)) {
  console.log("→ Downloading powersOfTau level 12 (~5 MB) ...");
  execSync(`curl -L "${PTAU_URL}" -o "${PTAU_PATH}"`, { stdio: "inherit" });
} else {
  console.log("✓ ptau12 exists");
}

// -----------------------------------------------------------------------
// Step 3: Groth16 setup
// -----------------------------------------------------------------------
const snarkjs = await import("snarkjs");

if (!existsSync(ZKEY)) {
  console.log("→ Running groth16 setup for identity ...");
  await snarkjs.zKey.newZKey(R1CS, PTAU_PATH, ZKEY0);
  console.log("→ Contributing randomness (single-party — replace with MPC for mainnet) ...");
  const entropy = createHash("sha256").update(Date.now().toString()).digest();
  await snarkjs.zKey.contribute(ZKEY0, ZKEY, "Datum alpha-4 testnet identity", entropy);
  console.log("✓ identity.zkey written");
} else {
  console.log("✓ identity.zkey exists");
}

// -----------------------------------------------------------------------
// Step 4: Export VK + Solidity calldata
// -----------------------------------------------------------------------
console.log("→ Exporting verification key ...");
const vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
writeFileSync(VK_PATH, JSON.stringify(vk, null, 2));
console.log("✓ identity_vk.json written");

function g1(p) { return [p[0], p[1]]; }
function g2eip197(p) {
  return [p[0][1], p[0][0], p[1][1], p[1][0]];
}

// Identity: 1 public input → IC0..IC1
const calldata = {
  alpha1: g1(vk.vk_alpha_1),
  beta2:  g2eip197(vk.vk_beta_2),
  gamma2: g2eip197(vk.vk_gamma_2),
  delta2: g2eip197(vk.vk_delta_2),
  IC0:    g1(vk.IC[0]),  // constant
  IC1:    g1(vk.IC[1]),  // commitment
};
writeFileSync(
  path.join(CIRCUITS, "identity-setVK-calldata.json"),
  JSON.stringify(calldata, null, 2)
);
console.log("✓ identity-setVK-calldata.json written");

console.log(`
=============================================================
 Identity ZK setup complete.

 Next steps:
   1. deploy.ts will call DatumIdentityVerifier.setVerifyingKey(...)
      automatically when circuits/identity-setVK-calldata.json exists.

   2. Generate identity proofs off-chain via snarkjs:
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          { secret: yourSecret, commitment: poseidon([yourSecret]) },
          "circuits/identity_js/identity.wasm",
          "circuits/identity.zkey"
        );
      Encode the proof as 256 bytes (a, b, c) matching DatumZKVerifier's
      encoding convention.

   3. Submit via DatumStakeRootV2.challengeRootBalance(...)
=============================================================
`);
