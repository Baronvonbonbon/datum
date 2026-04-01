import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPaymentVault } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, isSubstrate } from "./helpers/mine";

// PaymentVault tests for alpha-2 satellite:
// PV1-PV3: creditSettlement, withdrawals
// PV4-PV6: access control, edge cases

describe("DatumPaymentVault", function () {
  let vault: DatumPaymentVault;

  let owner: HardhatEthersSigner;
  let settlementMock: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let protocol: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, settlementMock, publisher, user, protocol, other] = await ethers.getSigners();

    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();

    await vault.setSettlement(settlementMock.address);

    // Fund vault with DOT (simulates BudgetLedger.deductAndTransfer sending DOT)
    await owner.sendTransaction({ to: await vault.getAddress(), value: parseDOT("100") });
  });

  // PV1: creditSettlement records balance split
  it("PV1: creditSettlement records publisher/user/protocol balances", async function () {
    const pubAmt = parseDOT("0.5");
    const userAmt = parseDOT("0.3");
    const protoAmt = parseDOT("0.1");

    await vault.connect(settlementMock).creditSettlement(
      publisher.address, pubAmt, user.address, userAmt, protoAmt
    );

    expect(await vault.publisherBalance(publisher.address)).to.equal(pubAmt);
    expect(await vault.userBalance(user.address)).to.equal(userAmt);
    expect(await vault.protocolBalance()).to.equal(protoAmt);
  });

  // PV2: Publisher withdrawal
  it("PV2: publisher can withdraw accumulated balance", async function () {
    const balance = await vault.publisherBalance(publisher.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(publisher.address);
    const tx = await vault.connect(publisher).withdrawPublisher();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(publisher.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    }
    expect(await vault.publisherBalance(publisher.address)).to.equal(0n);
  });

  // PV3: User withdrawal
  it("PV3: user can withdraw accumulated balance", async function () {
    const balance = await vault.userBalance(user.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(user.address);
    const tx = await vault.connect(user).withdrawUser();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(user.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    }
    expect(await vault.userBalance(user.address)).to.equal(0n);
  });

  // PV4: Protocol withdrawal (owner only)
  it("PV4: only owner can withdraw protocol fees", async function () {
    await expect(
      vault.connect(other).withdrawProtocol(other.address)
    ).to.be.reverted;

    const fee = await vault.protocolBalance();
    expect(fee).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(protocol.address);
    await vault.connect(owner).withdrawProtocol(protocol.address);
    const balAfter = await ethers.provider.getBalance(protocol.address);

    if (!(await isSubstrate())) {
      expect(balAfter - balBefore).to.equal(fee);
    }
    expect(await vault.protocolBalance()).to.equal(0n);
  });

  // PV5: creditSettlement only callable by settlement
  it("PV5: creditSettlement reverts for non-settlement caller", async function () {
    await expect(
      vault.connect(other).creditSettlement(
        publisher.address, 100n, user.address, 100n, 100n
      )
    ).to.be.revertedWith("E25");
  });

  // PV6: double-withdraw reverts E03
  it("PV6: withdrawPublisher with zero balance reverts E03", async function () {
    await expect(
      vault.connect(publisher).withdrawPublisher()
    ).to.be.revertedWith("E03");
  });

  it("PV6b: withdrawUser with zero balance reverts E03", async function () {
    await expect(
      vault.connect(user).withdrawUser()
    ).to.be.revertedWith("E03");
  });

  it("PV6c: withdrawProtocol with zero balance reverts E03", async function () {
    await expect(
      vault.connect(owner).withdrawProtocol(protocol.address)
    ).to.be.revertedWith("E03");
  });

  // PV7: Multiple credits accumulate
  it("PV7: multiple creditSettlement calls accumulate", async function () {
    const amt = parseDOT("0.1");
    await vault.connect(settlementMock).creditSettlement(
      publisher.address, amt, user.address, amt, amt
    );
    await vault.connect(settlementMock).creditSettlement(
      publisher.address, amt, user.address, amt, amt
    );

    expect(await vault.publisherBalance(publisher.address)).to.equal(amt * 2n);
    expect(await vault.userBalance(user.address)).to.equal(amt * 2n);
    expect(await vault.protocolBalance()).to.equal(amt * 2n);

    // Clean up
    await vault.connect(publisher).withdrawPublisher();
    await vault.connect(user).withdrawUser();
    await vault.connect(owner).withdrawProtocol(protocol.address);
  });

  // Admin setters
  it("setSettlement requires owner and non-zero", async function () {
    await expect(
      vault.connect(other).setSettlement(other.address)
    ).to.be.reverted;

    await expect(
      vault.setSettlement(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });
});
