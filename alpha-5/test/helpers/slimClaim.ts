import { ethers } from "hardhat";

// SLIM (#2b): shared helpers for the slim Claim wire format + optional proof sidecar.
// A plain view claim carries an empty `proof`. ZK/click/CPA/PoW claims carry one
// entry. The content-hash mirrors the contracts (DualSig/Relay/Attestation):
// keccak(abi.encode(slimClaim)) per claim, then keccak of the concatenation.

export const CLAIM_PROOF_TUPLE =
  "tuple(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)";
export const SLIM_CLAIM_TUPLE =
  `tuple(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,${CLAIM_PROOF_TUPLE}[] proof)`;

const Z = ethers.ZeroHash;

export interface ProofOpts {
  clickSessionHash?: string;
  stakeRootUsed?: string;
  nullifier?: string;
  powNonce?: string;
  zkProof?: string[];
  actionSig?: string[];
}

/** Build a single-entry proof sidecar; unset fields default to zero. */
export function mkProof(o: ProofOpts) {
  return [{
    clickSessionHash: o.clickSessionHash ?? Z,
    stakeRootUsed: o.stakeRootUsed ?? Z,
    nullifier: o.nullifier ?? Z,
    powNonce: o.powNonce ?? Z,
    zkProof: o.zkProof ?? new Array(8).fill(Z),
    actionSig: o.actionSig ?? new Array(3).fill(Z),
  }];
}

/**
 * The on-chain-derived claim hash (9-field preimage), mirroring
 * DatumClaimValidator.validateClaimWithContext. Needed wherever a test must
 * predict the hash the contract computes (e.g. PoW solving), since the claim
 * no longer carries it.
 */
export function computeClaimHash(args: {
  campaignId: bigint;
  publisher: string;
  user: string;
  eventCount: bigint;
  rateWei: bigint;
  actionType: number;
  nonce: bigint;
  clickSessionHash?: string;
  prevHash?: string;
  stakeRootUsed?: string;
}): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
    [args.campaignId, args.publisher, args.user, args.eventCount, args.rateWei, args.actionType,
     args.clickSessionHash ?? Z, args.nonce, args.prevHash ?? Z, args.stakeRootUsed ?? Z]
  ));
}

/** keccak(abi.encode(slimClaim)) per claim, then keccak of the concatenation. */
export function contentHashClaims(claims: any[]): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const hashes = claims.map((c) => ethers.keccak256(coder.encode([SLIM_CLAIM_TUPLE], [c])));
  return ethers.keccak256(ethers.concat(hashes));
}
