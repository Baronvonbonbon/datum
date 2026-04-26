import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPublisherStake, DatumPublishers, DatumPauseRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// DatumPublisherStake tests (FP-1 + FP-4)
// PS1–PS4:   stake() — basic staking, zero revert, accumulation
// PS5–PS9:   requestUnstake() — access, below-required revert, pending-request revert
// PS10–PS13: unstake() — delay check, happy path, no-request revert
// PS14–PS16: slash() — access control, capped to balance, zero skip
// PS17–PS19: recordImpressions() — access control, accumulation
// PS20–PS23: requiredStake() bonding curve — zero impressions, with impressions
// PS24–PS25: isAdequatelyStaked() — adequate, inadequate
// PS26–PS28: setParams(), ownership transfer

describe("DatumPublisherStake", function () {
  let stake: DatumPublisherStake;

  let owner: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let slashContract: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const BASE_STAKE    = 1_000_000_000n;  // 0.1 DOT
  const PER_IMP       = 1_000n;          // 1000 planck per impression
  const DELAY_BLOCKS  = 10n;             // short for testing

  before(async function () {
    await fundSigners();
    [owner, publisher, publisher2, settlement, slashContract, other] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumPublisherStake");
    stake = await Factory.deploy(BASE_STAKE, PER_IMP, DELAY_BLOCKS);

    await stake.connect(owner).setSettlementContract(settlement.address);
    await stake.connect(owner).setSlashContract(slashContract.address);

    // Pre-stake publisher2 so it has room to unstake above BASE_STAKE
    await stake.connect(publisher2).stake({ value: 5_000_000_000n });
  });

  // ── stake() ──────────────────────────────────────────────────────────────────

  // PS1: publisher stakes DOT, balance reflects it
  it("PS1: stake increases publisher balance", async function () {
    const amount = 5_000_000_000n;
    await stake.connect(publisher).stake({ value: amount });
    expect(await stake.staked(publisher.address)).to.equal(amount);
  });

  // PS2: second stake accumulates
  it("PS2: successive stakes accumulate", async function () {
    const before = await stake.staked(publisher.address);
    const extra = 2_000_000_000n;
    await stake.connect(publisher).stake({ value: extra });
    expect(await stake.staked(publisher.address)).to.equal(before + extra);
  });

  // PS3: zero-value stake reverts E11
  it("PS3: stake with value=0 reverts E11", async function () {
    await expect(
      stake.connect(publisher).stake({ value: 0n })
    ).to.be.revertedWith("E11");
  });

  // PS4: stake emits Staked event
  it("PS4: stake emits Staked event", async function () {
    const amount = 2_000_000_000n;
    const before = await stake.staked(publisher2.address);
    await expect(stake.connect(publisher2).stake({ value: amount }))
      .to.emit(stake, "Staked")
      .withArgs(publisher2.address, amount, before + amount);
  });

  // ── requestUnstake() ─────────────────────────────────────────────────────────

  // PS5: requestUnstake with sufficient remaining stake succeeds
  it("PS5: requestUnstake schedules withdrawal", async function () {
    // publisher2 has 1 DOT staked, baseStake = 0.1 DOT, no impressions
    const staked = await stake.staked(publisher2.address);
    const req = await stake.requiredStake(publisher2.address);
    const canUnstake = staked - req;
    expect(canUnstake).to.be.gt(0n);

    await stake.connect(publisher2).requestUnstake(canUnstake);
    const pending = await stake.pendingUnstake(publisher2.address);
    expect(pending.amount).to.equal(canUnstake);
    expect(pending.availableBlock).to.be.gt(0n);
  });

  // PS6: requestUnstake that would drop below requiredStake reverts E69
  it("PS6: requestUnstake below required stake reverts E69", async function () {
    const staked = await stake.staked(publisher.address);
    // Try to unstake everything (would drop to 0, below baseStake)
    await expect(
      stake.connect(publisher).requestUnstake(staked)
    ).to.be.revertedWith("E69");
  });

  // PS7: duplicate requestUnstake reverts E68
  it("PS7: second requestUnstake while pending reverts E68", async function () {
    // publisher2 already has a pending request from PS5
    await expect(
      stake.connect(publisher2).requestUnstake(1n)
    ).to.be.revertedWith("E68");
  });

  // PS8: requestUnstake with amount > staked reverts E03
  it("PS8: requestUnstake exceeding balance reverts E03", async function () {
    await expect(
      stake.connect(other).requestUnstake(1_000_000n)
    ).to.be.revertedWith("E03");
  });

  // PS9: requestUnstake with amount=0 reverts E11
  it("PS9: requestUnstake with amount=0 reverts E11", async function () {
    await expect(
      stake.connect(publisher).requestUnstake(0n)
    ).to.be.revertedWith("E11");
  });

  // ── unstake() ────────────────────────────────────────────────────────────────

  // PS10: unstake before delay reverts E70
  it("PS10: unstake before delay reverts E70", async function () {
    await expect(
      stake.connect(publisher2).unstake()
    ).to.be.revertedWith("E70");
  });

  // PS11: unstake after delay succeeds and transfers funds
  it("PS11: unstake after delay succeeds", async function () {
    await mineBlocks(DELAY_BLOCKS + 1n);
    const pending = await stake.pendingUnstake(publisher2.address);
    const balBefore = await ethers.provider.getBalance(publisher2.address);
    const tx = await stake.connect(publisher2).unstake();
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(publisher2.address);
    // Allow some tolerance for gas on Hardhat vs substrate
    expect(balAfter + gasUsed).to.be.closeTo(balBefore + pending.amount, 1_000_000_000n);
  });

  // PS12: unstake with no pending request reverts E01
  it("PS12: unstake with no pending request reverts E01", async function () {
    await expect(
      stake.connect(publisher2).unstake()
    ).to.be.revertedWith("E01");
  });

  // PS13: unstake emits Unstaked event
  it("PS13: unstake emits Unstaked event", async function () {
    // publisher2 needs a new unstake request
    await stake.connect(publisher2).stake({ value: 5_000_000_000n });
    const staked2 = await stake.staked(publisher2.address);
    const req2 = await stake.requiredStake(publisher2.address);
    const amount = staked2 - req2;
    await stake.connect(publisher2).requestUnstake(amount);
    await mineBlocks(DELAY_BLOCKS + 1n);
    await expect(stake.connect(publisher2).unstake())
      .to.emit(stake, "Unstaked")
      .withArgs(publisher2.address, amount);
  });

  // ── slash() ──────────────────────────────────────────────────────────────────

  // PS14: slash from non-slashContract reverts E18
  it("PS14: slash from non-slashContract reverts E18", async function () {
    await expect(
      stake.connect(other).slash(publisher.address, 1n, other.address)
    ).to.be.revertedWith("E18");
  });

  // PS15: slash transfers specified amount to recipient
  it("PS15: slash transfers amount to recipient", async function () {
    const staked = await stake.staked(publisher.address);
    const slashAmt = staked / 2n;
    const balBefore = await ethers.provider.getBalance(other.address);
    await stake.connect(slashContract).slash(publisher.address, slashAmt, other.address);
    const balAfter = await ethers.provider.getBalance(other.address);
    expect(balAfter - balBefore).to.equal(slashAmt);
    expect(await stake.staked(publisher.address)).to.equal(staked - slashAmt);
  });

  // PS16: slash capped to available balance (no revert on over-slash)
  it("PS16: slash over-request is capped to staked balance", async function () {
    const staked = await stake.staked(publisher.address);
    // Try to slash more than staked
    await stake.connect(slashContract).slash(publisher.address, staked * 100n, other.address);
    expect(await stake.staked(publisher.address)).to.equal(0n);
  });

  // ── recordImpressions() ──────────────────────────────────────────────────────

  // PS17: recordImpressions from non-settlement reverts E18
  it("PS17: recordImpressions from non-settlement reverts E18", async function () {
    await expect(
      stake.connect(other).recordImpressions(publisher.address, 100n)
    ).to.be.revertedWith("E18");
  });

  // PS18: recordImpressions accumulates cumulative count
  it("PS18: recordImpressions accumulates", async function () {
    await stake.connect(settlement).recordImpressions(publisher.address, 1000n);
    await stake.connect(settlement).recordImpressions(publisher.address, 500n);
    expect(await stake.cumulativeImpressions(publisher.address)).to.equal(1500n);
  });

  // PS19: recordImpressions emits ImpressionsRecorded
  it("PS19: recordImpressions emits ImpressionsRecorded", async function () {
    const before = await stake.cumulativeImpressions(publisher.address);
    await expect(
      stake.connect(settlement).recordImpressions(publisher.address, 200n)
    )
      .to.emit(stake, "ImpressionsRecorded")
      .withArgs(publisher.address, 200n, before + 200n);
  });

  // ── requiredStake() bonding curve ─────────────────────────────────────────────

  // PS20: requiredStake with zero impressions equals baseStakePlanck
  it("PS20: requiredStake with no impressions = baseStakePlanck", async function () {
    expect(await stake.requiredStake(other.address)).to.equal(BASE_STAKE);
  });

  // PS21: requiredStake grows with impressions
  it("PS21: requiredStake grows with cumulative impressions", async function () {
    const imps = await stake.cumulativeImpressions(publisher.address);
    const expected = BASE_STAKE + imps * PER_IMP;
    expect(await stake.requiredStake(publisher.address)).to.equal(expected);
  });

  // ── isAdequatelyStaked() ─────────────────────────────────────────────────────

  // PS22: newly staked publisher with enough stake is adequate
  it("PS22: publisher with stake >= requiredStake is adequately staked", async function () {
    await stake.connect(publisher2).stake({ value: 100_000_000_000n });
    expect(await stake.isAdequatelyStaked(publisher2.address)).to.equal(true);
  });

  // PS23: publisher with zero stake is not adequately staked (if baseStake > 0)
  it("PS23: publisher with zero stake is not adequately staked", async function () {
    expect(await stake.isAdequatelyStaked(other.address)).to.equal(false);
  });

  // PS24: publisher whose stake drops below curve is not adequate
  it("PS24: high impression count can make publisher inadequate", async function () {
    // publisher has 0 staked (slashed to 0 in PS16), but has accumulated impressions
    const imps = await stake.cumulativeImpressions(publisher.address);
    expect(imps).to.be.gt(0n);
    expect(await stake.isAdequatelyStaked(publisher.address)).to.equal(false);
  });

  // ── setParams() ───────────────────────────────────────────────────────────────

  // PS25: setParams from owner updates values and emits event
  it("PS25: setParams updates bonding curve params", async function () {
    await expect(
      stake.connect(owner).setParams(2_000_000_000n, 2_000n, 20n)
    )
      .to.emit(stake, "ParamsUpdated")
      .withArgs(2_000_000_000n, 2_000n, 20n);
    expect(await stake.baseStakePlanck()).to.equal(2_000_000_000n);
    expect(await stake.planckPerImpression()).to.equal(2_000n);
    expect(await stake.unstakeDelayBlocks()).to.equal(20n);
  });

  // PS26: setParams from non-owner reverts E18
  it("PS26: setParams from non-owner reverts E18", async function () {
    await expect(
      stake.connect(other).setParams(0n, 0n, 1n)
    ).to.be.revertedWith("E18");
  });

  // PS27: setParams with delay=0 reverts E00
  it("PS27: setParams with zero delay reverts E00", async function () {
    await expect(
      stake.connect(owner).setParams(0n, 0n, 0n)
    ).to.be.revertedWith("E00");
  });

  // PS28: two-step ownership transfer
  it("PS28: two-step ownership transfer works", async function () {
    await stake.connect(owner).transferOwnership(other.address);
    expect(await stake.pendingOwner()).to.equal(other.address);
    await stake.connect(other).acceptOwnership();
    expect(await stake.owner()).to.equal(other.address);
    // Transfer back
    await stake.connect(other).transferOwnership(owner.address);
    await stake.connect(owner).acceptOwnership();
    expect(await stake.owner()).to.equal(owner.address);
  });
});

