// Test the PaymentVault → FeeShare sweep integration.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  AssetHubPrecompileMock,
  DatumMintAuthority,
  DatumWrapper,
  DatumFeeShare,
  DatumPaymentVault,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const ASSET_ID = 31337n;
const DECIMALS = 10n;
const UNIT = 10n ** DECIMALS;
const ETHER = 10n ** 18n;

describe("DatumPaymentVault → DatumFeeShare sweep", function () {

  let precompile: AssetHubPrecompileMock;
  let authority: DatumMintAuthority;
  let wrapper: DatumWrapper;
  let feeShare: DatumFeeShare;
  let paymentVault: DatumPaymentVault;

  let deployer: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let funder: HardhatEthersSigner;

  before(async function () {
    [deployer, settlement, alice, bob, funder] = await ethers.getSigners();

    const PrecompileF = await ethers.getContractFactory("AssetHubPrecompileMock");
    precompile = await PrecompileF.deploy();

    const AuthorityF = await ethers.getContractFactory("DatumMintAuthority");
    authority = await AuthorityF.deploy(await precompile.getAddress(), ASSET_ID);

    await precompile.registerAsset(
      ASSET_ID, await authority.getAddress(),
      "DATUM", "DATUM", Number(DECIMALS),
    );

    const WrapperF = await ethers.getContractFactory("DatumWrapper");
    wrapper = await WrapperF.deploy(
      await authority.getAddress(), await precompile.getAddress(), ASSET_ID,
    );

    await authority.setWrapper(await wrapper.getAddress());
    await authority.setSettlement(settlement.address);

    const VaultF = await ethers.getContractFactory("DatumPaymentVault");
    paymentVault = await VaultF.deploy();

    const FeeShareF = await ethers.getContractFactory("DatumFeeShare");
    feeShare = await FeeShareF.deploy(await wrapper.getAddress());

    await feeShare.setPaymentVault(await paymentVault.getAddress());
    await paymentVault.setFeeShareRecipient(await feeShare.getAddress());

    await paymentVault.setSettlement(settlement.address);
  });

  async function seedWDatum(to: string, amount: bigint) {
    await authority.connect(settlement).mintForSettlement(
      to, amount,
      ethers.ZeroAddress, 0n,
      ethers.ZeroAddress, 0n,
    );
  }

  async function fundPaymentVaultProtocolFee(amount: bigint) {
    // Simulate BudgetLedger → PaymentVault DOT inflow then settlement record.
    await funder.sendTransaction({ to: await paymentVault.getAddress(), value: amount });
    await paymentVault.connect(settlement).creditSettlement(
      ethers.ZeroAddress, 0n,
      ethers.ZeroAddress, 0n,
      amount,
    );
  }

  describe("Setup", function () {
    it("FeeShare knows the PaymentVault address", async function () {
      expect(await feeShare.paymentVault()).to.equal(await paymentVault.getAddress());
    });

    it("PaymentVault knows the FeeShare recipient", async function () {
      expect(await paymentVault.feeShareRecipient()).to.equal(await feeShare.getAddress());
    });
  });

  describe("Sweep flow", function () {
    it("Reverts when there is nothing to sweep", async function () {
      expect(await paymentVault.protocolBalance()).to.equal(0);
      await expect(feeShare.sweep()).to.be.revertedWith("E03");
    });

    it("Stake → fees-arrive-at-vault → sweep → staker accrues", async function () {
      const stakeAmt = 100n * UNIT;
      await seedWDatum(alice.address, stakeAmt);
      await wrapper.connect(alice).approve(await feeShare.getAddress(), stakeAmt);
      await feeShare.connect(alice).stake(stakeAmt);

      const feeAmt = 5n * ETHER;
      await fundPaymentVaultProtocolFee(feeAmt);
      expect(await paymentVault.protocolBalance()).to.equal(feeAmt);

      const aliceBefore = await feeShare.pendingOf(alice.address);
      await feeShare.connect(bob).sweep();

      expect(await paymentVault.protocolBalance()).to.equal(0);

      const alicePending = await feeShare.pendingOf(alice.address);
      expect(alicePending - aliceBefore).to.equal(feeAmt);
    });

    it("Sweep reverts when feeShareRecipient is unset on the vault", async function () {
      await fundPaymentVaultProtocolFee(1n * ETHER);

      await paymentVault.setFeeShareRecipient(ethers.ZeroAddress);
      await expect(feeShare.sweep()).to.be.revertedWith("E00");

      await paymentVault.setFeeShareRecipient(await feeShare.getAddress());
    });

    it("Sweep reverts when FeeShare.paymentVault is unset", async function () {
      // Cypherpunk lock-once on FeeShare.setPaymentVault means the wired vault
      // can never be downgraded to address(0) mid-flight. Instead, deploy a
      // fresh FeeShare that never wires its paymentVault and verify the
      // pre-bootstrap revert path.
      const FreshFeeShareF = await ethers.getContractFactory("DatumFeeShare");
      const freshFeeShare = await FreshFeeShareF.deploy(await wrapper.getAddress());

      await expect(freshFeeShare.sweep()).to.be.revertedWith("E00");
    });

    it("Owner can withdraw protocol via legacy path (fallback)", async function () {
      const balBefore = await paymentVault.protocolBalance();
      expect(balBefore).to.equal(1n * ETHER);

      const treasuryBalBefore = await ethers.provider.getBalance(deployer.address);
      const tx = await paymentVault.withdrawProtocol(deployer.address);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const treasuryBalAfter = await ethers.provider.getBalance(deployer.address);

      expect(treasuryBalAfter - treasuryBalBefore + gasCost).to.equal(1n * ETHER);
      expect(await paymentVault.protocolBalance()).to.equal(0);
    });
  });
});
