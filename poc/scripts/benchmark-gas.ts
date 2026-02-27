/**
 * Gas benchmarks for DATUM contracts on pallet-revive substrate.
 *
 * Measures weight (gas units) for six key functions:
 *   1. createCampaign
 *   2. voteAye
 *   3. voteNay
 *   4. settleClaims (1 claim)
 *   5. settleClaims (10 claims)
 *   6. withdrawPublisher
 *
 * Outputs a markdown table suitable for BENCHMARKS.md.
 * Run: npx hardhat run scripts/benchmark-gas.ts --network substrate
 */
import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners, isSubstrate } from "../test/helpers/mine";
import {
  DatumPublishers,
  DatumCampaigns,
  DatumGovernanceVoting,
  DatumGovernanceRewards,
  DatumSettlement,
} from "../typechain-types";

// ---------------------------------------------------------------------------
// Claim chain builder (mirrors test/settlement.test.ts)
// ---------------------------------------------------------------------------
function computeClaimHash(
  campaignId: bigint,
  publisher: string,
  user: string,
  impressionCount: bigint,
  clearingCpmPlanck: bigint,
  nonce: bigint,
  previousClaimHash: string
): string {
  // Must use solidityPackedKeccak256 to match abi.encodePacked in the contract
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
    [campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousClaimHash]
  );
}

