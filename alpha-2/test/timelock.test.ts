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

// Admin timelock tests for alpha-2: T1-T15
// Same as alpha — DatumTimelock is unchanged.

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

  before(async function () {
    await fundSigners();
    [owner, other, newAddr, publisher] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

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
    settlement = await SettleFactory.deploy(await mock.getAddress(), await pauseReg.getAddress());

    // Wire contracts directly (owner is deployer, not timelock yet)
    await campaigns.setGovernanceContract(newAddr.address);
    await campaigns.setSettlementContract(other.address);
    await campaigns.setLifecycleContract(other.address);
    await settlement.setRelayContract(other.address);

    // Transfer ownership to timelock
    await campaigns.transferOwnership(await timelock.getAddress());
    await settlement.transferOwnership(await timelock.getAddress());
  });

  // T1: execute before 48h reverts
  it("T1: execute reverts before delay expires", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    await expect(timelock.execute()).to.be.revertedWith("E37");
  });

  // T2: execute after 48h succeeds
  it("T2: execute succeeds after 48h delay", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute();
    expect(await campaigns.settlementContract()).to.equal(newAddr.address);
  });

  // T3: governance role change via timelock
  it("T3: governance contract change via timelock", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setGovernanceContract", [other.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute();
    expect(await campaigns.governanceContract()).to.equal(other.address);
  });

  // T4: cancel clears pending state
  it("T4: cancel clears pending state", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    await timelock.cancel();
    await advanceTime(TIMELOCK_DELAY);
    await expect(timelock.execute()).to.be.revertedWith("E36");
  });

  // T5: only owner can propose
  it("T5: only owner can propose changes", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await expect(
      timelock.connect(other).propose(await campaigns.getAddress(), calldata)
    ).to.be.revertedWith("E18");
  });

  // T6: only owner can cancel
  it("T6: only owner can cancel changes", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    await expect(timelock.connect(other).cancel()).to.be.revertedWith("E18");
    await timelock.cancel();
  });

  // T7: anyone can execute after delay
  it("T7: anyone can execute after delay", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setGovernanceContract", [newAddr.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.connect(other).execute();
    expect(await campaigns.governanceContract()).to.equal(newAddr.address);
  });

  // T8: propose with zero target reverts
  it("T8: propose with zero target reverts", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await expect(
      timelock.propose(ethers.ZeroAddress, calldata)
    ).to.be.revertedWith("E00");
  });

  // T9: old reference still works during delay period
  it("T9: old reference still works during delay period", async function () {
    const currentSettlement = await campaigns.settlementContract();
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [publisher.address]);
    await timelock.propose(await campaigns.getAddress(), calldata);
    expect(await campaigns.settlementContract()).to.equal(currentSettlement);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute();
    expect(await campaigns.settlementContract()).to.equal(publisher.address);
  });

  // T10: propose emits event
  it("T10: propose emits ChangeProposed event", async function () {
    const calldata = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await expect(timelock.propose(await campaigns.getAddress(), calldata))
      .to.emit(timelock, "ChangeProposed");
    await timelock.cancel();
  });

  // T11: settlement relay change via timelock
  it("T11: relay contract change via timelock", async function () {
    const calldata = settlement.interface.encodeFunctionData("setRelayContract", [newAddr.address]);
    await timelock.propose(await settlement.getAddress(), calldata);
    await advanceTime(TIMELOCK_DELAY);
    await timelock.execute();
    expect(await settlement.relayContract()).to.equal(newAddr.address);
  });

  // T14: execute before delay reverts on settlement change
  it("T14: execute reverts before delay on settlement change", async function () {
    const calldata = settlement.interface.encodeFunctionData("setRelayContract", [other.address]);
    await timelock.propose(await settlement.getAddress(), calldata);
    await expect(timelock.execute()).to.be.revertedWith("E37");
    await timelock.cancel();
  });

  // T15: non-owner direct calls on timelocked contracts revert
  it("T15: direct calls on timelocked contracts revert (not owner)", async function () {
    await expect(
      campaigns.connect(other).setSettlementContract(newAddr.address)
    ).to.be.revertedWith("E18");
  });

  // T4-1: cancel() with no pending proposal reverts E35
  it("T4-1: cancel() with no pending proposal reverts E35", async function () {
    await expect(timelock.cancel()).to.be.revertedWith("E35");
  });

  // T4-2: propose() overwrites pending proposal (resets timer)
  it("T4-2: propose() overwrites pending proposal (resets timer)", async function () {
    const calldata1 = campaigns.interface.encodeFunctionData("setSettlementContract", [other.address]);
    await timelock.propose(await campaigns.getAddress(), calldata1);
    await advanceTime(TIMELOCK_DELAY / 2);

    const calldata2 = campaigns.interface.encodeFunctionData("setSettlementContract", [newAddr.address]);
    await timelock.propose(await campaigns.getAddress(), calldata2);

    await advanceTime(TIMELOCK_DELAY / 2);
    await expect(timelock.execute()).to.be.revertedWith("E37");

    await advanceTime(TIMELOCK_DELAY / 2 + 1);
    await timelock.execute();
    expect(await campaigns.settlementContract()).to.equal(newAddr.address);
  });

  // T4-3: execute() where target call reverts
  it("T4-3: execute() where target call reverts", async function () {
    const badCalldata = "0xdeadbeef";
    await timelock.propose(await settlement.getAddress(), badCalldata);
    await advanceTime(TIMELOCK_DELAY);
    await expect(timelock.execute()).to.be.revertedWith("E02");
  });
});
