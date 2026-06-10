import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumSettlement } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";
import { wireSettlementLogic } from "./helpers/settlementLogic";

// G-7 close confirmation: userMinAssurance can be set to L3 (ZK-only floor).
// Setter accepts 0..3; rejects 4+. The L3 enforcement itself lives in
// DatumSettlementLogicB._processBatch (M1-fix from audit-pass-5) and is
// table-tested separately via the assurance-gradient + integration paths.
// These tests confirm the setter bound and the per-user state read.

describe("DatumSettlement userMinAssurance L3 (G-7 close)", function () {
  let settlement: DatumSettlement;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let pauseGuard1: HardhatEthersSigner;
  let pauseGuard2: HardhatEthersSigner;

  beforeEach(async function () {
    await fundSigners();
    [owner, user, pauseGuard1, pauseGuard2] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    const pauseReg = await PauseFactory.deploy(owner.address, pauseGuard1.address, pauseGuard2.address);

    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await pauseReg.getAddress());
    await wireSettlementLogic(settlement as any);
  });

  it("G7-1: setUserMinAssurance(0) accepted (default)", async function () {
    await settlement.connect(user).setUserMinAssurance(0);
    expect(await settlement.userMinAssurance(user.address)).to.equal(0);
  });

  it("G7-2: setUserMinAssurance(1) accepted (L1 floor)", async function () {
    await settlement.connect(user).setUserMinAssurance(1);
    expect(await settlement.userMinAssurance(user.address)).to.equal(1);
  });

  it("G7-3: setUserMinAssurance(2) accepted (L2 dual-sig floor)", async function () {
    await settlement.connect(user).setUserMinAssurance(2);
    expect(await settlement.userMinAssurance(user.address)).to.equal(2);
  });

  it("G7-4: setUserMinAssurance(3) accepted (L3 ZK-only floor — G-7 close)", async function () {
    await settlement.connect(user).setUserMinAssurance(3);
    expect(await settlement.userMinAssurance(user.address)).to.equal(3);
  });

  it("G7-5: setUserMinAssurance(4) reverts E11", async function () {
    await expect(settlement.connect(user).setUserMinAssurance(4))
      .to.be.revertedWithCustomError(settlement, "E11");
  });

  it("G7-6: setUserMinAssurance(255) reverts E11", async function () {
    await expect(settlement.connect(user).setUserMinAssurance(255))
      .to.be.revertedWithCustomError(settlement, "E11");
  });

  it("G7-7: setUserMinAssurance is self-only (msg.sender)", async function () {
    await settlement.connect(user).setUserMinAssurance(3);
    expect(await settlement.userMinAssurance(user.address)).to.equal(3);
    expect(await settlement.userMinAssurance(owner.address)).to.equal(0);
  });

  it("G7-8: setUserMinAssurance emits UserMinAssuranceSet", async function () {
    await expect(settlement.connect(user).setUserMinAssurance(3))
      .to.emit(settlement, "UserMinAssuranceSet")
      .withArgs(user.address, 3);
  });
});
