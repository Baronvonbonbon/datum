import { expect } from "chai";
import { ethers } from "hardhat";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Batched vault credit (pallet-revive multi-claim storage-deposit fix):
// `deduct` updates pot accounting WITHOUT transferring DOT; `transferSettled`
// moves the batch aggregate in a single native transfer. Together they replace
// the old per-claim `deductAndTransfer` (N transfers → 1).
describe("DatumBudgetLedger — batched vault credit", function () {
  let ledger: any, owner: any, settlement: any, recipient: any, stranger: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, settlement, recipient, stranger] = await ethers.getSigners();
    const L = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await L.deploy();
    // owner stands in as both campaigns (to fund pots) and settlement (to deduct).
    await ledger.setCampaigns(owner.address);
    await ledger.setSettlement(settlement.address);
    await ledger.initializeBudget(1, 0, parseDOT("10"), parseDOT("10"), { value: parseDOT("10") });
  });

  it("deduct reduces remaining but transfers NO DOT (state-only)", async function () {
    const recipBefore = await ethers.provider.getBalance(recipient.address);
    const ledgerBefore = await ethers.provider.getBalance(await ledger.getAddress());

    for (let i = 1; i <= 3; i++) {
      await ledger.connect(settlement).deduct(1, 0, parseDOT("1"));
      expect(await ledger.getRemainingBudget(1, 0)).to.equal(parseDOT(String(10 - i)));
      // No DOT left the ledger and none reached the recipient.
      expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipBefore);
      expect(await ethers.provider.getBalance(await ledger.getAddress())).to.equal(ledgerBefore);
    }
  });

  it("transferSettled moves the aggregate in a single transfer", async function () {
    await ledger.connect(settlement).deduct(1, 0, parseDOT("1"));
    await ledger.connect(settlement).deduct(1, 0, parseDOT("2"));
    await ledger.connect(settlement).deduct(1, 0, parseDOT("3")); // sum = 6

    const recipBefore = await ethers.provider.getBalance(recipient.address);
    const ledgerBefore = await ethers.provider.getBalance(await ledger.getAddress());

    await ledger.connect(settlement).transferSettled(recipient.address, parseDOT("6"));

    expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipBefore + parseDOT("6"));
    expect(await ethers.provider.getBalance(await ledger.getAddress())).to.equal(ledgerBefore - parseDOT("6"));
    // Pot accounting already reflected the deductions (remaining = 10 - 6).
    expect(await ledger.getRemainingBudget(1, 0)).to.equal(parseDOT("4"));
  });

  it("deduct enforces the same gates as deductAndTransfer", async function () {
    await expect(ledger.connect(stranger).deduct(1, 0, parseDOT("1"))).to.be.revertedWith("E25"); // not settlement
    await expect(ledger.connect(settlement).deduct(1, 3, parseDOT("1"))).to.be.revertedWith("E88"); // bad actionType
    await expect(ledger.connect(settlement).deduct(1, 0, parseDOT("11"))).to.be.revertedWith("E16"); // over remaining

    // Daily cap: a pot whose dailyCap < budget rejects once cap is hit.
    await ledger.initializeBudget(2, 0, parseDOT("10"), parseDOT("2"), { value: parseDOT("10") });
    await ledger.connect(settlement).deduct(2, 0, parseDOT("2"));
    await expect(ledger.connect(settlement).deduct(2, 0, parseDOT("1"))).to.be.revertedWith("E26");
  });

  it("transferSettled is settlement-gated and a no-op for zero", async function () {
    await expect(ledger.connect(stranger).transferSettled(recipient.address, parseDOT("1"))).to.be.revertedWith("E25");
    const before = await ethers.provider.getBalance(recipient.address);
    await ledger.connect(settlement).transferSettled(recipient.address, 0n); // no-op
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(before);
  });

  it("deduct reports exhaustion exactly when the pot hits zero", async function () {
    expect(await ledger.connect(settlement).deduct.staticCall(1, 0, parseDOT("9"))).to.equal(false);
    await ledger.connect(settlement).deduct(1, 0, parseDOT("9"));
    expect(await ledger.connect(settlement).deduct.staticCall(1, 0, parseDOT("1"))).to.equal(true); // → remaining 0
  });
});
