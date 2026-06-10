// claimCore — snarkjs-free claim primitives shared by the real claimBuilder
// (extension/relay, which adds ZK proofs) and the demo daemon (which can't import
// claimBuilder because that pulls in zkProof.ts → snarkjs, not web-bundled).
//
// This is the SINGLE SOURCE OF TRUTH for the claim-hash preimage. Off-chain
// hashing drifted from the contract three times when each consumer kept its own
// copy (policyId, lastNonce arity, and the missing stakeRootUsed field that made
// every claim revert). Both consumers now import computeClaimHash from here, so
// the schema lives in exactly one place. Keep it byte-for-byte aligned with
// DatumClaimValidator.sol validateClaim():
//
//   keccak256(abi.encode(
//     campaignId, publisher, user, eventCount, rateWei, actionType,
//     clickSessionHash, nonce, previousClaimHash, stakeRootUsed))
//
// claimCore.test.ts pins the field list with a golden hash — changing the schema
// breaks the test, forcing a re-check against the contract.

import { AbiCoder, keccak256, ZeroHash, zeroPadValue, toBeHex } from "ethers";

/** Canonical claim-hash preimage types — MUST match DatumClaimValidator.sol:444. */
export const CLAIM_HASH_TYPES = [
  "uint256", // campaignId
  "address", // publisher
  "address", // user
  "uint256", // eventCount
  "uint256", // rateWei
  "uint8",   // actionType (0=view, 1=click, 2=remote-action)
  "bytes32", // clickSessionHash (type-1 only; ZeroHash otherwise)
  "uint256", // nonce
  "bytes32", // previousClaimHash
  "bytes32", // stakeRootUsed (Path A stake gate; ZeroHash = skip)
] as const;

const _abi = AbiCoder.defaultAbiCoder();

export interface ClaimHashInput {
  campaignId: bigint;
  publisher: string;
  user: string;
  eventCount: bigint;
  rateWei: bigint;
  actionType: number;
  clickSessionHash?: string;
  nonce: bigint;
  previousClaimHash: string;
  stakeRootUsed?: string;
}

/** keccak256(abi.encode(...)) over the canonical 10-field preimage. */
export function computeClaimHash(c: ClaimHashInput): string {
  return keccak256(
    _abi.encode(CLAIM_HASH_TYPES as unknown as string[], [
      c.campaignId,
      c.publisher,
      c.user,
      c.eventCount,
      c.rateWei,
      c.actionType,
      c.clickSessionHash ?? ZeroHash,
      c.nonce,
      c.previousClaimHash,
      c.stakeRootUsed ?? ZeroHash,
    ]),
  );
}

export const ZK_EMPTY: string[] = new Array(8).fill(ZeroHash);
export const SIG_EMPTY: string[] = [ZeroHash, ZeroHash, ZeroHash];

/** uint256 nonce → bytes32 hex (used as clickSessionHash on type-1 claims). */
export function nonceToBytes32(nonce: bigint): string {
  return zeroPadValue(toBeHex(nonce), 32);
}

/** Parse a 65-byte ECDSA signature hex into bytes32[3] = [r, s, v-as-bytes32]. */
export function parseSigToArray(sig: string): string[] {
  if (Array.isArray(sig)) return sig as string[];
  if (!sig || sig === "0x" || sig.length < 132) return SIG_EMPTY;
  const hex = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (hex.length < 130) return SIG_EMPTY;
  const r = "0x" + hex.slice(0, 64);
  const s = "0x" + hex.slice(64, 128);
  const v = parseInt(hex.slice(128, 130), 16);
  return [r, s, "0x" + v.toString(16).padStart(64, "0")];
}

// ───────────────────────────────────────────────────────────────────────────
// SLIM (#2) wire format — the on-chain Claim no longer carries
// campaignId/nonce/previousClaimHash/claimHash (derived on-chain), and the
// path-specific fields (clickSessionHash/stakeRootUsed/nullifier/powNonce/
// zkProof/actionSig) live in an OPTIONAL `proof` sidecar that is EMPTY for a
// plain view claim. Keep these byte-for-byte aligned with IDatumSettlement.sol.
// ───────────────────────────────────────────────────────────────────────────

