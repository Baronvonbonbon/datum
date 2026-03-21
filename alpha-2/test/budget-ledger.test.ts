import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumBudgetLedger } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// BudgetLedger tests for alpha-2 satellite:
// BL1-BL3: initializeBudget, deductAndTransfer, drainToAdvertiser
// BL4-BL6: access control, daily cap, edge cases

describe("DatumBudgetLedger", function () {
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let campaignsMock: HardhatEthersSigner;
  let settlementMock: HardhatEthersSigner;
  let lifecycleMock: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const BUDGET = parseDOT("10");
  const DAILY_CAP = parseDOT("1");

  before(async function () {
    await fundSigners();
    [owner, campaignsMock, settlementMock, lifecycleMock, recipient, other] =
      await ethers.getSigners();

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    await ledger.setCampaigns(campaignsMock.address);
    await ledger.setSettlement(settlementMock.address);
    await ledger.setLifecycle(lifecycleMock.address);
  });

  // BL1: initializeBudget
  it("BL1: initializeBudget stores budget and daily cap", async function () {
    const cid = 1n;
    await ledger.connect(campaignsMock).initializeBudget(cid, BUDGET, DAILY_CAP, { value: BUDGET });

    expect(await ledger.getRemainingBudget(cid)).to.equal(BUDGET);
    expect(await ledger.getDailyCap(cid)).to.equal(DAILY_CAP);
  });

  it("BL1b: initializeBudget rejects mismatched value (E16)", async function () {
    await expect(
      ledger.connect(campaignsMock).initializeBudget(2n, BUDGET, DAILY_CAP, { value: BUDGET / 2n })
    ).to.be.revertedWith("E16");
  });

  it("BL1c: initializeBudget rejects double init (E14)", async function () {
    await expect(
      ledger.connect(campaignsMock).initializeBudget(1n, BUDGET, DAILY_CAP, { value: BUDGET })
    ).to.be.revertedWith("E14");
  });

  // BL2: deductAndTransfer
  it("BL2: deductAndTransfer sends DOT to recipient and updates remaining", async function () {
    const cid = 10n;
    await ledger.connect(campaignsMock).initializeBudget(cid, BUDGET, DAILY_CAP, { value: BUDGET });

    const deductAmount = parseDOT("0.5");
    const recipientBalBefore = await ethers.provider.getBalance(recipient.address);

    const tx = await ledger.connect(settlementMock).deductAndTransfer(cid, deductAmount, recipient.address);
    await tx.wait();

    expect(await ledger.getRemainingBudget(cid)).to.equal(BUDGET - deductAmount);
    const recipientBalAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientBalAfter - recipientBalBefore).to.equal(deductAmount);
  });

  it("BL2b: deductAndTransfer returns exhausted=true when budget hits zero", async function () {
    const cid = 11n;
    const smallBudget = parseDOT("0.1");
    await ledger.connect(campaignsMock).initializeBudget(cid, smallBudget, smallBudget, { value: smallBudget });

    const result = await ledger.connect(settlementMock).deductAndTransfer.staticCall(
      cid, smallBudget, recipient.address
    );
    expect(result).to.be.true; // exhausted
  });

  it("BL2c: deductAndTransfer exceeding remaining reverts E16", async function () {
    const cid = 12n;
    const smallBudget = parseDOT("0.1");
    await ledger.connect(campaignsMock).initializeBudget(cid, smallBudget, smallBudget, { value: smallBudget });

    await expect(
      ledger.connect(settlementMock).deductAndTransfer(cid, smallBudget + 1n, recipient.address)
    ).to.be.revertedWith("E16");
  });

  // BL3: drainToAdvertiser
  it("BL3: drainToAdvertiser sends remaining budget and zeros balance", async function () {
    const cid = 20n;
    await ledger.connect(campaignsMock).initializeBudget(cid, BUDGET, DAILY_CAP, { value: BUDGET });

    const advBalBefore = await ethers.provider.getBalance(recipient.address);
    await ledger.connect(lifecycleMock).drainToAdvertiser(cid, recipient.address);
    const advBalAfter = await ethers.provider.getBalance(recipient.address);

    expect(advBalAfter - advBalBefore).to.equal(BUDGET);
    expect(await ledger.getRemainingBudget(cid)).to.equal(0n);
  });

  // BL4: Access control
  it("BL4: initializeBudget only callable by campaigns contract", async function () {
    await expect(
      ledger.connect(other).initializeBudget(99n, BUDGET, DAILY_CAP, { value: BUDGET })
    ).to.be.revertedWith("E25");
  });

  it("BL4b: deductAndTransfer only callable by settlement", async function () {
    await expect(
      ledger.connect(other).deductAndTransfer(1n, 100n, recipient.address)
    ).to.be.revertedWith("E25");
  });

  it("BL4c: drainToAdvertiser only callable by lifecycle", async function () {
    await expect(
      ledger.connect(other).drainToAdvertiser(1n, recipient.address)
    ).to.be.revertedWith("E25");
  });

  // BL5: Daily cap enforcement
  it("BL5: deductAndTransfer enforces daily cap (E26)", async function () {
    const cid = 30n;
    const smallCap = parseDOT("0.1");
    await ledger.connect(campaignsMock).initializeBudget(cid, BUDGET, smallCap, { value: BUDGET });

    // First deduction within cap succeeds
    await ledger.connect(settlementMock).deductAndTransfer(cid, smallCap, recipient.address);

    // Second deduction exceeds daily cap
    await expect(
      ledger.connect(settlementMock).deductAndTransfer(cid, 1n, recipient.address)
    ).to.be.revertedWith("E26");
  });

  // BL6: drainFraction
  it("BL6: drainFraction sends proportional amount", async function () {
    const cid = 40n;
    await ledger.connect(campaignsMock).initializeBudget(cid, BUDGET, DAILY_CAP, { value: BUDGET });

    const recipBalBefore = await ethers.provider.getBalance(recipient.address);
    await ledger.connect(lifecycleMock).drainFraction(cid, recipient.address, 1000); // 10%
    const recipBalAfter = await ethers.provider.getBalance(recipient.address);

    const expected = BUDGET * 1000n / 10000n;
    expect(recipBalAfter - recipBalBefore).to.equal(expected);
    expect(await ledger.getRemainingBudget(cid)).to.equal(BUDGET - expected);
  });

  it("BL6b: drainFraction > 10000 bps reverts E16", async function () {
    const cid = 41n;
    await ledger.connect(campaignsMock).initializeBudget(cid, BUDGET, DAILY_CAP, { value: BUDGET });

    await expect(
      ledger.connect(lifecycleMock).drainFraction(cid, recipient.address, 10001)
    ).to.be.revertedWith("E16");
  });

  // Admin setters
  it("admin setters require owner", async function () {
    await expect(
      ledger.connect(other).setCampaigns(other.address)
    ).to.be.revertedWith("E18");

    await expect(
      ledger.connect(other).setSettlement(other.address)
    ).to.be.revertedWith("E18");

    await expect(
      ledger.connect(other).setLifecycle(other.address)
    ).to.be.revertedWith("E18");
  });

  it("admin setters reject zero address", async function () {
    await expect(
      ledger.setCampaigns(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });
});
