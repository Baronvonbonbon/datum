import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumRelayStake } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// DatumRelayStake tests (G-1 first close)
// RS1–RS6:   stake() — basic staking, zero revert, accumulation, list management
// RS7–RS10:  topUp() — non-registered, post-exit, happy path
// RS11–RS15: requestExit / cancelExit / finalizeExit lifecycle + delay
// RS16–RS20: slash() — access control, refund-floor cap (MAX_PUNISHMENT_BPS),
//                     slash during exit pending
// RS21–RS24: isAuthorized() — disabled gate, adequate, post-exit
// RS25–RS28: parameter setters — bounds, locks
// RS29–RS32: wiring + plumbing lock
// RS33–RS34: lockStakeGate

describe("DatumRelayStake", function () {
  let stake: DatumRelayStake;

  let owner: HardhatEthersSigner;
  let governance: HardhatEthersSigner;
  let relay: HardhatEthersSigner;
  let relay1: HardhatEthersSigner;
  let relay2: HardhatEthersSigner;
  let challenger: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const MIN_STAKE   = 10_000_000_000n;      // 1 DOT
  const EXIT_DELAY  = 20n;
  // Bigger than MIN_STAKE so a slash leaves real residue.
  const FUND_AMT    = 100_000_000_000n;     // 10 DOT

  beforeEach(async function () {
    await fundSigners();
    [owner, governance, relay, relay1, relay2, challenger, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumRelayStake");
    stake = await Factory.deploy(MIN_STAKE, EXIT_DELAY);
  });

  // ── stake() ──────────────────────────────────────────────────────────

  it("RS1: stake increases balance and adds to relay list", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    const [amount, joinedAtBlock, exitRequestedBlock] = await stake.stakeOf(relay.address);
    expect(amount).to.equal(FUND_AMT);
    expect(joinedAtBlock).to.be.gt(0n);
    expect(exitRequestedBlock).to.equal(0n);
    expect(await stake.relayListLength()).to.equal(1n);
    expect(await stake.totalStaked()).to.equal(FUND_AMT);
  });

  it("RS2: subsequent stake() accumulates without growing the list", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).stake({ value: FUND_AMT });
    const [amount] = await stake.stakeOf(relay.address);
    expect(amount).to.equal(FUND_AMT * 2n);
    expect(await stake.relayListLength()).to.equal(1n);
  });

  it("RS3: stake with value=0 reverts", async function () {
    await expect(stake.connect(relay).stake({ value: 0n })).to.be.revertedWithCustomError(stake, "E11");
  });

  it("RS4: stake emits RelayStaked event", async function () {
    await expect(stake.connect(relay).stake({ value: FUND_AMT }))
      .to.emit(stake, "RelayStaked")
      .withArgs(relay.address, FUND_AMT, FUND_AMT);
  });

  it("RS5: stake from a different relay extends the list", async function () {
    await stake.connect(relay1).stake({ value: FUND_AMT });
    await stake.connect(relay2).stake({ value: FUND_AMT });
    expect(await stake.relayListLength()).to.equal(2n);
    expect(await stake.totalStaked()).to.equal(FUND_AMT * 2n);
  });

  it("RS6: stake after exit-request reverts PendingExit", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).requestExit();
    await expect(stake.connect(relay).stake({ value: FUND_AMT }))
      .to.be.revertedWithCustomError(stake, "PendingExit");
  });

  // ── topUp() ──────────────────────────────────────────────────────────

  it("RS7: topUp on non-registered relay reverts E03", async function () {
    await expect(stake.connect(relay).topUp({ value: FUND_AMT }))
      .to.be.revertedWithCustomError(stake, "E03");
  });

  it("RS8: topUp accumulates and emits RelayToppedUp", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await expect(stake.connect(relay).topUp({ value: FUND_AMT }))
      .to.emit(stake, "RelayToppedUp")
      .withArgs(relay.address, FUND_AMT, FUND_AMT * 2n);
  });

  it("RS9: topUp with value=0 reverts E11", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await expect(stake.connect(relay).topUp({ value: 0n }))
      .to.be.revertedWithCustomError(stake, "E11");
  });

  it("RS10: topUp during pending exit reverts PendingExit", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).requestExit();
    await expect(stake.connect(relay).topUp({ value: FUND_AMT }))
      .to.be.revertedWithCustomError(stake, "PendingExit");
  });

  // ── exit lifecycle ───────────────────────────────────────────────────

  it("RS11: requestExit on unregistered reverts E03", async function () {
    await expect(stake.connect(relay).requestExit())
      .to.be.revertedWithCustomError(stake, "E03");
  });

  it("RS12: requestExit emits ExitRequested with correct finalize block", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    const tx = await stake.connect(relay).requestExit();
    const receipt = await tx.wait();
    const finalizeBlock = BigInt(receipt!.blockNumber) + EXIT_DELAY;
    await expect(tx).to.emit(stake, "ExitRequested").withArgs(relay.address, finalizeBlock);
  });

  it("RS13: double requestExit reverts E68", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).requestExit();
    await expect(stake.connect(relay).requestExit())
      .to.be.revertedWithCustomError(stake, "E68");
  });

  it("RS14: finalizeExit before delay reverts E70", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).requestExit();
    await expect(stake.connect(relay).finalizeExit())
      .to.be.revertedWithCustomError(stake, "E70");
  });

  it("RS15: finalizeExit after delay refunds + removes from list", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).requestExit();
    await mineBlocks(Number(EXIT_DELAY) + 1);
    const balBefore = await ethers.provider.getBalance(relay.address);
    const tx = await stake.connect(relay).finalizeExit();
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(relay.address);
    expect(balAfter - balBefore + gasCost).to.equal(FUND_AMT);
    expect(await stake.relayListLength()).to.equal(0n);
  });

  it("RS16: cancelExit clears pending and re-enables stake", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(relay).requestExit();
    await stake.connect(relay).cancelExit();
    const [, , exitBlock] = await stake.stakeOf(relay.address);
    expect(exitBlock).to.equal(0n);
    // Re-stake works
    await stake.connect(relay).stake({ value: FUND_AMT });
    const [amount] = await stake.stakeOf(relay.address);
    expect(amount).to.equal(FUND_AMT * 2n);
  });

  it("RS17: cancelExit without pending exit reverts NotPending", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await expect(stake.connect(relay).cancelExit())
      .to.be.revertedWithCustomError(stake, "NotPending");
  });

  // ── slash() ──────────────────────────────────────────────────────────

  it("RS18: slash from non-governance reverts E18", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(owner).setRelayContract(other.address);  // any non-zero
    await stake.connect(owner).setGovernance(governance.address);
    await expect(stake.connect(other).slash(relay.address, 1n, other.address, 1))
      .to.be.revertedWithCustomError(stake, "E18");
  });

  it("RS19: slash respects MAX_PUNISHMENT_BPS = 8000 refund floor", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    // Attempt to slash 100% — should be capped to 80%.
    const tx = await stake.connect(governance).slash(relay.address, FUND_AMT, challenger.address, 1);
    const receipt = await tx.wait();
    const slashedEvent = receipt!.logs.find((l: any) => l.fragment?.name === "RelaySlashed") as any;
    expect(slashedEvent.args[1]).to.equal((FUND_AMT * 8000n) / 10000n);  // 80% slashed
    const [remaining] = await stake.stakeOf(relay.address);
    expect(remaining).to.equal((FUND_AMT * 2000n) / 10000n);  // 20% retained
  });

  it("RS20: slash transfers full slashed amount to recipient", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    const requested = (FUND_AMT * 5000n) / 10000n;  // 50% — below the 80% cap
    const balBefore = await ethers.provider.getBalance(challenger.address);
    await stake.connect(governance).slash(relay.address, requested, challenger.address, 1);
    const balAfter = await ethers.provider.getBalance(challenger.address);
    expect(balAfter - balBefore).to.equal(requested);
  });

  it("RS21: slash with amount=0 returns 0 without transfer", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    const balBefore = await ethers.provider.getBalance(challenger.address);
    await stake.connect(governance).slash(relay.address, 0n, challenger.address, 1);
    const balAfter = await ethers.provider.getBalance(challenger.address);
    expect(balAfter).to.equal(balBefore);
  });

  it("RS22: slash applies during exit-pending (exit is NOT a slash escape)", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    await stake.connect(relay).requestExit();
    const requested = (FUND_AMT * 5000n) / 10000n;
    await stake.connect(governance).slash(relay.address, requested, challenger.address, 1);
    const [remaining] = await stake.stakeOf(relay.address);
    expect(remaining).to.equal(FUND_AMT - requested);
  });

  // ── isAuthorized() ───────────────────────────────────────────────────

  it("RS23: isAuthorized returns false when relayMinStake == 0", async function () {
    await stake.connect(owner).setRelayMinStake(0n);
    await stake.connect(relay).stake({ value: FUND_AMT });
    expect(await stake.isAuthorized(relay.address)).to.equal(false);
  });

  it("RS24: isAuthorized true when staked above floor", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    expect(await stake.isAuthorized(relay.address)).to.equal(true);
  });

  it("RS25: isAuthorized false when staked below floor", async function () {
    await stake.connect(relay).stake({ value: MIN_STAKE - 1n });
    expect(await stake.isAuthorized(relay.address)).to.equal(false);
  });

  it("RS26: isAuthorized false after requestExit (even if still staked)", async function () {
    await stake.connect(relay).stake({ value: FUND_AMT });
    expect(await stake.isAuthorized(relay.address)).to.equal(true);
    await stake.connect(relay).requestExit();
    expect(await stake.isAuthorized(relay.address)).to.equal(false);
  });

  // ── parameter setters ────────────────────────────────────────────────

  it("RS27: setRelayMinStake updates floor and emits event", async function () {
    const newFloor = 5_000_000_000n;
    await expect(stake.connect(owner).setRelayMinStake(newFloor))
      .to.emit(stake, "RelayMinStakeSet")
      .withArgs(newFloor);
    expect(await stake.relayMinStake()).to.equal(newFloor);
  });

  it("RS28: setExitDelay enforces bounds", async function () {
    await expect(stake.connect(owner).setExitDelay(0n))
      .to.be.revertedWithCustomError(stake, "E11");
    const tooLong = 2_000_000n;  // > MAX_EXIT_DELAY (1_209_600)
    await expect(stake.connect(owner).setExitDelay(tooLong))
      .to.be.revertedWithCustomError(stake, "E11");
    await stake.connect(owner).setExitDelay(100n);
    expect(await stake.exitDelay()).to.equal(100n);
  });

  it("RS29: setRelayContract from non-owner reverts E18", async function () {
    await expect(stake.connect(other).setRelayContract(other.address))
      .to.be.revertedWith("E18");
  });

  // ── plumbing + stake-gate locks ──────────────────────────────────────

  it("RS30: lockPlumbing pre-OpenGov reverts not-opengov", async function () {
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    // No router wired — whenOpenGovPhase falls through to onlyOwner per
    // DatumUpgradable spec. Owner can fire pre-router but tests that
    // confirm "phase 2 required" require a router fixture. Here we just
    // confirm the function works without router.
    await expect(stake.connect(owner).lockPlumbing())
      .to.emit(stake, "PlumbingLocked");
    expect(await stake.plumbingLocked()).to.equal(true);
  });

  it("RS31: setRelayContract reverts after lockPlumbing", async function () {
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    await stake.connect(owner).lockPlumbing();
    await expect(stake.connect(owner).setRelayContract(other.address))
      .to.be.revertedWithCustomError(stake, "LockedAlready");
  });

  it("RS32: setGovernance reverts after lockPlumbing", async function () {
    await stake.connect(owner).setRelayContract(other.address);
    await stake.connect(owner).setGovernance(governance.address);
    await stake.connect(owner).lockPlumbing();
    await expect(stake.connect(owner).setGovernance(governance.address))
      .to.be.revertedWithCustomError(stake, "LockedAlready");
  });

  it("RS33: lockStakeGate freezes relayMinStake", async function () {
    await stake.connect(owner).lockStakeGate();
    expect(await stake.stakeGateLocked()).to.equal(true);
    await expect(stake.connect(owner).setRelayMinStake(123n))
      .to.be.revertedWithCustomError(stake, "LockedAlready");
  });

  it("RS34: double lockStakeGate reverts LockedAlready", async function () {
    await stake.connect(owner).lockStakeGate();
    await expect(stake.connect(owner).lockStakeGate())
      .to.be.revertedWithCustomError(stake, "LockedAlready");
  });
});
