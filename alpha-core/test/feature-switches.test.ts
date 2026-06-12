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
      await vault.setAssetAllowlistEnabled(false); // these tests exercise the switches, not the allowlist — use open mode
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

  // ── Emission switch on the engine (DatumEmissionEngine) ───────────────────
  // This is the live-deployment home for the emission switch: the WDATUM mint
  // chain is immutably anchored to the original coordinator, so the switch must
  // sit downstream on the engine — OFF => computeAndClipMint returns 0 => the
  // coordinator mints nothing, mint chain untouched.
  describe("DatumEmissionEngine.emissionEnabled", function () {
    let engine: any;
    const DOT = ethers.parseEther("1");

    beforeEach(async function () {
      engine = await (await ethers.getContractFactory("DatumEmissionEngine")).deploy();
      await engine.setSettlement(settlementSigner.address); // caller of computeAndClipMint
    });

    it("defaults to enabled", async function () {
      expect(await engine.emissionEnabled()).to.equal(true);
    });

    it("owner/PG/Council can toggle; strangers cannot", async function () {
      await engine.setParameterGovernance(pg.address);
      await engine.setCouncil(council.address);
      await expect(engine.setEmissionEnabled(false)).to.emit(engine, "EmissionEnabledSet").withArgs(false);
      await expect(engine.connect(pg).setEmissionEnabled(true)).to.emit(engine, "EmissionEnabledSet");
      await expect(engine.connect(council).setEmissionEnabled(false)).to.emit(engine, "EmissionEnabledSet");
      await expect(engine.connect(stranger).setEmissionEnabled(true)).to.be.revertedWith("E18");
    });

    it("computeAndClipMint mints when enabled", async function () {
      const minted = await engine.connect(settlementSigner).computeAndClipMint.staticCall(DOT);
      expect(minted > 0n).to.equal(true);
      await expect(engine.connect(settlementSigner).computeAndClipMint(DOT)).to.emit(engine, "MintComputed");
    });

    it("computeAndClipMint returns 0 and is a no-op when disabled", async function () {
      await engine.setEmissionEnabled(false);
      const minted = await engine.connect(settlementSigner).computeAndClipMint.staticCall(DOT);
      expect(minted).to.equal(0n);
      await expect(engine.connect(settlementSigner).computeAndClipMint(DOT)).to.not.emit(engine, "MintComputed");
    });
  });

  // ── ERC sidecar asset gating: compliant allowlist → fully open ────────────
  describe("DatumTokenRewardVault asset gating", function () {
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
      await mock.setCampaign(CID, advertiser.address, owner.address, 1000n, 5000, 1);
      for (const t of [token, token2]) {
        await t.mint(advertiser.address, AMT * 10n);
        await t.connect(advertiser).approve(await vault.getAddress(), AMT * 10n);
      }
    });

    const deposit = (t: any) => vault.connect(advertiser).depositCampaignBudget(CID, t.getAddress(), AMT);
    const credit = (t: any) => vault.connect(settlementSigner).creditReward(CID, t.getAddress(), user.address, TEN);
    const bal = async (t: any) => vault.userTokenBalance(await t.getAddress(), user.address);

    it("defaults to allowlist mode (compliant start); nothing permitted yet", async function () {
      expect(await vault.assetAllowlistEnabled()).to.equal(true);
      expect(await vault.isAssetPermitted(await token.getAddress())).to.equal(false);
    });

    it("allowlist mode: non-allowlisted deposit reverts", async function () {
      await expect(deposit(token)).to.be.revertedWith("asset-not-allowed");
    });

    it("allowlisted ERC-20: deposit + credit work", async function () {
      await expect(vault.setAssetAllowed(await token.getAddress(), true)).to.emit(vault, "AssetAllowedSet").withArgs(await token.getAddress(), true);
      expect(await vault.isAssetPermitted(await token.getAddress())).to.equal(true);
      await deposit(token);
      await credit(token);
      expect(await bal(token)).to.equal(TEN);
    });

    it("rejects non-ERC-20 addresses on allowlist-add (sanity check)", async function () {
      await expect(vault.setAssetAllowed(await mock.getAddress(), true)).to.be.revertedWith("not-erc20"); // contract w/o decimals/totalSupply
      await expect(vault.setAssetAllowed(stranger.address, true)).to.be.revertedWith("not-erc20");        // EOA
    });

    it("credit skips when a funded token is later de-listed (defense-in-depth)", async function () {
      await vault.setAssetAllowed(await token.getAddress(), true);
      await deposit(token);
      await vault.setAssetAllowed(await token.getAddress(), false);
      await expect(credit(token)).to.emit(vault, "RewardCreditSkipped");
      expect(await bal(token)).to.equal(0n);
    });

    it("open mode: any token works; denylist still blocks", async function () {
      await vault.setAssetAllowlistEnabled(false);
      expect(await vault.isAssetPermitted(await token.getAddress())).to.equal(true);
      await deposit(token);
      await credit(token);
      expect(await bal(token)).to.equal(TEN);
      // denylist wins even in open mode
      await vault.setTokenRewardBlocked(await token2.getAddress(), true);
      await expect(vault.connect(advertiser).depositCampaignBudget(CID, await token2.getAddress(), AMT)).to.be.revertedWith("asset-not-allowed");
    });

    it("denylist wins even when allowlisted", async function () {
      await vault.setAssetAllowed(await token.getAddress(), true);
      await vault.setTokenRewardBlocked(await token.getAddress(), true);
      expect(await vault.isAssetPermitted(await token.getAddress())).to.equal(false);
      await expect(deposit(token)).to.be.revertedWith("asset-not-allowed");
    });

    it("mode + allowlist are governance-only (owner/PG/Council); strangers rejected", async function () {
      await vault.setParameterGovernance(pg.address);
      await vault.setCouncil(council.address);
      await expect(vault.connect(pg).setAssetAllowlistEnabled(false)).to.emit(vault, "AssetAllowlistModeSet");
      await expect(vault.connect(council).setAssetAllowed(await token.getAddress(), true)).to.emit(vault, "AssetAllowedSet");
      await expect(vault.connect(stranger).setAssetAllowlistEnabled(true)).to.be.revertedWith("E18");
      await expect(vault.connect(stranger).setAssetAllowed(await token.getAddress(), true)).to.be.revertedWith("E18");
    });
  });

  // ── Native pallet_assets ERC-20 precompile (no decimals/name/symbol) ──────
  // Polkadot Hub's asset ERC-20 precompiles implement only the core surface
  // (totalSupply/balanceOf/allowance/transfer/approve/transferFrom) — NOT the
  // optional metadata. The gate's _isErc20 must accept them (probing the
  // guaranteed funcs, not decimals()) and the full credit path must work.
  describe("DatumTokenRewardVault native-asset precompile", function () {
    let vault: any, mock: any, native: any, erc20: any, multiAsset: any;
    const CID = 1n;
    const AMT = ethers.parseEther("1000");
    const TEN = ethers.parseEther("10");

    beforeEach(async function () {
      mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();
      vault = await (await ethers.getContractFactory("DatumTokenRewardVault")).deploy(await mock.getAddress());
      await vault.setSettlement(settlementSigner.address);
      native = await (await ethers.getContractFactory("MockNativeAssetPrecompile")).deploy(); // NO decimals()
      erc20 = await (await ethers.getContractFactory("MockERC20")).deploy("Tok", "TOK");        // has decimals()
      multiAsset = await (await ethers.getContractFactory("AssetHubPrecompileMock")).deploy();  // balanceOf(uint256,address)
      await mock.setCampaign(CID, advertiser.address, owner.address, 1000n, 5000, 1);
    });

    it("native precompile has NO decimals() but the gate still accepts it", async function () {
      // sanity: the mock genuinely lacks decimals()
      await expect((native as any).decimals?.() ?? Promise.reject(new Error("no decimals"))).to.be.rejected;
      // the fixed _isErc20 (totalSupply + balanceOf) accepts it
      await expect(vault.setAssetAllowed(await native.getAddress(), true))
        .to.emit(vault, "AssetAllowedSet").withArgs(await native.getAddress(), true);
      expect(await vault.isAssetPermitted(await native.getAddress())).to.equal(true);
    });

    it("still rejects EOAs and the multi-asset (non-ERC-20) precompile shape", async function () {
      await expect(vault.setAssetAllowed(stranger.address, true)).to.be.revertedWith("not-erc20");
      // AssetHubPrecompileMock exposes balanceOf(uint256,address) — not balanceOf(address) — so it fails the probe
      await expect(vault.setAssetAllowed(await multiAsset.getAddress(), true)).to.be.revertedWith("not-erc20");
    });

    it("full credit lifecycle with a native asset: allowlist → deposit → credit → withdraw", async function () {
      await vault.setAssetAllowed(await native.getAddress(), true);
      // seed the advertiser (stands in for Assets-pallet issuance) + approve
      await native.mint(advertiser.address, AMT * 2n);
      await native.connect(advertiser).approve(await vault.getAddress(), AMT * 2n);

      await vault.connect(advertiser).depositCampaignBudget(CID, await native.getAddress(), AMT);
      expect(await vault.campaignTokenBudget(await native.getAddress(), CID)).to.equal(AMT);

      await vault.connect(settlementSigner).creditReward(CID, await native.getAddress(), user.address, TEN);
      expect(await vault.userTokenBalance(await native.getAddress(), user.address)).to.equal(TEN);

      await vault.connect(user).withdraw(await native.getAddress());
      expect(await native.balanceOf(user.address)).to.equal(TEN);
      expect(await vault.userTokenBalance(await native.getAddress(), user.address)).to.equal(0n);
    });

    it("a standard ERC-20 (with decimals) is still accepted too", async function () {
      await expect(vault.setAssetAllowed(await erc20.getAddress(), true)).to.emit(vault, "AssetAllowedSet");
      expect(await vault.isAssetPermitted(await erc20.getAddress())).to.equal(true);
    });
  });
});
