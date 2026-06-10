import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

describe("StakeRoot cluster — upgrade migration", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, r1: HardhatEthersSigner, r2: HardhatEthersSigner, treasury: HardhatEthersSigner;
  let router: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, r1, r2, treasury] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
  });

  it("DatumStakeRoot copies reporters + threshold + finalized roots", async function () {
    const v1 = await (await ethers.getContractFactory("DatumStakeRoot")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.addReporter(r1.address);
    await v1.addReporter(r2.address);
    await v1.setThreshold(1);
    const ROOT = "0x" + "12".repeat(32);
    await v1.connect(r1).commitStakeRoot(5, ROOT); // threshold 1 → finalizes

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockStakeRootNext")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.rootAt(5)).to.equal(ROOT);
    expect(await v2.latestEpoch()).to.equal(5n);
    expect(await v2.threshold()).to.equal(1n);
    expect(await v2.isReporter(r1.address)).to.equal(true);
    expect(await v2.reporterCount()).to.equal(2n);
    expect(await v2.isRecent(ROOT)).to.equal(true);
  });

  it("DatumStakeRootV2 copies stakes + commitments + payouts and sweeps DOT", async function () {
    const tok = treasury.address; // datumToken not exercised here
    const v1 = await (await ethers.getContractFactory("DatumStakeRootV2"))
      .deploy(treasury.address, parseDOT("1"), 100, 6000, 100, parseDOT("1"), parseDOT("1"), 5000, 1000, parseDOT("0.5"), tok);
    await v1.setRouter(await router.getAddress());
    await v1.connect(r1).joinReporters({ value: parseDOT("2") });
    const COMMIT = "0x" + "ab".repeat(32);
    await v1.connect(r2).registerCommitment(COMMIT, { value: parseDOT("0.5") }); // bond → treasury payout

    const total = parseDOT("2.5");
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(total);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockStakeRootV2Next"))
      .deploy(treasury.address, parseDOT("1"), 100, 6000, 100, parseDOT("1"), parseDOT("1"), 5000, 1000, parseDOT("0.5"), tok);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    const [amt] = await v2.reporterStake(r1.address);
    expect(amt).to.equal(parseDOT("2"));
    expect(await v2.totalReporterStake()).to.equal(parseDOT("2"));
    expect(await v2.registeredCommitments(COMMIT)).to.equal(true);
    expect(await v2.pending(treasury.address)).to.equal(parseDOT("0.5"));
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(total);
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);
  });

  it("DatumBondedIdentityReporter copies reporter stakes + nonces and sweeps DOT", async function () {
    const v1 = await (await ethers.getContractFactory("DatumBondedIdentityReporter"))
      .deploy(treasury.address, parseDOT("1"), 100, 6000, 100, parseDOT("1"), parseDOT("1"), 5000, 1000);
    await v1.setRouter(await router.getAddress());
    await v1.connect(r1).joinReporters({ value: parseDOT("3") });

    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(parseDOT("3"));

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockBondedIdentityReporterNext"))
      .deploy(treasury.address, parseDOT("1"), 100, 6000, 100, parseDOT("1"), parseDOT("1"), 5000, 1000);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    const [amt] = await v2.reporterStake(r1.address);
    expect(amt).to.equal(parseDOT("3"));
    expect(await v2.totalReporterStake()).to.equal(parseDOT("3"));
    expect(await v2.reporterCount()).to.equal(1n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("3"));
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);
  });
});
