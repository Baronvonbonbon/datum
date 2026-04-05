#!/usr/bin/env node
/**
 * setup-zk.mjs — Datum ZK trusted setup + proof generation helper
 *
 * Steps:
 *   1. Compile circuits/impression.circom  (requires circom ≥ 2.1)
 *   2. Download Hermez powers-of-tau (ptau level 12, 4096 constraints)
 *   3. Groth16 circuit-specific setup (zkey)
 *   4. Export verification key JSON + Solidity calldata for setVerifyingKey()
 *   5. Generate a sample proof for benchmark-paseo.ts
 *
 * Prerequisites:
 *   npm install snarkjs circomlib            (in alpha-3/)
 *   npm install -g circom                    (or: brew install circom)
 *   OR: curl -L https://github.com/iden3/circom/releases/download/v2.1.9/circom-linux-amd64 \
 *           -o /usr/local/bin/circom && chmod +x /usr/local/bin/circom
 *
 * Usage:
 *   node scripts/setup-zk.mjs
 *
 * Outputs:
 *   circuits/impression_js/impression.wasm   — witness calculator
 *   circuits/impression.zkey                 — circuit-specific proving key
 *   circuits/vk.json                         — verification key
 *   circuits/setVK-calldata.json             — setVerifyingKey() args for deploy.ts
 *   circuits/sample-proof.json               — sample proof for benchmark
 */

import { execSync }    from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash }  from "crypto";
import path            from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const CIRCUITS  = path.join(ROOT, "circuits");
const PTAU_URL  = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau";
const PTAU_PATH = path.join(CIRCUITS, "ptau12.ptau");
const R1CS      = path.join(CIRCUITS, "impression.r1cs");
const WASM_DIR  = path.join(CIRCUITS, "impression_js");
const ZKEY0     = path.join(CIRCUITS, "impression_0000.zkey");
const ZKEY      = path.join(CIRCUITS, "impression.zkey");
const VK_PATH   = path.join(CIRCUITS, "vk.json");

// BN254 scalar order
const SCALAR_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

mkdirSync(CIRCUITS, { recursive: true });

// -----------------------------------------------------------------------
// Step 1: Compile
// -----------------------------------------------------------------------
// Resolve circom: prefer PATH, fall back to project-local binary
const CIRCOM_BIN = (() => {
  try { execSync("circom --version", { stdio: "pipe" }); return "circom"; } catch {}
  const local = path.join(ROOT, "circom");
  if (existsSync(local)) return local;
  throw new Error("circom not found — install it or place binary at alpha-3/circom");
})();

if (!existsSync(R1CS)) {
  console.log("→ Compiling impression.circom ...");
  execSync(
    `${CIRCOM_BIN} ${path.join(CIRCUITS, "impression.circom")} --r1cs --wasm --sym -o ${CIRCUITS}`,
    { stdio: "inherit" }
  );
} else {
  console.log("✓ impression.r1cs exists, skipping compile");
}

// -----------------------------------------------------------------------
// Step 2: Download ptau
// -----------------------------------------------------------------------
if (!existsSync(PTAU_PATH)) {
  console.log("→ Downloading powersOfTau level 12 (~11 MB) ...");
  execSync(`curl -L "${PTAU_URL}" -o "${PTAU_PATH}"`, { stdio: "inherit" });
} else {
  console.log("✓ ptau12 exists");
}

// -----------------------------------------------------------------------
// Step 3: Groth16 setup
// -----------------------------------------------------------------------
const snarkjs = await import("snarkjs");

if (!existsSync(ZKEY)) {
  console.log("→ Running groth16 setup ...");
  await snarkjs.zKey.newZKey(R1CS, PTAU_PATH, ZKEY0);
  console.log("→ Contributing randomness ...");
  // Single-party contribution (not production-safe without ceremony; fine for testnet)
  const entropy = createHash("sha256").update(Date.now().toString()).digest();
  await snarkjs.zKey.contribute(ZKEY0, ZKEY, "Datum alpha-3 testnet", entropy);
  console.log("✓ impression.zkey written");
} else {
  console.log("✓ impression.zkey exists");
}

// -----------------------------------------------------------------------
// Step 4: Export VK + Solidity calldata
// -----------------------------------------------------------------------
console.log("→ Exporting verification key ...");
const vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
writeFileSync(VK_PATH, JSON.stringify(vk, null, 2));
console.log("✓ vk.json written");

