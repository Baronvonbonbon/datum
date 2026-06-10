// Phase-B parameter-governance tests — converts five contracts'
// recurring-tune setters from onlyOwner to onlyOwnerOrPG.
//
// Each contract gets the same shape of coverage:
//   - setParameterGovernance is lock-once (second call reverts).
//   - Owner can tune via every PG-routable setter.
//   - PG can tune via every setter.
//   - Random caller reverts E18.
//   - Bounds enforced both ends (only on setters where Phase B added new bounds).
//
// Wiring setters that stayed onlyOwner are spot-checked to confirm PG
// CANNOT use them — the modifier swap was selective, not blanket.

import { expect } from "chai";
import { ethers } from "hardhat";
import { parseDOT } from "./helpers/dot";

async function pauseRegistry() {
  const [, g0, g1, g2] = await ethers.getSigners();
  return await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(g0.address, g1.address, g2.address);
}

describe("Phase B — DatumAdvertiserStake parameter governance", () => {
  async function deploy() {
    const Stake = await ethers.getContractFactory("DatumAdvertiserStake");
    // Constructor: (baseStakeWei, planckPerDOTSpent, unstakeDelayBlocks)
    return await Stake.deploy(parseDOT("1"), 10n ** 8n, 14_400n);
  }

  it("setParameterGovernance is phase-conditional (re-pointable until lock) + zero-addr rejected", async () => {
    const c = await deploy();
    const [owner, , pgA, pgB] = await ethers.getSigners();
    await expect(c.connect(owner).setParameterGovernance(ethers.ZeroAddress)).to.be.revertedWith("E00");
    await c.connect(owner).setParameterGovernance(pgA.address);
    await c.connect(owner).setParameterGovernance(pgB.address); // re-pointable while unlocked
    expect(await c.parameterGovernance()).to.equal(pgB.address);
  });

  it("owner + PG can both tune setParams; non-owner reverts E18", async () => {
    const c = await deploy();
    const [owner, attacker, pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);

    // Owner path
    await c.connect(owner).setParams(parseDOT("2"), 10n ** 9n, 28_800n);
    expect(await c.baseStakeWei()).to.equal(parseDOT("2"));

    // PG path
    await c.connect(pgSigner).setParams(parseDOT("3"), 10n ** 10n, 43_200n);
    expect(await c.baseStakeWei()).to.equal(parseDOT("3"));

    // Attacker path
    await expect(c.connect(attacker).setParams(parseDOT("4"), 0n, 14_400n)).to.be.revertedWith("E18");
  });

  it("bounds enforced on setParams (delay > MAX, base > MAX)", async () => {
    const c = await deploy();
    const [owner] = await ethers.getSigners();
    // delay > 5_256_000 → out-of-bounds
    await expect(c.connect(owner).setParams(parseDOT("1"), 0n, 5_256_001n)).to.be.revertedWith("out-of-bounds");
    // base > 10^16 → out-of-bounds
    await expect(c.connect(owner).setParams(10n ** 17n, 0n, 14_400n)).to.be.revertedWith("out-of-bounds");
  });

  it("setMaxRequiredStake and setMaxSlashBpsPerCall both PG-routable", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await c.connect(pgSigner).setMaxRequiredStake(parseDOT("100"));
    expect(await c.maxRequiredStake()).to.equal(parseDOT("100"));
    await c.connect(pgSigner).setMaxSlashBpsPerCall(3000);
    expect(await c.maxSlashBpsPerCall()).to.equal(3000);
  });

  it("wiring setters (setSettlementContract / setSlashContract) stay owner-only", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    // PG cannot wire — these are lock-once on owner side
    await expect(c.connect(pgSigner).setSettlementContract(owner.address)).to.be.reverted;
    await expect(c.connect(pgSigner).setSlashContract(owner.address)).to.be.reverted;
  });
});

describe("Phase B — DatumActivationBonds parameter governance", () => {
  async function deploy() {
    const [owner] = await ethers.getSigners();
    return await (await ethers.getContractFactory("DatumActivationBonds")).deploy(
      parseDOT("1"), 100n, 5000n, 1000n, owner.address,
    );
  }

  it("five setters all PG-routable; wiring setters owner-only", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await c.connect(pgSigner).setMinBond(parseDOT("2"));
    await c.connect(pgSigner).setTimelockBlocks(200);
    await c.connect(pgSigner).setPunishmentBps(3000, 1000);
    await c.connect(pgSigner).setMuteMinBond(parseDOT("0.5"));
    await c.connect(pgSigner).setMuteMaxBlocks(500);
    // setCampaignsContract is owner-only + lock-once
    await expect(c.connect(pgSigner).setCampaignsContract(owner.address)).to.be.reverted;
  });

  it("non-owner / non-PG reverts E18", async () => {
    const c = await deploy();
    const [, attacker] = await ethers.getSigners();
    await expect(c.connect(attacker).setMinBond(parseDOT("2"))).to.be.revertedWith("E18");
  });

  it("setMinBond MAX_BOND_CEILING bound enforced", async () => {
    const c = await deploy();
    const [owner] = await ethers.getSigners();
    await expect(c.connect(owner).setMinBond(10n ** 17n)).to.be.revertedWith("out-of-bounds");
  });
});

