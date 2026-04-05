import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumSettlementRateLimiter,
  DatumSettlement,
  DatumClaimValidator,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumPauseRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";

// DatumSettlementRateLimiter tests (BM-5)
// RL1–RL4:  checkAndIncrement basic path, cap enforcement, window reset
// RL5–RL7:  setLimits admin, zero-value guard, transferOwnership
// RL8–RL10: currentWindowUsage view, independent per-publisher windows
// RL11–RL13: Settlement integration — rate-limited claim rejected with code 14

describe("DatumSettlementRateLimiter", function () {
  let limiter: DatumSettlementRateLimiter;

  let owner: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const WINDOW_BLOCKS = 10n;
  const MAX_PER_WINDOW = 1000n;

  before(async function () {
    await fundSigners();
    [owner, publisher, publisher2, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumSettlementRateLimiter");
    limiter = await Factory.deploy(WINDOW_BLOCKS, MAX_PER_WINDOW);
  });

  // RL1: checkAndIncrement within limit returns true
  it("RL1: checkAndIncrement within limit returns true and records impressions", async function () {
    const result = await limiter.checkAndIncrement.staticCall(publisher.address, 500n);
    expect(result).to.equal(true);
    // Actually apply
    await limiter.checkAndIncrement(publisher.address, 500n);
    const [, impressions] = await limiter.currentWindowUsage(publisher.address);
    expect(impressions).to.equal(500n);
  });

  // RL2: second call within same window accumulates
  it("RL2: second call within same window accumulates correctly", async function () {
    await limiter.checkAndIncrement(publisher.address, 400n);
    const [, impressions] = await limiter.currentWindowUsage(publisher.address);
    expect(impressions).to.equal(900n); // 500 + 400
  });

  // RL3: exceeding cap returns false and does not record
  it("RL3: exceeding cap returns false and impressions not recorded", async function () {
    // 900 used, 101 would exceed 1000
    const result = await limiter.checkAndIncrement.staticCall(publisher.address, 101n);
    expect(result).to.equal(false);
    // Impressions unchanged
    const [, impressions] = await limiter.currentWindowUsage(publisher.address);
    expect(impressions).to.equal(900n);
  });

  // RL4: exactly at cap is allowed
  it("RL4: exactly at cap (900 + 100 = 1000) is allowed", async function () {
    const result = await limiter.checkAndIncrement.staticCall(publisher.address, 100n);
    expect(result).to.equal(true);
    await limiter.checkAndIncrement(publisher.address, 100n);
    const [, impressions] = await limiter.currentWindowUsage(publisher.address);
    expect(impressions).to.equal(1000n);
  });

  // RL5: window reset — after WINDOW_BLOCKS blocks, usage resets
  it("RL5: usage resets after window elapses", async function () {
    const [windowIdBefore] = await limiter.currentWindowUsage(publisher.address);
    // Mine enough blocks to move to next window
    await mineBlocks(Number(WINDOW_BLOCKS) + 1);
    const [windowIdAfter, impressionsAfter] = await limiter.currentWindowUsage(publisher.address);
    expect(windowIdAfter).to.be.gt(windowIdBefore);
    expect(impressionsAfter).to.equal(0n);
    // Should accept impressions again
    const result = await limiter.checkAndIncrement.staticCall(publisher.address, 1000n);
    expect(result).to.equal(true);
  });

  // RL6: setLimits updates parameters (owner only)
  it("RL6: setLimits updates windowBlocks and maxPerWindow", async function () {
    await expect(limiter.connect(owner).setLimits(20n, 2000n))
      .to.emit(limiter, "LimitsUpdated")
      .withArgs(20n, 2000n);
    expect(await limiter.windowBlocks()).to.equal(20n);
    expect(await limiter.maxPublisherImpressionsPerWindow()).to.equal(2000n);
    // Restore
    await limiter.connect(owner).setLimits(WINDOW_BLOCKS, MAX_PER_WINDOW);
  });

  // RL7: setLimits with zero values reverts E11
  it("RL7: setLimits with windowBlocks=0 reverts E11", async function () {
    await expect(limiter.connect(owner).setLimits(0n, 1000n)).to.be.revertedWith("E11");
  });

  it("RL7b: setLimits with maxPerWindow=0 reverts E11", async function () {
    await expect(limiter.connect(owner).setLimits(10n, 0n)).to.be.revertedWith("E11");
  });

  // RL8: setLimits reverts for non-owner
  it("RL8: setLimits from non-owner reverts E18", async function () {
    await expect(limiter.connect(other).setLimits(5n, 500n)).to.be.revertedWith("E18");
  });

  // RL9: currentWindowUsage returns correct windowId and limit
  it("RL9: currentWindowUsage returns limit field correctly", async function () {
    const [, , limitVal] = await limiter.currentWindowUsage(publisher.address);
    expect(limitVal).to.equal(MAX_PER_WINDOW);
  });

  // RL10: publishers are tracked independently
  it("RL10: publisher1 and publisher2 have independent window counts", async function () {
    // Mine to fresh window
    await mineBlocks(Number(WINDOW_BLOCKS) + 1);
    await limiter.checkAndIncrement(publisher.address, 800n);
    await limiter.checkAndIncrement(publisher2.address, 300n);
    const [, imp1] = await limiter.currentWindowUsage(publisher.address);
    const [, imp2] = await limiter.currentWindowUsage(publisher2.address);
    expect(imp1).to.equal(800n);
    expect(imp2).to.equal(300n);
  });

  // RL11: transferOwnership works correctly
  it("RL11: transferOwnership transfers to new owner", async function () {
    await expect(limiter.connect(owner).transferOwnership(other.address))
      .to.emit(limiter, "OwnershipTransferred")
      .withArgs(owner.address, other.address);
    expect(await limiter.owner()).to.equal(other.address);
    // Restore
    await limiter.connect(other).transferOwnership(owner.address);
  });

  // RL12: transferOwnership to zero address reverts
  it("RL12: transferOwnership to zero address reverts E00", async function () {
    await expect(
      limiter.connect(owner).transferOwnership(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  // RL13: constructor zero-value guards
  it("RL13: constructor with windowBlocks=0 reverts E11", async function () {
    const Factory = await ethers.getContractFactory("DatumSettlementRateLimiter");
    await expect(Factory.deploy(0n, 1000n)).to.be.revertedWith("E11");
  });

  it("RL13b: constructor with maxPerWindow=0 reverts E11", async function () {
    const Factory = await ethers.getContractFactory("DatumSettlementRateLimiter");
    await expect(Factory.deploy(10n, 0n)).to.be.revertedWith("E11");
  });
});

// RL-INT: Settlement integration tests for BM-5 rate limiter
describe("DatumSettlementRateLimiter — Settlement integration", function () {
  let limiter: DatumSettlementRateLimiter;
  let settlement: DatumSettlement;
  let validator: DatumClaimValidator;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let pauseReg: DatumPauseRegistry;
  let mock: any;
  let relay: any;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("10");
  const DAILY_CAP = parseDOT("1");

  let nextCampaignId = 100n; // offset to avoid collisions with other suites

  function buildChain(
    campaignId: bigint,
    pub: string,
    usr: string,
    count: number,
    impressions: bigint
  ) {
    const claims = [];
    let prevHash = ethers.ZeroHash;
    for (let i = 1; i <= count; i++) {
      const nonce = BigInt(i);
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [campaignId, pub, usr, impressions, BID_CPM, nonce, prevHash]
      );
      claims.push({ campaignId, publisher: pub, impressionCount: impressions, clearingCpmPlanck: BID_CPM, nonce, previousClaimHash: prevHash, claimHash: hash, zkProof: "0x" });
      prevHash = hash;
    }
    return claims;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();

    const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
    validator = await ValidatorFactory.deploy(
      await mock.getAddress(),
      await mock.getAddress(),
      await pauseReg.getAddress()
    );

    const SettlementFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementFactory.deploy(await pauseReg.getAddress());

    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(await settlement.getAddress(), await mock.getAddress(), await pauseReg.getAddress());

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await mock.getAddress(),
      await relay.getAddress()
    );
    await settlement.setClaimValidator(await validator.getAddress());

    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());
    await mock.setBudgetLedger(await ledger.getAddress());
    await vault.setSettlement(await settlement.getAddress());

    // Deploy and wire rate limiter: window=100, cap=500 impressions/window
    const LimiterFactory = await ethers.getContractFactory("DatumSettlementRateLimiter");
    limiter = await LimiterFactory.deploy(100n, 500n);
    await settlement.setRateLimiter(await limiter.getAddress());
  });

  async function newCampaign(): Promise<bigint> {
    const id = nextCampaignId++;
    await mock.setCampaign(id, owner.address, publisher.address, BID_CPM, TAKE_RATE_BPS, 1);
    await mock.initBudget(id, BUDGET, DAILY_CAP, { value: BUDGET });
    return id;
  }

  // RL-INT1: Claims within rate limit settle normally
  it("RL-INT1: claims within rate limit settle successfully", async function () {
    const cid = await newCampaign();
    const claims = buildChain(cid, publisher.address, user.address, 1, 100n);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // RL-INT2: Claims exceeding rate limit are rejected with reason 14
  it("RL-INT2: claim exceeding rate limit rejected with reason 14", async function () {
    // Fill up the window first (cap=500, use 450 in prior test + this one)
    // Mine to fresh window first
    await mineBlocks(110);
    const cid = await newCampaign();

    // First claim: 400 impressions (within 500 cap)
    const claims1 = buildChain(cid, publisher.address, user.address, 1, 400n);
    const batch1 = { user: user.address, campaignId: cid, claims: claims1 };
    const r1 = await settlement.connect(user).settleClaims.staticCall([batch1]);
    expect(r1.settledCount).to.equal(1n);
    await settlement.connect(user).settleClaims([batch1]);

    // Second claim: 200 impressions (400+200=600 > 500 cap)
    const cid2 = await newCampaign();
    // Need a fresh chain for cid2
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid2, publisher.address, user.address, 200n, BID_CPM, 1n, ethers.ZeroHash]
    );
    const claims2 = [{
      campaignId: cid2,
      publisher: publisher.address,
      impressionCount: 200n,
      clearingCpmPlanck: BID_CPM,
      nonce: 1n,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch2 = { user: user.address, campaignId: cid2, claims: claims2 };
    const r2 = await settlement.connect(user).settleClaims.staticCall([batch2]);
    expect(r2.rejectedCount).to.equal(1n);

    // Emitted ClaimRejected with reason 14
    const tx = await settlement.connect(user).settleClaims([batch2]);
    await expect(tx)
      .to.emit(settlement, "ClaimRejected")
      .withArgs(cid2, user.address, 1n, 14n);
  });

  // RL-INT3: Disabling rate limiter (setRateLimiter(0)) allows unlimited claims
  it("RL-INT3: disabling rate limiter with address(0) bypasses cap", async function () {
    await settlement.setRateLimiter(ethers.ZeroAddress);
    // Mine to fresh window
    await mineBlocks(110);
    const cid = await newCampaign();
    // 1000 impressions — would normally exceed 500 cap
    const claims = buildChain(cid, publisher.address, user.address, 1, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(1n);
    // Re-enable limiter for other tests
    await settlement.setRateLimiter(await limiter.getAddress());
  });
});
