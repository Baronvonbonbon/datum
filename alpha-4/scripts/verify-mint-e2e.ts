// End-to-end DATUM-mint verification: deploys the token stack, wires it,
// runs a real settleClaims batch, and verifies both the engine state +
// WDATUM balances. Confirms the Path H mechanism is firing on real
// settlements (not just unit tests).
//
// Prereqs:
//   1. npx hardhat node (running on localhost:8545)
//   2. DEPLOYER_PRIVATE_KEY=<alice> npx hardhat run scripts/deploy.ts --network localhost
//   3. DEPLOYER_PRIVATE_KEY=<alice> npx hardhat run scripts/setup-testnet.ts --network localhost
//
// Run:
//   DEPLOYER_PRIVATE_KEY=<alice> npx hardhat run scripts/verify-mint-e2e.ts --network localhost

import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import { parseDOT } from "../test/helpers/dot";
import fs from "fs";
import path from "path";

const ALICE_KEY  = "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8"; // deployer
const DIANA_KEY  = "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0"; // publisher
const BOB_KEY    = "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52"; // advertiser
// fresh user; we'll fund from Alice.
const USER_KEY   = "0xd5c2b5c1f5d3e1a7b9e0c8a6f4d2c0a8e6b4928071e9d7b5c3a1f0d8b6e4c2a0";

const ASSET_ID = 31337n;

