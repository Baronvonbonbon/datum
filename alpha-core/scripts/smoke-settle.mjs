// End-to-end settle smoke for the slim spine. Proves the deployed+seeded spine
// actually settles via the gasless relay path (user signs off-chain; publisher
// submits + pays gas), then credits PaymentVault. Read-only staticCall guards the
// real tx so a bad batch costs no gas.
//
//   node scripts/smoke-settle.mjs            # campaign 1, user=Bob, publisher=Diana
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, Interface, AbiCoder, keccak256, ZeroHash, toBeHex } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
const ZERO = "0x0000000000000000000000000000000000000000";
const CID = BigInt(process.env.CID || 1);
const ACTION = 0;                 // view claim
const RATE = 5n * 10n ** 17n;     // 0.5 PAS — matches the seeded campaign pot rate
const EVENTS = 2n;                // payment = RATE*EVENTS/1000 = 0.001 PAS
const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 };

const RELAY_ABI = [{
  inputs: [{ type: "tuple[]", name: "batches", components: [
    { type: "address", name: "user" }, { type: "uint256", name: "campaignId" }, { type: "uint256", name: "firstNonce" },
    { type: "tuple[]", name: "claims", components: [
      { type: "address", name: "publisher" }, { type: "uint256", name: "eventCount" }, { type: "uint256", name: "rateWei" }, { type: "uint8", name: "actionType" },
      { type: "tuple[]", name: "proof", components: [
        { type: "bytes32", name: "clickSessionHash" }, { type: "bytes32", name: "stakeRootUsed" }, { type: "bytes32", name: "nullifier" },
        { type: "bytes32", name: "powNonce" }, { type: "bytes32[8]", name: "zkProof" }, { type: "bytes32[3]", name: "actionSig" },
      ]},
    ]},
    { type: "uint256", name: "deadlineBlock" }, { type: "address", name: "expectedRelaySigner" }, { type: "address", name: "expectedAdvertiserRelaySigner" },
    { type: "bytes", name: "userSig" }, { type: "bytes", name: "publisherSig" }, { type: "bytes", name: "advertiserSig" },
  ]}],
  name: "settleClaimsFor",
  outputs: [{ type: "tuple", name: "result", components: [
    { type: "uint256", name: "settledCount" }, { type: "uint256", name: "rejectedCount" }, { type: "uint256", name: "totalPaid" },
  ]}],
  stateMutability: "nonpayable", type: "function",
}];
const SETTLEMENT_ABI = [
  "function lastNonce(address user, uint256 campaignId, uint8 actionType) view returns (uint256)",
  "function lastClaimHash(address user, uint256 campaignId, uint8 actionType) view returns (bytes32)",
];
const POW_ABI = [
  "function enforcePow() view returns (bool)",
  "function powTargetForUser(address user, uint256 eventCount) view returns (uint256)",
];

// Mirror DatumClaimValidator: claimHash = keccak256(abi.encode(...derived...)).
function computeClaimHash({ campaignId, publisher, user, eventCount, rateWei, actionType, nonce, prevHash }) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
    [campaignId, publisher, user, eventCount, rateWei, actionType, ZeroHash, nonce, prevHash, ZeroHash],
  ));
}
// PoW: find powNonce s.t. keccak256(abi.encodePacked(claimHash, powNonce)) <= target.
function solvePow(claimHash, target) {
  for (let i = 0n; i < 5_000_000n; i++) {
    const powNonce = toBeHex(i, 32);
    if (BigInt(keccak256(claimHash + powNonce.slice(2))) <= target) return { powNonce, iters: i };
  }
  throw new Error("PoW not solved in 5M iters");
}
const VAULT_ABI = ["function userBalance(address) view returns (uint256)", "function publisherBalance(address) view returns (uint256)"];

async function waitNonce(p, addr, prev, t = 90) { for (let i = 0; i < t; i++) { if ((await p.getTransactionCount(addr)) > prev) return; await new Promise(r => setTimeout(r, 2000)); } throw new Error("nonce stuck"); }

