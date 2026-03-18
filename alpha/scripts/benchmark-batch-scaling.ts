/**
 * Batch scaling benchmark — tests settleClaims at various batch sizes
 * to find the practical limit on EVM and inform the PVM cap.
 *
 * Deploys a fresh Settlement with a raised cap (100) for testing.
 * Run: npx hardhat run scripts/benchmark-batch-scaling.ts
 */
import { ethers } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { fundSigners, isSubstrate } from "../test/helpers/mine";

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
      clearingCpmPlanck: cpm, nonce, previousClaimHash: prevHash,
      claimHash, zkProof: "0x",
    });
    prevHash = claimHash;
  }
  return claims;
}

async function main() {
  const substrate = await isSubstrate();
  console.log(`Network: substrate=${substrate}`);
  await fundSigners();

  const signers = await ethers.getSigners();
  const [owner, voter1, voter2, advertiser, publisher, user] = signers;

  const QUORUM = parseDOT("1");
  const BID_CPM = parseDOT("0.016");
  const IMPRESSIONS = 100n; // small to avoid budget exhaustion
  const BATCH_SIZES = [1, 5, 10, 20, 50, 100];

  // Deploy
  const pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy();
  const pubs = await (await ethers.getContractFactory("DatumPublishers")).deploy(substrate ? 3n : 10n);
  const campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
    0n, substrate ? 3n : 100n, await pubs.getAddress(), await pause.getAddress()
  );
  const v2 = await (await ethers.getContractFactory("DatumGovernanceV2")).deploy(
    await campaigns.getAddress(), QUORUM, 1000n,
    substrate ? 3n : 10n, substrate ? 30n : 100n,
    QUORUM, substrate ? 3n : 10n
  );
  const slash = await (await ethers.getContractFactory("DatumGovernanceSlash")).deploy(
    await v2.getAddress(), await campaigns.getAddress()
  );
  const settlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(
    await campaigns.getAddress(), await pause.getAddress()
  );

  // Wire
  await v2.setSlashContract(await slash.getAddress());
  await campaigns.setGovernanceContract(await v2.getAddress());
  await campaigns.setSettlementContract(await settlement.getAddress());
  await pubs.connect(publisher).registerPublisher(5000);

  console.log("Contracts deployed.\n");

  // Helper: create + activate a campaign with large budget
  async function createActiveCampaign(): Promise<bigint> {
    const budget = parseDOT("10000"); // large budget so claims don't exhaust it
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, budget, BID_CPM, 0, { value: budget }
    );
    const receipt = await tx.wait();
    const log = receipt!.logs.find((l: any) => {
      try { return campaigns.interface.parseLog({ topics: l.topics, data: l.data })?.name === "CampaignCreated"; }
      catch { return false; }
    });
    const parsed = campaigns.interface.parseLog({ topics: log!.topics as string[], data: log!.data });
    const cid = parsed!.args.campaignId;
    await v2.connect(voter1).vote(cid, true, 0, { value: QUORUM });
    await v2.evaluateCampaign(cid);
    return cid;
  }

  // Run benchmarks for each batch size
  console.log("| Batch Size | Gas Used | Per-Claim Gas | Scaling vs 1 |");
  console.log("|------------|----------|---------------|--------------|");

  let baseGas = 0n;

  for (const size of BATCH_SIZES) {
    // Each batch size gets its own campaign + fresh nonce chain
    const cid = await createActiveCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, size, BID_CPM, IMPRESSIONS);

    try {
      const tx = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims }
      ]);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed;
      const perClaim = gasUsed / BigInt(size);
      if (size === 1) baseGas = gasUsed;
      const scale = baseGas > 0n ? (Number(gasUsed) / Number(baseGas)).toFixed(2) : "—";

      console.log(`| ${String(size).padEnd(10)} | ${String(gasUsed).padEnd(8)} | ${String(perClaim).padEnd(13)} | ${scale.padEnd(12)} |`);
    } catch (err: any) {
      const reason = err.message?.slice(0, 120) ?? String(err).slice(0, 120);
      console.log(`| ${String(size).padEnd(10)} | FAILED   | —             | ${reason} |`);
      // If it fails due to E28 (batch cap), note it and stop
      if (reason.includes("E28")) {
        console.log(`\nHit batch cap (E28) at size ${size}. Current contract limit: 5.`);
        break;
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
