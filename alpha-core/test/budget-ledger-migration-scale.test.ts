import { expect } from "chai";
import { ethers } from "hardhat";

// U3 pagination for DatumBudgetLedger: the live Paseo escrow (29 campaigns)
// could not migrate in a single tx (per-tx weight ceiling). migrate() is now
// paginated — governance calls it repeatedly until migrated() flips. This
// drives the full 29-campaign migration across batches and asserts the cursor
// advances, the partial window is observable + frozen (U6/MH-1), and the
// completed copy is loss-free.
describe("DatumBudgetLedger — paginated migrate (U3) at 29-campaign scale", () => {
  it("migrates 29 campaigns across batches with no loss; partial window is frozen", async () => {
    const [, campaigns, settlement] = await ethers.getSigners();
    const Router = await ethers.getContractFactory("MockOpenGovRouter");
    const router = await Router.deploy();
    const [gov] = await ethers.getSigners();
    await router.setGovernor(gov.address);

    const BL = await ethers.getContractFactory("DatumBudgetLedger");
    const v1 = await BL.deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setCampaigns(campaigns.address);
    await v1.setSettlement(settlement.address);

    const N = 29;
    let total = 0n;
    for (let id = 1; id <= N; id++) {
      const wei = ethers.parseEther("1");
      await v1.connect(campaigns).initializeBudget(id, 0, wei, wei / 2n, { value: wei });
      total += wei;
    }
    expect(await v1.budgetCampaignCount()).to.equal(BigInt(N));

    await v1.freeze();
    const v2 = await BL.deploy(); // a fresh higher-version successor
    // v1.version()==2; deploy MockBudgetLedgerV2 (v3) as the successor instead
    const V2 = await ethers.getContractFactory("MockBudgetLedgerV2");
    const succ = await V2.deploy();
    await succ.setRouter(await router.getAddress());
    await succ.setCampaigns(campaigns.address);
    await succ.setSettlement(settlement.address);

    await succ.setMigrationBatchSize(10);
    const BATCH = Number(await succ.migrationBatchSize());
    const expectedBatches = Math.ceil(N / BATCH);
    let calls = 0;
    while (!(await succ.migrated())) {
      await succ.migrate(await v1.getAddress());
      calls++;
      if (!(await succ.migrated())) {
        // mid-migration: window is frozen + observable + cursor advanced
        expect(await succ.frozen()).to.equal(true);
        expect(await succ.migrationCursor()).to.equal(BigInt(Math.min(calls * BATCH, N)));
      }
      expect(calls).to.be.lessThanOrEqual(expectedBatches + 1);
    }
    expect(calls).to.equal(expectedBatches);
    expect(await succ.frozen()).to.equal(false); // unfrozen on completion
    expect(await succ.budgetCampaignCount()).to.equal(BigInt(N));
    for (let id = 1; id <= N; id++) {
      const [rem] = await succ.getBudgetFull(id, 0);
      expect(rem).to.equal(ethers.parseEther("1"));
    }
    await v1.migrateFundsTo(await succ.getAddress());
    expect(await ethers.provider.getBalance(await succ.getAddress())).to.equal(total);

    // re-migrate after completion reverts
    await expect(succ.migrate(await v1.getAddress())).to.be.revertedWith("already migrated");
    void v2;
  });
});
