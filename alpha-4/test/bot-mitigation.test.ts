import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPublishers,
  DatumSettlement,
  DatumPauseRegistry,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumClaimValidator,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
import { fundSigners } from "./helpers/mine";

// BM-7: Publisher SDK version registry
// BM-2: Per-user per-campaign settlement cap

describe("Bot Mitigation (BM-7, BM-2)", function () {
  let publishers: DatumPublishers;
  let settlement: DatumSettlement;
  let pauseReg: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;
  let mock: MockCampaigns;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("100");
  const DAILY_CAP = parseDOT("50");

  let nextCampaignId = 1n;

  function buildClaimChain(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    count: number,
    baseCpm: bigint,
    impressionsPerClaim: bigint
  ) {
    const claims = [];
    let prevHash = ethers.ZeroHash;
    for (let i = 1; i <= count; i++) {
      const nonce = BigInt(i);
      const hash = ethersKeccakAbi(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
        [campaignId, publisherAddr, userAddr, impressionsPerClaim, baseCpm, 0, ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash]
      );
      claims.push({
        campaignId,
        publisher: publisherAddr,
        eventCount: impressionsPerClaim,
        ratePlanck: baseCpm,
        actionType: 0,
        clickSessionHash: ethers.ZeroHash,
        nonce,
        previousClaimHash: prevHash,
        claimHash: hash,
        zkProof: new Array(8).fill(ethers.ZeroHash),
        nullifier: ethers.ZeroHash,
        stakeRootUsed: ethers.ZeroHash,
        actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        powNonce: ethers.ZeroHash,
      });
      prevHash = hash;
    }
    return claims;
  }

  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
    const id = nextCampaignId++;
    await mock.setCampaign(id, owner.address, publisher.address, BID_CPM, TAKE_RATE_BPS, 1);
    await mock.initBudget(id, 0, budget, dailyCap, { value: budget });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher, other] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, user.address, publisher.address);

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
    validator = await ValidatorFactory.deploy(
      await mock.getAddress(),
      await publishers.getAddress(),
      await pauseReg.getAddress()
    );

    const SettleFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettleFactory.deploy(await pauseReg.getAddress());

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      owner.address,
      owner.address
    );
    await settlement.setClaimValidator(await validator.getAddress());
    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(owner.address);
    await vault.setSettlement(await settlement.getAddress());
    await mock.setBudgetLedger(await ledger.getAddress());

    // Register publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // =========================================================================
  // BM-7: SDK Version Registry
  // =========================================================================

  it("BM7-1: publisher can register SDK version hash", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("datum-sdk@1.0.0-minified"));
    await publishers.connect(publisher).registerSdkVersion(hash);
    expect(await publishers.getSdkVersion(publisher.address)).to.equal(hash);
  });

  it("BM7-1b: registerSdkVersion emits SdkVersionRegistered", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("datum-sdk@1.0.1"));
    await expect(publishers.connect(publisher).registerSdkVersion(hash))
      .to.emit(publishers, "SdkVersionRegistered")
      .withArgs(publisher.address, hash);
  });

  it("BM7-2: only registered publisher can register SDK version", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("fake-sdk"));
    await expect(
      publishers.connect(other).registerSdkVersion(hash)
    ).to.be.revertedWith("Not registered");
  });

  it("BM7-3: registerSdkVersion rejects zero hash (E00)", async function () {
    await expect(
      publishers.connect(publisher).registerSdkVersion(ethers.ZeroHash)
    ).to.be.revertedWith("E00");
  });

  it("BM7-4: registerSdkVersion reverts when paused", async function () {
    await pauseReg.pause();
    const hash = ethers.keccak256(ethers.toUtf8Bytes("datum-sdk@1.0.2"));
    await expect(
      publishers.connect(publisher).registerSdkVersion(hash)
    ).to.be.revertedWith("P");
    // C-4: unpause via guardian 2-of-3
    const pid = await pauseReg.connect(user).propose.staticCall(2);
    await pauseReg.connect(user).propose(2);
    await pauseReg.connect(publisher).approve(pid);
  });

  it("BM7-5: getSdkVersion returns zero for unregistered publisher", async function () {
    expect(await publishers.getSdkVersion(other.address)).to.equal(ethers.ZeroHash);
  });

  it("BM7-6: publisher can update SDK version hash", async function () {
    const hash1 = ethers.keccak256(ethers.toUtf8Bytes("v1"));
    const hash2 = ethers.keccak256(ethers.toUtf8Bytes("v2"));
    await publishers.connect(publisher).registerSdkVersion(hash1);
    expect(await publishers.getSdkVersion(publisher.address)).to.equal(hash1);
    await publishers.connect(publisher).registerSdkVersion(hash2);
    expect(await publishers.getSdkVersion(publisher.address)).to.equal(hash2);
  });

  // =========================================================================
  // BM-2: Per-User Settlement Cap
  // =========================================================================

  it("BM2-1: claims within cap settle successfully", async function () {
    const campaignId = await createTestCampaign();
    // 10 claims × 1000 impressions = 10,000 (below 100,000 cap)
    const claims = buildClaimChain(campaignId, publisher.address, user.address, 10, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId, claims };

    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(10n);
    expect(result.rejectedCount).to.equal(0n);

    await settlement.connect(user).settleClaims([batch]);
    expect(await settlement.userCampaignSettled(user.address, campaignId, 0)).to.equal(10000n);
  });

  it("BM2-2: claims exceeding cap are rejected with reason 13", async function () {
    const campaignId = await createTestCampaign();
    // First batch: 9 claims × 10000 impressions = 90,000 (within cap, ≤10 per batch)
    const claims1 = buildClaimChain(campaignId, publisher.address, user.address, 9, BID_CPM, 10000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId, claims: claims1 }]);
    expect(await settlement.userCampaignSettled(user.address, campaignId, 0)).to.equal(90000n);

    // Second batch: nonce 10, 10001 impressions → 90000 + 10001 = 100,001 > cap (100,000)
    let prevHash = await settlement.lastClaimHash(user.address, campaignId, 0);
    const nonce = 10n;
    const impressions = 10001n;
    const hash = ethersKeccakAbi(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
      [campaignId, publisher.address, user.address, impressions, BID_CPM, 0, ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash]
    );
    const overClaim = {
      campaignId,
      publisher: publisher.address,
      eventCount: impressions,
      ratePlanck: BID_CPM,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof: new Array(8).fill(ethers.ZeroHash),
      nullifier: ethers.ZeroHash,
      stakeRootUsed: ethers.ZeroHash,
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        powNonce: ethers.ZeroHash,
    };

    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId, claims: [overClaim] }
    ]);
    expect(result.settledCount).to.equal(0n);
    expect(result.rejectedCount).to.equal(1n);

    // Verify reason code 13
    await expect(
      settlement.connect(user).settleClaims([{ user: user.address, campaignId, claims: [overClaim] }])
    ).to.emit(settlement, "ClaimRejected").withArgs(campaignId, user.address, nonce, 13);
  });

  it("BM2-3: cap is per-user per-campaign (different users independent)", async function () {
    const campaignId = await createTestCampaign();
    // user settles 50,000 (5 claims × 10000, ≤10 per batch)
    const claims1 = buildClaimChain(campaignId, publisher.address, user.address, 5, BID_CPM, 10000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId, claims: claims1 }]);

    // other settles 50,000 — should work (independent cap, ≤10 per batch)
    const claims2 = buildClaimChain(campaignId, publisher.address, other.address, 5, BID_CPM, 10000n);
    const result = await settlement.connect(other).settleClaims.staticCall([
      { user: other.address, campaignId, claims: claims2 }
    ]);
    expect(result.settledCount).to.equal(5n);
  });

  it("BM2-4: MAX_USER_EVENTS is 100,000", async function () {
    expect(await settlement.MAX_USER_EVENTS()).to.equal(100000n);
  });

  // ===========================================================================
  // #5: Per-impression PoW with scaling difficulty
  // ===========================================================================
  describe("PoW gate (#5)", function () {
    /** Search for a powNonce that makes keccak256(claimHash || powNonce) <= target. */
    function findPowNonce(claimHash: string, target: bigint): string {
      for (let i = 0; i < 1 << 24; i++) {
        const nonceHex = ethers.toBeHex(i, 32);
        const h = BigInt(ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [claimHash, nonceHex])));
        if (h <= target) return nonceHex;
      }
      throw new Error("powNonce search exceeded budget — easy band misconfigured");
    }

    it("POW1: enforcePow=false accepts any powNonce (default)", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 100n);
      // powNonce already zero; should pass because enforcePow defaults false.
      const result = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(result.settledCount).to.equal(1n);
    });

    it("POW2: enforcePow=true with zero powNonce typically rejects (reason 27)", async function () {
      // Wire validator → settlement so the PoW view can be queried.
      await validator.setSettlement(await settlement.getAddress());
      await settlement.setEnforcePow(true);

      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 100n);
      // Easy band target = max>>8 / 100 ≈ max / 25600 → ~1/25600 random hash passes.
      // Zero powNonce hash is uniform random; overwhelmingly likely > target.
      // (A non-flaky negative path would require constructing a powNonce that
      //  fails by construction, but with ~1/25600 odds a single tx is fine in
      //  practice. To make it deterministic we attempt 5 times with different
      //  trailing-zero powNonces; if any passes we accept that case.)
      let observedReject = false;
      for (let i = 0; i < 5; i++) {
        const cidI = await createTestCampaign();
        const cl = buildClaimChain(cidI, publisher.address, user.address, 1, BID_CPM, 100n);
        cl[0].powNonce = ethers.toBeHex(0xdeadbeef + i, 32);
        try {
          await settlement.connect(user).settleClaims.staticCall([
            { user: user.address, campaignId: cidI, claims: cl }
          ]);
        } catch { /* would not happen — settleClaims doesn't revert on rejected */ }
        // Use return value: a rejected claim shows up as rejectedCount==1.
        const r = await settlement.connect(user).settleClaims.staticCall([
          { user: user.address, campaignId: cidI, claims: cl }
        ]);
        if (r.rejectedCount === 1n && r.settledCount === 0n) { observedReject = true; break; }
      }
      expect(observedReject).to.equal(true);

      // Clean up state for subsequent tests
      await settlement.setEnforcePow(false);
    });

    it("POW-curve: difficulty target tightens quadratically with usage", async function () {
      await settlement.setEnforcePow(true);
      // Pull target for the same user at different event counts. The user's
      // `userPowEventsThisWindow` was incremented by BM-2 settled events
      // (~thousands), so target should be very small (far harder than fresh).
      const tFresh = BigInt((await settlement.powTargetForUser(other.address, 1n)).toString());
      const tHeavy = BigInt((await settlement.powTargetForUser(user.address, 1n)).toString());
      // Heavy user's target must be much smaller (i.e., harder PoW).
      expect(tFresh).to.be.gt(tHeavy);
      // Per-impression scaling: bigger eventCount → proportionally smaller target.
      const t1 = BigInt((await settlement.powTargetForUser(other.address, 1n)).toString());
      const t100 = BigInt((await settlement.powTargetForUser(other.address, 100n)).toString());
      // Allow ±1 unit of rounding; t100 should be ≈ t1 / 100.
      const ratio = t1 / t100;
      expect(ratio).to.be.gte(99n);
      expect(ratio).to.be.lte(101n);
      await settlement.setEnforcePow(false);
    });

    it("POW-governance: setPowDifficultyCurve rejects invalid params and updates", async function () {
      await expect(settlement.setPowDifficultyCurve(0, 60, 100, 10)).to.be.revertedWith("E11"); // baseShift < 1
      await expect(settlement.setPowDifficultyCurve(33, 60, 100, 10)).to.be.revertedWith("E11"); // baseShift > 32
      await expect(settlement.setPowDifficultyCurve(8, 0, 100, 10)).to.be.revertedWith("E11"); // linDiv = 0
      await expect(settlement.setPowDifficultyCurve(8, 60, 0, 10)).to.be.revertedWith("E11"); // quadDiv = 0
      await expect(settlement.setPowDifficultyCurve(8, 60, 100, 0)).to.be.revertedWith("E11"); // leak = 0
      await settlement.setPowDifficultyCurve(10, 80, 120, 15);
      expect(await settlement.powBaseShift()).to.equal(10);
      expect(await settlement.powLinearDivisor()).to.equal(80n);
      expect(await settlement.powQuadDivisor()).to.equal(120n);
      expect(await settlement.powBucketLeakPerN()).to.equal(15n);
      // Restore defaults
      await settlement.setPowDifficultyCurve(8, 60, 100, 10);
    });

    it("POW-leak: bucket drains over time so difficulty decays to baseline", async function () {
      await settlement.setEnforcePow(true);
      // `user` accumulated bucket from BM-2 tests. Use hardhat_mine to batch
      // many blocks in one RPC call — looping evm_mine is O(blocks) RPC calls.
      const bucketNow = BigInt((await settlement.userPowBucketEffective(user.address)).toString());
      const leakPerN = BigInt((await settlement.powBucketLeakPerN()).toString());
      const blocksToFullyDrain = bucketNow * leakPerN + 1n;
      await ethers.provider.send("hardhat_mine", ["0x" + blocksToFullyDrain.toString(16)]);
      const after = BigInt((await settlement.userPowBucketEffective(user.address)).toString());
      expect(after).to.equal(0n);
      // Target should now equal the baseline target (same as a fresh user).
      const tHeavyDecayed = BigInt((await settlement.powTargetForUser(user.address, 1n)).toString());
      const tFresh = BigInt((await settlement.powTargetForUser(other.address, 1n)).toString());
      expect(tHeavyDecayed).to.equal(tFresh);
      await settlement.setEnforcePow(false);
    });

    it("POW3: enforcePow=true with valid powNonce settles", async function () {
      // Use a fresh signer so we're in the easy band (prior BM-2 tests
      // accumulated `user`'s userPowEventsThisWindow > 600 → shift=24,
      // pushing search cost into millions of hashes). `other` is unused.
      const freshUser = other;
      await settlement.setEnforcePow(true);
      const cid = await createTestCampaign();
      // eventCount=1 keeps the easy-band target manageable: max>>8 → ~256 hashes.
      const claims = buildClaimChain(cid, publisher.address, freshUser.address, 1, BID_CPM, 1n);
      const target = BigInt((await settlement.powTargetForUser(freshUser.address, claims[0].eventCount)).toString());
      claims[0].powNonce = findPowNonce(claims[0].claimHash, target);
      const r = await settlement.connect(freshUser).settleClaims.staticCall([
        { user: freshUser.address, campaignId: cid, claims }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.setEnforcePow(false);
    });
  });
});
