// Phase B integration tests for DatumPeopleChainXcmBridge.
//
// Covers the cases in @plans/fizzy-plotting-lerdorf.md Stage 1/2:
//   1. requestRefresh dispatches XCM, emits events, debits fee
//   2. requestRefresh with insufficient msg.value reverts (E03)
//   3. requestRefreshFromCampaign debits escrow when funded, reverts otherwise
//   4. cooldown enforced (refresh twice in same block reverts E96)
//   5. xcmCallback rejected unless msg.sender == peopleChainSovereign
//   6. xcmCallback writes to cache (isVerified flips)
//   7. lockSovereign is one-way (subsequent setSovereign reverts)
//   8. fundXcmRefreshEscrow / withdrawXcmRefreshEscrow — advertiser-only withdraw
//   9. cache.lockXcmDispatcher is one-way

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPeopleChainXcmBridge,
  DatumPeopleChainIdentity,
  MockXcmPrecompile,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const REFRESH_FEE = 1_000_000_000n;   // matches contract default
const COOLDOWN    = 600n;              // matches contract default

async function mineBlocks(n: bigint) {
  // hardhat_mine is far cheaper than a loop of evm_mine and has explicit semantics.
  await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

describe("DatumPeopleChainXcmBridge", function () {
  let owner: HardhatEthersSigner;
  let sovereign: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let bridge: DatumPeopleChainXcmBridge;
  let cache: DatumPeopleChainIdentity;
  let xcmMock: MockXcmPrecompile;
  let campaignsMock: MockCampaigns;

  beforeEach(async function () {
    [owner, sovereign, advertiser, user, other] = await ethers.getSigners();

    const CacheF = await ethers.getContractFactory("DatumPeopleChainIdentity");
    cache = await CacheF.deploy();

    const XcmF = await ethers.getContractFactory("MockXcmPrecompile");
    xcmMock = await XcmF.deploy();

    const CampaignsF = await ethers.getContractFactory("MockCampaigns");
    campaignsMock = await CampaignsF.deploy();

    const BridgeF = await ethers.getContractFactory("DatumPeopleChainXcmBridge");
    bridge = await BridgeF.deploy(
      await xcmMock.getAddress(),
      await cache.getAddress(),
    );

    // Wire bridge as the cache's xcmDispatcher so submitAttestation accepts it.
    await cache.connect(owner).setXcmDispatcher(await bridge.getAddress());

    // Bridge sovereign defaults unset; tests set it as needed.
    await bridge.connect(owner).setSovereign(sovereign.address);
    await bridge.connect(owner).setCampaignsContract(await campaignsMock.getAddress());
    // Pallet+call indices irrelevant for mock dispatch but must round-trip
    // through the encoder. Set arbitrary stable values.
    await bridge.connect(owner).setPalletCallIndices(50, 0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. requestRefresh dispatches XCM
  // ─────────────────────────────────────────────────────────────────────
  describe("requestRefresh (user-paid)", function () {
    it("dispatches XCM, emits events, records lastRefreshBlock", async () => {
      const tx = bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE });
      await expect(tx)
        .to.emit(bridge, "RefreshDispatched").withArgs(user.address, user.address, REFRESH_FEE)
        .and.to.emit(bridge, "RefreshInFlight").withArgs(user.address);

      expect(await xcmMock.dispatchedCount()).to.equal(1);
      const d = await xcmMock.lastDispatch();
      expect(d.caller).to.equal(await bridge.getAddress());
      expect(d.value).to.equal(REFRESH_FEE);

      // First two bytes of the dispatched payload are VersionedXcm::V5 (0x05) + compact(3)=0x0c.
      expect(d.message.slice(0, 6)).to.equal("0x050c");

      const last = await bridge.lastRefreshBlock(user.address);
      expect(last).to.be.greaterThan(0n);
    });

    it("forwards full msg.value to the precompile (caller can over-pay)", async () => {
      const overpay = REFRESH_FEE * 2n;
      await bridge.connect(user).requestRefresh(user.address, { value: overpay });
      const d = await xcmMock.lastDispatch();
      expect(d.value).to.equal(overpay);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. msg.value too low
  // ─────────────────────────────────────────────────────────────────────
  it("requestRefresh reverts E03 when msg.value < refreshFee", async () => {
    await expect(
      bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE - 1n })
    ).to.be.revertedWith("E03");
  });

  it("requestRefresh reverts E00 for zero address", async () => {
    await expect(
      bridge.connect(user).requestRefresh(ethers.ZeroAddress, { value: REFRESH_FEE })
    ).to.be.revertedWith("E00");
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. campaign escrow path
  // ─────────────────────────────────────────────────────────────────────
  describe("requestRefreshFromCampaign", function () {
    const CID = 42n;

    it("reverts E03 when campaign escrow is empty", async () => {
      await expect(bridge.requestRefreshFromCampaign(CID, user.address))
        .to.be.revertedWith("E03");
    });

    it("debits escrow on success, emits RefreshFromCampaign", async () => {
      await bridge.fundXcmRefreshEscrow(CID, { value: REFRESH_FEE * 3n });
      expect(await bridge.campaignXcmRefreshEscrow(CID)).to.equal(REFRESH_FEE * 3n);

      await expect(bridge.connect(user).requestRefreshFromCampaign(CID, user.address))
        .to.emit(bridge, "RefreshFromCampaign")
        .withArgs(CID, user.address, user.address, REFRESH_FEE);

      expect(await bridge.campaignXcmRefreshEscrow(CID)).to.equal(REFRESH_FEE * 2n);
      const d = await xcmMock.lastDispatch();
      expect(d.value).to.equal(REFRESH_FEE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. cooldown
  // ─────────────────────────────────────────────────────────────────────
  describe("cooldown", function () {
    it("blocks a second refresh inside the cooldown window with E96", async () => {
      await bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE });
      await expect(
        bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE })
      ).to.be.revertedWith("E96");
    });

    it("allows refresh after cooldown elapses", async () => {
      await bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE });
      await mineBlocks(COOLDOWN);
      // Second call should now succeed without error.
      await bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE });
      expect(await xcmMock.dispatchedCount()).to.equal(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5+6. xcmCallback origin check + cache write
  // ─────────────────────────────────────────────────────────────────────
  describe("xcmCallback (return leg)", function () {
    it("rejects non-sovereign callers with E18", async () => {
      await expect(
        bridge.connect(other).xcmCallback(user.address, 1, 100_000)
      ).to.be.revertedWith("E18");
    });

    it("writes a verified attestation when called by sovereign", async () => {
      expect(await cache.isVerified(user.address, 1)).to.equal(false);

      await expect(
        bridge.connect(sovereign).xcmCallback(user.address, 1, 100_000)
      )
        .to.emit(bridge, "RefreshCallback").withArgs(user.address, 1, 100_000)
        .and.to.emit(cache, "IdentityAttested");

      expect(await cache.isVerified(user.address, 1)).to.equal(true);
      expect(await cache.isVerified(user.address, 2)).to.equal(false);
    });

    it("validity == 0 falls back to defaultValidityBlocks", async () => {
      const vb = await bridge.defaultValidityBlocks();
      await bridge.connect(sovereign).xcmCallback(user.address, 2, 0);
      const rec = await cache.getIdentity(user.address);
      expect(rec.level).to.equal(2);
      expect(rec.expiryBlock).to.be.greaterThan(vb - 1n);
    });

    it("level > 2 reverts E11", async () => {
      await expect(
        bridge.connect(sovereign).xcmCallback(user.address, 3, 100_000)
      ).to.be.revertedWith("E11");
    });

    it("reverts sovereign-unset before setSovereign was ever called", async () => {
      // Fresh bridge with no sovereign set.
      const CacheF = await ethers.getContractFactory("DatumPeopleChainIdentity");
      const c2 = await CacheF.deploy();
      const BridgeF = await ethers.getContractFactory("DatumPeopleChainXcmBridge");
      const b2 = await BridgeF.deploy(await xcmMock.getAddress(), await c2.getAddress());
      await expect(
        b2.xcmCallback(user.address, 1, 100_000)
      ).to.be.revertedWith("sovereign-unset");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. lock-once: sovereign
  // ─────────────────────────────────────────────────────────────────────
  describe("lockSovereign", function () {
    it("blocks subsequent setSovereign", async () => {
      await bridge.connect(owner).lockSovereign();
      await expect(
        bridge.connect(owner).setSovereign(other.address)
      ).to.be.revertedWith("sovereign-locked");
    });

    it("reverts E00 if sovereign was never set", async () => {
      const BridgeF = await ethers.getContractFactory("DatumPeopleChainXcmBridge");
      const fresh = await BridgeF.deploy(await xcmMock.getAddress(), await cache.getAddress());
      await expect(fresh.lockSovereign()).to.be.revertedWith("E00");
    });

    it("emits SovereignLocked", async () => {
      await expect(bridge.connect(owner).lockSovereign())
        .to.emit(bridge, "SovereignLocked");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. campaign escrow withdraw — advertiser-only
  // ─────────────────────────────────────────────────────────────────────
  describe("withdrawXcmRefreshEscrow", function () {
    const CID = 123n;

    beforeEach(async () => {
      // MockCampaigns.setCampaign signature: (cid, advertiser, publisher, budget, takeRate, status)
      await campaignsMock.setCampaign(CID, advertiser.address, ethers.ZeroAddress, 0n, 5000, 1);
      await bridge.fundXcmRefreshEscrow(CID, { value: REFRESH_FEE * 5n });
    });

    it("non-advertiser caller reverts E18", async () => {
      await expect(
        bridge.connect(other).withdrawXcmRefreshEscrow(CID, other.address, REFRESH_FEE)
      ).to.be.revertedWith("E18");
    });

    it("advertiser can withdraw up to balance", async () => {
      // Use a fresh recipient so balance comparison isn't muddied by gas
      // costs paid by the advertiser caller.
      const recipient = other;
      const balBefore = await ethers.provider.getBalance(recipient.address);
      await expect(
        bridge.connect(advertiser).withdrawXcmRefreshEscrow(
          CID, recipient.address, REFRESH_FEE * 2n
        )
      ).to.emit(bridge, "XcmRefreshEscrowWithdrawn")
       .withArgs(CID, recipient.address, REFRESH_FEE * 2n);
      expect(await bridge.campaignXcmRefreshEscrow(CID)).to.equal(REFRESH_FEE * 3n);
      expect(await ethers.provider.getBalance(recipient.address) - balBefore)
        .to.equal(REFRESH_FEE * 2n);
    });

    it("over-withdraw reverts E03", async () => {
      await expect(
        bridge.connect(advertiser).withdrawXcmRefreshEscrow(
          CID, advertiser.address, REFRESH_FEE * 100n
        )
      ).to.be.revertedWith("E03");
    });

    it("reverts campaigns-unset on a fresh bridge with no Campaigns wired", async () => {
      const BridgeF = await ethers.getContractFactory("DatumPeopleChainXcmBridge");
      const b2 = await BridgeF.deploy(await xcmMock.getAddress(), await cache.getAddress());
      await expect(
        b2.withdrawXcmRefreshEscrow(CID, advertiser.address, REFRESH_FEE)
      ).to.be.revertedWith("campaigns-unset");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. cache.lockXcmDispatcher one-way
  // ─────────────────────────────────────────────────────────────────────
  describe("cache.lockXcmDispatcher", function () {
    it("blocks subsequent setXcmDispatcher", async () => {
      await cache.connect(owner).lockXcmDispatcher();
      await expect(
        cache.connect(owner).setXcmDispatcher(other.address)
      ).to.be.revertedWith("dispatcher-locked");
    });

    it("reverts E00 if dispatcher was never set", async () => {
      const CacheF = await ethers.getContractFactory("DatumPeopleChainIdentity");
      const fresh = await CacheF.deploy();
      await expect(fresh.lockXcmDispatcher()).to.be.revertedWith("E00");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Owner-only tunables
  // ─────────────────────────────────────────────────────────────────────
  describe("owner-only setters", function () {
    it("setRefreshFee bounded > 0; reflected in requestRefresh", async () => {
      await expect(bridge.connect(owner).setRefreshFee(0)).to.be.revertedWith("E11");
      await bridge.connect(owner).setRefreshFee(REFRESH_FEE * 10n);
      await expect(
        bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE })
      ).to.be.revertedWith("E03");
    });

    it("setRefreshCooldownBlocks bounded [60, 14400]", async () => {
      await expect(bridge.connect(owner).setRefreshCooldownBlocks(59)).to.be.revertedWith("E11");
      await expect(bridge.connect(owner).setRefreshCooldownBlocks(14401)).to.be.revertedWith("E11");
      await bridge.connect(owner).setRefreshCooldownBlocks(1000);
      expect(await bridge.refreshCooldownBlocks()).to.equal(1000);
    });

    it("setPalletCallIndices reflected in encoded XCM", async () => {
      await bridge.connect(owner).setPalletCallIndices(7, 3);
      await bridge.connect(user).requestRefresh(user.address, { value: REFRESH_FEE });
      const d = await xcmMock.lastDispatch();
      // pallet+call live in the inner DoubleEncodedCall, right before the
      // user's 32-byte AccountId. Last 34 bytes of the message = pallet+call+user.
      const tail = "0x" + d.message.slice(-68);  // 34 bytes = 68 hex chars
      expect(tail.slice(0, 6)).to.equal("0x0703");
    });

    it("lockPalletCallIndices blocks subsequent edits", async () => {
      await bridge.connect(owner).lockPalletCallIndices();
      await expect(
        bridge.connect(owner).setPalletCallIndices(1, 1)
      ).to.be.revertedWith("indices-locked");
    });

    it("non-owner setters revert E18", async () => {
      await expect(bridge.connect(other).setRefreshFee(1)).to.be.revertedWith("E18");
      await expect(bridge.connect(other).setSovereign(other.address)).to.be.revertedWith("E18");
      await expect(bridge.connect(other).lockSovereign()).to.be.revertedWith("E18");
    });
  });
});
