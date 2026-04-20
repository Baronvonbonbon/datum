// Real Groth16 proof generation for impression.circom (BN254/snarkjs)
// Public input:  claimHash mod BN254 scalar order r
// Private:       impressions (uint32, range-checked), nonce (quadratic binding)
//
// Circuit files are bundled as extension assets under circuits/:
//   circuits/impression.wasm  — witness generator
//   circuits/impression.zkey  — proving key (Groth16 trusted setup)

import { AbiCoder } from "ethers";

const BN254_r = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let wasmCache: Uint8Array | null = null;
let zkeyCache: Uint8Array | null = null;

async function loadCircuit(): Promise<{ wasm: Uint8Array; zkey: Uint8Array }> {
  if (!wasmCache || !zkeyCache) {
    const wasmUrl = chrome.runtime.getURL("circuits/impression.wasm");
    const zkeyUrl = chrome.runtime.getURL("circuits/impression.zkey");
    const [wasmResp, zkeyResp] = await Promise.all([fetch(wasmUrl), fetch(zkeyUrl)]);
    if (!wasmResp.ok || !zkeyResp.ok) {
      throw new Error(`[ZK] Failed to load circuit files: wasm=${wasmResp.status} zkey=${zkeyResp.status}`);
    }
    wasmCache = new Uint8Array(await wasmResp.arrayBuffer());
    zkeyCache = new Uint8Array(await zkeyResp.arrayBuffer());
  }
  return { wasm: wasmCache!, zkey: zkeyCache! };
}

/**
 * Generate a real Groth16 proof for an impression claim (FP-5 — 2-public-input circuit).
 * Public inputs:  claimHash (publicSignals[0]), nullifier (publicSignals[1])
 * Private inputs: impressions, nonce, userSecret, campaignId, windowId
 *
 * Returns proofBytes (256-byte ABI-encoded proof) and nullifier (bytes32 hex).
 * proofBytes matches the encoding expected by DatumZKVerifier.verify().
 */
export async function generateZKProof(
  claimHash: string,
  impressionCount: bigint,
  nonce: bigint,
  userSecret: Uint8Array,
  campaignId: bigint,
  windowId: bigint,
): Promise<{ proofBytes: string; nullifier: string }> {
  const { wasm, zkey } = await loadCircuit();
  // Dynamic import keeps snarkjs out of non-ZK code paths
  const snarkjs = await import("snarkjs");

  // Reduce 32-byte userSecret to a BN254 field element
  const userSecretHex = Array.from(userSecret).map(b => b.toString(16).padStart(2, "0")).join("");
  const userSecretField = (BigInt("0x" + userSecretHex) % BN254_r).toString();

  const input = {
    claimHash: (BigInt(claimHash) % BN254_r).toString(),
    impressions: impressionCount.toString(),
    nonce: nonce.toString(),
    userSecret: userSecretField,
    campaignId: (campaignId % BN254_r).toString(),
    windowId: windowId.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);

  // ABI-encode proof as 256 bytes.
  // pi_b G2 point must be in EIP-197 order: [x_imag, x_real, y_imag, y_real]
  const proofBytes = AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
      [proof.pi_c[0], proof.pi_c[1]],
    ],
  );

  // publicSignals[1] is the nullifier (bytes32 as decimal string)
  const nullifier = "0x" + BigInt(publicSignals[1]).toString(16).padStart(64, "0");

  return { proofBytes, nullifier };
}
