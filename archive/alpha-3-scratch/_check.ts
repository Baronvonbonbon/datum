import { network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface } from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as path from "path";
import * as fs from "fs";

const FRANK_KEY = "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c";
const ALICE_KEY = "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8";
const BOB_KEY   = "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52";
const GRACE_KEY = "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235";

async function main() {
  const rpcUrl = (network.config as any).url;
  const p = new JsonRpcProvider(rpcUrl);
  const frank = new Wallet(FRANK_KEY, p);
  const alice = new Wallet(ALICE_KEY, p);
  const bob   = new Wallet(BOB_KEY, p);
  const grace = new Wallet(GRACE_KEY, p);

  console.log("Frank:", frank.address, formatDOT(await p.getBalance(frank.address)), "PAS");
  console.log("Alice:", alice.address, formatDOT(await p.getBalance(alice.address)), "PAS");
  console.log("Bob  :", bob.address,   formatDOT(await p.getBalance(bob.address)),   "PAS");
  console.log("Grace:", grace.address, formatDOT(await p.getBalance(grace.address)), "PAS");

  const addrFile = path.join(__dirname, "..", "deployed-addresses.json");
  const A = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  const govIface = new Interface(["function quorumWeighted() view returns (uint256)"]);
  const data = govIface.encodeFunctionData("quorumWeighted", []);
  const raw = await p.call({ to: A.governanceV2, data });
  const q = BigInt(govIface.decodeFunctionResult("quorumWeighted", raw)[0]);
  console.log("quorumWeighted:", formatDOT(q), "DOT =", q.toString(), "planck");

  // Test blake2 precompile
  const SYSTEM = "0x0000000000000000000000000000000000000900";
  const sysCode = await p.getCode(SYSTEM);
  console.log("0x900 code present:", sysCode.length > 2);
  if (sysCode.length > 2) {
    const iface = new Interface(["function hashBlake256(bytes) view returns (bytes32)"]);
    const d = iface.encodeFunctionData("hashBlake256", ["0x4142434445"]);
    try {
      const r = await p.call({ to: SYSTEM, data: d });
      console.log("blake256(ABCDE):", r);
    } catch(e) {
      console.log("blake256 call err:", String(e).slice(0,150));
    }
  }

  // Check claim hash mismatch — what does ClaimValidator compute for a dummy claim?
  const cvIface = new Interface([
    "function validateClaim((uint256 campaignId,address publisher,uint256 impressionCount,uint256 clearingCpmPlanck,uint256 nonce,bytes32 previousClaimHash,bytes32 claimHash,bytes zkProof) claim, address user, uint256 expectedNonce, bytes32 expectedPrevHash) view returns (bool valid, uint16 reason, uint256 payout, bytes32 computedHash)"
  ]);
  // Use a dummy claim to see what hash is computed
  const { solidityPackedKeccak256, ZeroHash, ZeroAddress } = await import("ethers");
  const cid = 4n, pub = "0x92622970Bd48dD26c53bCCd09Aa6a0245dbc7620" /*frank*/, usr = grace.address;
  const imps = 100n, cpm = parseDOT("0.5"), nonce = 1n;
  const kHash = solidityPackedKeccak256(
    ["uint256","address","address","uint256","uint256","uint256","bytes32"],
    [cid, pub, usr, imps, cpm, nonce, ZeroHash]
  );
  console.log("keccak256 hash:", kHash);
  const dummyClaim = { campaignId: cid, publisher: pub, impressionCount: imps, clearingCpmPlanck: cpm, nonce, previousClaimHash: ZeroHash, claimHash: kHash, zkProof: "0x" };
  try {
    const cvd = cvIface.encodeFunctionData("validateClaim", [dummyClaim, usr, 1n, ZeroHash]);
    const cvr = await p.call({ to: A.claimValidator, data: cvd });
    const res = cvIface.decodeFunctionResult("validateClaim", cvr);
    console.log("validateClaim result: valid=", res[0], "reason=", res[1].toString(), "computedHash=", res[3]);
  } catch(e) {
    console.log("validateClaim err:", String(e).slice(0,200));
  }
}
main().catch(console.error);
