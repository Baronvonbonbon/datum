// DatumFeeShare tests.
//
// Covers:
//   - stake / unstake / claim accumulator correctness
//   - Multi-staker pro-rata distribution
//   - Flash-stake protection (same-block stake accrues nothing from prior fees)
//   - Orphan DOT pending (fees arriving with zero stake)
//   - notifyFee via fund() and direct receive()
//   - Pending DOT view function

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumFeeShare,
  AssetHubPrecompileMock,
  DatumWrapper,
  DatumMintAuthority,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const ASSET_ID = 31337n;
const DECIMALS = 10n;
const UNIT = 10n ** DECIMALS;     // 1 DATUM
const ETHER = 10n ** 18n;          // 1 native (DOT-equivalent on Polkadot Hub EVM)

describe("DatumFeeShare — stake WDATUM, earn DOT", function () {

  let precompile: AssetHubPrecompileMock;
  let authority: DatumMintAuthority;
  let wrapper: DatumWrapper;
  let feeShare: DatumFeeShare;

  let deployer: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let funder: HardhatEthersSigner;

  before(async function () {
    [deployer, settlement, alice, bob, carol, funder] = await ethers.getSigners();

    const PrecompileF = await ethers.getContractFactory("AssetHubPrecompileMock");
    precompile = await PrecompileF.deploy();

    const AuthorityF = await ethers.getContractFactory("DatumMintAuthority");
    authority = await AuthorityF.deploy(await precompile.getAddress(), ASSET_ID);

    await precompile.registerAsset(
      ASSET_ID,
      await authority.getAddress(),
      "DATUM", "DATUM", Number(DECIMALS),
    );

    const WrapperF = await ethers.getContractFactory("DatumWrapper");
    wrapper = await WrapperF.deploy(
      await authority.getAddress(),
      await precompile.getAddress(),
      ASSET_ID,
      true,
    );

    await authority.setWrapper(await wrapper.getAddress());
    await authority.setSettlement(settlement.address);

    const FeeShareF = await ethers.getContractFactory("DatumFeeShare");
    feeShare = await FeeShareF.deploy(await wrapper.getAddress());
  });

  async function seedWDatum(to: string, amount: bigint) {
    await authority.connect(settlement).mintForSettlement(
      to, amount,
      ethers.ZeroAddress, 0n,
      ethers.ZeroAddress, 0n,
    );
  }

  describe("Deployment", function () {
    it("references the WDATUM wrapper as stake token", async function () {
      expect(await feeShare.stakeToken()).to.equal(await wrapper.getAddress());
    });

    it("starts with zero stake and zero accumulator", async function () {
      expect(await feeShare.totalStaked()).to.equal(0);
      expect(await feeShare.accDotPerShare()).to.equal(0);
      expect(await feeShare.orphanDotPending()).to.equal(0);
    });
  });

  describe("Single-staker happy path", function () {
    it("stake → fund → claim pays the full amount to a sole staker", async function () {
      const stakeAmt = 100n * UNIT;
      await seedWDatum(alice.address, stakeAmt);
      await wrapper.connect(alice).approve(await feeShare.getAddress(), stakeAmt);
      await feeShare.connect(alice).stake(stakeAmt);

      expect(await feeShare.totalStaked()).to.equal(stakeAmt);
      expect(await feeShare.stakedBy(alice.address)).to.equal(stakeAmt);

      const feeAmt = 5n * ETHER;
      await feeShare.connect(funder).fund({ value: feeAmt });

      expect(await feeShare.pendingOf(alice.address)).to.equal(feeAmt);

      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await feeShare.connect(alice).claim();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      expect(balAfter - balBefore + gasCost).to.equal(feeAmt);
      expect(await feeShare.pendingOf(alice.address)).to.equal(0);
    });

    it("unstake returns WDATUM and pays out any remaining pending", async function () {
      await feeShare.connect(funder).fund({ value: 2n * ETHER });

      const stakedBefore = await feeShare.stakedBy(alice.address);
      const pending = await feeShare.pendingOf(alice.address);
      expect(pending).to.equal(2n * ETHER);

      const wdatumBefore = await wrapper.balanceOf(alice.address);
      const balBefore = await ethers.provider.getBalance(alice.address);

      const tx = await feeShare.connect(alice).unstake(stakedBefore);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const wdatumAfter = await wrapper.balanceOf(alice.address);
      const balAfter = await ethers.provider.getBalance(alice.address);

      expect(wdatumAfter - wdatumBefore).to.equal(stakedBefore);
      expect(balAfter - balBefore + gasCost).to.equal(2n * ETHER);
      expect(await feeShare.stakedBy(alice.address)).to.equal(0);
      expect(await feeShare.totalStaked()).to.equal(0);
    });
  });

  describe("Multi-staker pro-rata", function () {

    it("two stakers split fees proportional to stake", async function () {
      const aliceStake = 100n * UNIT;
      const bobStake = 300n * UNIT;

      await seedWDatum(alice.address, aliceStake);
      await seedWDatum(bob.address, bobStake);
      await wrapper.connect(alice).approve(await feeShare.getAddress(), aliceStake);
      await wrapper.connect(bob).approve(await feeShare.getAddress(), bobStake);

      await feeShare.connect(alice).stake(aliceStake);
      await feeShare.connect(bob).stake(bobStake);

      const feeAmt = 40n * ETHER;
      await feeShare.connect(funder).fund({ value: feeAmt });

      const alicePending = await feeShare.pendingOf(alice.address);
      const bobPending = await feeShare.pendingOf(bob.address);

      expect(alicePending).to.equal(feeAmt / 4n);
      expect(bobPending).to.equal((feeAmt * 3n) / 4n);
      expect(alicePending + bobPending).to.equal(feeAmt);
    });

    it("a staker joining mid-stream does not dilute prior unclaimed rewards", async function () {
      const aliceBefore = await feeShare.pendingOf(alice.address);
      const bobBefore = await feeShare.pendingOf(bob.address);
      expect(aliceBefore).to.equal(10n * ETHER);
      expect(bobBefore).to.equal(30n * ETHER);

      const carolStake = 400n * UNIT;
      await seedWDatum(carol.address, carolStake);
      await wrapper.connect(carol).approve(await feeShare.getAddress(), carolStake);
      await feeShare.connect(carol).stake(carolStake);

      expect(await feeShare.pendingOf(alice.address)).to.equal(aliceBefore);
      expect(await feeShare.pendingOf(bob.address)).to.equal(bobBefore);
      expect(await feeShare.pendingOf(carol.address)).to.equal(0);

      const newFee = 80n * ETHER;
      await feeShare.connect(funder).fund({ value: newFee });

      const aliceAfter = await feeShare.pendingOf(alice.address);
      const bobAfter = await feeShare.pendingOf(bob.address);
      const carolAfter = await feeShare.pendingOf(carol.address);

      expect(aliceAfter - aliceBefore).to.equal(newFee / 8n);
      expect(bobAfter - bobBefore).to.equal((newFee * 3n) / 8n);
      expect(carolAfter).to.equal((newFee * 4n) / 8n);
    });
  });

  describe("Flash-stake protection", function () {
    it("staking after fees arrived earns zero from those fees", async function () {
      const aliceStake = await feeShare.stakedBy(alice.address);
      const bobStake = await feeShare.stakedBy(bob.address);
      const carolStake = await feeShare.stakedBy(carol.address);
      if (aliceStake > 0) await feeShare.connect(alice).unstake(aliceStake);
      if (bobStake > 0) await feeShare.connect(bob).unstake(bobStake);
      if (carolStake > 0) await feeShare.connect(carol).unstake(carolStake);

      const bobNewStake = 100n * UNIT;
      await seedWDatum(bob.address, bobNewStake);
      await wrapper.connect(bob).approve(await feeShare.getAddress(), bobNewStake);
      await feeShare.connect(bob).stake(bobNewStake);

      await feeShare.connect(funder).fund({ value: 10n * ETHER });
      expect(await feeShare.pendingOf(bob.address)).to.equal(10n * ETHER);

      const aliceNewStake = 100n * UNIT;
      await seedWDatum(alice.address, aliceNewStake);
      await wrapper.connect(alice).approve(await feeShare.getAddress(), aliceNewStake);
      await feeShare.connect(alice).stake(aliceNewStake);

      expect(await feeShare.pendingOf(alice.address)).to.equal(0);
      expect(await feeShare.pendingOf(bob.address)).to.equal(10n * ETHER);
    });
  });

  describe("Orphan DOT pending", function () {

    it("fees arriving with zero stake accumulate in orphanDotPending", async function () {
      const aliceStake = await feeShare.stakedBy(alice.address);
      const bobStake = await feeShare.stakedBy(bob.address);
      if (aliceStake > 0) await feeShare.connect(alice).unstake(aliceStake);
      if (bobStake > 0) await feeShare.connect(bob).unstake(bobStake);
      expect(await feeShare.totalStaked()).to.equal(0);

      // Snapshot the accumulator before — it carries running state from prior tests.
      // The assertion is that the orphan-fee fund does NOT advance the accumulator.
      const accBefore = await feeShare.accDotPerShare();
      const orphanBefore = await feeShare.orphanDotPending();

      const orphanFee = 5n * ETHER;
      await feeShare.connect(funder).fund({ value: orphanFee });

      expect(await feeShare.orphanDotPending()).to.equal(orphanBefore + orphanFee);
      expect(await feeShare.accDotPerShare()).to.equal(accBefore);
    });

    it("first stake-then-fee folds orphans into the accumulator", async function () {
      const orphanBefore = await feeShare.orphanDotPending();
      expect(orphanBefore).to.be.greaterThan(0);

      const stake = 50n * UNIT;
      await seedWDatum(alice.address, stake);
      await wrapper.connect(alice).approve(await feeShare.getAddress(), stake);
      await feeShare.connect(alice).stake(stake);

      expect(await feeShare.orphanDotPending()).to.equal(orphanBefore);

      const newFee = 2n * ETHER;
      await feeShare.connect(funder).fund({ value: newFee });

      expect(await feeShare.orphanDotPending()).to.equal(0);
      expect(await feeShare.pendingOf(alice.address)).to.equal(orphanBefore + newFee);
    });
  });

  describe("Direct receive() path", function () {
    it("direct DOT transfer to the contract works like fund()", async function () {
      const aliceBefore = await feeShare.pendingOf(alice.address);
      const amount = 1n * ETHER;
      await funder.sendTransaction({
        to: await feeShare.getAddress(),
        value: amount,
      });
      expect(await feeShare.pendingOf(alice.address)).to.equal(aliceBefore + amount);
    });
  });

  describe("Edge cases", function () {
    it("stake zero amount reverts", async function () {
      await expect(feeShare.connect(alice).stake(0)).to.be.revertedWith("E11");
    });

    it("unstake more than staked reverts", async function () {
      const stake = await feeShare.stakedBy(alice.address);
      await expect(feeShare.connect(alice).unstake(stake + 1n)).to.be.revertedWith("E03");
    });

    it("claim with no pending is a no-op (no revert)", async function () {
      await feeShare.connect(alice).claim();
      expect(await feeShare.pendingOf(alice.address)).to.equal(0);
      await feeShare.connect(alice).claim();
    });

    it("fund with zero value reverts", async function () {
      await expect(feeShare.connect(funder).fund({ value: 0n })).to.be.revertedWith("E11");
    });
  });
});
