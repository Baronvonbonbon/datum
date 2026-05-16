// End-to-end on-chain verification of the Path H emission engine.
// Reads state from the deployed engine, exercises permissionless mechanics
// (adjustRate, rollEpoch), and confirms the Settlement integration.
//
// Run after `npx hardhat run scripts/deploy.ts --network localhost`:
//   npx hardhat run scripts/verify-emission-engine.ts --network localhost

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  if (!addrs.emissionEngine) throw new Error("emissionEngine address missing — re-run deploy.ts");

  const engine = await ethers.getContractAt("DatumEmissionEngine", addrs.emissionEngine);
  const settlement = await ethers.getContractAt("DatumSettlement", addrs.settlement);

  console.log(`\n=== Path H emission engine on ${network.name} ===\n`);
  console.log(`engine     : ${addrs.emissionEngine}`);
  console.log(`settlement : ${addrs.settlement}`);

  // 1. Constants
  console.log(`\n--- Baked constants ---`);
  console.log(`HALVING_PERIOD_SECONDS  : ${await engine.HALVING_PERIOD_SECONDS()}    (= 7 years)`);
  console.log(`DAYS_PER_EPOCH          : ${await engine.DAYS_PER_EPOCH()}`);
  console.log(`EPOCH_0_BUDGET          : ${await engine.EPOCH_0_BUDGET()}    (in 10-decimal base — 47.5M DATUM)`);
  console.log(`TOTAL_EPOCHS            : ${await engine.TOTAL_EPOCHS()}`);
  console.log(`MIN_RATE / MAX_RATE     : ${await engine.MIN_RATE()} / ${await engine.MAX_RATE()}`);
  console.log(`INITIAL_RATE            : ${await engine.INITIAL_RATE()}     (19 DATUM/DOT)`);

  // 2. Runtime state
  console.log(`\n--- Runtime state ---`);
  console.log(`currentEpoch                : ${await engine.currentEpoch()}`);
  console.log(`epochStartTime              : ${await engine.epochStartTime()}`);
  console.log(`remainingEpochBudget        : ${await engine.remainingEpochBudget()}`);
  console.log(`dailyCap()                  : ${await engine.dailyCap()}    (= EPOCH_0_BUDGET / 2555 days)`);
  console.log(`remainingDailyCap           : ${await engine.remainingDailyCap()}`);
  console.log(`currentRate                 : ${await engine.currentRate()}`);
  console.log(`adjustmentPeriodSeconds     : ${await engine.adjustmentPeriodSeconds()}  (= 1 day)`);
  console.log(`totalMinted                 : ${await engine.totalMinted()}`);

  // 3. Wiring
  console.log(`\n--- Wiring ---`);
  const engineSet = await engine.settlement();
  const settleEngine = await settlement.emissionEngine();
  const expectMatch =
    engineSet.toLowerCase() === addrs.settlement.toLowerCase() &&
    settleEngine.toLowerCase() === addrs.emissionEngine.toLowerCase();
  console.log(`engine.settlement()      = ${engineSet}    ${engineSet.toLowerCase() === addrs.settlement.toLowerCase() ? "✓" : "✗"}`);
  console.log(`settlement.emissionEngine = ${settleEngine}  ${settleEngine.toLowerCase() === addrs.emissionEngine.toLowerCase() ? "✓" : "✗"}`);

  // 4. Ownership
  console.log(`\n--- Ownership ---`);
  const owner = await engine.owner();
  const pendingOwner = await engine.pendingOwner();
  console.log(`engine.owner()        = ${owner}`);
  console.log(`engine.pendingOwner() = ${pendingOwner}`);
  if (owner.toLowerCase() === addrs.parameterGovernance.toLowerCase()) {
    console.log(`✓ ParameterGovernance owns the engine`);
  } else {
    console.log(`⚠ Owner is not ParameterGovernance — Stage 6 ownership migration may not have run`);
  }

  // 5. Permissionless adjust early-revert check
  console.log(`\n--- Permissionless adjustRate (should revert too-soon) ---`);
  try {
    await engine.adjustRate.staticCall();
    console.log(`⚠ adjustRate did not revert (unexpected — period should not have elapsed yet)`);
  } catch (e: any) {
    if ((e?.shortMessage ?? e?.message ?? "").includes("too soon")) {
      console.log(`✓ adjustRate reverts 'too soon' as expected`);
    } else {
      console.log(`? adjustRate reverted with: ${e?.shortMessage ?? e?.message}`);
    }
  }

  // 6. Permissionless rollEpoch early-revert check
  try {
    await engine.rollEpoch.staticCall();
    console.log(`⚠ rollEpoch did not revert (unexpected — 7-year period should not have elapsed)`);
  } catch (e: any) {
    if ((e?.shortMessage ?? e?.message ?? "").includes("too early")) {
      console.log(`✓ rollEpoch reverts 'too early' as expected`);
    } else {
      console.log(`? rollEpoch reverted with: ${e?.shortMessage ?? e?.message}`);
    }
  }

  // 7. Time travel + adjustRate
  console.log(`\n--- Simulating 1-day adjustment cycle (only works on hardhat) ---`);
  if (network.name === "localhost" || network.name === "hardhat") {
    const rateBefore = await engine.currentRate();
    await network.provider.send("evm_increaseTime", [86400]);
    await network.provider.send("evm_mine", []);
    const tx = await engine.adjustRate();
    await tx.wait();
    const rateAfter = await engine.currentRate();
    console.log(`rate before adjust : ${rateBefore}`);
    console.log(`rate after adjust  : ${rateAfter}    ${rateAfter > rateBefore ? "(increased — zero volume baseline pushed up)" : ""}`);
    console.log(`✓ adjustRate succeeded after 1-day time travel`);

    // Time-travel 7 years and rollEpoch
    console.log(`\n--- Simulating 7-year halving rollover ---`);
    const HALVING = Number(await engine.HALVING_PERIOD_SECONDS());
    await network.provider.send("evm_increaseTime", [HALVING]);
    await network.provider.send("evm_mine", []);
    const epochBefore = await engine.currentEpoch();
    const dailyCapBefore = await engine.dailyCap();
    const tx2 = await engine.rollEpoch();
    await tx2.wait();
    const epochAfter = await engine.currentEpoch();
    const dailyCapAfter = await engine.dailyCap();
    console.log(`epoch     : ${epochBefore} -> ${epochAfter}`);
    console.log(`dailyCap  : ${dailyCapBefore} -> ${dailyCapAfter}    (should halve)`);
    if (dailyCapAfter * 2n === dailyCapBefore) {
      console.log(`✓ Daily cap halved exactly`);
    } else {
      console.log(`⚠ Daily cap did NOT halve cleanly`);
    }
  }

  // 8. Settlement-side state
  console.log(`\n--- Settlement-side mint config ---`);
  console.log(`settlement.emissionEngine       : ${await settlement.emissionEngine()}`);
  console.log(`settlement.mintRatePerDot       : ${await settlement.mintRatePerDot()}  (legacy fallback rate)`);
  console.log(`settlement.dustMintThreshold    : ${await settlement.dustMintThreshold()}`);
  console.log(`settlement.mintAuthority        : ${await settlement.mintAuthority()}    (zero = mints disabled)`);

  console.log(`\n=== Verification complete ===\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
