import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

describe("Governance cluster 2 — GovernanceV2 / ParameterGovernance / Council migration", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, voter: HardhatEthersSigner, g3: HardhatEthersSigner, g4: HardhatEthersSigner;
  let router: any, pause: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, voter, g3, g4] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
    pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, g3.address, g4.address);
  });

  it("DatumGovernanceV2 migrates in-flight conviction votes + sweeps locked DOT", async function () {
    const mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();
    await mock.setCampaign(1, owner.address, voter.address, 1000n, 5000, 1); // Active
    const args = [await mock.getAddress(), parseDOT("1"), 1000n, parseDOT("2"), 100n, 0n, 1000n, await pause.getAddress()] as const;
    const v1 = await (await ethers.getContractFactory("DatumGovernanceV2")).deploy(...args);
    await v1.setRouter(await router.getAddress());
    await v1.connect(voter).vote(1, true, 0, { value: parseDOT("2") }); // locks 2 DOT

    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(parseDOT("2"));

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockGovernanceV2Next")).deploy(...args);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.quorumWeighted()).to.equal(parseDOT("1"));
    expect(await v2.voteCampaignCount()).to.equal(1n);
    expect(await v2.campaignVoterCount(1)).to.equal(1n);
    const vote = await v2.getVoteFull(1, voter.address);
    expect(vote.lockAmount).to.equal(parseDOT("2"));
    expect(vote.direction).to.equal(1n);
    expect(await v2.ayeWeighted(1)).to.be.greaterThan(0n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("2"));
  });

  it("DatumParameterGovernance migrates whitelist + in-flight bonded votes", async function () {
    const v1 = await (await ethers.getContractFactory("DatumParameterGovernance")).deploy(await pause.getAddress(), 100, 50, parseDOT("1"), 0);
    await v1.setRouter(await router.getAddress());
    const target = g3.address;
    const selector = "0x12345678";
    await v1.setWhitelistedTarget(target, true);
    await v1.setPermittedSelector(target, selector, true);
    const payload = selector + "00".repeat(32); // selector + dummy arg
    await v1.propose(target, payload, "desc"); // proposalId 0 (PG ids are 0-based)
    await v1.connect(voter).vote(0, true, 0, { value: parseDOT("2") });

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockParameterGovernanceNext")).deploy(await pause.getAddress(), 0, 0, 0, 0);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.quorum()).to.equal(parseDOT("1"));
    expect(await v2.whitelistedTargets(target)).to.equal(true);
    expect(await v2.permittedSelectors(target, selector)).to.equal(true);
    expect(await v2.whitelistTargetCount()).to.equal(1n);
    expect((await v2.getProposal(0)).target).to.equal(target);
    expect((await v2.getVote(0, voter.address)).lockAmount).to.equal(parseDOT("2"));
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("2"));
  });

  it("DatumCouncil migrates config; member set reconstructed at deploy", async function () {
    const guardian = owner.address; // not a member
    const members = [voter.address, g3.address, g4.address]; // MIN_COUNCIL_SIZE = 3
    const v1 = await (await ethers.getContractFactory("DatumCouncil")).deploy(members, 3, guardian, 100, 50, 30, 500);
    await v1.setRouter(await router.getAddress());

    await v1.connect(gov).freeze();
    // The off-chain migrator reads v1.memberAt(0..memberCount) and passes them to v2's constructor.
    const migratedMembers: string[] = [];
    const mc = Number(await v1.memberCount());
    for (let i = 0; i < mc; i++) migratedMembers.push(await v1.memberAt(i));
    const v2 = await (await ethers.getContractFactory("MockCouncilNext")).deploy(migratedMembers, 2, guardian, 1, 1, 1, 1);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());

    // config copied from predecessor (overrides the bootstrap values)
    expect(await v2.threshold()).to.equal(3n);
    expect(await v2.votingPeriodBlocks()).to.equal(100n);
    expect(await v2.guardian()).to.equal(guardian);
    // members reconstructed at construction from the predecessor's set
    expect(await v2.isMember(voter.address)).to.equal(true);
    expect(await v2.isMember(g4.address)).to.equal(true);
    expect(await v2.memberCount()).to.equal(3n);
  });
});
