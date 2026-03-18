/**
 * Gas benchmarks for DATUM contracts on Paseo.
 *
 * Uses the already-deployed contracts and pre-funded test accounts.
 * NOTE: On pallet-revive, accounts that have never made a contract call may hit
 * "Invalid Transaction" errors. All benchmarks use Alice (deployer) as the tx sender.
 * Settlement claims use Alice as both sender and user.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY="0x6eda..." \
 *   TESTNET_ACCOUNTS="0x1560...(charlie),0x40d6...(diana),0xd894...(frank)" \
 *   npx hardhat run scripts/benchmark-testnet.ts --network polkadotTestnet
 */
import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import * as fs from "fs";

/**
 * Format wei (18-decimal) to DOT string.
 * The eth-rpc adapter uses 18 decimals, but native DOT has 10.
 * gasPrice * gasUsed = cost in wei (18 dec). To get DOT: divide by 10^18.
 */
function formatWeiAsDOT(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function computeClaimHash(
  campaignId: bigint, publisher: string, user: string,
  impressionCount: bigint, clearingCpmPlanck: bigint,
  nonce: bigint, previousClaimHash: string
): string {
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
    [campaignId, publisher, user, impressionCount, clearingCpmPlanck, nonce, previousClaimHash]
  );
}

function buildClaimChain(
  campaignId: bigint, publisher: string, user: string,
  count: number, cpm: bigint, impressions: bigint
) {
  const claims = [];
  let prevHash = ethers.ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const claimHash = computeClaimHash(campaignId, publisher, user, impressions, cpm, nonce, prevHash);
    claims.push({
      campaignId, publisher, impressionCount: impressions,
      clearingCpmPlanck: cpm, nonce, previousClaimHash: prevHash, claimHash, zkProof: "0x",
    });
    prevHash = claimHash;
  }
  return claims;
}

interface Measurement { label: string; gasUsed: bigint; costPlanck: bigint }

