import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers } from "hardhat";
import {
  DatumCouncil,
  DatumGovernanceRouter,
  MockCampaigns,
  MockCampaignLifecycle,
  MockCallTarget,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// DatumCouncil (Phase 1 governance ladder)
//
// C1:  propose — member creates proposal, emits Proposed
// C2:  propose — non-member reverts
// C3:  propose — mismatched array lengths revert
// C4:  vote — member votes, emits Voted
// C5:  vote — duplicate vote reverts
// C6:  vote — vote after voting period reverts
// C7:  vote — non-member reverts
// C8:  threshold reached — emits ThresholdReached, sets executableAfterBlock
// C9:  execute — executes after delay, calls targets
// C10: execute — too early reverts
// C11: execute — already executed reverts
// C12: execute — expired proposal reverts
// C13: veto — guardian vetos, emits Vetoed
// C14: veto — non-guardian reverts
// C15: veto — after veto window reverts
// C16: veto — execute after veto reverts
// C17: cancel — proposer can cancel
// C18: cancel — non-proposer reverts
// C19: addMember — via council proposal
// C20: removeMember — via council proposal
// C21: setThreshold — via council proposal
// C22: proposalState returns correct state
// C23: council routes governance calls through Router + MockCampaigns
// C24: getMemberList returns initial members
// C25: setGuardian via council proposal removes guardian

describe("DatumCouncil", function () {
  let council: DatumCouncil;
  let router: DatumGovernanceRouter;
  let mock: MockCampaigns;
  let mockLifecycle: MockCampaignLifecycle;
  let callTarget: MockCallTarget;

  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  // Short periods for testing
  const VOTING_PERIOD = 20n;
  const EXEC_DELAY = 5n;
  const VETO_WINDOW = 50n;
  const MAX_EXEC_WINDOW = 100n;
  const THRESHOLD = 2n;

  before(async function () {
    await fundSigners();
    [owner, alice, bob, charlie, guardian, outsider] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const LifecycleFactory = await ethers.getContractFactory("MockCampaignLifecycle");
    mockLifecycle = await LifecycleFactory.deploy(await mock.getAddress());

    const TargetFactory = await ethers.getContractFactory("MockCallTarget");
    callTarget = await TargetFactory.deploy();

    // Deploy council: alice, bob, charlie; threshold=2; guardian
    const CouncilFactory = await ethers.getContractFactory("DatumCouncil");
    council = await CouncilFactory.deploy(
      [alice.address, bob.address, charlie.address],
      THRESHOLD,
      guardian.address,
      VOTING_PERIOD,
      EXEC_DELAY,
      VETO_WINDOW,
      MAX_EXEC_WINDOW
    );

    // Deploy router with council as governor
    const RouterFactory = await ethers.getContractFactory("DatumGovernanceRouter");
    router = await RouterFactory.deploy(
      await mock.getAddress(),
      await mockLifecycle.getAddress(),
      await council.getAddress()
    );

    // Wire governance
    await mockLifecycle.setGovernanceContract(await router.getAddress());
    await mock.setGovernanceContract(await router.getAddress());
  });

  // ── C1: propose happy path ─────────────────────────────────────────────────

  it("C1 propose — member creates proposal", async function () {
    const tx = await council.connect(alice).propose(
      [await callTarget.getAddress()],
      [0],
      ["0xdeadbeef"],
      "Test proposal"
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.map(l => {
      try { return council.interface.parseLog(l); } catch { return null; }
    }).find(e => e?.name === "Proposed");
    expect(event?.args.proposalId).to.equal(0n);
    expect(event?.args.proposer).to.equal(alice.address);

    const p = await council.proposals(0n);
    expect(p.proposedBlock).to.be.gt(0n);
    expect(p.executed).to.be.false;
    expect(p.voteCount).to.equal(0n);
  });

  // ── C2: propose — non-member reverts ──────────────────────────────────────

  it("C2 propose — non-member reverts", async function () {
    await expect(
      council.connect(outsider).propose([owner.address], [0], ["0x"], "bad")
    ).to.be.revertedWith("E18");
  });

  // ── C3: propose — mismatched arrays revert ─────────────────────────────────

  it("C3 propose — mismatched array lengths revert", async function () {
    await expect(
      council.connect(alice).propose([owner.address, owner.address], [0], ["0x"], "bad")
    ).to.be.revertedWith("E00");
  });

  // ── C4: vote — member votes, emits Voted ──────────────────────────────────

  it("C4 vote — first vote emits Voted with newCount=1", async function () {
    await expect(council.connect(alice).vote(0n))
      .to.emit(council, "Voted")
      .withArgs(0n, alice.address, 1n);
    const p = await council.proposals(0n);
    expect(p.voteCount).to.equal(1n);
  });

  // ── C5: vote — duplicate vote reverts ─────────────────────────────────────

  it("C5 vote — duplicate vote reverts E42", async function () {
    await expect(council.connect(alice).vote(0n)).to.be.revertedWith("E42");
  });

  // ── C6: vote after voting period reverts ──────────────────────────────────

  it("C6 vote — after voting period reverts E51", async function () {
    // Create proposal 1
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "Expire test");
    await mineBlocks(Number(VOTING_PERIOD) + 1);
    await expect(council.connect(bob).vote(1n)).to.be.revertedWith("E51");
  });

  // ── C7: vote — non-member reverts ─────────────────────────────────────────

  it("C7 vote — non-member reverts E18", async function () {
    // Create proposal 2
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "NonMember test");
    await expect(council.connect(outsider).vote(2n)).to.be.revertedWith("E18");
  });

  // ── C8: threshold reached → emits ThresholdReached ────────────────────────

  it("C8 threshold reached — emits ThresholdReached, sets executableAfterBlock", async function () {
    // Proposal 2 already created; alice votes first, bob's vote hits threshold
    await council.connect(alice).vote(2n);
    const tx = await council.connect(bob).vote(2n);
    await expect(tx).to.emit(council, "ThresholdReached").withArgs(2n, anyValue);

    const p = await council.proposals(2n);
    expect(p.executableAfterBlock).to.be.gt(0n);
    expect(p.executionExpiresBlock).to.equal(p.executableAfterBlock + MAX_EXEC_WINDOW);
  });

  // ── C9: execute — calls targets after delay ────────────────────────────────

  it("C9 execute — executes after delay, calls targets", async function () {
    // Create proposal 3 that calls MockCallTarget (0xdeadbeef selector isn't real but call will succeed silently)
    await council.connect(alice).propose(
      [await callTarget.getAddress()],
      [0],
      [callTarget.interface.encodeFunctionData("setValue", [42n])],
      "setValue(42)"
    );
    await council.connect(alice).vote(3n);
    await council.connect(bob).vote(3n); // threshold reached

    const p = await council.proposals(3n);
    const blocksUntilExec = Number(p.executableAfterBlock) - await ethers.provider.getBlockNumber();
    if (blocksUntilExec > 0) await mineBlocks(blocksUntilExec);

    await expect(council.execute(3n)).to.emit(council, "Executed").withArgs(3n);
    expect(await callTarget.value()).to.equal(42n);

    const p2 = await council.proposals(3n);
    expect(p2.executed).to.be.true;
  });

  // ── C10: execute — too early reverts ──────────────────────────────────────

  it("C10 execute — before executableAfterBlock reverts E55", async function () {
    // Create proposal 4
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "TooEarly");
    await council.connect(alice).vote(4n);
    await council.connect(bob).vote(4n); // threshold reached — delay starts now

    const p = await council.proposals(4n);
    const cur = await ethers.provider.getBlockNumber();
    // Only try if there's still a delay remaining
    if (BigInt(cur) < p.executableAfterBlock) {
      await expect(council.execute(4n)).to.be.revertedWith("E55");
    }
  });

  // ── C11: execute — already executed reverts ────────────────────────────────

  it("C11 execute — double execute reverts E52", async function () {
    await expect(council.execute(3n)).to.be.revertedWith("E52");
  });

  // ── C12: execute — expired proposal reverts ───────────────────────────────

  it("C12 execute — expired proposal reverts E56", async function () {
    // Create proposal 5, hit threshold, let it expire
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "Expire exec");
    await council.connect(alice).vote(5n);
    await council.connect(bob).vote(5n);

    // Mine past execution window
    await mineBlocks(Number(EXEC_DELAY) + Number(MAX_EXEC_WINDOW) + 5);

    await expect(council.execute(5n)).to.be.revertedWith("E56");
  });

  // ── C13: veto — guardian vetos ────────────────────────────────────────────

  it("C13 veto — guardian vetos proposal", async function () {
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "VetoTest");
    const pid = (await council.nextProposalId()) - 1n;
    await expect(council.connect(guardian).veto(pid))
      .to.emit(council, "Vetoed")
      .withArgs(pid, guardian.address);

    const p = await council.proposals(pid);
    expect(p.vetoed).to.be.true;
  });

  // ── C14: veto — non-guardian reverts ──────────────────────────────────────

  it("C14 veto — non-guardian reverts E18", async function () {
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "VetoFail");
    const pid = (await council.nextProposalId()) - 1n;
    await expect(council.connect(alice).veto(pid)).to.be.revertedWith("E18");
  });

  // ── C15: veto — after veto window reverts ─────────────────────────────────

  it("C15 veto — after vetoWindow reverts E56", async function () {
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "VetoWindow");
    const pid = (await council.nextProposalId()) - 1n;
    await mineBlocks(Number(VETO_WINDOW) + 1);
    await expect(council.connect(guardian).veto(pid)).to.be.revertedWith("E56");
  });

  // ── C16: execute after veto reverts ───────────────────────────────────────

  it("C16 execute — vetoed proposal reverts E53", async function () {
    const pid = (await council.nextProposalId()) - 3n; // C13 veto proposal (proposals 0,1,2,3,4,5,6=C13,7,8 → next=9, 9-3=6)
    await expect(council.execute(pid)).to.be.revertedWith("E53");
  });

  // ── C17: cancel — proposer cancels ────────────────────────────────────────

  it("C17 cancel — proposer can cancel own proposal", async function () {
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "Cancel");
    const pid = (await council.nextProposalId()) - 1n;
    await expect(council.connect(alice).cancel(pid))
      .to.emit(council, "Vetoed")
      .withArgs(pid, alice.address);
    expect((await council.proposals(pid)).vetoed).to.be.true;
  });

  // ── C18: cancel — non-proposer reverts ────────────────────────────────────

  it("C18 cancel — non-proposer reverts E18", async function () {
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "CancelFail");
    const pid = (await council.nextProposalId()) - 1n;
    await expect(council.connect(bob).cancel(pid)).to.be.revertedWith("E18");
  });

  // ── C19: addMember via council proposal ────────────────────────────────────

  it("C19 addMember — via council self-proposal", async function () {
    const calldata = council.interface.encodeFunctionData("addMember", [outsider.address]);
    await council.connect(alice).propose([await council.getAddress()], [0], [calldata], "add outsider");
    const pid = (await council.nextProposalId()) - 1n;
    await council.connect(alice).vote(pid);
    await council.connect(bob).vote(pid);

    const p = await council.proposals(pid);
    await mineBlocks(Number(p.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await council.execute(pid);

    expect(await council.isMember(outsider.address)).to.be.true;
    expect(await council.memberCount()).to.equal(4n);
  });

  // ── C20: removeMember via council proposal ─────────────────────────────────

  it("C20 removeMember — via council self-proposal", async function () {
    // Remove outsider (just added in C19)
    const calldata = council.interface.encodeFunctionData("removeMember", [outsider.address]);
    await council.connect(alice).propose([await council.getAddress()], [0], [calldata], "rm outsider");
    const pid = (await council.nextProposalId()) - 1n;
    await council.connect(alice).vote(pid);
    await council.connect(bob).vote(pid);

    const p = await council.proposals(pid);
    await mineBlocks(Number(p.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await council.execute(pid);

    expect(await council.isMember(outsider.address)).to.be.false;
    expect(await council.memberCount()).to.equal(3n);
  });

  // ── C21: setThreshold via council proposal ─────────────────────────────────

  it("C21 setThreshold — via council self-proposal", async function () {
    const calldata = council.interface.encodeFunctionData("setThreshold", [3n]);
    await council.connect(alice).propose([await council.getAddress()], [0], [calldata], "threshold=3");
    const pid = (await council.nextProposalId()) - 1n;
    await council.connect(alice).vote(pid);
    await council.connect(bob).vote(pid);

    const p = await council.proposals(pid);
    await mineBlocks(Number(p.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await council.execute(pid);

    expect(await council.threshold()).to.equal(3n);
    // Restore threshold to 2 via another proposal
    const calldata2 = council.interface.encodeFunctionData("setThreshold", [2n]);
    await council.connect(alice).propose([await council.getAddress()], [0], [calldata2], "threshold=2");
    const pid2 = (await council.nextProposalId()) - 1n;
    await council.connect(alice).vote(pid2);
    await council.connect(bob).vote(pid2);
    await council.connect(charlie).vote(pid2);
    const p2 = await council.proposals(pid2);
    await mineBlocks(Number(p2.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await council.execute(pid2);
    expect(await council.threshold()).to.equal(2n);
  });

  // ── C22: proposalState ─────────────────────────────────────────────────────

  it("C22 proposalState — returns correct state enum", async function () {
    // State 0: Active (just proposed)
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "StateTest");
    const pid = (await council.nextProposalId()) - 1n;
    expect(await council.proposalState(pid)).to.equal(0); // Active

    // State 1: Passed
    await council.connect(alice).vote(pid);
    await council.connect(bob).vote(pid);
    expect(await council.proposalState(pid)).to.equal(1); // Passed

    // State 2: Executed
    const p = await council.proposals(pid);
    await mineBlocks(Number(p.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await council.execute(pid);
    expect(await council.proposalState(pid)).to.equal(2); // Executed

    // State 3: Vetoed
    await council.connect(alice).propose([owner.address], [0], ["0x00"], "VetoState");
    const vid = (await council.nextProposalId()) - 1n;
    await council.connect(guardian).veto(vid);
    expect(await council.proposalState(vid)).to.equal(3); // Vetoed

    // State 4: Expired (not found)
    expect(await council.proposalState(9999n)).to.equal(4);
  });

  // ── C23: council routes through Router to campaigns ───────────────────────

  it("C23 council routes governance call through Router to MockCampaigns", async function () {
    await mock.setCampaign(20, owner.address, alice.address, 1_000_000_000n, 500, 0);

    const calldata = router.interface.encodeFunctionData("activateCampaign", [20]);
    await council.connect(alice).propose([await router.getAddress()], [0], [calldata], "activate campaign 20");
    const pid = (await council.nextProposalId()) - 1n;

    await council.connect(alice).vote(pid);
    await council.connect(bob).vote(pid);

    const p = await council.proposals(pid);
    await mineBlocks(Number(p.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await council.execute(pid);

    const c = await mock.campaigns(20);
    expect(c.status).to.equal(1n); // Active
  });

  // ── C24: getMemberList ─────────────────────────────────────────────────────

  it("C24 getMemberList — returns initial members", async function () {
    const list = await council.getMemberList();
    expect(list).to.include(alice.address);
    expect(list).to.include(bob.address);
    expect(list).to.include(charlie.address);
  });

  // ── C25: setGuardian removes guardian ─────────────────────────────────────

  it("C25 setGuardian — via council proposal, emits GuardianSet", async function () {
    const calldata = council.interface.encodeFunctionData("setGuardian", [ethers.ZeroAddress]);
    await council.connect(alice).propose([await council.getAddress()], [0], [calldata], "remove guardian");
    const pid = (await council.nextProposalId()) - 1n;
    await council.connect(alice).vote(pid);
    await council.connect(bob).vote(pid);

    const p = await council.proposals(pid);
    await mineBlocks(Number(p.executableAfterBlock - BigInt(await ethers.provider.getBlockNumber())) + 1);
    await expect(council.execute(pid))
      .to.emit(council, "GuardianSet")
      .withArgs(ethers.ZeroAddress);
    expect(await council.guardian()).to.equal(ethers.ZeroAddress);
  });
});
