// DatumGovernanceRouter — Stage 1 upgrade ladder (registry + regression).
//
// Covers narrative-analysis/upgrade-ladder-design.md §2:
//   - register / upgradeContract phase-gated auth
//   - version + history tracking
//   - phase regression with timelock (propose → 48h → execute)
//   - cancellation
//   - phase floor follows regression downward

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumGovernanceRouter,
  MockCampaigns,
  MockCampaignLifecycle,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const NAME_BRIDGE   = ethers.keccak256(ethers.toUtf8Bytes("bridge"));
const NAME_REPORTER = ethers.keccak256(ethers.toUtf8Bytes("reporter"));

// Match MIN_REGRESSION_TIMELOCK so tests don't have to mine 48h
const TIMELOCK_BLOCKS = 14400n;

async function mineBlocks(n: bigint) {
  await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

describe("DatumGovernanceRouter — Stage 1 upgrade ladder", function () {
  let router: DatumGovernanceRouter;
  let mock: MockCampaigns;
  let mockLifecycle: MockCampaignLifecycle;

  let owner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let openGov: HardhatEthersSigner;
  let v1: HardhatEthersSigner;
  let v2: HardhatEthersSigner;
  let v3: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, governor, council, openGov, v1, v2, v3, other] = await ethers.getSigners();

    const MockF = await ethers.getContractFactory("MockCampaigns");
    mock = await MockF.deploy();
    const LifecycleF = await ethers.getContractFactory("MockCampaignLifecycle");
    mockLifecycle = await LifecycleF.deploy(await mock.getAddress());

    const RouterF = await ethers.getContractFactory("DatumGovernanceRouter");
    router = await RouterF.deploy(
      await mock.getAddress(),
      await mockLifecycle.getAddress(),
      governor.address,
    );

    // Lower the regression timelock to MIN so tests can mine through it.
    await router.connect(owner).setRegressionTimelock(TIMELOCK_BLOCKS);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Registry: register
  // ─────────────────────────────────────────────────────────────────────
  describe("register", function () {
    it("owner can register an initial address", async () => {
      await expect(router.connect(owner).register(NAME_BRIDGE, v1.address))
        .to.emit(router, "ContractRegistered").withArgs(NAME_BRIDGE, v1.address);
      expect(await router.currentAddrOf(NAME_BRIDGE)).to.equal(v1.address);
      expect(await router.versionOf(NAME_BRIDGE)).to.equal(1n);
      expect(await router.addressHistoryLength(NAME_BRIDGE)).to.equal(1n);
      expect(await router.addressHistory(NAME_BRIDGE, 0)).to.equal(v1.address);
    });

    it("non-owner reverts E18", async () => {
      await expect(router.connect(other).register(NAME_BRIDGE, v1.address))
        .to.be.revertedWith("E18");
    });

    it("zero address reverts E00", async () => {
      await expect(router.connect(owner).register(NAME_BRIDGE, ethers.ZeroAddress))
        .to.be.revertedWith("E00");
    });

    it("double-register reverts (use upgradeContract)", async () => {
      await router.connect(owner).register(NAME_BRIDGE, v1.address);
      await expect(router.connect(owner).register(NAME_BRIDGE, v2.address))
        .to.be.revertedWith("already registered");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Registry: upgradeContract — phase-gated authorization
  // ─────────────────────────────────────────────────────────────────────
  describe("upgradeContract (Admin phase)", function () {
    beforeEach(async () => {
      await router.connect(owner).register(NAME_BRIDGE, v1.address);
    });

    it("governor (deployer) can upgrade in Admin phase", async () => {
      await expect(router.connect(governor).upgradeContract(NAME_BRIDGE, v2.address))
        .to.emit(router, "ContractUpgraded").withArgs(NAME_BRIDGE, v1.address, v2.address, 2n);
      expect(await router.currentAddrOf(NAME_BRIDGE)).to.equal(v2.address);
      expect(await router.versionOf(NAME_BRIDGE)).to.equal(2n);
      expect(await router.addressHistoryLength(NAME_BRIDGE)).to.equal(2n);
    });

    it("non-governor reverts E19", async () => {
      await expect(router.connect(other).upgradeContract(NAME_BRIDGE, v2.address))
        .to.be.revertedWith("E19");
    });

    it("upgrade to zero address reverts E00", async () => {
      await expect(router.connect(governor).upgradeContract(NAME_BRIDGE, ethers.ZeroAddress))
        .to.be.revertedWith("E00");
    });

    it("upgrade to same address reverts (no change)", async () => {
      await expect(router.connect(governor).upgradeContract(NAME_BRIDGE, v1.address))
        .to.be.revertedWith("no change");
    });

    it("upgrade unregistered name reverts (not registered)", async () => {
      await expect(router.connect(governor).upgradeContract(NAME_REPORTER, v2.address))
        .to.be.revertedWith("not registered");
    });

    it("multiple upgrades increment version + extend history", async () => {
      await router.connect(governor).upgradeContract(NAME_BRIDGE, v2.address);
      await router.connect(governor).upgradeContract(NAME_BRIDGE, v3.address);
      expect(await router.versionOf(NAME_BRIDGE)).to.equal(3n);
      expect(await router.addressHistory(NAME_BRIDGE, 0)).to.equal(v1.address);
      expect(await router.addressHistory(NAME_BRIDGE, 1)).to.equal(v2.address);
      expect(await router.addressHistory(NAME_BRIDGE, 2)).to.equal(v3.address);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Registry: upgradeContract under Council phase
  // ─────────────────────────────────────────────────────────────────────
  describe("upgradeContract (Council phase)", function () {
    beforeEach(async () => {
      await router.connect(owner).register(NAME_BRIDGE, v1.address);
      // Advance to Council phase via the existing two-step setGovernor flow.
      // Note: we use council EOA as a stand-in for a real DatumCouncil
      // contract — the auth check is just msg.sender == governor.
      await router.connect(owner).setGovernor(1, council.address);
      await router.connect(council).acceptGovernor();
      // Option 2: moving to Council governance also points the admin/upgrade
      // authority at the Council (owner/Timelock-gated). upgradeContract is
      // gated on adminGovernor, NOT the campaign governor.
      await router.connect(owner).setAdminGovernor(council.address);
      expect(await router.phase()).to.equal(1n); // Council
      expect(await router.governor()).to.equal(council.address);
      expect(await router.adminGovernor()).to.equal(council.address);
    });

    it("Admin-phase deployer can no longer upgrade", async () => {
      await expect(router.connect(governor).upgradeContract(NAME_BRIDGE, v2.address))
        .to.be.revertedWith("E19");
    });

    it("Council can upgrade", async () => {
      await router.connect(council).upgradeContract(NAME_BRIDGE, v2.address);
      expect(await router.currentAddrOf(NAME_BRIDGE)).to.equal(v2.address);
    });
  });

  describe("upgradeContract (OpenGov phase — admin/campaign split)", function () {
    // The point of Option 2: at OpenGov the CAMPAIGN governor is GovernanceV2
    // (openGov here), which has no upgrade call path, while the standing admin
    // executor (Council) retains upgrade authority. The split makes this
    // expressible: adminGovernor stays Council while governor advances to OpenGov.
    beforeEach(async () => {
      await router.connect(owner).register(NAME_BRIDGE, v1.address);
      await router.connect(owner).setGovernor(1, council.address);
      await router.connect(council).acceptGovernor();
      // Admin authority parks at the Council (standing executor)...
      await router.connect(owner).setAdminGovernor(council.address);
      // ...then the campaign governor advances to OpenGov.
      await router.connect(owner).setGovernor(2, openGov.address);
      await router.connect(openGov).acceptGovernor();
      expect(await router.phase()).to.equal(2n); // OpenGov
      expect(await router.governor()).to.equal(openGov.address);
      expect(await router.adminGovernor()).to.equal(council.address);
    });

    it("campaign governor (OpenGov) cannot upgrade — admin authority is decoupled", async () => {
      await expect(router.connect(openGov).upgradeContract(NAME_BRIDGE, v2.address))
        .to.be.revertedWith("E19");
    });

    it("adminGovernor (Council) still upgrades at OpenGov phase", async () => {
      await router.connect(council).upgradeContract(NAME_BRIDGE, v2.address);
      expect(await router.currentAddrOf(NAME_BRIDGE)).to.equal(v2.address);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Admin/campaign governor split (Option 2 — Stage 2)
  // ─────────────────────────────────────────────────────────────────────
  describe("adminGovernor split", function () {
    it("defaults to the constructor governor (Phase-0 single-key preserved)", async () => {
      expect(await router.adminGovernor()).to.equal(await router.governor());
    });

    it("setAdminGovernor is owner-only", async () => {
      await expect(router.connect(other).setAdminGovernor(council.address))
        .to.be.revertedWith("E18");
      await expect(router.connect(owner).setAdminGovernor(ethers.ZeroAddress))
        .to.be.revertedWith("E00");
    });

    it("setAdminGovernor moves upgrade authority independently of the campaign governor", async () => {
      await router.connect(owner).register(NAME_BRIDGE, v1.address);
      // Advancing the campaign governor alone does NOT move upgrade authority.
      await router.connect(owner).setGovernor(1, council.address);
      await router.connect(council).acceptGovernor();
      await expect(router.connect(council).upgradeContract(NAME_BRIDGE, v2.address))
        .to.be.revertedWith("E19"); // adminGovernor still the deployer
      expect(await router.adminGovernor()).to.equal(governor.address);
      // Explicitly handing admin authority over is what grants it.
      await router.connect(owner).setAdminGovernor(council.address);
      await router.connect(council).upgradeContract(NAME_BRIDGE, v2.address);
      expect(await router.currentAddrOf(NAME_BRIDGE)).to.equal(v2.address);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Phase regression: propose / cancel / execute
  // ─────────────────────────────────────────────────────────────────────
  describe("phase regression", function () {
    beforeEach(async () => {
      // Move all the way to OpenGov so regression has somewhere to go back to.
      await router.connect(owner).setGovernor(1, council.address);
      await router.connect(council).acceptGovernor();
      // Option 2: Council is the standing admin/emergency executor — regression
      // is gated on adminGovernor, not the campaign governor.
      await router.connect(owner).setAdminGovernor(council.address);
      await router.connect(owner).setGovernor(2, openGov.address);
      await router.connect(openGov).acceptGovernor();
      // Ratchet the floor up so we can verify regression breaks it.
      await router.connect(other).raisePhaseFloor();
      expect(await router.phase()).to.equal(2n);
      expect(await router.phaseFloor()).to.equal(2n);
      expect(await router.adminGovernor()).to.equal(council.address);
    });

    it("adminGovernor (Council) proposes regression to Council", async () => {
      const tx = await router.connect(council).proposeRegression(1, council.address);
      const receipt = await tx.wait();
      const head = BigInt(receipt!.blockNumber);
      const executable = head + TIMELOCK_BLOCKS;
      await expect(tx)
        .to.emit(router, "RegressionProposed")
        .withArgs(1, council.address, executable);
      expect(await router.pendingRegressionPhase()).to.equal(1n);
      expect(await router.pendingRegressionGovernor()).to.equal(council.address);
    });

    it("only adminGovernor can propose regression (campaign governor + randoms rejected)", async () => {
      await expect(router.connect(other).proposeRegression(1, council.address))
        .to.be.revertedWith("E19");
      // The campaign governor (OpenGov) can no longer drive regression — it is
      // an adminGovernor (Council) power now.
      await expect(router.connect(openGov).proposeRegression(1, council.address))
        .to.be.revertedWith("E19");
    });

    it("must be strictly downward", async () => {
      // OpenGov can't propose OpenGov (no regression)
      await expect(router.connect(council).proposeRegression(2, openGov.address))
        .to.be.revertedWith("not a regression");
    });

    it("cannot stack two pending regressions", async () => {
      await router.connect(council).proposeRegression(1, council.address);
      await expect(router.connect(council).proposeRegression(0, governor.address))
        .to.be.revertedWith("regression pending");
    });

    it("execute fails before timelock", async () => {
      await router.connect(council).proposeRegression(1, council.address);
      await expect(router.executeRegression())
        .to.be.revertedWith("still in timelock");
    });

    it("execute succeeds after timelock; phase + governor + floor follow down", async () => {
      await router.connect(council).proposeRegression(1, council.address);
      await mineBlocks(TIMELOCK_BLOCKS);

      await expect(router.executeRegression())
        .to.emit(router, "RegressionExecuted").withArgs(1, council.address);

      // F-008 fix: executeRegression now stages the candidate; the
      // candidate must call acceptGovernor() to finalize. After execute,
      // pendingGovernor is set but phase + governor remain unchanged.
      expect(await router.phase()).to.equal(2n); // still OpenGov pre-accept
      expect(await router.governor()).to.equal(openGov.address);
      expect(await router.pendingGovernor()).to.equal(council.address);
      // Soft floor follows down so re-promotion is unblocked.
      expect(await router.phaseFloor()).to.equal(1n);
      // Regression-pending state cleared.
      expect(await router.pendingRegressionGovernor()).to.equal(ethers.ZeroAddress);

      // Candidate accepts → phase + governor flip.
      await router.connect(council).acceptGovernor();
      expect(await router.phase()).to.equal(1n);
      expect(await router.governor()).to.equal(council.address);
    });

    it("cancel by adminGovernor clears the pending state", async () => {
      await router.connect(council).proposeRegression(1, council.address);
      await expect(router.connect(council).cancelRegression())
        .to.emit(router, "RegressionCancelled");
      expect(await router.pendingRegressionGovernor()).to.equal(ethers.ZeroAddress);
      // Execute now reverts no-pending.
      await mineBlocks(TIMELOCK_BLOCKS);
      await expect(router.executeRegression()).to.be.revertedWith("no pending");
    });

    it("non-adminGovernor cannot cancel", async () => {
      await router.connect(council).proposeRegression(1, council.address);
      await expect(router.connect(other).cancelRegression())
        .to.be.revertedWith("E19");
    });

    it("after regression, can re-promote via setGovernor + raisePhaseFloor", async () => {
      await router.connect(council).proposeRegression(1, council.address);
      await mineBlocks(TIMELOCK_BLOCKS);
      await router.executeRegression();
      // F-008: complete the regression handoff with acceptGovernor.
      await router.connect(council).acceptGovernor();
      expect(await router.phase()).to.equal(1n);

      // Re-promote to OpenGov via the normal two-step
      await router.connect(owner).setGovernor(2, openGov.address);
      await router.connect(openGov).acceptGovernor();
      expect(await router.phase()).to.equal(2n);
      expect(await router.phaseFloor()).to.equal(1n);

      // Re-ratchet the floor
      await router.connect(other).raisePhaseFloor();
      expect(await router.phaseFloor()).to.equal(2n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // setRegressionTimelock
  // ─────────────────────────────────────────────────────────────────────
  describe("setRegressionTimelock", function () {
    it("owner can set within bounds", async () => {
      await router.connect(owner).setRegressionTimelock(50000n);
      expect(await router.regressionTimelockBlocks()).to.equal(50000n);
    });

    it("below MIN reverts E11", async () => {
      await expect(router.connect(owner).setRegressionTimelock(100n))
        .to.be.revertedWith("E11");
    });

    it("above MAX reverts E11", async () => {
      await expect(router.connect(owner).setRegressionTimelock(1_000_000n))
        .to.be.revertedWith("E11");
    });

    it("non-owner reverts E18", async () => {
      await expect(router.connect(other).setRegressionTimelock(50000n))
        .to.be.revertedWith("E18");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Router self-upgrade — bytes32("governanceRouter") slot is just a
  // registry entry; recursive upgrade is supported but flagged in the
  // runbook as needing a manual operator step (deployed-addresses
  // reference + every consumer re-wires).
  // ─────────────────────────────────────────────────────────────────────
  describe("router self-upgrade slot", function () {
    const NAME_SELF = ethers.keccak256(ethers.toUtf8Bytes("governanceRouter"));

    it("can register and upgrade its own slot like any other contract", async () => {
      const routerAddr = await router.getAddress();
      await router.connect(owner).register(NAME_SELF, routerAddr);
      // Pretend we've deployed a router v2 elsewhere; upgrade the slot.
      // (No state migration here — that's a Stage 6 operator runbook step.)
      const fakeV2 = v2.address;
      await router.connect(governor).upgradeContract(NAME_SELF, fakeV2);
      expect(await router.currentAddrOf(NAME_SELF)).to.equal(fakeV2);
      expect(await router.versionOf(NAME_SELF)).to.equal(2n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // U1 fix — upgradeContract's atomic freeze+migrate hooks actually fire.
  // Targets accept the calls with msg.sender == router via
  // onlyGovernanceOrRouter (PRE-MAINNET-CHECKLIST §U1, option 1).
  // ─────────────────────────────────────────────────────────────────────
  describe("upgradeContract — atomic freeze+migrate hooks (U1)", function () {
    const NAME_MOCK = ethers.keccak256(ethers.toUtf8Bytes("mockUpgradable"));

    async function deployPair() {
      const V1F = await ethers.getContractFactory("MockUpgradable");
      const oldC = await V1F.deploy(1n); // version() == 1
      const V2F = await ethers.getContractFactory("MockUpgradableV2");
      const newC = await V2F.deploy();   // version() == 2
      const routerAddr = await router.getAddress();
      await oldC.connect(owner).setRouter(routerAddr);
      await newC.connect(owner).setRouter(routerAddr);
      await oldC.connect(owner).setCounter(42n);
      await router.connect(owner).register(NAME_MOCK, await oldC.getAddress());
      return { oldC, newC };
    }

    it("one-tx upgrade freezes old, migrates state into new, emits hooks event", async () => {
      const { oldC, newC } = await deployPair();
      const oldAddr = await oldC.getAddress();
      const newAddr = await newC.getAddress();

      await expect(router.connect(governor).upgradeContract(NAME_MOCK, newAddr))
        .to.emit(router, "UpgradeHooksFired").withArgs(NAME_MOCK, true, true);

      expect(await oldC.frozen()).to.equal(true);            // freeze() fired
      expect(await newC.migrated()).to.equal(true);          // migrate() fired
      expect(await newC.migrationSource()).to.equal(oldAddr);
      expect(await newC.counter()).to.equal(42n);            // _migrate copied state
      expect(await router.currentAddrOf(NAME_MOCK)).to.equal(newAddr);

      // old contract refuses writes post-freeze
      await expect(oldC.connect(other).increment()).to.be.revertedWith("frozen");
    });

    it("two-tx flow (governor pre-runs freeze+migrate) stays valid; hooks report false benignly", async () => {
      const { oldC, newC } = await deployPair();
      const oldAddr = await oldC.getAddress();
      const newAddr = await newC.getAddress();

      // Governor runs the explicit flow first (scripts/bump-all-paseo.ts).
      await oldC.connect(governor).freeze();
      await newC.connect(governor).migrate(oldAddr);
      expect(await newC.counter()).to.equal(42n);

      // Rotation afterwards: hooks revert already-frozen / already-migrated,
      // reported as (false, false) — state untouched.
      await expect(router.connect(governor).upgradeContract(NAME_MOCK, newAddr))
        .to.emit(router, "UpgradeHooksFired").withArgs(NAME_MOCK, false, false);
      expect(await newC.counter()).to.equal(42n);
      expect(await newC.migrationSource()).to.equal(oldAddr);
    });

    it("co-authority does not open freeze/migrate to non-governor EOAs", async () => {
      const { oldC, newC } = await deployPair();
      await expect(oldC.connect(other).freeze()).to.be.revertedWith("E19");
      await expect(newC.connect(other).migrate(await oldC.getAddress()))
        .to.be.revertedWith("E19");
      // and the only router entry that reaches the hooks is governor-gated
      await expect(router.connect(other).upgradeContract(NAME_MOCK, await newC.getAddress()))
        .to.be.revertedWith("E19");
    });

    it("migrate hook refuses a version downgrade even via the router", async () => {
      const { oldC } = await deployPair();
      // second v1-version contract as the "new" target: freeze fires, migrate fails
      const V1F = await ethers.getContractFactory("MockUpgradable");
      const sameVer = await V1F.deploy(1n);
      await sameVer.connect(owner).setRouter(await router.getAddress());

      await expect(router.connect(governor).upgradeContract(NAME_MOCK, await sameVer.getAddress()))
        .to.emit(router, "UpgradeHooksFired").withArgs(NAME_MOCK, true, false);
      expect(await oldC.frozen()).to.equal(true);
      expect(await sameVer.migrated()).to.equal(false);
    });
  });
});
