import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Exercises the DatumUpgradable redeploy-migrate-rewire flow against the
// fund-holding DatumPaymentVault: freeze v1 → deploy v2 → v2.migrate(v1) copies
// the balance ACCOUNTING for every enumerated holder → v1.migrateFundsTo(v2)
// sweeps the native DOT so v2 is solvent → users withdraw from v2.
describe("DatumPaymentVault — upgrade migration (DatumUpgradable)", function () {
  let v1: any;
  let v1Addr: string;
  let v2: any;
  let v2Addr: string;
  let router: any;
  let owner: HardhatEthersSigner;
  let settlementMock: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let pub: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let recovery: HardhatEthersSigner;

  const PUB_AMT = parseDOT("30");
  const USER_AMT = parseDOT("20");
  const PROTO_AMT = parseDOT("5");

  beforeEach(async function () {
    await fundSigners();
    [owner, settlementMock, governor, pub, user, recovery] = await ethers.getSigners();

    const Router = await ethers.getContractFactory("MockOpenGovRouter");
    router = await Router.deploy();
    await router.setGovernor(governor.address);

    const Vault = await ethers.getContractFactory("DatumPaymentVault");
    v1 = await Vault.deploy();
    v1Addr = await v1.getAddress();
    await v1.setSettlement(settlementMock.address);
    await v1.setRouter(await router.getAddress());

    // Seed v1: credit balances (settlement) + back them with real DOT, and
    // register a recovery address so recovery state migrates too.
    await v1.connect(settlementMock).creditSettlement(pub.address, PUB_AMT, user.address, USER_AMT, PROTO_AMT);
    await owner.sendTransaction({ to: v1Addr, value: PUB_AMT + USER_AMT + PROTO_AMT });
    await v1.connect(user).setRecoveryAddress(recovery.address);

    const V2 = await ethers.getContractFactory("MockPaymentVaultV2");
    v2 = await V2.deploy();
    v2Addr = await v2.getAddress();
    await v2.setSettlement(settlementMock.address);
    await v2.setRouter(await router.getAddress());
  });

  it("enumerates credited holders (and recovery registrants)", async function () {
    expect(await v1.holderCount()).to.equal(2n); // pub + user
    const seen = new Set([await v1.holderAt(0), await v1.holderAt(1)]);
    expect(seen.has(pub.address)).to.equal(true);
    expect(seen.has(user.address)).to.equal(true);
  });

  it("freeze(v1) blocks credits/withdrawals but reads still work", async function () {
    await v1.connect(governor).freeze();
    expect(await v1.frozen()).to.equal(true);
    await expect(v1.connect(user).withdrawUser()).to.be.revertedWith("frozen");
    await expect(
      v1.connect(settlementMock).creditSettlement(pub.address, 1n, user.address, 1n, 0n),
    ).to.be.revertedWith("frozen");
    // reads remain available so v2 can pull state
    expect(await v1.userBalance(user.address)).to.equal(USER_AMT);
    expect(await v1.protocolBalance()).to.equal(PROTO_AMT);
  });

  it("v2.migrate(v1) copies balance accounting + recovery state", async function () {
    await v1.connect(governor).freeze();
    await v2.connect(governor).migrate(v1Addr);

    expect(await v2.migrated()).to.equal(true);
    expect(await v2.publisherBalance(pub.address)).to.equal(PUB_AMT);
    expect(await v2.userBalance(user.address)).to.equal(USER_AMT);
    expect(await v2.protocolBalance()).to.equal(PROTO_AMT);
    expect(await v2.recoveryAddress(user.address)).to.equal(recovery.address);
    expect(await v2.holderCount()).to.equal(2n);
  });

  it("v1.migrateFundsTo(v2) sweeps the native DOT so v2 is solvent", async function () {
    await v1.connect(governor).freeze();
    await v2.connect(governor).migrate(v1Addr);

    const total = PUB_AMT + USER_AMT + PROTO_AMT;
    expect(await ethers.provider.getBalance(v1Addr)).to.equal(total);

    await expect(v1.connect(governor).migrateFundsTo(v2Addr))
      .to.emit(v1, "FundsMigratedOut").withArgs(v2Addr, total);

    expect(await ethers.provider.getBalance(v1Addr)).to.equal(0n);
    expect(await ethers.provider.getBalance(v2Addr)).to.equal(total);
    expect(await v1.fundsMigratedOut()).to.equal(true);

    // v2 is now solvent: the migrated user can withdraw their migrated balance.
    await expect(v2.connect(user).withdrawUser()).to.emit(v2, "UserWithdrawal").withArgs(user.address, USER_AMT);
    expect(await v2.userBalance(user.address)).to.equal(0n);
  });

  it("migrateFundsTo guards: frozen-only, governance-only, one-shot", async function () {
    // not frozen yet
    await expect(v1.connect(governor).migrateFundsTo(v2Addr)).to.be.revertedWith("not frozen");
    await v1.connect(governor).freeze();
    // governance-only
    await expect(v1.connect(owner).migrateFundsTo(v2Addr)).to.be.revertedWith("E19");
    // zero successor
    await expect(v1.connect(governor).migrateFundsTo(ethers.ZeroAddress)).to.be.revertedWith("E00");
    // happy path + one-shot
    await v1.connect(governor).migrateFundsTo(v2Addr);
    await expect(v1.connect(governor).migrateFundsTo(v2Addr)).to.be.revertedWith("already swept");
  });

  it("migrate guards: old-not-frozen, governance-only, lock-once", async function () {
    await expect(v2.connect(governor).migrate(v1Addr)).to.be.revertedWith("old-not-frozen");
    await v1.connect(governor).freeze();
    await expect(v2.connect(owner).migrate(v1Addr)).to.be.revertedWith("E19");
    await v2.connect(governor).migrate(v1Addr);
    await expect(v2.connect(governor).migrate(v1Addr)).to.be.revertedWith("already migrated");
  });
});