// Convert snarkjs VK to setVerifyingKey() args.
// snarkjs G1 point: [x, y] (strings, decimal)
// snarkjs G2 point: [[x_real, x_imag], [y_real, y_imag]]
// EIP-197 order for G2:  [x_imag, x_real, y_imag, y_real]
function g1(p) { return [p[0], p[1]]; }
function g2eip197(p) {
  return [
    p[0][1], p[0][0],  // x_imag, x_real
    p[1][1], p[1][0],  // y_imag, y_real
  ];
}

const calldata = {
  alpha1: g1(vk.vk_alpha_1),
  beta2:  g2eip197(vk.vk_beta_2),
  gamma2: g2eip197(vk.vk_gamma_2),
  delta2: g2eip197(vk.vk_delta_2),
  IC0:    g1(vk.IC[0]),
  IC1:    g1(vk.IC[1]),
};
writeFileSync(
  path.join(CIRCUITS, "setVK-calldata.json"),
  JSON.stringify(calldata, null, 2)
);
console.log("✓ setVK-calldata.json written");

// Print the deploy.ts / hardhat snippet
console.log("\n--- setVerifyingKey() calldata ---");
console.log(JSON.stringify(calldata, null, 2));

// -----------------------------------------------------------------------
// Step 5: Generate a sample proof for a known input
// -----------------------------------------------------------------------
console.log("\n→ Generating sample proof ...");

// Sample claim: campaignId=1, impressions=100, nonce=1
// claimHash is a dummy value (all zeros truncated to field)
const sampleClaimHash = 0n % SCALAR_ORDER;  // replace with real claim hash in benchmark
const sampleInput = {
  claimHash:   sampleClaimHash.toString(),
  impressions: "100",
  nonce:       "1",
};

const wasmPath = path.join(WASM_DIR, "impression.wasm");
const { proof, publicSignals } = await snarkjs.groth16.fullProve(sampleInput, wasmPath, ZKEY);
console.log("✓ Sample proof generated");
console.log("  publicSignals:", publicSignals);

// Encode proof as 256-byte ABI-encoded (uint256[2], uint256[4], uint256[2])
// pi_a: G1   [ax, ay]
// pi_b: G2   [bx_imag, bx_real, by_imag, by_real]  (EIP-197 order)
// pi_c: G1   [cx, cy]
const sampleProof = {
  pi_a:  [proof.pi_a[0], proof.pi_a[1]],
  pi_b:  [
    proof.pi_b[0][1], proof.pi_b[0][0],  // x_imag, x_real
    proof.pi_b[1][1], proof.pi_b[1][0],  // y_imag, y_real
  ],
  pi_c:  [proof.pi_c[0], proof.pi_c[1]],
  publicSignals,
  input: sampleInput,
};
writeFileSync(
  path.join(CIRCUITS, "sample-proof.json"),
  JSON.stringify(sampleProof, null, 2)
);
console.log("✓ circuits/sample-proof.json written");

console.log(`
=============================================================
 ZK setup complete.

 Next steps:
   1. In deploy.ts, after deploying DatumZKVerifier, call:
        await zkVerifier.setVerifyingKey(
          calldata.alpha1, calldata.beta2, calldata.gamma2,
          calldata.delta2, calldata.IC0, calldata.IC1
        );
      (values from circuits/setVK-calldata.json)

   2. In benchmark-paseo.ts, import snarkjs and call:
        const { proof } = await snarkjs.groth16.fullProve(
          { claimHash: claimHashFe.toString(), impressions: imps.toString(), nonce: n.toString() },
          "circuits/impression_js/impression.wasm",
          "circuits/impression.zkey"
        );
      Then encode as shown in encodeProof() below.

   3. Run the benchmark:
        npx hardhat run scripts/benchmark-paseo.ts --network polkadotTestnet
=============================================================
`);

/**
 * encodeProof(proof) — reference implementation for benchmark-paseo.ts
 *
 * import { AbiCoder } from "ethers";
 * function encodeProof(proof) {
 *   return AbiCoder.defaultAbiCoder().encode(
 *     ["uint256[2]", "uint256[4]", "uint256[2]"],
 *     [
 *       [proof.pi_a[0],   proof.pi_a[1]],
 *       [proof.pi_b[0][1], proof.pi_b[0][0],   // x_imag, x_real
 *        proof.pi_b[1][1], proof.pi_b[1][0]],   // y_imag, y_real
 *       [proof.pi_c[0],   proof.pi_c[1]],
 *     ]
 *   );
 * }
 */
