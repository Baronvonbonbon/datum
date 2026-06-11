import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// Regression test for F-006 (phase regression resets `phaseFloor`).
//
// Before the fix: executeRegression reset `phaseFloor` to the regressed-to
// phase, breaking the "monotonic decentralization" invariant. A compromised
// governor could roll back to Admin (48h timelock) and then re-stage any
// governor address — full unwind of past commitments.
//
// After the fix: `hardFloor` ratchets up at acceptGovernor / executeRegression
// (only ever non-decreasing). `setGovernor` requires `newPhase >= hardFloor`,
// so a regression can drop the soft `phaseFloor` but cannot let any new
// staging fall below the highest decentralization level ever reached.

describe("Audit F-006: hardFloor preserves monotonic decentralization across regression", function () {
  let router: any;
  let owner: HardhatEthersSigner;
  let council: HardhatEthersSigner;
  let openGov: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  beforeEach(async function () {
    await fundSigners();
    [owner, council, openGov, attacker] = await ethers.getSigners();

    const MockCF = await ethers.getContractFactory("MockCampaigns");
    const mc = await MockCF.deploy();
    const MockLF = await ethers.getContractFactory("MockCampaignLifecycle");
    const ml = await MockLF.deploy(await mc.getAddress());

    const RouterF = await ethers.getContractFactory("DatumGovernanceRouter");
    router = await RouterF.deploy(
      await mc.getAddress(),
      await ml.getAddress(),
      owner.address, // initial governor
    );
  });

  it("hardFloor starts at Admin (0) and ratchets up on acceptGovernor", async function () {
    expect(await router.hardFloor()).to.equal(0n);

    // Phase 0 → 1
    await router.connect(owner).setGovernor(1, council.address);
    await router.connect(council).acceptGovernor();
    expect(await router.hardFloor()).to.equal(1n);

    // Phase 1 → 2
    await router.connect(owner).setGovernor(2, openGov.address);
    await router.connect(openGov).acceptGovernor();
    expect(await router.hardFloor()).to.equal(2n);
  });

  it("setGovernor cannot stage below hardFloor", async function () {
    await router.connect(owner).setGovernor(1, council.address);
    await router.connect(council).acceptGovernor();

    // hardFloor is now 1; staging phase 0 reverts.
    await expect(
      router.connect(owner).setGovernor(0, attacker.address)
    ).to.be.revertedWith("below hard floor");
  });

  it("regression resets soft phaseFloor but NOT hardFloor; subsequent setGovernor still blocked below hardFloor", async function () {
    // Climb to OpenGov.
    await router.connect(owner).setGovernor(1, council.address);
    await router.connect(council).acceptGovernor();
    await router.connect(owner).setGovernor(2, openGov.address);
    await router.connect(openGov).acceptGovernor();
    await router.raisePhaseFloor();
    expect(await router.phaseFloor()).to.equal(2n);
    expect(await router.hardFloor()).to.equal(2n);

    // Compromised admin authority proposes regression to Admin. Regression is
    // adminGovernor-gated (Option 2 split); model openGov as the compromised
    // admin executor so the hardFloor assertion below stays meaningful.
    await router.connect(owner).setRegressionTimelock(14400);
    await router.connect(owner).setAdminGovernor(openGov.address);
    await router.connect(openGov).proposeRegression(0, attacker.address);
    await ethers.provider.send("hardhat_mine", ["0x3840"]); // 14400
    await router.executeRegression();

    // F-008 fix: executeRegression now stages the candidate as pending;
    // phase hasn't flipped yet. Soft phaseFloor still resets (regression
    // intent committed), but governor + phase wait on acceptGovernor.
    expect(await router.phase()).to.equal(2n); // still OpenGov
    expect(await router.governor()).to.equal(openGov.address);
    expect(await router.pendingGovernor()).to.equal(attacker.address);
    expect(await router.phaseFloor()).to.equal(0n);
    expect(await router.hardFloor()).to.equal(2n);

    // Candidate must accept from own context to complete handoff.
    await router.connect(attacker).acceptGovernor();
    expect(await router.phase()).to.equal(0n);
    expect(await router.governor()).to.equal(attacker.address);

    // setGovernor below hardFloor blocked — even though soft floor allows.
    await expect(
      router.connect(owner).setGovernor(1, attacker.address)
    ).to.be.revertedWith("below hard floor");

    // Re-staging OpenGov is allowed (>= hardFloor).
    await router.connect(owner).setGovernor(2, openGov.address);
    await router.connect(openGov).acceptGovernor();
    expect(await router.phase()).to.equal(2n);
  });
});