async function main() {
  const provider = ethers.provider;
  const signers = await ethers.getSigners();

  if (signers.length < 4) {
    console.error("Need 4 signers: Alice + Charlie + Diana + Frank.");
    console.error('Set TESTNET_ACCOUNTS="charlie_key,diana_key,frank_key"');
    process.exitCode = 1;
    return;
  }

  const [alice, charlie, diana, frank] = signers;
  console.log(`Alice   (deployer/user): ${alice.address}`);
  console.log(`Charlie (advertiser):    ${charlie.address}`);
  console.log(`Diana   (publisher):     ${diana.address}`);
  console.log(`Frank   (voter):         ${frank.address}`);

  const addrs = JSON.parse(fs.readFileSync(__dirname + "/../deployed-addresses.json", "utf-8"));

  const net = await provider.getNetwork();
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1n;
  console.log(`\nNetwork: chainId=${net.chainId}  gasPrice=${gasPrice}\n`);

  const publishers = await ethers.getContractAt("DatumPublishers", addrs.publishers);
  const campaigns  = await ethers.getContractAt("DatumCampaigns",  addrs.campaigns);
  const v2         = await ethers.getContractAt("DatumGovernanceV2", addrs.governanceV2);
  const settlement = await ethers.getContractAt("DatumSettlement", addrs.settlement);

  const results: Measurement[] = [];

  async function measure(label: string, txPromise: Promise<any>): Promise<bigint> {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed as bigint;
    const costPlanck = gasUsed * gasPrice;
    results.push({ label, gasUsed, costPlanck });
    console.log(`  ${label}: gas=${gasUsed}  cost=${formatWeiAsDOT(costPlanck)} DOT`);
    return gasUsed;
  }

  const BID_CPM   = parseDOT("0.016");
  const BUDGET    = parseDOT("10");
  const DAILY_CAP = parseDOT("10");
  const CATEGORY  = 2;
  const quorum = await v2.quorumWeighted();
  const STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");

  // Helper: create + activate campaign
  async function createAndActivate(): Promise<bigint> {
    const tx = await campaigns.connect(charlie).createCampaign(
      diana.address, DAILY_CAP, BID_CPM, CATEGORY, { value: BUDGET }
    );
    const receipt = await tx.wait();
    let cid = 0n;
    for (const log of receipt!.logs) {
      try {
        const parsed = campaigns.interface.parseLog(log);
        if (parsed?.name === "CampaignCreated") cid = parsed.args.campaignId;
      } catch {}
    }
    await (await v2.connect(frank).vote(cid, true, 0, { value: STAKE })).wait();
    await (await v2.connect(alice).evaluateCampaign(cid)).wait();
    return cid;
  }

  // ─── 1. createCampaign ──────────────────────────────────────────────────
  console.log("1. createCampaign");
  {
    const tx = await campaigns.connect(charlie).createCampaign(
      diana.address, DAILY_CAP, BID_CPM, CATEGORY, { value: BUDGET }
    );
    const receipt = await tx.wait();
    results.push({ label: "createCampaign", gasUsed: receipt!.gasUsed, costPlanck: receipt!.gasUsed * gasPrice });
    console.log(`  createCampaign: gas=${receipt!.gasUsed}  cost=${formatWeiAsDOT(receipt!.gasUsed * gasPrice)} DOT`);
  }

  // ─── 2. vote aye ────────────────────────────────────────────────────────
  console.log("2. vote (aye)");
  const cidVote = await createAndActivate(); // need a pending one
  const cidVote2Tx = await campaigns.connect(charlie).createCampaign(
    diana.address, DAILY_CAP, BID_CPM, CATEGORY, { value: BUDGET }
  );
  const cidVote2Receipt = await cidVote2Tx.wait();
  let cidVote2 = 0n;
  for (const log of cidVote2Receipt!.logs) {
    try {
      const parsed = campaigns.interface.parseLog(log);
      if (parsed?.name === "CampaignCreated") cidVote2 = parsed.args.campaignId;
    } catch {}
  }
  await measure("vote (aye)", v2.connect(frank).vote(cidVote2, true, 0, { value: STAKE }));

  // ─── 3. evaluateCampaign ────────────────────────────────────────────────
  console.log("3. evaluateCampaign");
  await measure("evaluateCampaign", v2.connect(alice).evaluateCampaign(cidVote2));

  // ─── 4. settleClaims (1 claim) ──────────────────────────────────────────
  // Use Alice as both sender and user (she's a known working signer)
  console.log("4. settleClaims (1 claim)");
  const cidSettle1 = await createAndActivate();
  console.log(`  Campaign: ${cidSettle1}`);
  const claims1 = buildClaimChain(cidSettle1, diana.address, alice.address, 1, BID_CPM, 1000n);
  await measure("settleClaims (1 claim)",
    settlement.connect(alice).settleClaims([
      { user: alice.address, campaignId: cidSettle1, claims: claims1 }
    ])
  );

  // ─── 5. settleClaims (5 claims) ─────────────────────────────────────────
  console.log("5. settleClaims (5 claims)");
  const cidSettle5 = await createAndActivate();
  console.log(`  Campaign: ${cidSettle5}`);
  const claims5 = buildClaimChain(cidSettle5, diana.address, alice.address, 5, BID_CPM, 200n);
  await measure("settleClaims (5 claims)",
    settlement.connect(alice).settleClaims([
      { user: alice.address, campaignId: cidSettle5, claims: claims5 }
    ])
  );

  // ─── 6. withdrawPublisher ───────────────────────────────────────────────
  console.log("6. withdrawPublisher");
  const pubBal = await settlement.publisherBalance(diana.address);
  console.log(`  Diana balance: ${formatWeiAsDOT(pubBal)} DOT`);
  if (pubBal > 0n) {
    await measure("withdrawPublisher", settlement.connect(diana).withdrawPublisher());
  } else {
    console.log("  No balance — skipping");
  }

  // ─── 7. withdrawUser ───────────────────────────────────────────────────
  console.log("7. withdrawUser");
  const userBal = await settlement.userBalance(alice.address);
  console.log(`  Alice user balance: ${formatWeiAsDOT(userBal)} DOT`);
  if (userBal > 0n) {
    await measure("withdrawUser", settlement.connect(alice).withdrawUser());
  } else {
    console.log("  No balance — skipping");
  }

  // ─── Results ────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(90));
  console.log("DATUM Testnet Gas Benchmarks — Paseo (Chain ID 420420417)");
  console.log("=".repeat(90));
  console.log(`${"Function".padEnd(30)} | ${"Gas (weight)".padEnd(14)} | ${"Cost (DOT)".padEnd(14)} | Cost (USD @$5)`);
  console.log("-".repeat(85));
  for (const r of results) {
    const dotCost = Number(r.costPlanck) / 1e18;
    const usdCost = dotCost * 5;
    console.log(`${r.label.padEnd(30)} | ${r.gasUsed.toString().padEnd(14)} | ${dotCost.toFixed(6).padEnd(14)} | $${usdCost.toFixed(4)}`);
  }

  const s1 = results.find(r => r.label === "settleClaims (1 claim)");
  const s5 = results.find(r => r.label === "settleClaims (5 claims)");
  if (s1 && s5) {
    const s1Dot = Number(s1.costPlanck) / 1e18;
    const s5Dot = Number(s5.costPlanck) / 1e18;
    console.log(`\nSettlement scale: 5-claim / 1-claim = ${(Number(s5.gasUsed) / Number(s1.gasUsed)).toFixed(2)}x`);
    console.log(`Per-claim cost in 5-batch: ${(s5Dot / 5).toFixed(6)} DOT vs single: ${s1Dot.toFixed(6)} DOT`);
  }

  const date = new Date().toISOString().slice(0, 10);
  console.log(`\n--- Markdown ---`);
  console.log(`| Function | Gas (weight) | Cost (DOT) | Cost (USD @$5) |`);
  console.log(`|----------|-------------|-----------|---------------|`);
  for (const r of results) {
    const dotCost = Number(r.costPlanck) / 1e18;
    const usdCost = dotCost * 5;
    console.log(`| \`${r.label}\` | ${r.gasUsed} | ${dotCost.toFixed(6)} | $${usdCost.toFixed(4)} |`);
  }
  console.log(`\n_Measured ${date} on Paseo (chainId ${net.chainId}), gasPrice=${gasPrice} (eth-rpc 18-decimal)_`);
  console.log(`_Note: eth-rpc uses 18-decimal denomination. Cost (DOT) = gas × gasPrice / 10^18._`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
