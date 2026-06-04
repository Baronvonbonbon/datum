import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Governance cluster migration: in-flight proposals/votes are drained
// pre-migration (refunds queue into pendingGovPayout); _migrate copies config +
// the settled payout queue, and migrateFundsTo sweeps the native DOT.
describe("Governance cluster — upgrade migration", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, g2: HardhatEthersSigner, g3: HardhatEthersSigner;
  let router: any, pause: any;
  const LOCKS: bigint[] = [100n, 1n, 3n, 7n, 21n, 90n, 180n, 270n, 365n];

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, g2, g3] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
    pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, g2.address, g3.address);
  });

  it("DatumRelayGovernance migrates config + in-flight vote state + sweeps locked DOT", async function () {
    const v1 = await (await ethers.getContractFactory("DatumRelayGovernance")).deploy(10, 100, 0, 5000, 2000, 1000); // proposeBond=0
    await v1.setRouter(await router.getAddress());
    await v1.setConvictionLockups(LOCKS);
    const EVID = "0x" + "ee".repeat(32);
    await v1.connect(g2).propose(owner.address, 1, EVID); // proposer g2, target owner → proposalId 1
    await v1.connect(g3).vote(1, true, 0, { value: parseDOT("2") }); // locks 2 DOT (conviction 0 → lock 100 blocks)

    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(parseDOT("2"));

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockRelayGovernanceNext")).deploy(0, 0, 0, 0, 0, 0);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    // config
    expect(await v2.quorum()).to.equal(10n);
    expect(await v2.convictionLockup(8)).to.equal(365n);
    expect(await v2.nextProposalId()).to.equal(2n);
    // in-flight proposal + vote record carried over
    expect((await v2.getProposal(1)).relay).to.equal(owner.address);
    expect(await v2.proposalVoterCount(1)).to.equal(1n);
    const vote = await v2.getVote(1, g3.address);
    expect(vote.lockAmount).to.equal(parseDOT("2"));
    expect(vote.direction).to.equal(1n); // aye
    // locked DOT swept so the successor can honour the eventual withdrawVote
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("2"));
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);
  });

  it("DatumPublisherGovernance copies config + sweeps DOT", async function () {
    const p = await pause.getAddress();
    const v1 = await (await ethers.getContractFactory("DatumPublisherGovernance")).deploy(p, p, p, 20, 4000, 500, 200, parseDOT("2"));
    await v1.setRouter(await router.getAddress());
    await v1.setConvictionLockups(LOCKS);
    await owner.sendTransaction({ to: await v1.getAddress(), value: parseDOT("3") });

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockPublisherGovernanceNext")).deploy(p, p, p, 0, 0, 0, 0, 0);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.quorum()).to.equal(20n);
    expect(await v2.slashBps()).to.equal(4000n);
    expect(await v2.bondBonusBps()).to.equal(500n);
    expect(await v2.nextAdvertiserClaimId()).to.equal(1n);
    expect(await v2.convictionLockup(8)).to.equal(365n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("3"));
  });

  it("DatumAdvertiserGovernance copies config", async function () {
    const p = await pause.getAddress();
    const v1 = await (await ethers.getContractFactory("DatumAdvertiserGovernance")).deploy(15, 3000, 150, parseDOT("1"), p);
    await v1.setRouter(await router.getAddress());
    await v1.setConvictionLockups(LOCKS);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockAdvertiserGovernanceNext")).deploy(0, 0, 0, 0, p);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.quorum()).to.equal(15n);
    expect(await v2.slashBps()).to.equal(3000n);
    expect(await v2.minGraceBlocks()).to.equal(150n);
    expect(await v2.convictionLockup(0)).to.equal(100n);
    expect(await v2.nextPublisherClaimId()).to.equal(1n);
  });
});