async function main() {
  const provider = new JsonRpcProvider("http://127.0.0.1:8545");
  const alice = new Wallet(ALICE_KEY, provider);
  const diana = new Wallet(DIANA_KEY, provider);
  const bob   = new Wallet(BOB_KEY, provider);
  const user  = new Wallet(USER_KEY, provider);

  const addrFile = path.join(__dirname, "..", "deployed-addresses.json");
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  if (!addrs.emissionEngine) throw new Error("emissionEngine missing — run deploy.ts first");

  console.log("=== Stage 0: Fund the test user ===");
  await (await alice.sendTransaction({ to: user.address, value: ethers.parseEther("100") })).wait();
  console.log(`user funded: ${ethers.formatEther(await provider.getBalance(user.address))} ETH`);

  console.log("\n=== Stage 1: Deploy token stack ===");
  // Local nonce counter; ethers Wallet on hardhat sometimes returns stale
  // getTransactionCount even with "pending" tag, so just bump manually.
  const nonces: Record<string, number> = {};
  async function nextNonce(addr: string): Promise<number> {
    if (nonces[addr] === undefined) {
      nonces[addr] = await provider.getTransactionCount(addr, "pending");
    }
    return nonces[addr]++;
  }
  async function rawDeploy(name: string, args: any[] = []): Promise<string> {
    const F = await ethers.getContractFactory(name);
    const deployTx = await F.getDeployTransaction(...args);
    const nonce = await nextNonce(alice.address);
    const tx = await alice.sendTransaction({ data: deployTx.data, nonce, gasLimit: 15000000n });
    const r = await tx.wait();
    return r!.contractAddress!;
  }

  const precompileAddr = await rawDeploy("AssetHubPrecompileMock");
  console.log(`AssetHubPrecompileMock: ${precompileAddr}`);
  const precompile = await ethers.getContractAt("AssetHubPrecompileMock", precompileAddr, alice);

  const authorityAddr = await rawDeploy("DatumMintAuthority", [precompileAddr, ASSET_ID]);
  console.log(`DatumMintAuthority   : ${authorityAddr}`);
  const authority = await ethers.getContractAt("DatumMintAuthority", authorityAddr, alice);

  // registerAsset on precompile
  {
    const iface = precompile.interface;
    const data = iface.encodeFunctionData("registerAsset", [ASSET_ID, authorityAddr, "DATUM", "DATUM", 10]);
    const nonce = await nextNonce(alice.address);
    await (await alice.sendTransaction({ to: precompileAddr, data, nonce, gasLimit: 15000000n })).wait();
  }

  const wrapperAddr = await rawDeploy("DatumWrapper", [authorityAddr, precompileAddr, ASSET_ID, true]);
  console.log(`DatumWrapper         : ${wrapperAddr}`);
  const wrapper = await ethers.getContractAt("DatumWrapper", wrapperAddr, alice);

  console.log("\n=== Stage 2: Wire token stack ===");
  async function rawCall(to: string, iface: any, method: string, args: any[]) {
    const data = iface.encodeFunctionData(method, args);
    const nonce = await nextNonce(alice.address);
    await (await alice.sendTransaction({ to, data, nonce, gasLimit: 15000000n })).wait();
  }
  await rawCall(authorityAddr, authority.interface, "setWrapper", [wrapperAddr]);
  console.log(`authority.setWrapper(wrapper) ✓`);
  await rawCall(authorityAddr, authority.interface, "setSettlement", [addrs.settlement]);
  console.log(`authority.setSettlement(settlement) ✓`);

  const settlement = await ethers.getContractAt("DatumSettlement", addrs.settlement, alice);
  const currentAuthority = await settlement.mintAuthority();
  if (currentAuthority === ethers.ZeroAddress) {
    await rawCall(addrs.settlement, settlement.interface, "setMintAuthority", [authorityAddr]);
    console.log(`settlement.setMintAuthority(authority) ✓`);
  } else {
    console.log(`settlement.mintAuthority already set to ${currentAuthority}`);
  }

  console.log("\n=== Stage 3: Engine state BEFORE mint ===");
  const engine = await ethers.getContractAt("DatumEmissionEngine", addrs.emissionEngine);
  const before = {
    totalMinted: await engine.totalMinted(),
    remainingDailyCap: await engine.remainingDailyCap(),
    remainingEpochBudget: await engine.remainingEpochBudget(),
    currentRate: await engine.currentRate(),
    cumulativeDot: await engine.cumulativeDotThisAdjustmentPeriod(),
  };
  console.log(before);

  console.log("\n=== Stage 4: Create + activate a fresh test campaign ===");
  const campaigns = await ethers.getContractAt("DatumCampaigns", addrs.campaigns);
  const activationBonds = await ethers.getContractAt("DatumActivationBonds", addrs.activationBonds);

  const BUDGET = parseDOT("10");
  const DAILY  = parseDOT("5");
  const CPM    = parseDOT("0.5");
  const pots = [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }];
  const activationBond = parseDOT("0.5");
  const totalValue = BUDGET + activationBond;

  // Bob creates the campaign — raw send with explicit nonce
  {
    const data = campaigns.interface.encodeFunctionData("createCampaignWithActivation",
      [diana.address, pots, [], false, ethers.ZeroAddress, 0n, 0n, activationBond]);
    const nonce = await nextNonce(bob.address);
    await (await bob.sendTransaction({ to: addrs.campaigns, data, value: totalValue, nonce, gasLimit: 15000000n })).wait();
  }
  const cid = (await campaigns.nextCampaignId()) - 1n;
  console.log(`campaign ${cid} created (publisher Diana, CPM 0.5 DOT, budget 10 DOT)`);

  const tlBlocks = await activationBonds.timelockBlocks();
  console.log(`waiting ${tlBlocks} blocks for activation timelock...`);
  await provider.send("hardhat_mine", ["0x" + Number(tlBlocks).toString(16)]);

  // Activate — anyone can call after timelock
  {
    const data = activationBonds.interface.encodeFunctionData("activate", [cid]);
    const nonce = await nextNonce(alice.address);
    await (await alice.sendTransaction({ to: addrs.activationBonds, data, nonce, gasLimit: 15000000n })).wait();
  }
  const status = await campaigns.getCampaignStatus(cid);
  console.log(`campaign status after activate: ${status} (1 = Active)`);
  if (status !== 1n) throw new Error("campaign did not reach Active");

  console.log("\n=== Stage 5: User settles 1 claim × 100 impressions ===");
  // Build the Claim struct manually. Required fields (per IDatumSettlement):
  //   campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash,
  //   nonce, previousClaimHash, claimHash, zkProof[8], nullifier, stakeRootUsed, actionSig[3], powNonce
  //
  // claimHash = keccak(abi.encode(10 fields incl stakeRootUsed))

  const claim = {
    campaignId: cid,
    publisher: diana.address,
    user: user.address,
    eventCount: 100n,
    ratePlanck: CPM,
    actionType: 0,
    clickSessionHash: ethers.ZeroHash,
    nonce: 1n,
    previousClaimHash: ethers.ZeroHash,
    claimHash: ethers.ZeroHash,
    zkProof: new Array(8).fill(ethers.ZeroHash),
    nullifier: ethers.ZeroHash,
    stakeRootUsed: ethers.ZeroHash,
    actionSig: new Array(3).fill(ethers.ZeroHash),
    powNonce: ethers.ZeroHash,
  };
  claim.claimHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256","address","address","uint256","uint256","uint8","bytes32","uint256","bytes32","bytes32"],
    [claim.campaignId, claim.publisher, claim.user, claim.eventCount, claim.ratePlanck, claim.actionType,
     claim.clickSessionHash, claim.nonce, claim.previousClaimHash, claim.stakeRootUsed],
  ));

  // Mine a valid powNonce. Default shift = 8, target ≈ 2^248 / eventCount.
  // For a fresh user with empty bucket and 100 events, ~25k hashes on average.
  const settlementForPow = await ethers.getContractAt("DatumSettlement", addrs.settlement);
  const target = await settlementForPow.powTargetForUser(user.address, claim.eventCount);
  console.log(`mining powNonce (target ${target.toString(16).slice(0, 16)}...)`);
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const h = BigInt(ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [claim.claimHash, candidate])));
    if (h <= target) {
      claim.powNonce = candidate;
      console.log(`powNonce mined after ${i} attempts: ${candidate.slice(0, 10)}...`);
      break;
    }
  }
  if (claim.powNonce === ethers.ZeroHash) throw new Error("powNonce mining failed");

  const settlementForRead = await ethers.getContractAt("DatumSettlement", addrs.settlement);
  // Raw send with explicit nonce to avoid signer-cache issues
  const settleData = settlementForRead.interface.encodeFunctionData("settleClaims", [[{
    user: user.address,
    campaignId: cid,
    claims: [claim],
  }]]);
  const userNonce = await nextNonce(user.address);
  const settleTx = await user.sendTransaction({ to: addrs.settlement, data: settleData, nonce: userNonce, gasLimit: 15000000n });
  const settleR = await settleTx.wait();
  const settlementUser = settlementForRead;

  // Count Settled / Rejected events
  let settled = 0, rejected = 0; let rejReason = "";
  let mintedEvent: any = null;
  let mintComputed: any = null;
  const settleIface = settlementUser.interface;
  const engineIface = engine.interface;
  for (const log of settleR!.logs as any[]) {
    try {
      const p = settleIface.parseLog({ topics: log.topics, data: log.data });
      if (p?.name === "ClaimSettled") settled++;
      else if (p?.name === "ClaimRejected") { rejected++; rejReason = String(p.args.reasonCode ?? p.args[2]); }
      else if (p?.name === "DatumMintFailed") { mintedEvent = "FAILED"; }
    } catch {}
    try {
      const p = engineIface.parseLog({ topics: log.topics, data: log.data });
      if (p?.name === "MintComputed") {
        mintComputed = { dotPaid: p.args[0], rawMint: p.args[1], effectiveMint: p.args[2] };
      }
    } catch {}
  }
  console.log(`settled: ${settled}, rejected: ${rejected}${rejected ? ` (reason ${rejReason})` : ""}`);
  if (mintComputed) {
    console.log(`engine.MintComputed: dotPaid=${mintComputed.dotPaid}, raw=${mintComputed.rawMint}, effective=${mintComputed.effectiveMint}`);
  } else {
    console.log(`⚠ no MintComputed event — engine path may not have fired`);
  }

  console.log("\n=== Stage 6: Engine state AFTER mint ===");
  const after = {
    totalMinted: await engine.totalMinted(),
    remainingDailyCap: await engine.remainingDailyCap(),
    remainingEpochBudget: await engine.remainingEpochBudget(),
    currentRate: await engine.currentRate(),
    cumulativeDot: await engine.cumulativeDotThisAdjustmentPeriod(),
  };
  console.log(after);

  console.log("\n=== Stage 7: Diff ===");
  console.log(`totalMinted: ${before.totalMinted} → ${after.totalMinted} (Δ ${after.totalMinted - before.totalMinted})`);
  console.log(`remainingDailyCap: ${before.remainingDailyCap} → ${after.remainingDailyCap} (Δ -${before.remainingDailyCap - after.remainingDailyCap})`);
  console.log(`remainingEpochBudget: ${before.remainingEpochBudget} → ${after.remainingEpochBudget} (Δ -${before.remainingEpochBudget - after.remainingEpochBudget})`);
  console.log(`cumulativeDotThisAdjustmentPeriod: ${before.cumulativeDot} → ${after.cumulativeDot}`);

  console.log("\n=== Stage 8: WDATUM balances ===");
  console.log(`user      ${user.address}: ${await wrapper.balanceOf(user.address)} WDATUM`);
  console.log(`publisher ${diana.address}: ${await wrapper.balanceOf(diana.address)} WDATUM`);
  console.log(`advertiser${bob.address}: ${await wrapper.balanceOf(bob.address)} WDATUM`);

  // Final assertions
  const ok = (after.totalMinted as bigint) > (before.totalMinted as bigint)
          && (await wrapper.balanceOf(user.address) as bigint) > 0n;
  console.log(`\n=== ${ok ? "✓ END-TO-END MINT VERIFIED" : "✗ MINT DID NOT FIRE"} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
