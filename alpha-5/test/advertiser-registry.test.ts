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
});
