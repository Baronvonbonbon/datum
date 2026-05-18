// DatumUpgradable — Stage 2 base abstract.
//
// Covers narrative-analysis/upgrade-ladder-design.md §3:
//   - setRouter (lock-once, owner-only)
//   - version() (per-version override)
//   - pause / unpause (onlyGovernance, whenNotPaused effect)
//   - migrate() (lock-once, version-must-increase, old-must-pause,
//     reentrancy-safe ordering)
//   - storage gap doesn't trip up inheritance

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumGovernanceRouter,
  MockCampaigns,
  MockCampaignLifecycle,
  MockUpgradable,
  MockUpgradableV2,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("DatumUpgradable", function () {
  let router: DatumGovernanceRouter;
  let mockC: MockCampaigns;
  let mockL: MockCampaignLifecycle;

  let owner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let v1: MockUpgradable;
  let v2: MockUpgradableV2;

  beforeEach(async function () {
    [owner, governor, council, other] = await ethers.getSigners();

    const MockCF = await ethers.getContractFactory("MockCampaigns");
    mockC = await MockCF.deploy();
    const MockLF = await ethers.getContractFactory("MockCampaignLifecycle");
    mockL = await MockLF.deploy(await mockC.getAddress());

    const RouterF = await ethers.getContractFactory("DatumGovernanceRouter");
    router = await RouterF.deploy(
      await mockC.getAddress(),
      await mockL.getAddress(),
      governor.address,
    );

    const V1F = await ethers.getContractFactory("MockUpgradable");
    v1 = await V1F.deploy(1);

    const V2F = await ethers.getContractFactory("MockUpgradableV2");
    v2 = await V2F.deploy();
  });

  // ─────────────────────────────────────────────────────────────────────
  // setRouter
  // ─────────────────────────────────────────────────────────────────────
  describe("setRouter (lock-once)", function () {
    it("owner can set the router", async () => {
      await expect(v1.connect(owner).setRouter(await router.getAddress()))
        .to.emit(v1, "RouterSet").withArgs(await router.getAddress());
      expect(await v1.router()).to.equal(await router.getAddress());
    });

    it("non-owner reverts E18", async () => {
      await expect(v1.connect(other).setRouter(await router.getAddress()))
        .to.be.revertedWith("E18");
    });

    it("zero address reverts E00", async () => {
      await expect(v1.connect(owner).setRouter(ethers.ZeroAddress))
        .to.be.revertedWith("E00");
    });

    it("second call reverts (lock-once)", async () => {
      await v1.connect(owner).setRouter(await router.getAddress());
      await expect(v1.connect(owner).setRouter(await router.getAddress()))
        .to.be.revertedWith("router-set");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // version()
  // ─────────────────────────────────────────────────────────────────────
  describe("version()", function () {
    it("default child returns 1", async () => {
      expect(await v1.version()).to.equal(1n);
    });

    it("override child returns higher", async () => {
      expect(await v2.version()).to.equal(2n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // pause / unpause / whenNotPaused
  // ─────────────────────────────────────────────────────────────────────
  describe("pause", function () {
    beforeEach(async () => {
      await v1.connect(owner).setRouter(await router.getAddress());
    });

    it("rejects pause before router is set", async () => {
      const fresh = await (await ethers.getContractFactory("MockUpgradable")).deploy(1);
      // governor on the router is `governor` but fresh has no router wired
      await expect(fresh.connect(governor).pause()).to.be.revertedWith("router-unset");
    });

    it("non-governor reverts E19", async () => {
      await expect(v1.connect(other).pause()).to.be.revertedWith("E19");
    });

    it("governor can pause + unpause", async () => {
      await expect(v1.connect(governor).pause()).to.emit(v1, "Paused");
      expect(await v1.paused()).to.equal(true);
      await expect(v1.connect(governor).unpause()).to.emit(v1, "Unpaused");
      expect(await v1.paused()).to.equal(false);
    });

    it("paused blocks whenNotPaused functions; reads work", async () => {
      await v1.connect(governor).pause();
      await expect(v1.connect(other).increment()).to.be.revertedWith("paused");
      // Read is still available
      expect(await v1.counter()).to.equal(0n);
    });

    it("double-pause reverts", async () => {
      await v1.connect(governor).pause();
      await expect(v1.connect(governor).pause()).to.be.revertedWith("already paused");
    });

    it("unpause without prior pause reverts", async () => {
      await expect(v1.connect(governor).unpause()).to.be.revertedWith("not paused");
    });

    it("authority follows the router's current governor (Council phase)", async () => {
      // Advance router to Council phase
      await router.connect(owner).setGovernor(1, council.address);
      await router.connect(council).acceptGovernor();
      // governor EOA can no longer pause
      await expect(v1.connect(governor).pause()).to.be.revertedWith("E19");
      // council can
      await v1.connect(council).pause();
      expect(await v1.paused()).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // migrate — version + pause requirements
  // ─────────────────────────────────────────────────────────────────────
  describe("migrate", function () {
    beforeEach(async () => {
      // Wire both v1 and v2 to the same router
      await v1.connect(owner).setRouter(await router.getAddress());
      await v2.connect(owner).setRouter(await router.getAddress());
      // Seed state on v1
      await v1.connect(owner).setCounter(42n);
      // Pause v1 so its state is frozen
      await v1.connect(governor).pause();
    });

    it("v2 can migrate from v1 (state copied)", async () => {
      await expect(v2.connect(governor).migrate(await v1.getAddress()))
        .to.emit(v2, "Migrated").withArgs(await v1.getAddress(), 1, 2);
      expect(await v2.counter()).to.equal(42n);
      expect(await v2.migrated()).to.equal(true);
      expect(await v2.migrationSource()).to.equal(await v1.getAddress());
    });

    it("migrate from unpaused old reverts", async () => {
      await v1.connect(governor).unpause();
      await expect(v2.connect(governor).migrate(await v1.getAddress()))
        .to.be.revertedWith("old-not-paused");
    });

    it("migrate from same-or-higher version reverts (downgrade)", async () => {
      // v2 paused (set up to be migration source); v1 trying to migrate from v2 → downgrade
      await v1.connect(governor).unpause();
      await v2.connect(governor).pause();
      // Re-wire so v1 can be the target: v1.version() = 1, v2.version() = 2.
      // v1 migrating from v2 = downgrade (1 < 2 NOT >= so revert)
      await expect(v1.connect(governor).migrate(await v2.getAddress()))
        .to.be.revertedWith("downgrade");
    });

    it("migrate same-version reverts (also a downgrade)", async () => {
      // Fresh peer v1' at the same version as v1
      const peer = await (await ethers.getContractFactory("MockUpgradable")).deploy(1);
      await peer.connect(owner).setRouter(await router.getAddress());
      await peer.connect(governor).pause();
      // v1 (version 1) trying to migrate from peer (version 1) — not strictly greater
      await v1.connect(governor).unpause();
      await expect(v1.connect(governor).migrate(await peer.getAddress()))
        .to.be.revertedWith("downgrade");
    });

    it("migrate to self reverts E18", async () => {
      // v2 trying to migrate from itself
      await v2.connect(governor).pause();
      await expect(v2.connect(governor).migrate(await v2.getAddress()))
        .to.be.revertedWith("E18");
    });

    it("migrate from zero address reverts E00", async () => {
      await expect(v2.connect(governor).migrate(ethers.ZeroAddress))
        .to.be.revertedWith("E00");
    });

    it("double-migrate reverts (lock-once)", async () => {
      await v2.connect(governor).migrate(await v1.getAddress());
      // Try a second migration from a third peer
      const peer = await (await ethers.getContractFactory("MockUpgradable")).deploy(1);
      await peer.connect(owner).setRouter(await router.getAddress());
      await peer.connect(governor).pause();
      await expect(v2.connect(governor).migrate(await peer.getAddress()))
        .to.be.revertedWith("already migrated");
    });

    it("non-governance cannot migrate", async () => {
      await expect(v2.connect(other).migrate(await v1.getAddress()))
        .to.be.revertedWith("E19");
    });
  });
});
