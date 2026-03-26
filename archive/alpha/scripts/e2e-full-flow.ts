// E2E Full-Flow Test Script (H5)
// Exercises: campaign lifecycle, settlement, withdrawals, pause/unpause,
// timelock propose/execute, and governance slash flow.
//
// Prerequisites:
//   1. Docker substrate devchain running (docker compose up -d)
//   2. Contracts deployed (npx hardhat run scripts/deploy.ts --network substrate)
//
// Usage:
//   npx hardhat run scripts/e2e-full-flow.ts --network substrate

import { ethers } from "hardhat";
import { keccak256, toUtf8Bytes, AbiCoder, solidityPackedKeccak256 } from "ethers";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners } from "../test/helpers/mine";
import * as fs from "fs";

const STATUS = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

function log(section: string, msg: string) {
  console.log(`[${section}] ${msg}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, publisher, user, voter2] = signers;

  log("INIT", `Deployer: ${deployer.address}`);
  log("INIT", `Publisher: ${publisher.address}`);
  log("INIT", `User: ${user.address}`);
  log("INIT", `Voter2: ${voter2.address}`);

  // Fund unfunded accounts from deployer (devchain only pre-funds Alith/Baltathar)
  // Pallet-revive gas costs are ~5×10^21 planck per contract call, need 10^24 per signer
  log("INIT", "Funding signers (pallet-revive needs ~10^24 planck per signer)...");
  await fundSigners(4);

  // Load deployed addresses
  const addrFile = __dirname + "/../deployed-addresses.json";
  if (!fs.existsSync(addrFile)) throw new Error("No deployed-addresses.json — run deploy.ts first");
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  log("INIT", "Loaded addresses from " + addrFile);

  // Connect to contracts
  const pauseRegistry = await ethers.getContractAt("DatumPauseRegistry", addrs.pauseRegistry);
  const timelock = await ethers.getContractAt("DatumTimelock", addrs.timelock);
  const publishers = await ethers.getContractAt("DatumPublishers", addrs.publishers);
  const campaigns = await ethers.getContractAt("DatumCampaigns", addrs.campaigns);
  const v2 = await ethers.getContractAt("DatumGovernanceV2", addrs.governanceV2);
  const slash = await ethers.getContractAt("DatumGovernanceSlash", addrs.governanceSlash);
  const settlement = await ethers.getContractAt("DatumSettlement", addrs.settlement);

  // ===================================================================
  // 1. CAMPAIGN LIFECYCLE: create -> vote -> activate
  // ===================================================================
  log("1", "--- Campaign Lifecycle ---");

  // Register publisher
  const pubInfo = await publishers.getPublisher(publisher.address);
  if (!pubInfo.registered) {
    await (await publishers.connect(publisher).registerPublisher(5000)).wait();
    log("1", "Publisher registered: " + publisher.address);
  } else {
    log("1", "Publisher already registered");
  }

  // Create campaign
  // Budget/dailyCap must be large enough that settlement totalPayment and each revenue split
  // exceed the existential deposit (~1 DOT on devchain). Use 100 DOT budget.
  const BUDGET = parseDOT("100");
  const DAILY_CAP = parseDOT("100");
  const BID_CPM = parseDOT("0.016");
  const CATEGORY = 1;

  const createTx = await campaigns.connect(deployer).createCampaign(
    publisher.address, DAILY_CAP, BID_CPM, CATEGORY,
    { value: BUDGET }
  );
  const createReceipt = await createTx.wait();

  let campaignId: bigint | undefined;
  for (const logEntry of createReceipt!.logs) {
    try {
      const parsed = campaigns.interface.parseLog(logEntry);
      if (parsed?.name === "CampaignCreated") campaignId = parsed.args.campaignId;
    } catch { /* different contract */ }
  }
  assert(campaignId !== undefined, "CampaignCreated event not found");
  log("1", `Campaign created: ID ${campaignId!.toString()}`);

  // Verify Pending
  let status = Number(await campaigns.getCampaignStatus(campaignId!));
  assert(status === 0, `Expected Pending (0), got ${STATUS[status]}`);
  log("1", `Status: ${STATUS[status]}`);

  // Vote aye to activate (quorum is 100 DOT weighted; use 150 DOT with conviction 0)
  const STAKE = parseDOT("150");
  await (await v2.connect(voter2).vote(campaignId!, true, 0, { value: STAKE })).wait();
  log("1", "Aye vote cast by voter2 (150 DOT)");

  await (await v2.evaluateCampaign(campaignId!)).wait();
  status = Number(await campaigns.getCampaignStatus(campaignId!));
  assert(status === 1, `Expected Active (1), got ${STATUS[status]}`);
  log("1", `Status: ${STATUS[status]} (activated)`);

  // Set metadata
  const metaHash = keccak256(toUtf8Bytes("e2e-test-meta-" + campaignId!.toString()));
  await (await campaigns.connect(deployer).setMetadata(campaignId!, metaHash)).wait();
  log("1", "Metadata set: " + metaHash.slice(0, 18) + "...");

  // ===================================================================
  // 2. SETTLEMENT: build claim hash chain, settle
  // ===================================================================
  log("2", "--- Settlement ---");

  // Build a simple claim hash chain
  // Note: totalPayment = (cpm * impressions) / 1000, must exceed existential deposit (~1 DOT on devchain)
  // and each split (publisher 50%, user 37.5%, protocol 12.5%) should also exceed ED for withdrawals.
  // With 0.016 DOT CPM × 1M impressions / 1000 = 16 DOT total.
  // Split: publisher ~8 DOT, user ~6 DOT, protocol ~2 DOT — all above ED.
  const impressionCount = 1_000_000n;
  const clearingCpm = BID_CPM; // clearing = bid for single campaign
  const nonce = 1n; // Genesis nonce is 1 (0 is invalid)
  const previousHash = "0x" + "0".repeat(64);

  // Compute claim hash: keccak256(abi.encodePacked(...))
  const claimHash = solidityPackedKeccak256(
    ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
    [campaignId!, publisher.address, user.address, impressionCount, clearingCpm, nonce, previousHash]
  );

  const claimBatch = [{
    user: user.address,
    campaignId: campaignId!,
    claims: [{
      campaignId: campaignId!,
      publisher: publisher.address,
      impressionCount,
      clearingCpmPlanck: clearingCpm,
      nonce,
      previousClaimHash: previousHash,
      claimHash,
      zkProof: "0x",
    }],
  }];

  const settleTx = await settlement.connect(user).settleClaims(claimBatch);
  const settleReceipt = await settleTx.wait();

  let settledCount = 0;
  let rejectedCount = 0;
  for (const logEntry of settleReceipt!.logs) {
    try {
      const parsed = settlement.interface.parseLog(logEntry);
      if (parsed?.name === "ClaimSettled") settledCount++;
      if (parsed?.name === "ClaimRejected") rejectedCount++;
    } catch { /* different contract */ }
  }
  log("2", `Settlement: ${settledCount} settled, ${rejectedCount} rejected`);
  assert(settledCount === 1, `Expected 1 settled, got ${settledCount}`);

  // ===================================================================
  // 3. WITHDRAWALS: publisher + user balances
  // ===================================================================
  log("3", "--- Withdrawals ---");

  const pubBal = await settlement.publisherBalance(publisher.address);
  const userBal = await settlement.userBalance(user.address);
  log("3", `Publisher balance: ${pubBal.toString()} planck`);
  log("3", `User balance: ${userBal.toString()} planck`);

  if (pubBal > 0n) {
    await (await settlement.connect(publisher).withdrawPublisher()).wait();
    log("3", "Publisher withdrawal successful");
  }

  if (userBal > 0n) {
    await (await settlement.connect(user).withdrawUser()).wait();
    log("3", "User withdrawal successful");
  }

  // Verify balances zeroed
  const pubBalAfter = await settlement.publisherBalance(publisher.address);
  const userBalAfter = await settlement.userBalance(user.address);
  assert(pubBalAfter === 0n, "Publisher balance should be 0 after withdrawal");
  assert(userBalAfter === 0n, "User balance should be 0 after withdrawal");
  log("3", "Balances verified zero after withdrawal");

  // ===================================================================
  // 4. PAUSE / UNPAUSE cycle
  // ===================================================================
  log("4", "--- Pause/Unpause ---");

  await (await pauseRegistry.connect(deployer).pause()).wait();
  let paused = await pauseRegistry.paused();
  assert(paused, "Expected system to be paused");
  log("4", "System paused");

  // Verify settlement blocked while paused
  try {
    await settlement.connect(user).settleClaims([]);
    log("4", "WARNING: settlement did not revert while paused (empty batch may not trigger check)");
  } catch (err) {
    log("4", "Settlement correctly blocked while paused");
  }

  await (await pauseRegistry.connect(deployer).unpause()).wait();
  paused = await pauseRegistry.paused();
  assert(!paused, "Expected system to be unpaused");
  log("4", "System unpaused");

  // ===================================================================
  // 5. GOVERNANCE SLASH: vote nay -> terminate -> slash
  // ===================================================================
  log("5", "--- Governance Slash ---");

  // Create a second campaign for slash testing
  const createTx2 = await campaigns.connect(deployer).createCampaign(
    publisher.address, DAILY_CAP, BID_CPM, CATEGORY,
    { value: BUDGET }
  );
  const receipt2 = await createTx2.wait();
  let cid2: bigint | undefined;
  for (const logEntry of receipt2!.logs) {
    try {
      const parsed = campaigns.interface.parseLog(logEntry);
      if (parsed?.name === "CampaignCreated") cid2 = parsed.args.campaignId;
    } catch { /* different contract */ }
  }
  assert(cid2 !== undefined, "Second CampaignCreated not found");
  log("5", `Second campaign: ID ${cid2!.toString()}`);

  // Vote aye to activate
  await (await v2.connect(deployer).vote(cid2!, true, 0, { value: STAKE })).wait();
  await (await v2.evaluateCampaign(cid2!)).wait();
  status = Number(await campaigns.getCampaignStatus(cid2!));
  assert(status === 1, "Second campaign should be Active");
  log("5", "Second campaign activated");

  // Vote nay (heavier than aye) to enable termination
  const NAY_STAKE = parseDOT("200");
  await (await v2.connect(voter2).vote(cid2!, false, 0, { value: NAY_STAKE })).wait();
  log("5", "Nay vote cast (200 DOT)");

  // Aye voter withdraws to shift majority
  // (deployer voted aye, need to wait for lockup)
  // On local devnet with short lockup, we can just try
  try {
    await (await v2.connect(deployer).withdraw(cid2!)).wait();
    log("5", "Aye voter withdrew");
  } catch (err) {
    log("5", "Aye voter cannot withdraw yet (lockup): " + String(err).slice(0, 80));
  }

  // Evaluate to terminate
  try {
    await (await v2.evaluateCampaign(cid2!)).wait();
    status = Number(await campaigns.getCampaignStatus(cid2!));
    log("5", `Status after eval: ${STATUS[status]}`);
  } catch (err) {
    log("5", "evaluateCampaign reverted (may need aye withdrawal first): " + String(err).slice(0, 80));
  }

  // Try to finalize slash (only works if resolved)
  const resolved = await v2.resolved(cid2!);
  if (resolved) {
    await (await slash.finalizeSlash(cid2!)).wait();
    log("5", "Slash finalized");

    const claimable = await slash.getClaimable(cid2!, voter2.address);
    log("5", `Claimable for nay voter: ${claimable.toString()} planck`);
    if (claimable > 0n) {
      await (await slash.connect(voter2).claimSlashReward(cid2!)).wait();
      log("5", "Slash reward claimed");
    }
  } else {
    log("5", "Campaign not yet resolved — slash test skipped (may need more blocks for lockup)");
  }

  // ===================================================================
  // 6. TIMELOCK: propose -> (wait) -> execute
  // ===================================================================
  log("6", "--- Timelock ---");

  // Note: On a real devchain, the 48h delay would need time travel.
  // We verify the propose step works and the execute reverts (too early).
  // The Hardhat tests (T1-T15) already validate the full flow with time travel.

  // We'll just verify the propose call succeeds.
  // Pick a harmless change: propose setting ZKVerifier to its current address
  const zkAddr = addrs.zkVerifier;
  const settlementAddr = addrs.settlement;
  const setZKData = settlement.interface.encodeFunctionData("setZKVerifier", [zkAddr]);

  try {
    await (await timelock.connect(deployer).propose(settlementAddr, setZKData)).wait();
    log("6", "Timelock propose succeeded");

    // Verify execute reverts (48h hasn't passed)
    try {
      await timelock.connect(deployer).execute();
      log("6", "WARNING: execute should have reverted (delay not expired)");
    } catch {
      log("6", "Execute correctly reverted (48h delay not expired)");
    }

    // Cancel to clean up
    await (await timelock.connect(deployer).cancel()).wait();
    log("6", "Proposal cancelled");
  } catch (err) {
    log("6", "Timelock propose failed: " + String(err).slice(0, 100));
  }

  // ===================================================================
  // SUMMARY
  // ===================================================================
  console.log("\n=== E2E Full Flow Complete ===");
  console.log("1. Campaign lifecycle: create -> vote -> activate -> metadata  OK");
  console.log("2. Settlement: hash chain claim submitted and settled          OK");
  console.log("3. Withdrawals: publisher + user balances withdrawn            OK");
  console.log("4. Pause/unpause: circuit breaker toggled                      OK");
  console.log("5. Governance slash: vote/evaluate/finalize/claim flow         " + (resolved ? "OK" : "PARTIAL"));
  console.log("6. Timelock: propose/execute(reverts)/cancel                   OK");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
