import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Config-only _migrate: a frozen predecessor's scalar configuration is copied
// into the successor (structural refs are re-wired separately).
describe("Config-only _migrate (MintCoordinator, PowEngine)", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner;
  let router: any;

  beforeEach(async function () {
    [owner, gov] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
  });

  it("DatumMintCoordinator copies mint-rate + reward-split scalars", async function () {
    const v1 = await (await ethers.getContractFactory("DatumMintCoordinator")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setMintRate(42n * 10n ** 10n);
    await v1.setDustMintThreshold(123n);
    await v1.setDatumRewardSplit(6000, 3500, 500);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockMintCoordinatorV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.mintRatePerDot()).to.equal(42n * 10n ** 10n);
    expect(await v2.dustMintThreshold()).to.equal(123n);
    expect(await v2.datumRewardUserBps()).to.equal(6000);
    expect(await v2.datumRewardPublisherBps()).to.equal(3500);
    expect(await v2.datumRewardAdvertiserBps()).to.equal(500);
  });

  it("DatumPowEngine copies the curve config (buckets reset by design)", async function () {
    const v1 = await (await ethers.getContractFactory("DatumPowEngine")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setEnforcePow(true);
    await v1.setPowDifficultyCurve(10, 80, 150, 30); // baseShift, linearDiv, quadDiv, leakPerN

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockPowEngineV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.enforcePow()).to.equal(true);
    expect(await v2.powBaseShift()).to.equal(10);
    expect(await v2.powLinearDivisor()).to.equal(80);
    expect(await v2.powQuadDivisor()).to.equal(150);
    expect(await v2.powBucketLeakPerN()).to.equal(30);
  });
});
