import { expect } from "chai";
import { ethers } from "hardhat";
import { fundSigners } from "./helpers/mine";
import { parseDOT } from "./helpers/dot";

// Tests for the governance-tunable gating parameters added in the
// "make everything governable within bounds" pass.

describe("Governance-tunable params: DatumGovernanceV2", function () {
  let v2: any, owner: any, other: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, other] = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    const signers = await ethers.getSigners();
    const pause = await Pause.deploy(signers[0].address, signers[1].address, signers[2].address);
    const V2 = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2.deploy(
      signers[0].address,  // campaigns placeholder
      parseDOT("0.5"),     // quorum
      1000n,               // slashBps
      parseDOT("0.5"),     // termQuorum
      5n, 10n, 30n,        // grace
      await pause.getAddress()
    );
  });

  it("defaults: convictionA=25, convictionB=50; weight(8)=21", async function () {
    expect(await v2.convictionA()).to.equal(25n);
    expect(await v2.convictionB()).to.equal(50n);
    expect(await v2.convictionWeight(8)).to.equal(21n);
    expect(await v2.convictionWeight(0)).to.equal(1n);
  });

  it("setConvictionCurve updates A/B and recomputes weight", async function () {
    await v2.setConvictionCurve(0, 200);  // pure linear: weight(c) = 2c + 1
    expect(await v2.convictionWeight(0)).to.equal(1n);
    expect(await v2.convictionWeight(8)).to.equal(17n);
  });

  it("setConvictionCurve rejects coefficients producing > 1000x max weight", async function () {
    // a=10000, b=0 → weight(8) = (10000*64)/100 + 1 = 6401 > 1000
    await expect(v2.setConvictionCurve(10_000n, 0n)).to.be.revertedWith("E11");
  });

  it("setSlashBps rejects >= 10000", async function () {
    await expect(v2.setSlashBps(10000n)).to.be.revertedWith("E11");
    await v2.setSlashBps(9999n);
    expect(await v2.slashBps()).to.equal(9999n);
  });

  it("setGraceParams enforces maxGrace >= baseGrace", async function () {
    await expect(v2.setGraceParams(10n, 5n, 5n)).to.be.revertedWith("E11");
    await v2.setGraceParams(5n, 10n, 50n);
    expect(await v2.baseGraceBlocks()).to.equal(5n);
    expect(await v2.maxGraceBlocks()).to.equal(50n);
  });

  it("setConvictionLockups bounded by MAX_LOCKUP_BLOCKS", async function () {
    const bad = new Array(9).fill(0n);
    bad[8] = 11_000_000n;  // > MAX_LOCKUP_BLOCKS (10_512_000)
    await expect(v2.setConvictionLockups(bad)).to.be.revertedWith("E11");
    const good = new Array(9).fill(0n);
    good[8] = 5_000_000n;
    await v2.setConvictionLockups(good);
    expect(await v2.convictionLockup(8)).to.equal(5_000_000n);
  });

  it("non-owner rejected (E18)", async function () {
    await expect(v2.connect(other).setConvictionCurve(25n, 50n)).to.be.revertedWith("E18");
    await expect(v2.connect(other).setSlashBps(100n)).to.be.revertedWith("E18");
  });
});

describe("Governance-tunable params: DatumSettlement revenue split", function () {
  let settlement: any, owner: any, other: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, other] = await ethers.getSigners();
    const signers = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    const pause = await Pause.deploy(signers[0].address, signers[1].address, signers[2].address);
    const S = await ethers.getContractFactory("DatumSettlement");
    settlement = await S.deploy(await pause.getAddress());
  });

  it("userShareBps default 7500, bounded [5000, 9000]", async function () {
    expect(await settlement.userShareBps()).to.equal(7500);
    await expect(settlement.setUserShareBps(4999)).to.be.revertedWith("E11");
    await expect(settlement.setUserShareBps(9001)).to.be.revertedWith("E11");
    await settlement.setUserShareBps(8500);
    expect(await settlement.userShareBps()).to.equal(8500);
  });

  it("datumRewardSplit default 55/40/5 with 10000 sum invariant", async function () {
    expect(await settlement.datumRewardUserBps()).to.equal(5500);
    await expect(settlement.setDatumRewardSplit(5000, 4000, 500)).to.be.revertedWith("E11");
    await settlement.setDatumRewardSplit(4000, 4000, 2000);
    expect(await settlement.datumRewardUserBps()).to.equal(4000);
    expect(await settlement.datumRewardAdvertiserBps()).to.equal(2000);
  });

  it("non-owner rejected (E18)", async function () {
    await expect(settlement.connect(other).setUserShareBps(8000)).to.be.revertedWith("E18");
    await expect(settlement.connect(other).setDatumRewardSplit(5000, 4500, 500)).to.be.revertedWith("E18");
  });
});
