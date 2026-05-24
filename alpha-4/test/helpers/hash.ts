// Shared claim-hash helper.
//
// L-2: alpha-4 ClaimValidator computes the claim preimage with abi.encode
// (32-byte aligned). Off-chain mirrors must use the same encoding — this
// helper is the single source of truth for tests and scripts.
//
// C1/C2 (2026-05-24): the preimage grew from 10 to 13 fields with the
// addition of `policyId` (uint8), `interestWeightBps` (uint16), and
// `auctionRootCommit` (bytes32) at the tail. For backwards compatibility
// with existing test call sites that still pass the 10-field schema,
// `ethersKeccakAbi` auto-pads the values array with zero defaults for the
// three new fields. Tests that want to exercise the new policy/transcript
// paths must populate the fields explicitly via the 13-field call.

import { ethers } from "hardhat";

const _abiCoder = ethers.AbiCoder.defaultAbiCoder();

const LEGACY_CLAIM_TYPES = [
  "uint256",
  "address",
  "address",
  "uint256",
  "uint256",
  "uint8",
  "bytes32",
  "uint256",
  "bytes32",
  "bytes32",
];
const NEW_FIELD_TYPES = ["uint8", "uint16", "bytes32"];

/** keccak256 of abi.encode(types, values). Matches DatumClaimValidator on EVM.
 *  If `types` matches the legacy 10-field claim schema, the call is
 *  transparently padded to the 13-field schema with C1/C2 zero defaults so
 *  existing tests keep working. */
export function ethersKeccakAbi(types: string[], values: unknown[]): string {
  if (types.length === LEGACY_CLAIM_TYPES.length &&
      types.every((t, i) => t === LEGACY_CLAIM_TYPES[i]) &&
      values.length === LEGACY_CLAIM_TYPES.length) {
    const newTypes = [...types, ...NEW_FIELD_TYPES];
    const newValues = [...values, 0, 0, ethers.ZeroHash];
    return ethers.keccak256(_abiCoder.encode(newTypes, newValues));
  }
  return ethers.keccak256(_abiCoder.encode(types, values));
}