/** Optional per-claim proof sidecar (mirrors IDatumSettlement.ClaimProof). */
export interface ClaimProofEntry {
  clickSessionHash: string;
  stakeRootUsed: string;
  nullifier: string;
  powNonce: string;
  zkProof: string[];   // bytes32[8]
  actionSig: string[]; // bytes32[3]
}

/** On-chain slim Claim (mirrors IDatumSettlement.Claim). */
export interface SlimClaim {
  publisher: string;
  eventCount: bigint;
  rateWei: bigint;
  actionType: number;
  proof: ClaimProofEntry[]; // 0 entries = plain view; 1 entry = ZK/click/CPA/PoW
}

/** ABI tuple for keccak(abi.encode(slimClaim)) — MUST match IDatumSettlement.sol. */
export const CLAIM_PROOF_TUPLE =
  "tuple(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)";
export const SLIM_CLAIM_TUPLE =
  `tuple(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,${CLAIM_PROOF_TUPLE}[] proof)`;

function _isZeroHash(h: string | undefined): boolean {
  return !h || h === ZeroHash || /^0x0+$/.test(h);
}

/** Rich claim fields that carry the path-specific proof material. */
export interface ProofFields {
  clickSessionHash?: string;
  stakeRootUsed?: string;
  nullifier?: string;
  powNonce?: string;
  zkProof?: string[];
  actionSig?: string[];
}

/**
 * Build the proof sidecar from a claim's path-specific fields. Returns [] (empty
 * sidecar) for a plain view claim where every field is zero — that's what keeps
 * a view claim down to ~224 bytes. Returns a single entry otherwise.
 */
export function packProof(f: ProofFields): ClaimProofEntry[] {
  const zk = (f.zkProof && f.zkProof.length === 8) ? f.zkProof : ZK_EMPTY;
  const sig = (f.actionSig && f.actionSig.length === 3) ? f.actionSig : SIG_EMPTY;
  const allZero =
    _isZeroHash(f.clickSessionHash) &&
    _isZeroHash(f.stakeRootUsed) &&
    _isZeroHash(f.nullifier) &&
    _isZeroHash(f.powNonce) &&
    zk.every(_isZeroHash) &&
    sig.every(_isZeroHash);
  if (allZero) return [];
  return [{
    clickSessionHash: f.clickSessionHash ?? ZeroHash,
    stakeRootUsed: f.stakeRootUsed ?? ZeroHash,
    nullifier: f.nullifier ?? ZeroHash,
    powNonce: f.powNonce ?? ZeroHash,
    zkProof: zk,
    actionSig: sig,
  }];
}

/** Convert a rich internal claim to the on-chain slim Claim wire shape. */
export function toSlimClaim(c: {
  publisher: string; eventCount: bigint; rateWei: bigint; actionType: number;
} & ProofFields): SlimClaim {
  return {
    publisher: c.publisher,
    eventCount: c.eventCount,
    rateWei: c.rateWei,
    actionType: c.actionType,
    proof: packProof(c),
  };
}

/**
 * Cosig claimsHash over slim claims, mirroring the contracts' _hashClaims
 * (DatumDualSigSettlement / DatumRelay / DatumAttestationVerifier):
 *   keccak256( concat_i keccak256(abi.encode(slimClaim_i)) )
 * Replaces the old keccak(abi.encodePacked(claim.claimHash[])) — claimHash is
 * no longer on the wire.
 */
export function contentHashClaims(slimClaims: SlimClaim[]): string {
  const hashes = slimClaims.map((c) => keccak256(_abi.encode([SLIM_CLAIM_TUPLE], [c])));
  return keccak256("0x" + hashes.map((h) => h.slice(2)).join(""));
}
