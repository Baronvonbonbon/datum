import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPaymentVault } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// G-8 first close: time-locked recovery address on DatumPaymentVault.
//
// G8-1..6:   setRecoveryAddress — validation, staging, delay, overwrite
// G8-7..10:  cancelRecoveryAddress — clear pending, clear active
// G8-11..18: emergencyWithdraw — happy path, delay enforcement, recipient,
//                                one-shot clear, both balance slots
// G8-19..22: setRecoveryDelayBlocks — bounds, owner-only, event
// G8-23..25: anti-attack scenarios — attacker re-registration delayed,
//                                    user can cancel during attacker's
//                                    delay window

describe("DatumPaymentVault G-8 first close (recovery address)", function () {
  let vault: DatumPaymentVault;

  let owner: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let coldWallet: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const DELAY = 14400n; // default
  const USER_CREDIT = 5_000_000_000n;  // 0.5 DOT
  const PUB_CREDIT  = 3_000_000_000n;  // 0.3 DOT

  beforeEach(async function () {
    await fundSigners();
    [owner, settlement, user, coldWallet, attacker, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await Factory.deploy();

    await vault.connect(owner).setSettlement(settlement.address);

    // Credit the user via settlement
    await settlement.sendTransaction({ to: vault.target, value: USER_CREDIT + PUB_CREDIT });
    await vault.connect(settlement).creditSettlement(
      user.address, PUB_CREDIT,    // publisher = same user (for the test)
      user.address, USER_CREDIT,
      0n
    );
  });

  // ── setRecoveryAddress ──────────────────────────────────────────────

  it("G8-1: setRecoveryAddress with zero address reverts E00", async function () {
    await expect(vault.connect(user).setRecoveryAddress(ethers.ZeroAddress))
      .to.be.revertedWith("E00");
  });

  it("G8-2: setRecoveryAddress with self reverts E11", async function () {
    await expect(vault.connect(user).setRecoveryAddress(user.address))
      .to.be.revertedWith("E11");
  });

  it("G8-3: setRecoveryAddress emits RecoveryAddressStaged", async function () {
    const tx = await vault.connect(user).setRecoveryAddress(coldWallet.address);
    const receipt = await tx.wait();
    const expectedEffective = BigInt(receipt!.blockNumber) + DELAY;
    await expect(tx).to.emit(vault, "RecoveryAddressStaged")
      .withArgs(user.address, coldWallet.address, expectedEffective);
  });

  it("G8-4: setRecoveryAddress sets recoveryEffectiveBlock = block + delay", async function () {
    const tx = await vault.connect(user).setRecoveryAddress(coldWallet.address);
    const receipt = await tx.wait();
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(BigInt(receipt!.blockNumber) + DELAY);
  });

  it("G8-5: recoveryActive returns false before delay", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    expect(await vault.recoveryActive(user.address)).to.equal(false);
  });

  it("G8-6: setRecoveryAddress overwrites prior staging and restarts delay", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(100);
    // Overwrite with a different address — delay restarts
    const tx = await vault.connect(user).setRecoveryAddress(other.address);
    const receipt = await tx.wait();
    expect(await vault.recoveryAddress(user.address)).to.equal(other.address);
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(BigInt(receipt!.blockNumber) + DELAY);
  });

  // ── cancelRecoveryAddress ───────────────────────────────────────────

  it("G8-7: cancelRecoveryAddress without registration reverts E01", async function () {
    await expect(vault.connect(user).cancelRecoveryAddress())
      .to.be.revertedWith("E01");
  });

  it("G8-8: cancelRecoveryAddress clears pending recovery", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await vault.connect(user).cancelRecoveryAddress();
    expect(await vault.recoveryAddress(user.address)).to.equal(ethers.ZeroAddress);
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(0n);
  });

  it("G8-9: cancelRecoveryAddress clears active recovery (post-delay)", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    await vault.connect(user).cancelRecoveryAddress();
    expect(await vault.recoveryActive(user.address)).to.equal(false);
  });

  it("G8-10: cancelRecoveryAddress emits RecoveryAddressCancelled", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await expect(vault.connect(user).cancelRecoveryAddress())
      .to.emit(vault, "RecoveryAddressCancelled")
      .withArgs(user.address);
  });

  // ── emergencyWithdraw ───────────────────────────────────────────────

  it("G8-11: emergencyWithdraw before delay reverts E70", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await expect(vault.connect(coldWallet).emergencyWithdraw(user.address))
      .to.be.revertedWith("E70");
  });

  it("G8-12: emergencyWithdraw without registration reverts E01", async function () {
    await expect(vault.connect(other).emergencyWithdraw(user.address))
      .to.be.revertedWith("E01");
  });

  it("G8-13: emergencyWithdraw after delay sends both balances to recovery", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    const balBefore = await ethers.provider.getBalance(coldWallet.address);
    const tx = await vault.connect(other).emergencyWithdraw(user.address);
    await tx.wait();
    const balAfter = await ethers.provider.getBalance(coldWallet.address);
    expect(balAfter - balBefore).to.equal(USER_CREDIT + PUB_CREDIT);
  });

  it("G8-14: emergencyWithdraw clears both balance slots", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    await vault.connect(other).emergencyWithdraw(user.address);
    expect(await vault.userBalance(user.address)).to.equal(0n);
    expect(await vault.publisherBalance(user.address)).to.equal(0n);
  });

  it("G8-15: emergencyWithdraw is callable by anyone (recovery still receives)", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    const balBefore = await ethers.provider.getBalance(coldWallet.address);
    // Called by `other` — funds still go to coldWallet
    await vault.connect(other).emergencyWithdraw(user.address);
    const balAfter = await ethers.provider.getBalance(coldWallet.address);
    expect(balAfter - balBefore).to.equal(USER_CREDIT + PUB_CREDIT);
  });

  it("G8-16: emergencyWithdraw with zero balance reverts E03", async function () {
    // New user with no balance
    const [, , , , , , freshUser] = await ethers.getSigners();
    await vault.connect(freshUser).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    await expect(vault.connect(other).emergencyWithdraw(freshUser.address))
      .to.be.revertedWith("E03");
  });

  it("G8-17: emergencyWithdraw is one-shot — clears recovery after use", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    await vault.connect(other).emergencyWithdraw(user.address);
    expect(await vault.recoveryAddress(user.address)).to.equal(ethers.ZeroAddress);
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(0n);
  });

  it("G8-18: emergencyWithdraw emits EmergencyWithdrawn + UserWithdrawal + PublisherWithdrawal", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(Number(DELAY) + 1);
    const tx = vault.connect(other).emergencyWithdraw(user.address);
    await expect(tx)
      .to.emit(vault, "EmergencyWithdrawn")
      .withArgs(user.address, coldWallet.address, USER_CREDIT, PUB_CREDIT)
      .and.to.emit(vault, "UserWithdrawal")
      .and.to.emit(vault, "PublisherWithdrawal");
  });

  // ── setRecoveryDelayBlocks ─────────────────────────────────────────

  it("G8-19: setRecoveryDelayBlocks below MIN reverts E11", async function () {
    await expect(vault.connect(owner).setRecoveryDelayBlocks(100))
      .to.be.revertedWith("E11");
  });

  it("G8-20: setRecoveryDelayBlocks above MAX reverts E11", async function () {
    const tooHigh = 500_000n;
    await expect(vault.connect(owner).setRecoveryDelayBlocks(tooHigh))
      .to.be.revertedWith("E11");
  });

  it("G8-21: setRecoveryDelayBlocks emits event", async function () {
    const newDelay = 50_000n;
    await expect(vault.connect(owner).setRecoveryDelayBlocks(newDelay))
      .to.emit(vault, "RecoveryDelayBlocksSet")
      .withArgs(newDelay);
    expect(await vault.recoveryDelayBlocks()).to.equal(newDelay);
  });

  it("G8-22: setRecoveryDelayBlocks from non-owner reverts", async function () {
    await expect(vault.connect(other).setRecoveryDelayBlocks(50_000n))
      .to.be.revertedWith("E18");
  });

  // ── anti-attack scenarios ──────────────────────────────────────────

  it("G8-23: attacker re-registration cannot bypass delay", async function () {
    // 1. Legitimate user registers cold wallet as recovery
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(50);

    // 2. Attacker steals hot key, tries to redirect recovery to attacker addr
    await vault.connect(user).setRecoveryAddress(attacker.address);

    // 3. Attacker tries emergencyWithdraw immediately — fails
    await expect(vault.connect(attacker).emergencyWithdraw(user.address))
      .to.be.revertedWith("E70");
  });

  it("G8-24: legitimate user can cancel during attacker's delay window", async function () {
    // 1. Legitimate setup
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    // 2. Attacker overwrites
    await vault.connect(user).setRecoveryAddress(attacker.address);
    // 3. Legitimate user detects compromise and cancels (assumes they still have hot key)
    await vault.connect(user).cancelRecoveryAddress();
    expect(await vault.recoveryAddress(user.address)).to.equal(ethers.ZeroAddress);
    // 4. After delay, attacker can't withdraw — recovery is cancelled.
    await mineBlocks(Number(DELAY) + 1);
    await expect(vault.connect(attacker).emergencyWithdraw(user.address))
      .to.be.revertedWith("E01");
  });

  it("G8-25: recoveryActive view tracks state correctly", async function () {
    expect(await vault.recoveryActive(user.address)).to.equal(false);
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    expect(await vault.recoveryActive(user.address)).to.equal(false); // still staging
    // After exactly DELAY blocks, we're at effectiveBlock — active (>=)
    await mineBlocks(Number(DELAY));
    expect(await vault.recoveryActive(user.address)).to.equal(true);
    await mineBlocks(10);
    expect(await vault.recoveryActive(user.address)).to.equal(true);
  });
});
