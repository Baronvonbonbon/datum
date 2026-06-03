import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Predecessor-chain migration for ClickRegistry's append-only session state:
// the successor consults the frozen predecessor's chained sessionStatus on a
// local miss, so a session recorded pre-upgrade can be claimed (once) post-
// upgrade and cannot be re-recorded.
describe("DatumClickRegistry — predecessor-chain migration", function () {
  let v1: any, v2: any, router: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, relay: HardhatEthersSigner, settle: HardhatEthersSigner, user: HardhatEthersSigner;
  const CID = 5n;
  const NONCE = "0x" + "cc".repeat(32);
  const NONCE2 = "0x" + "dd".repeat(32);

  beforeEach(async function () {
    [owner, gov, relay, settle, user] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);

    v1 = await (await ethers.getContractFactory("DatumClickRegistry")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setRelay(relay.address);
    await v1.setSettlement(settle.address);
    await v1.connect(relay).recordClick(user.address, CID, NONCE); // recorded (status 1) on v1

    v2 = await (await ethers.getContractFactory("MockClickRegistryV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.setRelay(relay.address);
    await v2.setSettlement(settle.address);
  });

  it("a pre-upgrade session is visible, claimable once, and not re-recordable on v2", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());

    // recorded session is visible via the predecessor
    expect(await v2.hasUnclaimed(user.address, CID, NONCE)).to.equal(true);
    // cannot re-record it on v2 (recorded somewhere in the chain)
    await expect(v2.connect(relay).recordClick(user.address, CID, NONCE)).to.be.revertedWith("E90");
    // can claim it once on v2 (claim is written locally)
    await expect(v2.connect(settle).markClaimed(user.address, CID, NONCE)).to.emit(v2, "ClickClaimed");
    expect(await v2.hasUnclaimed(user.address, CID, NONCE)).to.equal(false);
    // double-claim rejected
    await expect(v2.connect(settle).markClaimed(user.address, CID, NONCE)).to.be.revertedWith("E90");
  });

  it("a fresh session still records + claims on v2", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());
    await v2.connect(relay).recordClick(user.address, CID, NONCE2);
    expect(await v2.hasUnclaimed(user.address, CID, NONCE2)).to.equal(true);
    await v2.connect(settle).markClaimed(user.address, CID, NONCE2);
    expect(await v2.hasUnclaimed(user.address, CID, NONCE2)).to.equal(false);
  });
});
