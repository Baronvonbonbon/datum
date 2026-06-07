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
