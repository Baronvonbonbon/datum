// Stage 4: phase-gate verification for lock-once functions.
//
// Confirms the whenOpenGovPhase modifier on DatumUpgradable:
//   - Pre-router (no setRouter call): deferred to onlyOwner (existing
//     test surface continues to work)
//   - Router wired, Admin phase: lock reverts "not-opengov"
//   - Router wired, Council phase: lock reverts "not-opengov"
//   - Router wired, OpenGov phase: lock fires normally
//
// Uses DatumTagCurator as a representative contract (small + has
// lockCouncil()). Pattern generalizes to every other lock function.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumGovernanceRouter,
  DatumTagCurator,
  MockCampaigns,
  MockCampaignLifecycle,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Stage 4: whenOpenGovPhase on lock functions", function () {
  let router: DatumGovernanceRouter;
  let curator: DatumTagCurator;
  let owner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let openGov: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async () => {
    [owner, governor, council, openGov, other] = await ethers.getSigners();

    const MockCF = await ethers.getContractFactory("MockCampaigns");
    const mc = await MockCF.deploy();
    const MockLF = await ethers.getContractFactory("MockCampaignLifecycle");
    const ml = await MockLF.deploy(await mc.getAddress());

    const RouterF = await ethers.getContractFactory("DatumGovernanceRouter");
    router = await RouterF.deploy(
      await mc.getAddress(),
      await ml.getAddress(),
      governor.address,
    );

    const CuratorF = await ethers.getContractFactory("DatumTagCurator");
    curator = await CuratorF.deploy();
    // Set a council so lockCouncil() can fire (it requires council != 0)
    await curator.connect(owner).setCouncil(other.address);
  });

  it("pre-router: lock reverts 'router-unset' (F-004 fail-closed)", async () => {
    // F-004 fix (2026-05-20): whenOpenGovPhase is fail-closed when the
    // router is unset. The previous silent-pass-through-to-onlyOwner
    // behavior let a deployer accidentally fire lock-once functions
    // without OpenGov-phase gating. Both owner AND non-owner now revert,
    // but with different reasons depending on which check fires first.
    await expect(curator.connect(other).lockCouncil()).to.be.reverted; // E18 (onlyOwner before modifier)
    await expect(curator.connect(owner).lockCouncil()).to.be.revertedWith("router-unset");
  });

  it("router wired in Admin phase: lock reverts 'not-opengov'", async () => {
    await curator.connect(owner).setRouter(await router.getAddress());
    expect(await router.phase()).to.equal(0n); // Admin
    await expect(curator.connect(owner).lockCouncil()).to.be.revertedWith("not-opengov");
  });

  it("router wired in Council phase: lock reverts 'not-opengov'", async () => {
    await curator.connect(owner).setRouter(await router.getAddress());
    await router.connect(owner).setGovernor(1, council.address);
    await router.connect(council).acceptGovernor();
    expect(await router.phase()).to.equal(1n);
    await expect(curator.connect(owner).lockCouncil()).to.be.revertedWith("not-opengov");
  });

  it("router wired in OpenGov phase: lock succeeds", async () => {
    await curator.connect(owner).setRouter(await router.getAddress());
    await router.connect(owner).setGovernor(1, council.address);
    await router.connect(council).acceptGovernor();
    await router.connect(owner).setGovernor(2, openGov.address);
    await router.connect(openGov).acceptGovernor();
    expect(await router.phase()).to.equal(2n);
    await curator.connect(owner).lockCouncil();
    expect(await curator.councilLocked()).to.equal(true);
  });

  it("after regression OpenGov→Council: lock reverts again", async () => {
    await curator.connect(owner).setRouter(await router.getAddress());
    await router.connect(owner).setGovernor(1, council.address);
    await router.connect(council).acceptGovernor();
    await router.connect(owner).setGovernor(2, openGov.address);
    await router.connect(openGov).acceptGovernor();

    // Regress to Council. Router timelock = MIN by default (28800), tests
    // tighten to MIN (14400).
    await router.connect(owner).setRegressionTimelock(14400);
    // Regression is adminGovernor-gated (Option 2 split); grant the proposer
    // admin authority. In production this is the Council.
    await router.connect(owner).setAdminGovernor(openGov.address);
    await router.connect(openGov).proposeRegression(1, council.address);
    await ethers.provider.send("hardhat_mine", ["0x3840"]); // 14400
    await router.executeRegression();
    // F-008: complete the regression handoff with acceptGovernor.
    await router.connect(council).acceptGovernor();
    expect(await router.phase()).to.equal(1n);

    await expect(curator.connect(owner).lockCouncil()).to.be.revertedWith("not-opengov");
  });
});
