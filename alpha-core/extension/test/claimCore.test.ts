import { ZeroHash } from "ethers";
import {
  computeClaimHash,
  CLAIM_HASH_TYPES,
  nonceToBytes32,
  parseSigToArray,
  ZK_EMPTY,
  SIG_EMPTY,
} from "../src/background/claimCore";

describe("claimCore", () => {
  // GOLDEN: pins the claim-hash preimage to DatumClaimValidator.sol validateClaim()
  // (keccak256(abi.encode(campaignId, publisher, user, eventCount, rateWei,
  //  actionType, clickSessionHash, nonce, previousClaimHash, stakeRootUsed))).
  // If CLAIM_HASH_TYPES changes, this breaks — re-verify against the contract before
  // updating the constant. This guard would have caught the 9-field drift that made
  // every demo claim revert with code 10.
  const GOLDEN = "0x2e4c2ac369b3fffecf698a03a03520d9f78c970497240cad233e503c92f2a91e";
  const base = {
    campaignId: 85n,
    publisher: "0x00000000000000000000000000000000000000a9",
    user: "0x00000000000000000000000000000000000000ae",
    eventCount: 3n,
    rateWei: 6605036446n,
    actionType: 0,
    clickSessionHash: ZeroHash,
    nonce: 1n,
    previousClaimHash: ZeroHash,
    stakeRootUsed: ZeroHash,
  };

  it("hashes the canonical 10-field schema", () => {
    expect(CLAIM_HASH_TYPES.length).toBe(10);
    expect(computeClaimHash(base)).toBe(GOLDEN);
  });

  it("defaults clickSessionHash + stakeRootUsed to ZeroHash", () => {
    const { clickSessionHash: _c, stakeRootUsed: _s, ...rest } = base;
    expect(computeClaimHash(rest)).toBe(GOLDEN);
  });

  it("changing any field changes the hash", () => {
    expect(computeClaimHash({ ...base, nonce: 2n })).not.toBe(GOLDEN);
    expect(computeClaimHash({ ...base, eventCount: 4n })).not.toBe(GOLDEN);
  });

  it("helpers", () => {
    expect(ZK_EMPTY).toHaveLength(8);
    expect(SIG_EMPTY).toHaveLength(3);
    expect(nonceToBytes32(1n)).toBe("0x" + "0".repeat(63) + "1");
    expect(parseSigToArray("0x")).toEqual(SIG_EMPTY);
  });
});