function buildClaimChain(
  campaignId: bigint,
  publisher: string,
  user: string,
  count: number,
  cpm: bigint,
  impressions: bigint
) {
  const claims = [];
  let prevHash = ethers.ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const claimHash = computeClaimHash(campaignId, publisher, user, impressions, cpm, nonce, prevHash);
    claims.push({
      campaignId,
      publisher,
      impressionCount: impressions,
      clearingCpmPlanck: cpm,
      nonce,
      previousClaimHash: prevHash,
      claimHash,
      zkProof: "0x",
    });
    prevHash = claimHash;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const substrate = await isSubstrate();
  const net = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${net.chainId} substrate=${substrate}`);

  await fundSigners();
  const signers = await ethers.getSigners();
  const [owner, voter1, voter2, advertiser, publisher, user] = signers;

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1n;
  console.log(`gasPrice: ${gasPrice}\n`);

  // ---------------------------------------------------------------------------
  // Deploy all 5 contracts
  // ---------------------------------------------------------------------------
  console.log("Deploying contracts...");

  const TAKE_RATE_BPS = 5000;
  const ACTIVATION_THRESHOLD = parseDOT("1");
  const TERMINATION_THRESHOLD = parseDOT("2");
  const MIN_REVIEWER_STAKE = parseDOT("0.1");
  const BASE_LOCKUP = substrate ? 3n : 10n;
  const MAX_LOCKUP = substrate ? 30n : 100n;
  const TAKE_RATE_DELAY = substrate ? 3n : 10n;
  const PENDING_TIMEOUT = substrate ? 3n : 100n;
  const MIN_CPM_FLOOR = 0n;
  const BID_CPM = parseDOT("0.016"); // clean denomination
  const BUDGET = parseDOT("50");
  const DAILY_CAP = parseDOT("10");
  const IMPRESSIONS_1 = 1000n;
  const IMPRESSIONS_5 = 200n; // 5 claims × 200 impressions

  const PubFactory = await ethers.getContractFactory("DatumPublishers");
  const publishers: DatumPublishers = await PubFactory.deploy(TAKE_RATE_DELAY);

  const CampFactory = await ethers.getContractFactory("DatumCampaigns");
  const campaigns: DatumCampaigns = await CampFactory.deploy(
    MIN_CPM_FLOOR, PENDING_TIMEOUT, await publishers.getAddress()
  );

  const VotingFactory = await ethers.getContractFactory("DatumGovernanceVoting");
  const voting: DatumGovernanceVoting = await VotingFactory.deploy(
    await campaigns.getAddress(),
    ACTIVATION_THRESHOLD, TERMINATION_THRESHOLD,
    MIN_REVIEWER_STAKE, BASE_LOCKUP, MAX_LOCKUP
  );

  const RewardsFactory = await ethers.getContractFactory("DatumGovernanceRewards");
  const rewards: DatumGovernanceRewards = await RewardsFactory.deploy(
    await voting.getAddress(), await campaigns.getAddress()
  );

  const SettFactory = await ethers.getContractFactory("DatumSettlement");
  const settlement: DatumSettlement = await SettFactory.deploy(await campaigns.getAddress());

  // Wire
  await voting.setRewardsContract(await rewards.getAddress());
  await campaigns.setGovernanceContract(await voting.getAddress());
  await campaigns.setSettlementContract(await settlement.getAddress());

  // Register publisher
  await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);

  console.log("Contracts deployed and wired.\n");

  // ---------------------------------------------------------------------------
  // Helper to measure a tx
  // ---------------------------------------------------------------------------
  interface Measurement { gasUsed: bigint; label: string }
  const results: Measurement[] = [];

  async function measure(label: string, txPromise: Promise<any>): Promise<bigint> {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed as bigint;
    results.push({ label, gasUsed });
    console.log(`  ${label}: gasUsed=${gasUsed}`);
    return gasUsed;
  }

  // Parse campaign ID from CampaignCreated event in a receipt
  async function createCampaignAndGetId(signer: any): Promise<bigint> {
    const tx = await campaigns.connect(signer).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    const receipt = await tx.wait();
    const log = receipt!.logs.find((l: any) => {
      try { return campaigns.interface.parseLog({ topics: l.topics, data: l.data })?.name === "CampaignCreated"; }
      catch { return false; }
    });
    const parsed = campaigns.interface.parseLog({ topics: log!.topics as string[], data: log!.data });
    return parsed!.args[0] as bigint;
  }

  // ---------------------------------------------------------------------------
  // 1. createCampaign
  // ---------------------------------------------------------------------------
  console.log("1. createCampaign");
  {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, { value: BUDGET }
    );
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed as bigint;
    results.push({ label: "createCampaign", gasUsed });
    console.log(`  createCampaign: gasUsed=${gasUsed}`);
    const log = receipt!.logs.find((l: any) => {
      try { return campaigns.interface.parseLog({ topics: l.topics, data: l.data })?.name === "CampaignCreated"; }
      catch { return false; }
    });
    const parsed = campaigns.interface.parseLog({ topics: log!.topics as string[], data: log!.data });
    // cid1 not needed for further benchmarks
  }

  // Create campaigns for other benchmarks
  const cidVote = await createCampaignAndGetId(advertiser);
  const cidSettle1 = await createCampaignAndGetId(advertiser);
  const cidSettle10 = await createCampaignAndGetId(advertiser);

  // ---------------------------------------------------------------------------
  // 2. voteAye (also activates cidVote, cidSettle1, cidSettle10)
  // ---------------------------------------------------------------------------
  console.log("2. voteAye");
  // Use cidVote for the voteAye measurement (will be activated, then terminated in step 3)
  // Create a dedicated campaign for the voteAye measurement so cidVote stays Pending for step 3
  const cidAye = await createCampaignAndGetId(advertiser);
  await measure("voteAye", voting.connect(voter1).voteAye(cidAye, 0, { value: ACTIVATION_THRESHOLD }));

  // Activate the settle campaigns too
  await voting.connect(voter2).voteAye(cidSettle1, 0, { value: ACTIVATION_THRESHOLD });
  await voting.connect(voter2).voteAye(cidSettle10, 0, { value: ACTIVATION_THRESHOLD });

  // ---------------------------------------------------------------------------
  // 3. voteNay (terminates cidVote)
  // — first activate it
  // ---------------------------------------------------------------------------
  console.log("3. voteNay");
  await voting.connect(voter1).voteAye(cidVote, 0, { value: ACTIVATION_THRESHOLD });
  await measure("voteNay", voting.connect(voter2).voteNay(cidVote, 0, { value: TERMINATION_THRESHOLD }));

  // ---------------------------------------------------------------------------
  // 4. settleClaims — 1 claim
  // ---------------------------------------------------------------------------
  console.log("4. settleClaims (1 claim)");
  {
    const c1 = await campaigns.getCampaign(cidSettle1);
    console.log(`  cidSettle1=${cidSettle1} status=${c1.status} remainingBudget=${c1.remainingBudget}`);
  }
  const claims1 = buildClaimChain(cidSettle1, publisher.address, user.address, 1, BID_CPM, IMPRESSIONS_1);
  {
    // Static call first to see result
    try {
      const sr = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cidSettle1, claims: claims1 }
      ]);
      console.log(`  staticCall: settled=${sr.settledCount} rejected=${sr.rejectedCount} totalPaid=${sr.totalPaid}`);
    } catch(e: any) { console.log(`  staticCall failed: ${e.message?.slice(0,100)}`); }
    // Check campaign details
    const c = await campaigns.getCampaign(cidSettle1);
    console.log(`  campaign: publisher=${c.publisher} bidCpm=${c.bidCpmPlanck} takeRate=${c.snapshotTakeRateBps}`);
    console.log(`  claim[0]: publisher=${claims1[0].publisher} cpm=${claims1[0].clearingCpmPlanck} nonce=${claims1[0].nonce}`);
    console.log(`  msg.sender(user)=${user.address} batch.user=${user.address}`);
    // Verify publisher is registered
    const pub = await publishers.getPublisher(publisher.address);
    console.log(`  publisher registered=${pub.registered} takeRate=${pub.takeRateBps}`);
  }
  const tx4 = await settlement.connect(user).settleClaims([
    { user: user.address, campaignId: cidSettle1, claims: claims1 }
  ]);
  const r4 = await tx4.wait();
  results.push({ label: "settleClaims (1 claim)", gasUsed: r4!.gasUsed });
  console.log(`  settleClaims (1 claim): gasUsed=${r4!.gasUsed}`);
  {
    const pubBal1 = await settlement.publisherBalance(publisher.address);
    const settBal1 = await ethers.provider.getBalance(await settlement.getAddress());
    const campBal1 = await ethers.provider.getBalance(await campaigns.getAddress());
    console.log(`  after: publisherBalance=${pubBal1}  settlementBal=${settBal1}  campaignsBal=${campBal1}`);
  }

  // ---------------------------------------------------------------------------
  // 5. settleClaims — 5 claims (MAX_CLAIMS_PER_BATCH)
  // ---------------------------------------------------------------------------
  console.log("5. settleClaims (5 claims)");
  const claims5 = buildClaimChain(cidSettle10, publisher.address, user.address, 5, BID_CPM, IMPRESSIONS_5);
  await measure("settleClaims (5 claims)", settlement.connect(user).settleClaims([
    { user: user.address, campaignId: cidSettle10, claims: claims5 }
  ]));

  // ---------------------------------------------------------------------------
  // 6. withdrawPublisher
  // ---------------------------------------------------------------------------
  console.log("6. withdrawPublisher");
  const pubBal = await settlement.publisherBalance(publisher.address);
  const settBal = await ethers.provider.getBalance(await settlement.getAddress());
  console.log(`  publisherBalance: ${pubBal}  settlementContractBalance: ${settBal}`);
  if (pubBal === 0n) {
    // Create a fresh campaign, activate, and settle to get a publisher balance
    console.log("  Re-settling to fund publisher balance...");
    const cidW = await createCampaignAndGetId(advertiser);
    await voting.connect(voter1).voteAye(cidW, 0, { value: ACTIVATION_THRESHOLD });
    const claimsW = buildClaimChain(cidW, publisher.address, user.address, 1, BID_CPM, IMPRESSIONS_1);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cidW, claims: claimsW }]);
    const pubBal2 = await settlement.publisherBalance(publisher.address);
    console.log(`  publisherBalance after re-settle: ${pubBal2}`);
    if (pubBal2 === 0n) {
      console.log("  WARNING: still no publisher balance — check campaign/settlement wiring");
      results.push({ label: "withdrawPublisher", gasUsed: 0n });
    } else {
      await measure("withdrawPublisher", settlement.connect(publisher).withdrawPublisher());
    }
  } else {
    await measure("withdrawPublisher", settlement.connect(publisher).withdrawPublisher());
  }

  // ---------------------------------------------------------------------------
  // Results table
  // ---------------------------------------------------------------------------
  console.log("\n--- Results ---");
  console.log(`${"Function".padEnd(30)} | ${"gasUsed (weight)".padEnd(22)} | DOT cost (at gasPrice=${gasPrice})`);
  console.log("-".repeat(85));
  for (const r of results) {
    const cost = (r.gasUsed * gasPrice).toString();
    console.log(`${r.label.padEnd(30)} | ${r.gasUsed.toString().padEnd(22)} | ${cost}`);
  }

  // Scale factor: 5 claims / 1 claim
  const settle1 = results.find(r => r.label === "settleClaims (1 claim)")!.gasUsed;
  const settle5 = results.find(r => r.label === "settleClaims (5 claims)")!.gasUsed;
  console.log(`\nsettleClaims scale: 5-claim / 1-claim = ${(Number(settle5) / Number(settle1)).toFixed(2)}x`);
  console.log(`Per-claim cost in 5-batch: ${(Number(settle5) / 5).toFixed(0)} vs single: ${Number(settle1)}`);

  // ---------------------------------------------------------------------------
  // Emit markdown
  // ---------------------------------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  console.log(`\n--- Markdown (for BENCHMARKS.md) ---`);
  console.log(`| Function | gasUsed (weight) | gasPrice | Est. cost (planck) |`);
  console.log(`|----------|-----------------|----------|-------------------|`);
  for (const r of results) {
    const cost = r.gasUsed * gasPrice;
    console.log(`| \`${r.label}\` | ${r.gasUsed} | ${gasPrice} | ${cost} |`);
  }
  const netName = substrate ? "pallet-revive dev chain (chainId 420420420)" : `Hardhat EVM (chainId ${net.chainId})`;
  console.log(`\n_Measured ${date} on ${netName}_`);
}

main().catch(console.error);
