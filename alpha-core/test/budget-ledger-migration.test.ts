import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// DatumUpgradable redeploy-migrate-rewire against the fund-holding
// DatumBudgetLedger: freeze v1 → v2.migrate(v1) copies budget + refund
// accounting → v1.migrateFundsTo(v2) sweeps native DOT (via acceptMigration,
// since receive() rejects deposits) → advertiser claims their refund from v2.
describe("DatumBudgetLedger — upgrade migration (DatumUpgradable)", function () {
  let v1: any, v2: any, router: any;
  let v1Addr: string, v2Addr: string;
  let owner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let campaignsS: HardhatEthersSigner;  // stand-in for the Campaigns contract
  let settlementS: HardhatEthersSigner;
  let lifecycleS: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;

  const BUDGET_A = parseDOT("10"); // live budget (campaign 1)
  const BUDGET_B = parseDOT("5");  // drained → refund (campaign 2)
  const CAP = parseDOT("100");

  beforeEach(async function () {
    await fundSigners();
    [owner, governor, campaignsS, settlementS, lifecycleS, advertiser] = await ethers.getSigners();

    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(governor.address);

    const Ledger = await ethers.getContractFactory("DatumBudgetLedger");
    v1 = await Ledger.deploy();
    v1Addr = await v1.getAddress();
    await v1.setRouter(await router.getAddress());
    // EOA stand-ins so the test can drive the authorized entry points directly.
    await v1.setCampaigns(campaignsS.address);
    await v1.setSettlement(settlementS.address);
    await v1.setLifecycle(lifecycleS.address);

    // Campaign 1: a live budget. Campaign 2: funded then drained → refund queued.
    await v1.connect(campaignsS).initializeBudget(1, 0, BUDGET_A, CAP, { value: BUDGET_A });
    await v1.connect(campaignsS).initializeBudget(2, 0, BUDGET_B, CAP, { value: BUDGET_B });
    await v1.connect(lifecycleS).drainToAdvertiser(2, advertiser.address);

    v2 = await (await ethers.getContractFactory("MockBudgetLedgerV2")).deploy();
    v2Addr = await v2.getAddress();
    await v2.setRouter(await router.getAddress());
  });

  it("enumerates budget campaigns + refund holders", async function () {
    expect(await v1.budgetCampaignCount()).to.equal(2n);
    expect(await v1.refundHolderCount()).to.equal(1n);
    expect(await v1.refundHolderAt(0)).to.equal(advertiser.address);
  });

  it("v2.migrate(v1) copies budget + refund accounting from the frozen predecessor", async function () {
    await v1.connect(governor).freeze();
    await v2.connect(governor).migrate(v1Addr);
    expect(await v2.migrated()).to.equal(true);
    expect(await v2.getRemainingBudget(1, 0)).to.equal(BUDGET_A);
    expect(await v2.getRemainingBudget(2, 0)).to.equal(0n); // drained
    expect(await v2.pendingAdvertiserRefund(advertiser.address)).to.equal(BUDGET_B);
    expect(await v2.treasury()).to.equal(await v1.treasury());
    expect(await v2.budgetCampaignCount()).to.equal(2n);
  });

  it("v1.migrateFundsTo(v2) sweeps native DOT so v2 is solvent (advertiser claims on v2)", async function () {
    const total = BUDGET_A + BUDGET_B;
    expect(await ethers.provider.getBalance(v1Addr)).to.equal(total);

    await v1.connect(governor).freeze();
    await v2.connect(governor).migrate(v1Addr);
    await expect(v1.connect(governor).migrateFundsTo(v2Addr))
      .to.emit(v1, "FundsMigratedOut").withArgs(v2Addr, total);

    expect(await ethers.provider.getBalance(v1Addr)).to.equal(0n);
    expect(await ethers.provider.getBalance(v2Addr)).to.equal(total);
    expect(await v1.fundsMigratedOut()).to.equal(true);

    // v2 solvent: the migrated advertiser pulls their refund.
    await expect(v2.connect(advertiser).claimAdvertiserRefund())
      .to.emit(v2, "AdvertiserRefundClaimed");
    expect(await v2.pendingAdvertiserRefund(advertiser.address)).to.equal(0n);
  });

  it("migrateFundsTo guards: frozen-only, governance-only, one-shot", async function () {
    await expect(v1.connect(governor).migrateFundsTo(v2Addr)).to.be.revertedWith("not frozen");
    await v1.connect(governor).freeze();
    await v2.connect(governor).migrate(v1Addr);
    await expect(v1.connect(owner).migrateFundsTo(v2Addr)).to.be.revertedWith("E19");
    await v1.connect(governor).migrateFundsTo(v2Addr);
    await expect(v1.connect(governor).migrateFundsTo(v2Addr)).to.be.revertedWith("already swept");
  });

  it("structural refs are phase-conditional (re-pointable until lockPlumbing@OpenGov)", async function () {
    await v1.connect(owner).setSettlement(advertiser.address); // re-point while unlocked
    expect(await v1.settlement()).to.equal(advertiser.address);
    await v1.connect(owner).lockPlumbing(); // router phase=2 (OpenGov) by default
    expect(await v1.plumbingLocked()).to.equal(true);
    await expect(v1.connect(owner).setSettlement(owner.address)).to.be.revertedWith("locked");
  });
});
