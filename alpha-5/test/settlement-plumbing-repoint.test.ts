import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { wireSettlementLogic } from "./helpers/settlementLogic";
import { wireOpenGovRouter } from "./helpers/openGovRouter";

// Cypherpunk-posture regression guard (roadmap 2026-05-18): Settlement's
// structural references — including the payment vault — must stay GOVERNANCE-
// re-pointable through Admin/Council ("upgradable today") and freeze only when
// OpenGov fires lockPlumbing() ("locked tomorrow"). The prior B8-fix froze them
// at deploy (revert AlreadySet on first write), which forced a full Settlement
// redeploy to swap the vault. This suite locks in the corrected behavior.
describe("Settlement / Vault structural-ref re-point (cypherpunk posture)", function () {
  let settlement: any;
  let owner: HardhatEthersSigner;
  let a: HardhatEthersSigner; // stand-in addresses for structural refs
  let b: HardhatEthersSigner;
  let c: HardhatEthersSigner;
  let vault1: HardhatEthersSigner;
  let vault2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, a, b, c, vault1, vault2] = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    const pause = await Pause.deploy(owner.address, a.address, b.address);
    settlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(await pause.getAddress());
    await wireSettlementLogic(settlement as any);
    // Bootstrap: configure with vault1 as the payment vault.
    await settlement.configure(a.address, vault1.address, b.address, c.address);
  });

  it("governance can re-point the payment vault via configure while unlocked (the cascade fix)", async function () {
    expect(await settlement.paymentVault()).to.equal(vault1.address);
    // Re-point to a fresh vault — no redeploy needed.
    await settlement.connect(owner).configure(a.address, vault2.address, b.address, c.address);
    expect(await settlement.paymentVault()).to.equal(vault2.address);
  });

  it("individual structural setters are re-pointable while unlocked", async function () {
    await settlement.connect(owner).setPublishers(a.address);
    await settlement.connect(owner).setPublishers(b.address); // would have reverted AlreadySet pre-fix
    await settlement.connect(owner).setClaimValidator(a.address);
    await settlement.connect(owner).setClaimValidator(b.address);
  });

  it("lockPlumbing (OpenGov-gated) freezes every structural ref permanently", async function () {
    await wireOpenGovRouter(settlement as any);
    await settlement.connect(owner).lockPlumbing();
    expect(await settlement.plumbingLocked()).to.equal(true);
    await expect(
      settlement.connect(owner).configure(a.address, vault2.address, b.address, c.address),
    ).to.be.revertedWithCustomError(settlement, "AlreadySet");
    await expect(settlement.connect(owner).setPublishers(a.address))
      .to.be.revertedWithCustomError(settlement, "AlreadySet");
  });

  it("lockPlumbing requires OpenGov phase (cannot fire in Admin/Council)", async function () {
    const router = await wireOpenGovRouter(settlement as any);
    await router.setPhase(0); // Admin
    await expect(settlement.connect(owner).lockPlumbing()).to.be.revertedWith("not-opengov");
    await router.setPhase(2);
    await settlement.connect(owner).lockPlumbing();
  });

  describe("DatumPaymentVault.setSettlement", function () {
    let vault: any;
    beforeEach(async function () {
      vault = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
    });

    it("is re-pointable until lockSettlementRef, then frozen at OpenGov", async function () {
      await vault.connect(owner).setSettlement(a.address);
      await vault.connect(owner).setSettlement(b.address); // re-pointable (pre-fix: "already set")
      expect(await vault.settlement()).to.equal(b.address);
      await wireOpenGovRouter(vault as any);
      await vault.connect(owner).lockSettlementRef();
      expect(await vault.settlementRefLocked()).to.equal(true);
      await expect(vault.connect(owner).setSettlement(c.address)).to.be.revertedWith("locked");
    });

    it("lockSettlementRef requires OpenGov phase + a set settlement", async function () {
      const router = await wireOpenGovRouter(vault as any);
      await expect(vault.connect(owner).lockSettlementRef()).to.be.revertedWith("set first");
      await vault.connect(owner).setSettlement(a.address);
      await router.setPhase(1); // Council
      await expect(vault.connect(owner).lockSettlementRef()).to.be.revertedWith("not-opengov");
      await router.setPhase(2);
      await vault.connect(owner).lockSettlementRef();
    });
  });
});
