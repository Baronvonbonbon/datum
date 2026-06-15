/**
 * repro-multiclaim.ts — minimal multi-claim settle repro.
 *
 * Deploys ONLY the core settle spine (no PublisherStake / Reputation /
 * NullifierRegistry / RateLimiter / PowEngine — all address(0) ⇒ skipped),
 * using MockCampaigns so there's no governance/grace/PoW/stake gate. Then
 * settles n=1 and n=5 and reports settled/rejected/revert.
 *
 * Run on hardhat EVM (control):   npx hardhat run scripts/repro-multiclaim.ts
 * Run on pallet-revive (suspect): npx hardhat run scripts/repro-multiclaim.ts --network substrate
 *
 * Discriminator:
 *   - n=5 reverts here  ⇒ bug is in the CORE LogicA→LogicB delegatecall/loop.
 *   - n=5 settles here  ⇒ bug needs a satellite the full deploy wires.
 */
import { ethers, network } from "hardhat";
import { parseDOT } from "../test/helpers/dot";
import { wireSettlementLogic } from "../test/helpers/settlementLogic";

const TAKE_RATE_BPS = 5000;
const BID_CPM = parseDOT("0.016");
const BUDGET = parseDOT("10");
const DAILY_CAP = parseDOT("10");

function buildClaims(count: number, publisher: string, rate: bigint, imps: bigint) {
  // SLIM plain-CPM claims: { publisher, eventCount, rateWei, actionType, proof:[] }.
  // The contract derives nonce/prevHash on-chain, so identical claims are valid.
  return Array.from({ length: count }, () => ({
    publisher, eventCount: imps, rateWei: rate, actionType: 0, proof: [] as any[],
  }));
}

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`network=${network.name} chainId=${net.chainId}`);
  const signers = await ethers.getSigners();
  const [owner, user, publisher, protocol] = signers;
  console.log(`owner=${owner.address}\nuser=${user.address}\npublisher=${publisher.address}`);

  const D = async (name: string, ...args: any[]) => {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args); await c.waitForDeployment();
    console.log(`  ${name}: ${await c.getAddress()}`);
    return c;
  };

  console.log("Deploying core settle spine...");
  const pauseReg = await D("DatumPauseRegistry", owner.address, user.address, publisher.address);
  const mock = await D("MockCampaigns");
  const ledger = await D("DatumBudgetLedger");
  const vault = await D("DatumPaymentVault");
  const validator = await D("DatumClaimValidator", await mock.getAddress(), await mock.getAddress(), await pauseReg.getAddress());
  const settlement = await D("DatumSettlement", await pauseReg.getAddress());
  await wireSettlementLogic(settlement as any);
  const relay = await D("DatumRelay", await settlement.getAddress(), await mock.getAddress(), await pauseReg.getAddress());

  console.log("Wiring...");
  await (await settlement.configure(await ledger.getAddress(), await vault.getAddress(), await mock.getAddress(), await relay.getAddress())).wait();
  await (await settlement.setClaimValidator(await validator.getAddress())).wait();
  await (await ledger.setCampaigns(await mock.getAddress())).wait();
  await (await ledger.setSettlement(await settlement.getAddress())).wait();
  await (await ledger.setLifecycle(await mock.getAddress())).wait();
  await (await mock.setBudgetLedger(await ledger.getAddress())).wait();
  await (await vault.setSettlement(await settlement.getAddress())).wait();
  await (await settlement.setPublishers(await mock.getAddress())).wait();
  await (await settlement.setCampaigns(await mock.getAddress())).wait();

  // ── Satellite gates (mirror Paseo deploy.ts wiring; deployAll/hardhat-stress
  // does NOT wire these, which is why multi-claim settles there). Each behind a
  // flag so we can bisect which satellite triggers the Paseo revert.
  const on = (k: string) => process.env.SATS === "all" || (process.env.SATS ?? "").split(",").includes(k);
  if (on("stake")) {
    const ps = await D("DatumPublisherStake", parseDOT("1"), parseDOT("0.0001"), 14400n);
    await (await ps.setSettlementContract(await settlement.getAddress())).wait();
    await (await settlement.setPublisherStake(await ps.getAddress())).wait();
    const req = await ps.requiredStake(publisher.address);
    await (await ps.connect(publisher).stake({ value: BigInt(req) + parseDOT("1") })).wait();
    console.log(`  [sat] PublisherStake wired; publisher staked ${BigInt(req) + parseDOT("1")} (req ${req})`);
  }
  if (on("pow")) {
    const pow = await D("DatumPowEngine");
    await (await pow.setSettlement(await settlement.getAddress())).wait();
    await (await pow.setEnforcePow(false)).wait(); // off ⇒ no per-claim mining needed
    await (await settlement.setPowEngine(await pow.getAddress())).wait();
    console.log(`  [sat] PowEngine wired (enforcePow=false)`);
  }
  if (on("rep")) {
    const rep = await D("DatumPublisherReputation");
    await (await rep.setSettlement(await settlement.getAddress())).wait();
    await (await settlement.setReputationContract(await rep.getAddress())).wait();
    console.log(`  [sat] Reputation wired`);
  }
  if (on("null")) {
    const nr = await D("DatumNullifierRegistry");
    await (await nr.setSettlement(await settlement.getAddress())).wait();
    await (await nr.setNullifierWindowBlocks(14400n)).wait();
    await (await settlement.setNullifierRegistry(await nr.getAddress())).wait();
    console.log(`  [sat] NullifierRegistry wired`);
  }
  if (on("rl")) {
    const rl = await D("DatumSettlementRateLimiter");
    await (await rl.setSettlement(await settlement.getAddress())).wait();
    await (await settlement.setRateLimiter(await rl.getAddress())).wait();
    console.log(`  [sat] RateLimiter wired`);
  }

  let nextId = 1n;
  async function activeCampaign(): Promise<bigint> {
    const id = nextId++;
    await (await mock.setCampaign(id, owner.address, publisher.address, BID_CPM, TAKE_RATE_BPS, 1)).wait();
    await (await mock.initBudget(id, 0, BUDGET, DAILY_CAP, { value: BUDGET })).wait();
    return id;
  }

  for (const n of [1, 5]) {
    const cid = await activeCampaign();
    const batch = [{ user: user.address, campaignId: cid, claims: buildClaims(n, publisher.address, BID_CPM, 100n) }];
    try {
      const res = await settlement.connect(user).settleClaims.staticCall(batch);
      const tx = await settlement.connect(user).settleClaims(batch);
      const r = await tx.wait();
      console.log(`n=${n}: settled=${res.settledCount} rejected=${res.rejectedCount} status=${r?.status} gasUsed=${r?.gasUsed} ${res.settledCount === BigInt(n) ? "✅" : "⚠️"}`);
    } catch (e: any) {
      console.log(`n=${n}: ❌ REVERTED — ${(e?.shortMessage ?? e?.reason ?? e?.message ?? e).toString().split("\n")[0].slice(0, 140)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