async function main() {
  for (const k of ["relay", "settlement", "paymentVault"]) if (!A[k]) throw new Error("missing " + k);
  const p = new JsonRpcProvider(RPC);
  const { chainId } = await p.getNetwork();
  const user = new Wallet(process.env.BOB_PRIVATE_KEY, p);       // signs off-chain, pays no gas
  const publisher = new Wallet(process.env.DIANA_PRIVATE_KEY, p); // registered publisher, submits + pays gas

  const settlement = new Contract(A.settlement, SETTLEMENT_ABI, p);
  const vault = new Contract(A.paymentVault, VAULT_ABI, p);
  const relayIface = new Interface(RELAY_ABI);
  const relay = new Contract(A.relay, RELAY_ABI, publisher);

  const firstNonce = (await settlement.lastNonce(user.address, CID, ACTION)) + 1n;
  const deadline = BigInt(await p.getBlockNumber()) + 100n;
  console.log(`smoke settle — campaign ${CID}  user ${user.address}  publisher ${publisher.address}`);
  console.log(`  firstNonce ${firstNonce}  rate ${RATE} wei  events ${EVENTS}  → payment ${(RATE * EVENTS) / 1000n} wei (0.001 PAS)`);

  // PoW gate (enforced at launch): solve a nonce for this claim's derived hash.
  const pow = new Contract(A.powEngine, POW_ABI, p);
  let proof = [];
  if (await pow.enforcePow()) {
    const prevHash = await settlement.lastClaimHash(user.address, CID, ACTION); // ZeroHash at genesis
    const claimHash = computeClaimHash({
      campaignId: CID, publisher: publisher.address, user: user.address,
      eventCount: EVENTS, rateWei: RATE, actionType: ACTION, nonce: firstNonce, prevHash,
    });
    const target = await pow.powTargetForUser(user.address, EVENTS);
    const { powNonce, iters } = solvePow(claimHash, target);
    console.log(`  PoW enforced — solved in ${iters} iters (powNonce ${powNonce.slice(0, 10)}…)`);
    proof = [{
      clickSessionHash: ZeroHash, stakeRootUsed: ZeroHash, nullifier: ZeroHash,
      powNonce, zkProof: Array(8).fill(ZeroHash), actionSig: Array(3).fill(ZeroHash),
    }];
  }
  const claim = { publisher: publisher.address, eventCount: EVENTS, rateWei: RATE, actionType: ACTION, proof };

  // User signs the nonce-range ClaimBatch over the DatumRelay EIP-712 domain.
  const domain = { name: "DatumRelay", version: "1", chainId, verifyingContract: A.relay };
  const types = { ClaimBatch: [
    { name: "user", type: "address" }, { name: "campaignId", type: "uint256" }, { name: "firstNonce", type: "uint256" },
    { name: "lastNonce", type: "uint256" }, { name: "claimCount", type: "uint256" }, { name: "deadlineBlock", type: "uint256" },
  ]};
  const userSig = await user.signTypedData(domain, types, {
    user: user.address, campaignId: CID, firstNonce, lastNonce: firstNonce, claimCount: 1n, deadlineBlock: deadline,
  });

  const batch = {
    user: user.address, campaignId: CID, firstNonce, claims: [claim], deadlineBlock: deadline,
    expectedRelaySigner: ZERO, expectedAdvertiserRelaySigner: ZERO,
    userSig, publisherSig: "0x", advertiserSig: "0x",
  };

  // Guard: read-only simulate first.
  const sim = await relay.settleClaimsFor.staticCall([batch]);
  console.log(`  staticCall → settled ${sim.settledCount}  rejected ${sim.rejectedCount}  totalPaid ${sim.totalPaid}`);
  if (sim.settledCount !== 1n) { console.error("  ✗ staticCall did not settle — aborting (no gas spent)."); process.exit(1); }

  const uBefore = await vault.userBalance(user.address);
  const pBefore = await vault.publisherBalance(publisher.address);

  const nonce = await p.getTransactionCount(publisher.address);
  const tx = await publisher.sendTransaction({ to: A.relay, data: relayIface.encodeFunctionData("settleClaimsFor", [[batch]]), ...GAS });
  console.log(`  settleClaimsFor tx ${tx.hash}`);
  await waitNonce(p, publisher.address, nonce);

  const uAfter = await vault.userBalance(user.address);
  const pAfter = await vault.publisherBalance(publisher.address);
  console.log(`  PaymentVault user      ${uBefore} → ${uAfter}  (+${uAfter - uBefore})`);
  console.log(`  PaymentVault publisher ${pBefore} → ${pAfter}  (+${pAfter - pBefore})`);
  const ok = uAfter > uBefore && pAfter > pBefore;
  console.log(ok ? "\n✅ E2E SETTLE SMOKE PASSED — spine settles + credits PaymentVault." : "\n✗ balances did not increase");
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error("ERR", e.message || e); process.exit(1); });
