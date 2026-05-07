import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumTimelock,
  DatumPauseRegistry,
  DatumCampaigns,
  DatumPublishers,
  DatumSettlement,
  DatumBudgetLedger,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { advanceTime, fundSigners } from "./helpers/mine";

// Admin timelock tests for alpha-3: C-6 multi-proposal API
// propose(target, data, salt) → proposalId, execute(proposalId), cancel(proposalId)

describe("Admin Timelock (DatumTimelock)", function () {
  let timelock: DatumTimelock;
  let pauseReg: DatumPauseRegistry;
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let settlement: DatumSettlement;
  let mock: MockCampaigns;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let newAddr: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  const TIMELOCK_DELAY = 172800; // 48 hours in seconds
  const SALT_0 = ethers.ZeroHash;
  let saltNonce = 0;

  /** Unique salt per call to avoid proposalId collisions in the same test run */
  function nextSalt(): string {
    return ethers.keccak256(ethers.toBeHex(++saltNonce, 32));
  }

  before(async function () {
    await fundSigners();
    [owner, other, newAddr, publisher] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, other.address, newAddr.address);

    const TimelockFactory = await ethers.getContractFactory("DatumTimelock");
    timelock = await TimelockFactory.deploy();

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(0n, 100n, await publishers.getAddress(), await pauseReg.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await ledger.setCampaigns(await campaigns.getAddress());

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await pauseReg.getAddress());

    // Wire contracts directly (owner is deployer, not timelock yet)
    await campaigns.setGovernanceContract(newAddr.address);
    await campaigns.setSettlementContract(other.address);
    await campaigns.setLifecycleContract(other.address);
    await settlement.configure(other.address, other.address, other.address, other.address);

    // Transfer ownership to timelock (2-step: transferOwnership + acceptOwnership)
    await campaigns.transferOwnership(await timelock.getAddress());
    // Timelock must accept ownership via propose+execute
    const acceptCampaignsData = campaigns.interface.encodeFunctionData("acceptOwnership");
    const salt1 = nextSalt();
    const pid1 = await timelock.hashProposal(await campaigns.getAddress(), acceptCampaignsData, salt1);
    await timelock.propose(await campaigns.getAddress(), acceptCampaignsData, salt1);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid1);

    await settlement.transferOwnership(await timelock.getAddress());
    const acceptSettlementData = settlement.interface.encodeFunctionData("acceptOwnership");
    const salt2 = nextSalt();
    const pid2 = await timelock.hashProposal(await settlement.getAddress(), acceptSettlementData, salt2);
    await timelock.propose(await settlement.getAddress(), acceptSettlementData, salt2);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid2);
  });

  // T1: execute before 48h reverts
  it("T1: execute reverts before delay expires", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await expect(timelock.execute(pid)).to.be.revertedWith("E37");
    await timelock.cancel(pid);
  });

  // T2: execute after 48h succeeds
  it("T2: execute succeeds after 48h delay", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid);
    expect(await campaigns.settlementContract()).to.equal(newAddr.address);
  });

  // T3: governance role change via timelock
  it("T3: governance contract change via timelock", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setGovernanceContract", [other.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid);
    expect(await campaigns.governanceContract()).to.equal(other.address);
  });

  // T4: cancel clears pending state
  it("T4: cancel clears pending state", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await timelock.cancel(pid);
    await advanceTime(TIMELOCK_DELAY);
    await expect(timelock.execute(pid)).to.be.revertedWith("E36");
  });

  // T5: only owner can propose
  it("T5: only owner can propose changes", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await expect(
      timelock.connect(other).propose(await campaigns.getAddress(), calldata, SALT_0)
    ).to.be.revertedWith("E18");
  });

  // T6: only owner can cancel
  it("T6: only owner can cancel changes", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await expect(timelock.connect(other).cancel(pid)).to.be.revertedWith("E18");
    await timelock.cancel(pid);
  });

  // T7: anyone can execute after delay
  it("T7: anyone can execute after delay", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setGovernanceContract", [newAddr.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.connect(other).execute(pid);
    expect(await campaigns.governanceContract()).to.equal(newAddr.address);
  });

  // T8: propose with zero target reverts
  it("T8: propose with zero target reverts", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await expect(
      timelock.propose(ethers.ZeroAddress, calldata, SALT_0)
    ).to.be.revertedWith("E00");
  });

  // T9: old reference still works during delay period
  it("T9: old reference still works during delay period", async function () {
    const currentSettlement = await campaigns.settlementContract();
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [publisher.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    expect(await campaigns.settlementContract()).to.equal(currentSettlement);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid);
    expect(await campaigns.settlementContract()).to.equal(publisher.address);
  });

  // T10: propose emits event
  it("T10: propose emits ChangeProposed event", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await expect(timelock.propose(await campaigns.getAddress(), calldata, salt))
      .to.emit(timelock, "ChangeProposed");
    await timelock.cancel(pid);
  });

  // T11: settlement configure change via timelock
  it("T11: settlement configure via timelock", async function () {
    const calldata = settlement.interface.encodeFunctionData("configure", [
      other.address, other.address, other.address, newAddr.address
    ]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await settlement.getAddress(), calldata, salt);
    await timelock.propose(await settlement.getAddress(), calldata, salt);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid);
    expect(await settlement.relayContract()).to.equal(newAddr.address);
  });

  // T14: execute before delay reverts on settlement change
  it("T14: execute reverts before delay on settlement change", async function () {
    const calldata = settlement.interface.encodeFunctionData("configure", [
      other.address, other.address, other.address, other.address
    ]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await settlement.getAddress(), calldata, salt);
    await timelock.propose(await settlement.getAddress(), calldata, salt);
    await expect(timelock.execute(pid)).to.be.revertedWith("E37");
    await timelock.cancel(pid);
  });

  // T15: non-owner direct calls on timelocked contracts revert
  it("T15: direct calls on timelocked contracts revert (not owner)", async function () {
    await expect(
      campaigns.connect(other).setSettlementContract(newAddr.address)
    ).to.be.revertedWith("E18");
  });

  // T4-1: cancel(proposalId) with non-existent proposal reverts E36
  it("T4-1: cancel() with non-existent proposal reverts E36", async function () {
    const fakePid = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
    await expect(timelock.cancel(fakePid)).to.be.revertedWith("E36");
  });

  // T4-2: C-6 multi-proposal — can have multiple concurrent proposals
  it("T4-2: multiple concurrent proposals (C-6)", async function () {
    const calldata1 = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    const calldata2 = campaigns.interface.encodeFunctionData("setGovernanceContract", [other.address]);
    const salt1 = nextSalt();
    const salt2 = nextSalt();
    const pid1 = await timelock.hashProposal(await campaigns.getAddress(), calldata1, salt1);
    const pid2 = await timelock.hashProposal(await campaigns.getAddress(), calldata2, salt2);

    await timelock.propose(await campaigns.getAddress(), calldata1, salt1);
    await timelock.propose(await campaigns.getAddress(), calldata2, salt2);

    expect(await timelock.pendingCount()).to.equal(2n);

    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute(pid1);
    await timelock.execute(pid2);

    expect(await campaigns.settlementContract()).to.equal(other.address);
    expect(await campaigns.governanceContract()).to.equal(other.address);
    expect(await timelock.pendingCount()).to.equal(0n);
  });

  // T4-3: execute() where target call reverts
  it("T4-3: execute() where target call reverts", async function () {
    const badCalldata = "0xdeadbeef";
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await settlement.getAddress(), badCalldata, salt);
    await timelock.propose(await settlement.getAddress(), badCalldata, salt);
    await advanceTime(TIMELOCK_DELAY);
    await expect(timelock.execute(pid)).to.be.revertedWith("E02");
  });

  // T4-4: duplicate proposalId reverts E35
  it("T4-4: duplicate proposalId reverts E35", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    const salt = nextSalt();
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    await expect(
      timelock.propose(await campaigns.getAddress(), calldata, salt)
    ).to.be.revertedWith("E35");
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.cancel(pid);
  });

  // AUDIT-029: stale proposal expires after PROPOSAL_TIMEOUT
  it("T4-5: stale proposal expires after 7 days (AUDIT-029)", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    const salt = nextSalt();
    const pid = await timelock.hashProposal(await campaigns.getAddress(), calldata, salt);
    await timelock.propose(await campaigns.getAddress(), calldata, salt);
    // Advance past delay + timeout (48h + 7d)
    await advanceTime(TIMELOCK_DELAY + 604800 + 1);
    await expect(timelock.execute(pid)).to.be.revertedWith("E37");
  });
});
