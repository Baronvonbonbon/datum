// Shared claim-hash helper.
//
// L-2: alpha-4 ClaimValidator computes the 9-field claim preimage with abi.encode
// (32-byte aligned). Off-chain mirrors must use the same encoding — this helper
// is the single source of truth for tests and scripts.

import { ethers } from "hardhat";

const _abiCoder = ethers.AbiCoder.defaultAbiCoder();

/** keccak256 of abi.encode(types, values). Matches DatumClaimValidator on EVM. */
export function ethersKeccakAbi(types: string[], values: unknown[]): string {
  return ethers.keccak256(_abiCoder.encode(types, values));
}
