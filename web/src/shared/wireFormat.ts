// wireFormat — SINGLE SOURCE OF TRUTH for the DATUM claim wire format + the
// EIP-712 settlement typehashes (RUNBOOK Phase 3). Every off-chain consumer
// (web demo-daemon, extension, relay-bot, seed scripts, indexer) must derive its
// EIP-712 signing types and slim-claim shape from HERE, not from inline copies.
//
// Why: typehash drift between the contracts and the off-chain signers is silent
// until a batch is rejected on-chain (E31/E34). This module is pinned to the
// deployed contracts by `web/test/wireFormat.test.ts`, which reads the typehash
// STRINGS straight out of the Solidity sources and asserts they reconstruct
// exactly from the field arrays below. Change a contract typehash → that test
// fails until this module is updated → every importing consumer follows.

export type Eip712Field = { name: string; type: string };

/** EIP-712 encodeType string for a single (non-nested) struct: `Name(type name,…)`. */
export function eip712TypeString(typeName: string, fields: readonly Eip712Field[]): string {
  return `${typeName}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

// ── SLIM (#2) claim wire ──────────────────────────────────────────────────────
// The on-chain Claim carries only pure content; campaignId/nonce/prevHash/
// claimHash are derived on-chain, path-specific material lives in an optional
// `proof` sidecar, and the batch carries `firstNonce` (== on-chain lastNonce+1).
export const SLIM_CLAIM_FIELDS = ["publisher", "eventCount", "rateWei", "actionType", "proof"] as const;

// ── EIP-712 settlement types (pinned to the contracts) ────────────────────────

/** Publisher attestation — signed on BOTH the DatumAttestationVerifier domain
 *  (extension path) and the DatumRelay domain (relay path). Same field layout. */
export const PUBLISHER_ATTESTATION_FIELDS: readonly Eip712Field[] = [
  { name: "campaignId", type: "uint256" },
  { name: "user", type: "address" },
  { name: "firstNonce", type: "uint256" },
  { name: "claimsHash", type: "bytes32" },
  { name: "deadlineBlock", type: "uint256" },
];

/** Relay-path user signature (DatumRelay BATCH_TYPEHASH): the user signs the
 *  nonce RANGE for the batch. */
export const RELAY_CLAIM_BATCH_FIELDS: readonly Eip712Field[] = [
  { name: "user", type: "address" },
  { name: "campaignId", type: "uint256" },
  { name: "firstNonce", type: "uint256" },
  { name: "lastNonce", type: "uint256" },
  { name: "claimCount", type: "uint256" },
  { name: "deadlineBlock", type: "uint256" },
];

/** Dual-sig path (DatumDualSigSettlement CLAIM_BATCH_TYPEHASH): publisher +
 *  advertiser co-sign over the content claimsHash + the relay/advertiser signer
 *  bindings. */
export const DUAL_SIG_CLAIM_BATCH_FIELDS: readonly Eip712Field[] = [
  { name: "user", type: "address" },
  { name: "campaignId", type: "uint256" },
  { name: "firstNonce", type: "uint256" },
  { name: "claimsHash", type: "bytes32" },
  { name: "deadlineBlock", type: "uint256" },
  { name: "expectedRelaySigner", type: "address" },
  { name: "expectedAdvertiserRelaySigner", type: "address" },
];

/** Ready-to-use ethers `types` maps for signTypedData. */
export const PUBLISHER_ATTESTATION_TYPES = { PublisherAttestation: PUBLISHER_ATTESTATION_FIELDS };
export const RELAY_CLAIM_BATCH_TYPES = { ClaimBatch: RELAY_CLAIM_BATCH_FIELDS };
export const DUAL_SIG_CLAIM_BATCH_TYPES = { ClaimBatch: DUAL_SIG_CLAIM_BATCH_FIELDS };

/** Canonical encodeType strings — these must equal the Solidity typehash
 *  preimages (asserted in wireFormat.test.ts). */
export const TYPEHASH_STRINGS = {
  PublisherAttestation: eip712TypeString("PublisherAttestation", PUBLISHER_ATTESTATION_FIELDS),
  RelayClaimBatch: eip712TypeString("ClaimBatch", RELAY_CLAIM_BATCH_FIELDS),
  DualSigClaimBatch: eip712TypeString("ClaimBatch", DUAL_SIG_CLAIM_BATCH_FIELDS),
} as const;
