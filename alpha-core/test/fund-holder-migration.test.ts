import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// DatumUpgradable redeploy-migrate-rewire for the fund-holding contracts:
// each test stakes/deposits into v1, freezes, migrates accounting into v2,
// sweeps the custodied funds, and verifies v2 is solvent. Native-DOT vaults
// use acceptMigration (their receive() rejects deposits); ERC-20 vaults sweep
// via token.safeTransfer.
describe("Fund-holder upgrade migration (DatumUpgradable)", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, a: HardhatEthersSigner, b: HardhatEthersSigner, c: HardhatEthersSigner;
  let router: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, a, b, c] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
  });

  it("DatumPublisherStake: stake + impressions migrate; v2 solvent (unstake)", async function () {
    const PS = await ethers.getContractFactory("DatumPublisherStake");
    const v1 = await PS.deploy(0, 0, 1); // base=0, perImp=0, delay=1 → requiredStake=0
    await v1.setRouter(await router.getAddress());
    await v1.setSettlementContract(b.address); // EOA stand-in for Settlement
    await v1.connect(a).stake({ value: parseDOT("10") });
    await v1.connect(b).recordImpressions(a.address, 5);

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockPublisherStakeV2")).deploy(0, 0, 1);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.staked(a.address)).to.equal(parseDOT("10"));
    expect(await v2.cumulativeImpressions(a.address)).to.equal(5n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("10"));
    // solvency
    await v2.connect(a).requestUnstake(parseDOT("10"));
    await mine(2);
    await expect(v2.connect(a).unstake()).to.emit(v2, "Unstaked");
  });

  it("DatumAdvertiserStake: stake + budget-spent migrate; v2 solvent", async function () {
    const AS = await ethers.getContractFactory("DatumAdvertiserStake");
    const v1 = await AS.deploy(0, 0, 1);
    await v1.setRouter(await router.getAddress());
    await v1.setSettlementContract(b.address);
    await v1.connect(a).stake({ value: parseDOT("8") });
    await v1.connect(b).recordBudgetSpent(a.address, parseDOT("50")); // 50 DOT spent

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockAdvertiserStakeV2")).deploy(0, 0, 1);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.staked(a.address)).to.equal(parseDOT("8"));
    expect(await v2.cumulativeBudgetSpent(a.address)).to.equal(50n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("8"));
    await v2.connect(a).requestUnstake(parseDOT("8"));
    await mine(2);
    await expect(v2.connect(a).unstake()).to.emit(v2, "Unstaked");
  });

  it("DatumRelayStake: stake migrates with relayList + totalStaked + funds", async function () {
    const RS = await ethers.getContractFactory("DatumRelayStake");
    const v1 = await RS.deploy(parseDOT("1"), 100);
    await v1.setRouter(await router.getAddress());
    await v1.connect(a).stake({ value: parseDOT("6") });

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockRelayStakeV2")).deploy(parseDOT("1"), 100);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    const [amount] = await v2.stakeOf(a.address);
    expect(amount).to.equal(parseDOT("6"));
    expect(await v2.totalStaked()).to.equal(parseDOT("6"));
    expect(await v2.relayListLength()).to.equal(1n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("6"));
  });

  it("DatumZKStake: ERC-20 stake migrates; tokens swept to v2", async function () {
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Datum", "DTM");
    await token.mint(a.address, parseDOT("100"));
    const ZK = await ethers.getContractFactory("DatumZKStake");
    const v1 = await ZK.deploy(await token.getAddress());
    await v1.setRouter(await router.getAddress());
    const commitment = "0x" + "ab".repeat(32);
    await token.connect(a).approve(await v1.getAddress(), parseDOT("40"));
    await v1.connect(a).depositWith(commitment, parseDOT("40"));

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockZKStakeV2")).deploy(await token.getAddress());
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.staked(a.address)).to.equal(parseDOT("40"));
    expect(await v2.userCommitment(a.address)).to.equal(commitment);
    expect(await v2.totalLocked()).to.equal(parseDOT("40"));
    expect(await token.balanceOf(await v2.getAddress())).to.equal(parseDOT("40"));
  });

  it("DatumChallengeBonds: bond + pool + pending-return migrate; v2 solvent", async function () {
    const CB = await ethers.getContractFactory("DatumChallengeBonds");
    const v1 = await CB.deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setCampaignsContract(b.address);   // EOA stand-in for Campaigns
    await v1.setLifecycleContract(c.address);   // EOA stand-in for Lifecycle
    await v1.setGovernanceContract(owner.address);
    // campaign 1: live bond + pool; campaign 2: bond then returned → pending refund to advertiser `a`
    await v1.connect(b).lockBond(1, a.address, gov.address, { value: parseDOT("5") });
    await v1.connect(owner).addToPool(gov.address, { value: parseDOT("3") });
    await v1.connect(b).lockBond(2, a.address, owner.address, { value: parseDOT("2") });
    await v1.connect(c).returnBond(2); // queues pendingBondReturn[a] += 2

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockChallengeBondsV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.bondForPublisher(1, gov.address)).to.equal(parseDOT("5"));
    expect(await v2.bonusPool(gov.address)).to.equal(parseDOT("3"));
    expect(await v2.pendingBondReturn(a.address)).to.equal(parseDOT("2"));
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("10"));
    await expect(v2.connect(a).claimBondReturn()).to.emit(v2, "BondReturnClaimed");
  });

  it("DatumActivationBonds: bond state + funds migrate", async function () {
    const AB = await ethers.getContractFactory("DatumActivationBonds");
    const v1 = await AB.deploy(parseDOT("1"), 100, 1000, 500, owner.address);
    await v1.setRouter(await router.getAddress());
    await v1.setCampaignsContract(b.address);
    await v1.connect(b).openBond(7, a.address, { value: parseDOT("4") });

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockActivationBondsV2"))
      .deploy(parseDOT("1"), 100, 1000, 500, owner.address);
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.creatorOf(7)).to.equal(a.address);
    expect(await v2.creatorBond(7)).to.equal(parseDOT("4"));
    expect(await v2.bondCampaignCount()).to.equal(1n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(parseDOT("4"));
  });

  it("DatumTokenRewardVault: ERC-20 balances + budgets migrate; v2 solvent (withdraw)", async function () {
    const mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();
    await mock.setCampaign(9, a.address, b.address, 1000n, 5000, 1); // advertiser = a
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Reward", "RWD");
    await token.mint(a.address, parseDOT("100"));
    const TRV = await ethers.getContractFactory("DatumTokenRewardVault");
    const v1 = await TRV.deploy(await mock.getAddress());
    await v1.setRouter(await router.getAddress());
    await v1.setSettlement(c.address); // EOA stand-in for Settlement
    await v1.setAssetAllowlistEnabled(false); // open mode — migration test predates the asset allowlist
    await token.connect(a).approve(await v1.getAddress(), parseDOT("30"));
    await v1.connect(a).depositCampaignBudget(9, await token.getAddress(), parseDOT("30"));
    await v1.connect(c).creditReward(9, await token.getAddress(), b.address, parseDOT("12"));

    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockTokenRewardVaultV2")).deploy(await mock.getAddress());
    await v2.setRouter(await router.getAddress());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    expect(await v2.userTokenBalance(await token.getAddress(), b.address)).to.equal(parseDOT("12"));
    expect(await v2.campaignTokenBudget(await token.getAddress(), 9)).to.equal(parseDOT("18"));
    expect(await token.balanceOf(await v2.getAddress())).to.equal(parseDOT("30"));
    // solvency: the credited user withdraws their reward from v2
    await expect(v2.connect(b).withdraw(await token.getAddress())).to.emit(v2, "TokenWithdrawal");
    expect(await token.balanceOf(b.address)).to.equal(parseDOT("12"));
  });
});
