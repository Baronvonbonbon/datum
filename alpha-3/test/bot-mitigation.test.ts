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
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
        [campaignId, publisherAddr, userAddr, impressionsPerClaim, baseCpm, 0, ethers.ZeroHash, nonce, prevHash]
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
        zkProof: "0x",
        nullifier: ethers.ZeroHash,
        actionSig: "0x",
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
    await pauseReg.unpause();
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
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
      [campaignId, publisher.address, user.address, impressions, BID_CPM, 0, ethers.ZeroHash, nonce, prevHash]
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
      zkProof: "0x",
      nullifier: ethers.ZeroHash,
      actionSig: "0x",
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
});
