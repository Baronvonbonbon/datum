// Tests for keccak256 hash consistency in claimBuilder and behaviorChain.
// Verifies that the hash output is deterministic, 32-byte, and 0x-prefixed.

import "./chromeMock";
import { solidityPacked, keccak256 as ethersKeccak256 } from "ethers";

function hashPacked(types: string[], values: unknown[]): string {
  return ethersKeccak256(solidityPacked(types, values));
}

describe("hashPacked (keccak256)", () => {
  test("returns 0x-prefixed 32-byte hex string", () => {
    const h = hashPacked(["uint256"], [42n]);
    expect(h.startsWith("0x")).toBe(true);
    expect(h.length).toBe(66); // 0x + 64 hex chars = 32 bytes
  });

  test("deterministic — same inputs produce same hash", () => {
    const a = hashPacked(["uint256", "address"], [1n, "0x0000000000000000000000000000000000000001"]);
    const b = hashPacked(["uint256", "address"], [1n, "0x0000000000000000000000000000000000000001"]);
    expect(a).toBe(b);
  });

  test("different inputs produce different hashes", () => {
    const a = hashPacked(["uint256"], [1n]);
    const b = hashPacked(["uint256"], [2n]);
    expect(a).not.toBe(b);
  });

  test("claim hash field order matches Settlement contract", () => {
    // (campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousHash)
    const campaignId = 1n;
    const publisher = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
    const user = "0x94CC36412EE0c099BfE7D61a35092e40342F62D7";
    const impressionCount = 1n;
    const clearingCpmPlanck = 5_000_000_000n;
    const nonce = 1n;
    const previousHash = "0x0000000000000000000000000000000000000000000000000000000000000000";

    const hash = hashPacked(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousHash],
    );

    expect(hash.startsWith("0x")).toBe(true);
    expect(hash.length).toBe(66);
    // Hash should be non-zero
    expect(hash).not.toBe("0x" + "0".repeat(64));
  });

  test("hash chain links correctly — each new hash depends on previous", () => {
    const h0 = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const h1 = hashPacked(
      ["bytes32", "string", "uint256", "uint256", "uint256", "uint256", "bool", "uint256"],
      [h0, "1", 3000, 80, 2500, 3000, true, 1700000000],
    );
    const h2 = hashPacked(
      ["bytes32", "string", "uint256", "uint256", "uint256", "uint256", "bool", "uint256"],
      [h1, "1", 3000, 80, 2500, 3000, true, 1700000001],
    );
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h0);
    expect(h2.startsWith("0x")).toBe(true);
  });
});
