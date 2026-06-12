import { expect } from "chai";
import { ethers } from "hardhat";
import { fundSigners } from "./helpers/mine";

// Governance-settable on/off switches for DATUM emission + the ERC-20 sidecar.
//
// Authority model: owner OR ParameterGovernance OR DatumCouncil (emergency).
// Enforcement: in the source contracts (MintCoordinator.coordinate /
// TokenRewardVault.creditReward). Behaviour when OFF: stop NEW issuance, never
// revert settlement, leave already-accrued value withdrawable.

describe("Feature switches: DATUM emission + ERC sidecar", function () {
  let owner: any, settlementSigner: any, pg: any, council: any, stranger: any;
  let user: any, publisher: any, advertiser: any;

  before(async function () {
    await fundSigners();
    [owner, settlementSigner, pg, council, stranger, user, publisher, advertiser] =
      await ethers.getSigners();
  });

  // ── DATUM emission (DatumMintCoordinator) ─────────────────────────────────
  describe("DatumMintCoordinator.emissionEnabled", function () {
    let coordinator: any, engine: any;

    beforeEach(async function () {
      coordinator = await (await ethers.getContractFactory("DatumMintCoordinator")).deploy();
      engine = await (await ethers.getContractFactory("DatumEmissionEngine")).deploy();
      await coordinator.setSettlement(settlementSigner.address);
      await engine.setSettlement(await coordinator.getAddress());
      await coordinator.setEmissionEngine(await engine.getAddress());
      // Non-zero authority with bytecode. coordinate() calls the engine first
      // (emits MintComputed) then the authority; the authority call here hits a
      // missing selector and is swallowed by coordinate's try/catch — exactly
      // the path we want, without standing up the full DatumMintAuthority stack.
      await coordinator.setMintAuthority(await engine.getAddress());
    });

    it("defaults to enabled", async function () {
      expect(await coordinator.emissionEnabled()).to.equal(true);
    });

    it("owner can disable + re-enable and it emits", async function () {
      await expect(coordinator.setEmissionEnabled(false))
        .to.emit(coordinator, "EmissionEnabledSet").withArgs(false);
      expect(await coordinator.emissionEnabled()).to.equal(false);
      await coordinator.setEmissionEnabled(true);
      expect(await coordinator.emissionEnabled()).to.equal(true);
    });

    it("ParameterGovernance and Council can toggle; strangers cannot", async function () {
      await coordinator.setParameterGovernance(pg.address);
      await coordinator.setCouncil(council.address);
      await expect(coordinator.connect(pg).setEmissionEnabled(false))
        .to.emit(coordinator, "EmissionEnabledSet");
      await expect(coordinator.connect(council).setEmissionEnabled(true))
        .to.emit(coordinator, "EmissionEnabledSet");
      await expect(coordinator.connect(stranger).setEmissionEnabled(false))
        .to.be.revertedWith("E18");
    });

    it("coordinate mints when enabled (engine is invoked)", async function () {
      await expect(
        coordinator.connect(settlementSigner)
          .coordinate(user.address, publisher.address, advertiser.address, ethers.parseEther("1")),
      ).to.emit(engine, "MintComputed");
    });

    it("coordinate is a clean no-op when disabled (engine not invoked)", async function () {
      await coordinator.setEmissionEnabled(false);
      await expect(
        coordinator.connect(settlementSigner)
          .coordinate(user.address, publisher.address, advertiser.address, ethers.parseEther("1")),
      ).to.not.emit(engine, "MintComputed");
    });
  });

  // ── ERC sidecar (DatumTokenRewardVault) ───────────────────────────────────
  describe("DatumTokenRewardVault sidecar switches", function () {
    let vault: any, mock: any, token: any, token2: any;
    const CID = 1n;
    const AMT = ethers.parseEther("1000");
    const TEN = ethers.parseEther("10");

    beforeEach(async function () {
      mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();
      vault = await (await ethers.getContractFactory("DatumTokenRewardVault")).deploy(await mock.getAddress());
      await vault.setSettlement(settlementSigner.address);
      token = await (await ethers.getContractFactory("MockERC20")).deploy("Test Token", "TST");
      token2 = await (await ethers.getContractFactory("MockERC20")).deploy("Token Two", "TT2");
      await mock.setCampaign(CID, advertiser.address, owner.address, 1000n, 5000, 1); // Active
      for (const t of [token, token2]) {
        await t.mint(advertiser.address, AMT * 10n);
        await t.connect(advertiser).approve(await vault.getAddress(), AMT * 10n);
        await vault.connect(advertiser).depositCampaignBudget(CID, await t.getAddress(), AMT);
      }
    });

    const credit = (t: any) =>
      vault.connect(settlementSigner).creditReward(CID, t.getAddress(), user.address, TEN);
    const bal = async (t: any) => vault.userTokenBalance(await t.getAddress(), user.address);

    it("defaults to enabled and credits", async function () {
      expect(await vault.tokenRewardsEnabled()).to.equal(true);
      await credit(token);
      expect(await bal(token)).to.equal(TEN);
    });

    it("master OFF: creditReward no-ops cleanly, no balance change", async function () {
      await vault.setTokenRewardsEnabled(false);
      await expect(credit(token)).to.emit(vault, "RewardCreditSkipped");
      expect(await bal(token)).to.equal(0n);
    });

    it("per-token block: blocked token skipped, other tokens still credit", async function () {
      await vault.setTokenRewardBlocked(await token.getAddress(), true);
      await expect(credit(token)).to.emit(vault, "RewardCreditSkipped");
      expect(await bal(token)).to.equal(0n);
      await credit(token2);
      expect(await bal(token2)).to.equal(TEN);
    });

    it("accrued balances stay withdrawable after the switch is turned off", async function () {
      await credit(token);
      await vault.setTokenRewardsEnabled(false);
      await expect(vault.connect(user).withdraw(await token.getAddress())).to.not.be.reverted;
      expect(await token.balanceOf(user.address)).to.equal(TEN);
    });

    it("PG + Council can toggle both switches; strangers cannot", async function () {
      await vault.setParameterGovernance(pg.address);
      await vault.setCouncil(council.address);
      await expect(vault.connect(pg).setTokenRewardsEnabled(false))
        .to.emit(vault, "TokenRewardsEnabledSet");
      await expect(vault.connect(council).setTokenRewardsEnabled(true))
        .to.emit(vault, "TokenRewardsEnabledSet");
      await expect(vault.connect(council).setTokenRewardBlocked(await token.getAddress(), true))
        .to.emit(vault, "TokenRewardBlockedSet");
      await expect(vault.connect(stranger).setTokenRewardsEnabled(false)).to.be.revertedWith("E18");
      await expect(vault.connect(stranger).setTokenRewardBlocked(await token.getAddress(), true))
        .to.be.revertedWith("E18");
    });
  });
});
