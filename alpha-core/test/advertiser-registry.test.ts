import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Standalone advertiser-side registry — symmetric counterpart of DatumPublishers
// (relaySigner + profileHash + rotation cooldown). Staged for the next contract
// upgrade; replaces the in-DatumCampaigns advertiser additions to relieve EIP-170.
describe("DatumAdvertiserRegistry", function () {
  let registry: any;
  let pauseReg: any;
  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let signerA: HardhatEthersSigner;

  const HASH = "0x" + "ab".repeat(32);
  const HASH2 = "0x" + "cd".repeat(32);

  beforeEach(async function () {
    [owner, advertiser, other, signerA] = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await Pause.deploy(owner.address, advertiser.address, other.address);
    const Registry = await ethers.getContractFactory("DatumAdvertiserRegistry");
    registry = await Registry.deploy(await pauseReg.getAddress());
  });

  it("constructor rejects zero pause registry", async function () {
    const Registry = await ethers.getContractFactory("DatumAdvertiserRegistry");
    await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "E00");
  });

  it("setAdvertiserProfile stores + emits + reads back; rejects zero hash", async function () {
    await expect(registry.connect(advertiser).setAdvertiserProfile(HASH))
      .to.emit(registry, "AdvertiserProfileSet").withArgs(advertiser.address, HASH);
    expect(await registry.getAdvertiserProfileHash(advertiser.address)).to.equal(HASH);
    await expect(registry.connect(advertiser).setAdvertiserProfile(ethers.ZeroHash))
      .to.be.revertedWithCustomError(registry, "E00");
  });

  it("setAdvertiserRelaySigner sets + reads back, and clears with address(0)", async function () {
    await expect(registry.connect(advertiser).setAdvertiserRelaySigner(signerA.address))
      .to.emit(registry, "AdvertiserRelaySignerSet").withArgs(advertiser.address, signerA.address);
    expect(await registry.getAdvertiserRelaySigner(advertiser.address)).to.equal(signerA.address);
  });

  it("setAdvertiserRelaySigner enforces the anti-sandwich rotation cooldown (E22)", async function () {
    await registry.connect(advertiser).setAdvertiserRelaySigner(signerA.address);
    await expect(registry.connect(advertiser).setAdvertiserRelaySigner(other.address))
      .to.be.revertedWithCustomError(registry, "E22");
  });

  it("setAdvertiserRelaySignerAndProfile sets both atomically", async function () {
    await expect(registry.connect(advertiser).setAdvertiserRelaySignerAndProfile(signerA.address, HASH2))
      .to.emit(registry, "AdvertiserRelaySignerSet").withArgs(advertiser.address, signerA.address)
      .and.to.emit(registry, "AdvertiserProfileSet").withArgs(advertiser.address, HASH2);
    expect(await registry.getAdvertiserRelaySigner(advertiser.address)).to.equal(signerA.address);
    expect(await registry.getAdvertiserProfileHash(advertiser.address)).to.equal(HASH2);
  });

  it("rotations revert when settlement is paused", async function () {
    await pauseReg.connect(owner).pause(); // owner solo-pause engages all categories incl. settlement
    await expect(registry.connect(advertiser).setAdvertiserRelaySigner(signerA.address))
      .to.be.revertedWithCustomError(registry, "Paused");
  });

  // Exercises the DatumUpgradable redeploy-migrate-rewire flow against the registry:
  // freeze v1 → deploy v2 → v2.migrate(v1) copies the enumerable advertiser state.
  describe("upgrade migration (DatumUpgradable)", function () {
    let router: any;
    let governor: HardhatEthersSigner;
    let v2: any;
    const HASH_B = "0x" + "11".repeat(32);

    beforeEach(async function () {
      governor = (await ethers.getSigners())[5];
      const Router = await ethers.getContractFactory("MockOpenGovRouter");
      router = await Router.deploy();
      await router.setGovernor(governor.address);

      // registry (from the outer beforeEach) is v1: wire the router + seed two advertisers.
      await registry.connect(owner).setRouter(await router.getAddress());
      await registry.connect(advertiser).setAdvertiserRelaySignerAndProfile(signerA.address, HASH);
      await registry.connect(other).setAdvertiserProfile(HASH_B);

      const V2 = await ethers.getContractFactory("MockAdvertiserRegistryV2");
      v2 = await V2.deploy(await pauseReg.getAddress());
      await v2.connect(owner).setRouter(await router.getAddress());
    });

    it("freeze(v1) blocks writes but reads still work (so v2 can pull state)", async function () {
      await registry.connect(governor).freeze();
      expect(await registry.frozen()).to.equal(true);
      await expect(registry.connect(advertiser).setAdvertiserProfile(HASH)).to.be.revertedWith("frozen");
      expect(await registry.getAdvertiserRelaySigner(advertiser.address)).to.equal(signerA.address);
    });

    it("v2.migrate(v1) copies the full advertiser set from the frozen predecessor", async function () {
      await registry.connect(governor).freeze();
      await v2.connect(governor).migrate(await registry.getAddress());
      expect(await v2.migrated()).to.equal(true);
      expect(await v2.getAdvertiserRelaySigner(advertiser.address)).to.equal(signerA.address);
      expect(await v2.getAdvertiserProfileHash(advertiser.address)).to.equal(HASH);
      expect(await v2.getAdvertiserProfileHash(other.address)).to.equal(HASH_B);
      expect(await v2.registeredCount()).to.equal(2n);
    });

    it("migrate guards: old-not-frozen, governance-only, lock-once", async function () {
      await expect(v2.connect(governor).migrate(await registry.getAddress())).to.be.revertedWith("old-not-frozen");
      await registry.connect(governor).freeze();
      await expect(v2.connect(other).migrate(await registry.getAddress())).to.be.revertedWith("E19");
      await v2.connect(governor).migrate(await registry.getAddress());
      await expect(v2.connect(governor).migrate(await registry.getAddress())).to.be.revertedWith("already migrated");
    });
  });
});
