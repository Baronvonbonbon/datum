// ZK proof stub — generates a dummy proof that satisfies the DatumZKVerifier stub.
// DatumZKVerifier.verify() returns proof.length > 0, so any non-empty bytes work.
// Real Groth16 circuit replaces this in P9 post-alpha.

/**
 * Generate a stub ZK proof from a behavior commitment hash.
 * Returns "0x01" + commitment (satisfies stub verifier).
 */
export function generateStubProof(behaviorCommit: string): string {
  // Strip "0x" prefix from commitment and prepend 0x01
  const commitHex = behaviorCommit.startsWith("0x")
    ? behaviorCommit.slice(2)
    : behaviorCommit;
  return "0x01" + commitHex;
}
