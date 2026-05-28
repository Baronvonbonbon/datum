import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumGovernanceRouter,
  DatumAdminGovernance,
  MockCampaigns,
  MockCampaignLifecycle,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumGovernanceRouter + DatumAdminGovernance (Phase 0 governance ladder)
//
// R1:  Router routes activateCampaign to campaigns via governor
// R2:  Router routes terminateCampaign to lifecycle via governor
// R3:  Router routes demoteCampaign to lifecycle via governor
// R4:  Non-governor cannot call routing functions
// R5:  Router getCampaignForSettlement passthrough
// R6:  Router setGovernor updates phase + governor
// R7:  Router sweepTo forwards accumulated ETH
// R8:  Router owner-only: non-owner reverts
// R9:  Router ownership transfer
//
// AG1: AdminGov.activateCampaign succeeds (owner)
// AG2: AdminGov.terminateCampaign succeeds (owner)
// AG3: AdminGov.demoteCampaign succeeds (owner)
// AG4: Non-owner reverts on all actions
// AG5: AdminGov.setRouter updates router reference
// AG6: AdminGov ownership transfer

describe("DatumGovernanceRouter + DatumAdminGovernance", function () {
  let router: DatumGovernanceRouter;
  let adminGov: DatumAdminGovernance;
  let mock: MockCampaigns;
  let mockLifecycle: MockCampaignLifecycle;

  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;

  before(async function () {
    await fundSigners();
    [owner, other, newOwner] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const LifecycleFactory = await ethers.getContractFactory("MockCampaignLifecycle");
    mockLifecycle = await LifecycleFactory.deploy(await mock.getAddress());

    // Deploy AdminGov with a placeholder router address first, then deploy router
    const AdminGovFactory = await ethers.getContractFactory("DatumAdminGovernance");
    // deploy router first with a placeholder governor (will update)
    const RouterFactory = await ethers.getContractFactory("DatumGovernanceRouter");
    // temp: use owner.address as governor placeholder
    router = await RouterFactory.deploy(
      await mock.getAddress(),
      await mockLifecycle.getAddress(),
      owner.address
    );

    adminGov = await AdminGovFactory.deploy(await router.getAddress());

    // Point router to adminGov as governor
    await router.setGovernor(0, await adminGov.getAddress()); // Phase.Admin = 0

    // Wire lifecycle to accept calls from router (lifecycle.governanceContract = router)
    await mockLifecycle.setGovernanceContract(await router.getAddress());
    // Wire campaigns to accept calls from router
    await mock.setGovernanceContract(await router.getAddress());
    // Wire campaigns to accept lifecycle status updates (setCampaignStatus requires msg.sender == lifecycleContract)
    await mock.setLifecycleContract(await mockLifecycle.getAddress());

    // Set up campaign 1 in Pending state
    await mock.setCampaign(1, owner.address, other.address, 1_000_000_000n, 500, 0);
    // Set up campaign 2 in Active state
    await mock.setCampaign(2, owner.address, other.address, 1_000_000_000n, 500, 1);
  });

  // ── R1: Router routes activateCampaign ─────────────────────────────────────

  it("R1 router activateCampaign — governor can activate via router", async function () {
    // Call directly on router with governor (adminGov) as msg.sender
    // We test the full path via AdminGov
    await expect(adminGov.connect(owner).activateCampaign(1))
      .to.emit(adminGov, "CampaignActivated")
      .withArgs(1n);
    const c = await mock.campaigns(1);
    expect(c.status).to.equal(1n); // Active
  });

  // ── R2: Router routes terminateCampaign ────────────────────────────────────

  it("R2 router terminateCampaign — governor can terminate via router", async function () {
    await expect(adminGov.connect(owner).terminateCampaign(2))
      .to.emit(adminGov, "CampaignTerminated")
      .withArgs(2n);
    const c = await mock.campaigns(2);
    expect(c.status).to.equal(4n); // Terminated
  });

  // ── R3: Router routes demoteCampaign ───────────────────────────────────────

  it("R3 router demoteCampaign — governor can demote via router", async function () {
    // Set campaign 3 as Active
    await mock.setCampaign(3, owner.address, other.address, 1_000_000_000n, 500, 1);
    await expect(adminGov.connect(owner).demoteCampaign(3))
      .to.emit(adminGov, "CampaignDemoted")
      .withArgs(3n);
    const c = await mock.campaigns(3);
    expect(c.status).to.equal(0n); // Pending
  });

  // ── R4: Non-governor cannot call Router routing functions ──────────────────

  it("R4 router non-governor reverts", async function () {
    await mock.setCampaign(4, owner.address, other.address, 1_000_000_000n, 500, 0);
    await expect(
      router.connect(other).activateCampaign(4)
    ).to.be.revertedWith("E19");
    await expect(
      router.connect(other).terminateCampaign(4)
    ).to.be.revertedWith("E19");
    await expect(
      router.connect(other).demoteCampaign(4)
    ).to.be.revertedWith("E19");
  });

  // ── R5: getCampaignForSettlement passthrough ────────────────────────────────

  it("R5 router getCampaignForSettlement passthrough", async function () {
    await mock.setCampaign(5, owner.address, other.address, 1_000_000_000n, 500, 1);
    const [status, publisher, takeRate] = await router.getCampaignForSettlement(5);
    expect(status).to.equal(1n);
    expect(publisher).to.equal(other.address);
    expect(takeRate).to.equal(500n);
  });

  // ── R6: setGovernor updates phase and governor ─────────────────────────────

  it("R6 router setGovernor — updates phase + governor, emits PhaseTransitioned", async function () {
    const tx = await router.connect(owner).setGovernor(1, other.address); // Council = 1
    await expect(tx)
      .to.emit(router, "PhaseTransitioned")
      .withArgs(1n, other.address);
    expect(await router.governor()).to.equal(other.address);
    expect(await router.phase()).to.equal(1n);

    // Restore
    await router.connect(owner).setGovernor(0, await adminGov.getAddress());
  });

  // ── R7: sweepTo forwards ETH ───────────────────────────────────────────────

  it("R7 router sweepTo — sweeps ETH balance to recipient", async function () {
    // Fund the router directly
    await owner.sendTransaction({ to: await router.getAddress(), value: ethers.parseEther("1") });
    const balBefore = await ethers.provider.getBalance(newOwner.address);
    await router.connect(owner).sweepTo(newOwner.address);
    const balAfter = await ethers.provider.getBalance(newOwner.address);
    expect(balAfter - balBefore).to.equal(ethers.parseEther("1"));
  });

  // ── R8: Router owner-only setters ──────────────────────────────────────────

  it("R8 router owner-only — non-owner reverts", async function () {
    await expect(
      router.connect(other).setGovernor(0, owner.address)
    ).to.be.revertedWith("E18");
    await expect(
      router.connect(other).setCampaigns(owner.address)
    ).to.be.revertedWith("E18");
    await expect(
      router.connect(other).setLifecycle(owner.address)
    ).to.be.revertedWith("E18");
    await expect(
      router.connect(other).sweepTo(other.address)
    ).to.be.revertedWith("E18");
  });

  // ── R9: Router ownership transfer ──────────────────────────────────────────

  it("R9 router ownership transfer — two-step", async function () {
    await router.connect(owner).transferOwnership(newOwner.address);
    expect(await router.pendingOwner()).to.equal(newOwner.address);
    await router.connect(newOwner).acceptOwnership();
    expect(await router.owner()).to.equal(newOwner.address);
    // Restore
    await router.connect(newOwner).transferOwnership(owner.address);
    await router.connect(owner).acceptOwnership();
  });

  // ── AG1: AdminGov activateCampaign ─────────────────────────────────────────

  it("AG1 adminGov activateCampaign — owner activates", async function () {
    await mock.setCampaign(10, owner.address, other.address, 1_000_000_000n, 500, 0);
    await expect(adminGov.connect(owner).activateCampaign(10))
      .to.emit(adminGov, "CampaignActivated")
      .withArgs(10n);
    const c = await mock.campaigns(10);
    expect(c.status).to.equal(1n);
  });

  // ── AG2: AdminGov terminateCampaign ────────────────────────────────────────

  it("AG2 adminGov terminateCampaign — owner terminates", async function () {
    await mock.setCampaign(11, owner.address, other.address, 1_000_000_000n, 500, 1);
    await expect(adminGov.connect(owner).terminateCampaign(11))
      .to.emit(adminGov, "CampaignTerminated")
      .withArgs(11n);
    const c = await mock.campaigns(11);
    expect(c.status).to.equal(4n);
  });

  // ── AG3: AdminGov demoteCampaign ───────────────────────────────────────────

  it("AG3 adminGov demoteCampaign — owner demotes active campaign", async function () {
    await mock.setCampaign(12, owner.address, other.address, 1_000_000_000n, 500, 1);
    await expect(adminGov.connect(owner).demoteCampaign(12))
      .to.emit(adminGov, "CampaignDemoted")
      .withArgs(12n);
    const c = await mock.campaigns(12);
    expect(c.status).to.equal(0n);
  });

  // ── AG4: Non-owner reverts ─────────────────────────────────────────────────

  it("AG4 adminGov non-owner reverts on all actions", async function () {
    await mock.setCampaign(13, owner.address, other.address, 1_000_000_000n, 500, 0);
    await expect(adminGov.connect(other).activateCampaign(13)).to.be.revertedWith("E18");
    await expect(adminGov.connect(other).terminateCampaign(13)).to.be.revertedWith("E18");
    await expect(adminGov.connect(other).demoteCampaign(13)).to.be.revertedWith("E18");
  });

  // ── AG5: setRouter ─────────────────────────────────────────────────────────

  it("AG5 adminGov setRouter — updates reference", async function () {
    await adminGov.connect(owner).setRouter(other.address);
    expect(await adminGov.router()).to.equal(other.address);
    await adminGov.connect(owner).setRouter(await router.getAddress());
  });

  // ── AG6: AdminGov ownership transfer ──────────────────────────────────────

  it("AG6 adminGov ownership transfer — two-step", async function () {
    await adminGov.connect(owner).transferOwnership(newOwner.address);
    expect(await adminGov.pendingOwner()).to.equal(newOwner.address);
    await adminGov.connect(newOwner).acceptOwnership();
    expect(await adminGov.owner()).to.equal(newOwner.address);
    // Restore
    await adminGov.connect(newOwner).transferOwnership(owner.address);
    await adminGov.connect(owner).acceptOwnership();
  });
});
