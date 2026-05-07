import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumGovernanceRouter,
  MockCampaigns,
  MockCampaignLifecycle,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumGovernanceRouter admin functions (alpha-4: AdminGovernance merged into Router)
//
// R1:  adminActivateCampaign — owner can activate
// R2:  adminTerminateCampaign — owner can terminate
// R3:  adminDemoteCampaign — owner can demote
// R4:  Non-owner reverts on all admin actions
// R5:  Router routes activateCampaign via governor
// R6:  Non-governor cannot call routing functions
// R7:  getCampaignForSettlement passthrough
// R8:  setGovernor updates phase + governor
// R9:  sweepTo forwards accumulated ETH
// R10: owner-only setters: non-owner reverts
// R11: ownership transfer (two-step)

describe("DatumGovernanceRouter (admin functions)", function () {
  let router: DatumGovernanceRouter;
  let mock: MockCampaigns;
  let mockLifecycle: MockCampaignLifecycle;

  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, other, newOwner, governor] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const LifecycleFactory = await ethers.getContractFactory("MockCampaignLifecycle");
    mockLifecycle = await LifecycleFactory.deploy(await mock.getAddress());

    const RouterFactory = await ethers.getContractFactory("DatumGovernanceRouter");
    router = await RouterFactory.deploy(
      await mock.getAddress(),
      await mockLifecycle.getAddress(),
      owner.address // governor placeholder (owner is governor initially)
    );

    // Wire lifecycle to accept calls from router
    await mockLifecycle.setGovernanceContract(await router.getAddress());
    // Wire campaigns to accept calls from router
    await mock.setGovernanceContract(await router.getAddress());
    await mock.setLifecycleContract(await mockLifecycle.getAddress());

    // Set up campaigns in various states
    await mock.setCampaign(1, owner.address, other.address, 1_000_000_000n, 500, 0); // Pending
    await mock.setCampaign(2, owner.address, other.address, 1_000_000_000n, 500, 1); // Active
    await mock.setCampaign(3, owner.address, other.address, 1_000_000_000n, 500, 1); // Active
  });

  // ── Admin functions (onlyOwner) ───────────────────────────────────────────

  it("R1: adminActivateCampaign — owner can activate", async function () {
    await router.connect(owner).adminActivateCampaign(1);
    const c = await mock.campaigns(1);
    expect(c.status).to.equal(1n); // Active
  });

  it("R2: adminTerminateCampaign — owner can terminate", async function () {
    await router.connect(owner).adminTerminateCampaign(2);
    const c = await mock.campaigns(2);
    expect(c.status).to.equal(4n); // Terminated
  });

  it("R3: adminDemoteCampaign — owner can demote", async function () {
    await router.connect(owner).adminDemoteCampaign(3);
    const c = await mock.campaigns(3);
    expect(c.status).to.equal(0n); // Pending
  });

  it("R4: non-owner reverts on all admin actions", async function () {
    await mock.setCampaign(4, owner.address, other.address, 1_000_000_000n, 500, 0);
    await expect(router.connect(other).adminActivateCampaign(4)).to.be.revertedWith("E18");
    await expect(router.connect(other).adminTerminateCampaign(4)).to.be.revertedWith("E18");
    await expect(router.connect(other).adminDemoteCampaign(4)).to.be.revertedWith("E18");
  });

  // ── Governor routing ──────────────────────────────────────────────────────

  it("R5: governor can activate via router", async function () {
    await mock.setCampaign(5, owner.address, other.address, 1_000_000_000n, 500, 0);
    // owner is currently the governor
    await router.connect(owner).activateCampaign(5);
    const c = await mock.campaigns(5);
    expect(c.status).to.equal(1n);
  });

  it("R6: non-governor cannot call routing functions", async function () {
    await mock.setCampaign(6, owner.address, other.address, 1_000_000_000n, 500, 0);
    await expect(router.connect(other).activateCampaign(6)).to.be.revertedWith("E19");
    await expect(router.connect(other).terminateCampaign(6)).to.be.revertedWith("E19");
    await expect(router.connect(other).demoteCampaign(6)).to.be.revertedWith("E19");
  });

  // ── Views and setters ─────────────────────────────────────────────────────

  it("R7: getCampaignForSettlement passthrough", async function () {
    await mock.setCampaign(7, owner.address, other.address, 1_000_000_000n, 500, 1);
    const [status, publisher, takeRate] = await router.getCampaignForSettlement(7);
    expect(status).to.equal(1n);
    expect(publisher).to.equal(other.address);
    expect(takeRate).to.equal(500n);
  });

  it("R8: setGovernor updates phase + governor, emits PhaseTransitioned", async function () {
    const tx = await router.connect(owner).setGovernor(1, governor.address);
    await expect(tx)
      .to.emit(router, "PhaseTransitioned")
      .withArgs(1n, governor.address);
    expect(await router.governor()).to.equal(governor.address);
    expect(await router.phase()).to.equal(1n);

    // Restore owner as governor
    await router.connect(owner).setGovernor(0, owner.address);
  });

  it("R9: sweepTo forwards ETH balance to recipient", async function () {
    await owner.sendTransaction({ to: await router.getAddress(), value: ethers.parseEther("1") });
    const balBefore = await ethers.provider.getBalance(newOwner.address);
    await router.connect(owner).sweepTo(newOwner.address);
    const balAfter = await ethers.provider.getBalance(newOwner.address);
    expect(balAfter - balBefore).to.equal(ethers.parseEther("1"));
  });

  it("R10: owner-only — non-owner reverts", async function () {
    await expect(router.connect(other).setGovernor(0, owner.address)).to.be.revertedWith("E18");
    await expect(router.connect(other).setCampaigns(owner.address)).to.be.revertedWith("E18");
    await expect(router.connect(other).setLifecycle(owner.address)).to.be.revertedWith("E18");
    await expect(router.connect(other).sweepTo(other.address)).to.be.revertedWith("E18");
  });

  it("R11: ownership transfer — two-step", async function () {
    await router.connect(owner).transferOwnership(newOwner.address);
    expect(await router.pendingOwner()).to.equal(newOwner.address);
    await router.connect(newOwner).acceptOwnership();
    expect(await router.owner()).to.equal(newOwner.address);
    // Restore
    await router.connect(newOwner).transferOwnership(owner.address);
    await router.connect(owner).acceptOwnership();
  });
});