// ── Stake-gated publisher registration (PG-1 – PG-7) ────────────────────────
// Tests for DatumPublishers.setStakeGate() and stake-bypass logic in registerPublisher().

describe("DatumPublishers — stake-gated registration", function () {
  let stakeContract: DatumPublisherStake;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let pub1: HardhatEthersSigner;
  let pub2: HardhatEthersSigner;
  let pub3: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const BASE_STAKE   = 1_000_000_000n; // 0.1 DOT
  const GATE         = 5_000_000_000n; // 0.5 DOT — the registration threshold
  const TAKE_RATE    = 5000;

  before(async function () {
    await fundSigners();
    [owner, pub1, pub2, pub3, other] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, pub1.address, pub2.address);

    const StakeFactory = await ethers.getContractFactory("DatumPublisherStake");
    stakeContract = await StakeFactory.deploy(BASE_STAKE, 0n, 10n);

    const PubFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PubFactory.deploy(100n, await pauseReg.getAddress());

    // Enable whitelist mode so stake-gate bypass is meaningful
    await publishers.connect(owner).setWhitelistMode(true);
  });

  // PG-1: setStakeGate stores contract + threshold and emits event
  it("PG-1: setStakeGate stores values and emits StakeGateSet", async function () {
    await expect(
      publishers.connect(owner).setStakeGate(await stakeContract.getAddress(), GATE)
    )
      .to.emit(publishers, "StakeGateSet")
      .withArgs(await stakeContract.getAddress(), GATE);

    expect(await publishers.publisherStake()).to.equal(await stakeContract.getAddress());
    expect(await publishers.stakeGate()).to.equal(GATE);
  });

  // PG-2: publisher without sufficient stake is rejected in whitelist mode
  it("PG-2: publisher with insufficient stake cannot register in whitelist mode", async function () {
    // pub1 has no stake at all
    await expect(
      publishers.connect(pub1).registerPublisher(TAKE_RATE)
    ).to.be.revertedWith("E79");
  });

  // PG-3: publisher with exactly GATE stake can register without whitelist approval
  it("PG-3: publisher meeting stake gate registers without whitelist approval", async function () {
    await stakeContract.connect(pub1).stake({ value: GATE });
    expect(await stakeContract.staked(pub1.address)).to.equal(GATE);

    await publishers.connect(pub1).registerPublisher(TAKE_RATE);
    expect((await publishers.getPublisher(pub1.address)).registered).to.be.true;
  });

  // PG-4: publisher with stake below gate is rejected even if just 1 planck short
  it("PG-4: stake one planck below gate is rejected", async function () {
    await stakeContract.connect(pub2).stake({ value: GATE - 1n });
    await expect(
      publishers.connect(pub2).registerPublisher(TAKE_RATE)
    ).to.be.revertedWith("E79");
  });

  // PG-5: manually approved publisher registers regardless of stake
  it("PG-5: manually approved publisher registers even with zero stake", async function () {
    // pub3 has no stake
    await publishers.connect(owner).setApproved(pub3.address, true);
    await publishers.connect(pub3).registerPublisher(TAKE_RATE);
    expect((await publishers.getPublisher(pub3.address)).registered).to.be.true;
  });

  // PG-6: disabling stake gate (threshold=0) blocks stake bypass
  it("PG-6: stakeGate=0 disables stake-based bypass", async function () {
    await publishers.connect(owner).setStakeGate(await stakeContract.getAddress(), 0n);
    // pub2 still has GATE-1 stake — not approved, gate disabled → rejected
    await expect(
      publishers.connect(pub2).registerPublisher(TAKE_RATE)
    ).to.be.revertedWith("E79");
    // Restore
    await publishers.connect(owner).setStakeGate(await stakeContract.getAddress(), GATE);
  });

  // PG-7: setting stakeContract to zero address disables bypass (even if stakeGate > 0)
  it("PG-7: zero stakeContract address disables bypass", async function () {
    await publishers.connect(owner).setStakeGate(ethers.ZeroAddress, GATE);
    await expect(
      publishers.connect(pub2).registerPublisher(TAKE_RATE)
    ).to.be.revertedWith("E79");
    // Restore
    await publishers.connect(owner).setStakeGate(await stakeContract.getAddress(), GATE);
  });
});