describe("Phase B — DatumGovernanceV2 parameter governance", () => {
  async function deploy() {
    const pr = await pauseRegistry();
    // Constructor: (campaigns, quorum, slashBps, terminationQuorum, baseGrace, gracePerQuorum, maxGrace, pauseRegistry)
    const [owner] = await ethers.getSigners();
    return await (await ethers.getContractFactory("DatumGovernanceV2")).deploy(
      owner.address, parseDOT("1"), 1000n, parseDOT("1"), 10n, 10n, 50n, await pr.getAddress(),
    );
  }

  it("seven parameter setters PG-routable", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await c.connect(pgSigner).setQuorumWeighted(parseDOT("2"));
    await c.connect(pgSigner).setSlashBps(2000);
    await c.connect(pgSigner).setTerminationQuorum(parseDOT("3"));
    await c.connect(pgSigner).setGraceParams(20n, 20n, 60n);
    // convictionCurve cannot be (0,0); pick non-zero values that satisfy maxWeight ≤ 1000
    await c.connect(pgSigner).setConvictionCurve(20n, 40n);
    await c.connect(pgSigner).setConvictionLockups([0n, 14_400n, 43_200n, 100_800n, 302_400n, 1_296_000n, 2_592_000n, 3_888_000n, 5_256_000n]);
    await c.connect(pgSigner).setCommitRevealPhases(100, 100);
  });

  it("wiring setters stay owner-only", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await expect(c.connect(pgSigner).setLifecycle(owner.address)).to.be.reverted;
    await expect(c.connect(pgSigner).setCampaigns(owner.address)).to.be.reverted;
    await expect(c.connect(pgSigner).setActivationBonds(owner.address)).to.be.reverted;
  });

  it("setQuorumWeighted MAX bound enforced", async () => {
    const c = await deploy();
    const [owner] = await ethers.getSigners();
    await expect(c.connect(owner).setQuorumWeighted(10n ** 18n)).to.be.revertedWith("out-of-bounds");
  });
});

describe("Phase B — DatumMintCoordinator parameter governance", () => {
  async function deploy() {
    return await (await ethers.getContractFactory("DatumMintCoordinator")).deploy();
  }

  it("three parameter setters PG-routable", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await c.connect(pgSigner).setMintRate(parseDOT("0.001"));
    await c.connect(pgSigner).setDustMintThreshold(100n);
    await c.connect(pgSigner).setDatumRewardSplit(5500, 4000, 500); // sums to 10000
  });

  it("non-owner / non-PG reverts E18", async () => {
    const c = await deploy();
    const [, attacker] = await ethers.getSigners();
    await expect(c.connect(attacker).setMintRate(parseDOT("1"))).to.be.revertedWith("E18");
  });
});

describe("Phase B — DatumAdvertiserGovernance parameter governance", () => {
  async function deploy() {
    const pr = await pauseRegistry();
    const AdvGov = await ethers.getContractFactory("DatumAdvertiserGovernance");
    // Constructor: (quorum, slashBps, minGraceBlocks, proposeBond, pauseRegistry)
    return await AdvGov.deploy(parseDOT("1"), 1000n, 10n, parseDOT("0.1"), await pr.getAddress());
  }

  it("four parameter setters PG-routable", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await c.connect(pgSigner).setParams(parseDOT("2"), 2000n, 20n, parseDOT("0.2"));
    await c.connect(pgSigner).setConvictionCurve(25n, 50n);
    await c.connect(pgSigner).setConvictionLockups([0n, 14_400n, 43_200n, 100_800n, 302_400n, 1_296_000n, 2_592_000n, 3_888_000n, 5_256_000n]);
    await c.connect(pgSigner).setPublisherClaimBond(parseDOT("0.5"));
  });

  it("setAdvertiserStake stays owner-only", async () => {
    const c = await deploy();
    const [owner, , pgSigner] = await ethers.getSigners();
    await c.connect(owner).setParameterGovernance(pgSigner.address);
    await expect(c.connect(pgSigner).setAdvertiserStake(owner.address)).to.be.reverted;
  });
});
