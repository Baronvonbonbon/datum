import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumTokenRewardVault, MockCampaigns, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks, fundSigners } from "./helpers/mine";

// G-8 mirror: time-locked recovery address on DatumTokenRewardVault.
// Structural mirror of payment-vault-g8.test.ts adapted for per-token balances.

describe("DatumTokenRewardVault G-8 mirror (recovery address)", function () {
  let vault: DatumTokenRewardVault;
  let mock: MockCampaigns;
  let token: MockERC20;
  let token2: MockERC20;

  let owner: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let coldWallet: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const CAMPAIGN_ID = 1n;
  const DELAY = 14400n;
  const REWARD_A = ethers.parseEther("5");
  const REWARD_B = ethers.parseEther("3");

  beforeEach(async function () {
    await fundSigners();
    [owner, settlement, user, coldWallet, attacker, other] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();
    const VaultFactory = await ethers.getContractFactory("DatumTokenRewardVault");
    vault = await VaultFactory.deploy(await mock.getAddress());
    await vault.setSettlement(settlement.address);
    await vault.setAssetAllowlistEnabled(false); // open mode — these tests predate the asset allowlist

    const ERC20Factory = await ethers.getContractFactory("MockERC20");
    token = await ERC20Factory.deploy("Test", "TST");
    token2 = await ERC20Factory.deploy("Two", "TT2");

    await mock.setCampaign(CAMPAIGN_ID, owner.address, owner.address, 1000n, 5000, 1);

    // Settlement credits the user with two tokens
    await token.mint(await vault.getAddress(), REWARD_A);
    await token2.mint(await vault.getAddress(), REWARD_B);
    await mock.setCampaign(CAMPAIGN_ID, owner.address, owner.address, 1000n, 5000, 1);
    // Pre-fund budgets so creditReward can credit
    await token.mint(owner.address, REWARD_A);
    await token.approve(await vault.getAddress(), REWARD_A);
    await vault.depositCampaignBudget(CAMPAIGN_ID, await token.getAddress(), REWARD_A);
    await token2.mint(owner.address, REWARD_B);
    await token2.approve(await vault.getAddress(), REWARD_B);
    await vault.depositCampaignBudget(CAMPAIGN_ID, await token2.getAddress(), REWARD_B);

    await vault.connect(settlement).creditReward(CAMPAIGN_ID, await token.getAddress(), user.address, REWARD_A);
    await vault.connect(settlement).creditReward(CAMPAIGN_ID, await token2.getAddress(), user.address, REWARD_B);
  });

  // ── setRecoveryAddress ──────────────────────────────────────────────

  it("TG8-1: setRecoveryAddress(0) reverts E00", async function () {
    await expect(vault.connect(user).setRecoveryAddress(ethers.ZeroAddress))
      .to.be.revertedWith("E00");
  });

  it("TG8-2: setRecoveryAddress(self) reverts E11", async function () {
    await expect(vault.connect(user).setRecoveryAddress(user.address))
      .to.be.revertedWith("E11");
  });

  it("TG8-3: setRecoveryAddress stages with delay", async function () {
    const tx = await vault.connect(user).setRecoveryAddress(coldWallet.address);
    const receipt = await tx.wait();
    const expected = BigInt(receipt!.blockNumber) + DELAY;
    await expect(tx).to.emit(vault, "RecoveryAddressStaged")
      .withArgs(user.address, coldWallet.address, expected);
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(expected);
    expect(await vault.recoveryActive(user.address)).to.equal(false);
  });

  it("TG8-4: recoveryActive flips true after delay", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(DELAY);
    expect(await vault.recoveryActive(user.address)).to.equal(true);
  });

  // ── cancelRecoveryAddress ──────────────────────────────────────────

  it("TG8-5: cancel clears pending recovery", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await expect(vault.connect(user).cancelRecoveryAddress())
      .to.emit(vault, "RecoveryAddressCancelled").withArgs(user.address);
    expect(await vault.recoveryAddress(user.address)).to.equal(ethers.ZeroAddress);
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(0n);
  });

  it("TG8-6: cancel with nothing staged reverts E01", async function () {
    await expect(vault.connect(other).cancelRecoveryAddress())
      .to.be.revertedWith("E01");
  });

  // ── emergencyWithdraw ──────────────────────────────────────────────

  it("TG8-7: emergencyWithdraw before delay reverts E70", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await expect(
      vault.connect(other).emergencyWithdraw(user.address, [await token.getAddress()])
    ).to.be.revertedWith("E70");
  });

  it("TG8-8: emergencyWithdraw without recovery reverts E01", async function () {
    await expect(
      vault.connect(other).emergencyWithdraw(user.address, [await token.getAddress()])
    ).to.be.revertedWith("E01");
  });

  it("TG8-9: emergencyWithdraw with empty tokens reverts E11", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(DELAY);
    await expect(
      vault.connect(other).emergencyWithdraw(user.address, [])
    ).to.be.revertedWith("E11");
  });

  it("TG8-10: emergencyWithdraw drains multiple tokens, funds go to recovery, one-shot clear", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(DELAY);

    const aBefore = await token.balanceOf(coldWallet.address);
    const bBefore = await token2.balanceOf(coldWallet.address);

    await expect(
      vault.connect(other).emergencyWithdraw(user.address, [await token.getAddress(), await token2.getAddress()])
    )
      .to.emit(vault, "EmergencyTokenWithdrawn").withArgs(user.address, coldWallet.address, await token.getAddress(), REWARD_A)
      .and.to.emit(vault, "EmergencyTokenWithdrawn").withArgs(user.address, coldWallet.address, await token2.getAddress(), REWARD_B)
      .and.to.emit(vault, "RecoveryAddressCancelled").withArgs(user.address);

    expect(await token.balanceOf(coldWallet.address)).to.equal(aBefore + REWARD_A);
    expect(await token2.balanceOf(coldWallet.address)).to.equal(bBefore + REWARD_B);

    expect(await vault.userTokenBalance(await token.getAddress(), user.address)).to.equal(0n);
    expect(await vault.userTokenBalance(await token2.getAddress(), user.address)).to.equal(0n);

    // One-shot: recovery cleared
    expect(await vault.recoveryAddress(user.address)).to.equal(ethers.ZeroAddress);
    expect(await vault.recoveryEffectiveBlock(user.address)).to.equal(0n);

    // Second call reverts E01
    await expect(
      vault.connect(other).emergencyWithdraw(user.address, [await token.getAddress()])
    ).to.be.revertedWith("E01");
  });

  it("TG8-11: emergencyWithdraw with only zero-balance tokens reverts E03", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(DELAY);
    // user has no balance in some fresh token
    const ERC20Factory = await ethers.getContractFactory("MockERC20");
    const empty = await ERC20Factory.deploy("Empty", "EMP");
    await expect(
      vault.connect(other).emergencyWithdraw(user.address, [await empty.getAddress()])
    ).to.be.revertedWith("E03");
  });

  it("TG8-12: emergencyWithdraw skips address(0) entries without reverting", async function () {
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    await mineBlocks(DELAY);

    await vault.connect(other).emergencyWithdraw(user.address, [
      ethers.ZeroAddress,
      await token.getAddress(),
      ethers.ZeroAddress,
    ]);
    expect(await token.balanceOf(coldWallet.address)).to.equal(REWARD_A);
  });

  // ── setRecoveryDelayBlocks ─────────────────────────────────────────

  it("TG8-13: setRecoveryDelayBlocks below MIN reverts E11", async function () {
    await expect(vault.connect(owner).setRecoveryDelayBlocks(1n))
      .to.be.revertedWith("E11");
  });

  it("TG8-14: setRecoveryDelayBlocks above MAX reverts E11", async function () {
    await expect(vault.connect(owner).setRecoveryDelayBlocks(500_000n))
      .to.be.revertedWith("E11");
  });

  it("TG8-15: setRecoveryDelayBlocks non-owner reverts E18", async function () {
    await expect(vault.connect(other).setRecoveryDelayBlocks(28800n))
      .to.be.revertedWith("E18");
  });

  it("TG8-16: setRecoveryDelayBlocks updates and emits", async function () {
    await expect(vault.connect(owner).setRecoveryDelayBlocks(28800n))
      .to.emit(vault, "RecoveryDelayBlocksSet").withArgs(28800n);
    expect(await vault.recoveryDelayBlocks()).to.equal(28800n);
  });

  // ── anti-attack: attacker re-stage cannot override existing delayed recovery instantly ──

  it("TG8-17: attacker re-staging restarts the delay (cannot beat original window)", async function () {
    // User stages cold wallet
    await vault.connect(user).setRecoveryAddress(coldWallet.address);
    // Attacker (with compromised user key) re-stages attacker as recovery
    await vault.connect(user).setRecoveryAddress(attacker.address);
    // Even after some blocks, attacker still has to wait the full delay
    await mineBlocks(100n);
    await expect(
      vault.connect(attacker).emergencyWithdraw(user.address, [await token.getAddress()])
    ).to.be.revertedWith("E70");
  });

  it("TG8-18: legitimate user can cancel during attacker's pending window", async function () {
    await vault.connect(user).setRecoveryAddress(attacker.address);
    // Within the delay, user notices and cancels
    await vault.connect(user).cancelRecoveryAddress();
    await mineBlocks(DELAY);
    await expect(
      vault.connect(attacker).emergencyWithdraw(user.address, [await token.getAddress()])
    ).to.be.revertedWith("E01");
  });
});
