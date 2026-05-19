import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumTokenRewardVault, MockCampaigns, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// TokenRewardVault tests
//
// TR1-TR3: depositCampaignBudget
// TR4-TR6: creditReward
// TR7-TR9: withdraw (to self)
// TR10-TR12: withdrawTo (to recipient)
// TR13-TR15: reclaimExpiredBudget
// TR16-TR17: access control edge cases

describe("DatumTokenRewardVault", function () {
  let vault: DatumTokenRewardVault;
  let mock: MockCampaigns;
  let token: MockERC20;
  let token2: MockERC20;

  let owner: HardhatEthersSigner;
  let settlementMock: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const CAMPAIGN_ID = 1n;
  const TOKEN_AMOUNT = ethers.parseEther("1000");

  before(async function () {
    await fundSigners();
    [owner, settlementMock, advertiser, user, other] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const VaultFactory = await ethers.getContractFactory("DatumTokenRewardVault");
    vault = await VaultFactory.deploy(await mock.getAddress());

    await vault.setSettlement(settlementMock.address);

    const ERC20Factory = await ethers.getContractFactory("MockERC20");
    token = await ERC20Factory.deploy("Test Token", "TST");
    token2 = await ERC20Factory.deploy("Token Two", "TT2");

    // Set up campaign 1 with advertiser as owner
    await mock.setCampaign(CAMPAIGN_ID, advertiser.address, owner.address, 1000n, 5000, 1); // status=1 (Active)

    // Mint tokens to advertiser and approve vault
    await token.mint(advertiser.address, TOKEN_AMOUNT * 10n);
    await token.connect(advertiser).approve(await vault.getAddress(), TOKEN_AMOUNT * 10n);
    await token2.mint(advertiser.address, TOKEN_AMOUNT * 10n);
    await token2.connect(advertiser).approve(await vault.getAddress(), TOKEN_AMOUNT * 10n);
  });

  // ── TR1-TR3: depositCampaignBudget ─────────────────────────────────────────

  it("TR1: advertiser can deposit token budget for a campaign", async function () {
    await vault.connect(advertiser).depositCampaignBudget(CAMPAIGN_ID, await token.getAddress(), TOKEN_AMOUNT);
    expect(await vault.campaignTokenBudget(await token.getAddress(), CAMPAIGN_ID)).to.equal(TOKEN_AMOUNT);
  });

  it("TR2: depositCampaignBudget reverts for non-advertiser caller", async function () {
    await expect(
      vault.connect(other).depositCampaignBudget(CAMPAIGN_ID, await token.getAddress(), TOKEN_AMOUNT)
    ).to.be.revertedWith("E18");
  });

  it("TR3: depositCampaignBudget reverts with zero address token or zero amount", async function () {
    await expect(
      vault.connect(advertiser).depositCampaignBudget(CAMPAIGN_ID, ethers.ZeroAddress, TOKEN_AMOUNT)
    ).to.be.revertedWith("E00");

    await expect(
      vault.connect(advertiser).depositCampaignBudget(CAMPAIGN_ID, await token.getAddress(), 0n)
    ).to.be.revertedWith("E11");
  });

  // ── TR4-TR6: creditReward ──────────────────────────────────────────────────

  it("TR4: settlement can credit reward to user", async function () {
    const reward = ethers.parseEther("10");
    const budgetBefore = await vault.campaignTokenBudget(await token.getAddress(), CAMPAIGN_ID);

    await vault.connect(settlementMock).creditReward(CAMPAIGN_ID, await token.getAddress(), user.address, reward);

    expect(await vault.userTokenBalance(await token.getAddress(), user.address)).to.equal(reward);
    expect(await vault.campaignTokenBudget(await token.getAddress(), CAMPAIGN_ID)).to.equal(budgetBefore - reward);
  });

  it("TR5: creditReward caps at remaining budget and emits BudgetExhausted", async function () {
    // Deposit small budget on token2 for a new campaign
    const cid = 99n;
    await mock.setCampaign(cid, advertiser.address, owner.address, 1000n, 5000, 1);
    const smallBudget = ethers.parseEther("5");
    await vault.connect(advertiser).depositCampaignBudget(cid, await token2.getAddress(), smallBudget);

    // Credit more than budget
    const largeClaim = ethers.parseEther("100");
    const tx = await vault.connect(settlementMock).creditReward(cid, await token2.getAddress(), user.address, largeClaim);
    await tx.wait();

    // Budget exhausted, user gets capped amount
    expect(await vault.campaignTokenBudget(await token2.getAddress(), cid)).to.equal(0n);
    expect(await vault.userTokenBalance(await token2.getAddress(), user.address)).to.equal(smallBudget);
  });

  it("TR6: creditReward reverts for non-settlement caller", async function () {
    await expect(
      vault.connect(other).creditReward(CAMPAIGN_ID, await token.getAddress(), user.address, 100n)
    ).to.be.revertedWith("E25");
  });

  // ── TR7-TR9: withdraw ──────────────────────────────────────────────────────

  it("TR7: user can withdraw accumulated token balance to self", async function () {
    const balance = await vault.userTokenBalance(await token.getAddress(), user.address);
    expect(balance).to.be.gt(0n);

    const tokenBalBefore = await token.balanceOf(user.address);
    await vault.connect(user).withdraw(await token.getAddress());
    const tokenBalAfter = await token.balanceOf(user.address);

    expect(tokenBalAfter - tokenBalBefore).to.equal(balance);
    expect(await vault.userTokenBalance(await token.getAddress(), user.address)).to.equal(0n);
  });

  it("TR8: withdraw with zero balance reverts E03", async function () {
    // user already withdrew above
    await expect(
      vault.connect(user).withdraw(await token.getAddress())
    ).to.be.revertedWith("E03");
  });

  it("TR9: other user with no balance reverts E03", async function () {
    await expect(
      vault.connect(other).withdraw(await token.getAddress())
    ).to.be.revertedWith("E03");
  });

  // ── TR10-TR12: withdrawTo ──────────────────────────────────────────────────

  it("TR10: withdrawTo sends tokens to specified recipient", async function () {
    // Credit user again
    const reward = ethers.parseEther("20");
    await vault.connect(settlementMock).creditReward(CAMPAIGN_ID, await token.getAddress(), user.address, reward);

    const recipientBalBefore = await token.balanceOf(other.address);
    await vault.connect(user).withdrawTo(await token.getAddress(), other.address);
    const recipientBalAfter = await token.balanceOf(other.address);

    expect(recipientBalAfter - recipientBalBefore).to.equal(reward);
    expect(await vault.userTokenBalance(await token.getAddress(), user.address)).to.equal(0n);
  });

  it("TR11: withdrawTo reverts with zero recipient address", async function () {
    const reward = ethers.parseEther("5");
    await vault.connect(settlementMock).creditReward(CAMPAIGN_ID, await token.getAddress(), user.address, reward);

    await expect(
      vault.connect(user).withdrawTo(await token.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWith("E00");

    // Clean up
    await vault.connect(user).withdraw(await token.getAddress());
  });

  it("TR12: withdrawTo with zero balance reverts E03", async function () {
    await expect(
      vault.connect(other).withdrawTo(await token.getAddress(), user.address)
    ).to.be.revertedWith("E03");
  });

  // ── TR13-TR15: reclaimExpiredBudget ────────────────────────────────────────

  it("TR13: advertiser can reclaim budget from a completed campaign", async function () {
    const cid = 50n;
    await mock.setCampaign(cid, advertiser.address, owner.address, 1000n, 5000, 3); // status=3 (Completed)
    const budget = ethers.parseEther("50");
    await vault.connect(advertiser).depositCampaignBudget(cid, await token.getAddress(), budget);

    const balBefore = await token.balanceOf(advertiser.address);
    await vault.connect(advertiser).reclaimExpiredBudget(cid, await token.getAddress());
    const balAfter = await token.balanceOf(advertiser.address);

    expect(balAfter - balBefore).to.equal(budget);
    expect(await vault.campaignTokenBudget(await token.getAddress(), cid)).to.equal(0n);
  });

  it("TR14: reclaimExpiredBudget reverts if campaign is still active (status < 3)", async function () {
    const cid = 51n;
    await mock.setCampaign(cid, advertiser.address, owner.address, 1000n, 5000, 1); // status=1 (Active)
    const budget = ethers.parseEther("10");
    await vault.connect(advertiser).depositCampaignBudget(cid, await token.getAddress(), budget);

    await expect(
      vault.connect(advertiser).reclaimExpiredBudget(cid, await token.getAddress())
    ).to.be.revertedWith("E22");
  });

  it("TR15: reclaimExpiredBudget reverts for non-advertiser caller", async function () {
    const cid = 52n;
    await mock.setCampaign(cid, advertiser.address, owner.address, 1000n, 5000, 4); // status=4 (Terminated)
    const budget = ethers.parseEther("10");
    await vault.connect(advertiser).depositCampaignBudget(cid, await token.getAddress(), budget);

    await expect(
      vault.connect(other).reclaimExpiredBudget(cid, await token.getAddress())
    ).to.be.revertedWith("E18");
  });

  // ── TR16-TR17: admin / access control ──────────────────────────────────────

  it("TR16: setSettlement requires owner and non-zero address", async function () {
    await expect(
      vault.connect(other).setSettlement(other.address)
    ).to.be.revertedWith("E18");

    await expect(
      vault.setSettlement(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  it("TR17: vault rejects accidental ETH deposits", async function () {
    await expect(
      owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") })
    ).to.be.revertedWith("E03");
  });
});
