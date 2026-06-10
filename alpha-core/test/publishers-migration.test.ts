import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// DatumUpgradable redeploy-migrate-rewire for the core publisher registry:
// freeze v1 → v2.migrate(v1) copies every registered publisher's record +
// per-publisher advertiser allowlist + registry config.
describe("DatumPublishers — upgrade migration", function () {
  let v1: any, v2: any, router: any, pause: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, pub: HardhatEthersSigner, signer: HardhatEthersSigner, adv: HardhatEthersSigner;
  const HASH = "0x" + "ab".repeat(32);

  beforeEach(async function () {
    [owner, gov, pub, signer, adv] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
    pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, pub.address, adv.address);

    v1 = await (await ethers.getContractFactory("DatumPublishers")).deploy(100, await pause.getAddress());
    await v1.setRouter(await router.getAddress());
    await v1.connect(pub).registerPublisher(6000);
    await v1.connect(pub).setRelaySignerAndProfile(signer.address, HASH);
    await v1.connect(pub).setAllowlistEnabled(true);
    await v1.connect(pub).setAllowedAdvertiser(adv.address, true);

    v2 = await (await ethers.getContractFactory("MockPublishersV2")).deploy(100, await pause.getAddress());
    await v2.setRouter(await router.getAddress());
  });

  it("copies the publisher record + relay profile + advertiser allowlist", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());

    expect(await v2.registeredCount()).to.equal(1n);
    const p = await v2.getPublisher(pub.address);
    expect(p.registered).to.equal(true);
    expect(p.takeRateBps).to.equal(6000);
    expect(await v2.relaySigner(pub.address)).to.equal(signer.address);
    expect(await v2.profileHash(pub.address)).to.equal(HASH);
    expect(await v2.allowlistEnabled(pub.address)).to.equal(true);
    expect(await v2.isAllowedAdvertiser(pub.address, adv.address)).to.equal(true);
    // config copied
    expect(await v2.takeRateUpdateDelayBlocks()).to.equal(100n);
  });

  it("the migrated publisher is fully usable on v2 (no re-registration)", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());
    // a migrated registration blocks a duplicate register on v2
    await expect(v2.connect(pub).registerPublisher(5000)).to.be.revertedWith("Already registered");
    // and the publisher can still update their allowlist on v2
    await v2.connect(pub).setAllowedAdvertiser(adv.address, false);
    expect(await v2.isAllowedAdvertiser(pub.address, adv.address)).to.equal(false);
  });
});
