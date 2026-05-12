import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumSettlement,
  DatumPauseRegistry,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumClaimValidator,
  DatumPublisherStake,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
import { fundSigners } from "./helpers/mine";

// settleClaimsMulti tests (cross-campaign claim batching)
// SM1–SM3:  single-user single-campaign — same result as settleClaims
// SM4–SM6:  single-user multi-campaign — aggregates across campaigns
// SM7–SM8:  multi-user multi-campaign — each user processed independently
// SM9–SM11: auth checks — relay, self, E32 on wrong sender
// SM12–SM13: batch limits — >10 users reverts E28, >10 campaigns/user reverts E28
// SM14–SM15: FP-1 integration — publisher stake check rejects claims with code 15

describe("DatumSettlement.settleClaimsMulti", function () {
  let settlement: DatumSettlement;
  let mock: MockCampaigns;
  let pauseReg: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;
  let stakeContract: DatumPublisherStake;

  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let relay: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM   = parseDOT("0.016");
  const BUDGET     = parseDOT("10");
  const DAILY_CAP  = parseDOT("1");
  const IMPRESSIONS = 1000n;

  let _nextId = 1n;

  function nextId(): bigint { return _nextId++; }

  function buildClaims(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    count: number
  ) {
    const claims = [];
    let prevHash = ethers.ZeroHash;
    for (let i = 1; i <= count; i++) {
      const nonce = BigInt(i);
      const hash = ethersKeccakAbi(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
        [campaignId, publisherAddr, userAddr, IMPRESSIONS, BID_CPM, 0, ethers.ZeroHash, nonce, prevHash]
      );
      claims.push({
        campaignId,
        publisher: publisherAddr,
        eventCount: IMPRESSIONS,
        ratePlanck: BID_CPM,
        actionType: 0,
        clickSessionHash: ethers.ZeroHash,
        nonce,
        previousClaimHash: prevHash,
        claimHash: hash,
        zkProof: new Array(8).fill(ethers.ZeroHash),
        nullifier: ethers.ZeroHash,
        actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        powNonce: ethers.ZeroHash,
      });
      prevHash = hash;
    }
    return claims;
  }

  async function createCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
    const id = nextId();
    await mock.setCampaign(id, owner.address, publisher.address, BID_CPM, TAKE_RATE_BPS, 1);
    await mock.initBudget(id, 0, budget, dailyCap, { value: budget });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user1, user2, user3, publisher, relay, other] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, user1.address, publisher.address);

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

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await mock.getAddress(),
      relay.address  // relay contract
    );
    await settlement.setClaimValidator(await validator.getAddress());
    await settlement.setPublishers(await mock.getAddress());

    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());

    await mock.setBudgetLedger(await ledger.getAddress());
    await vault.setSettlement(await settlement.getAddress());

    // Deploy publisher stake for FP-1 tests
    const StakeFactory = await ethers.getContractFactory("DatumPublisherStake");
    stakeContract = await StakeFactory.deploy(5_000_000_000n, 0n, 10n); // 0.5 DOT base, no curve
    await stakeContract.setSettlementContract(await settlement.getAddress());
  });

  // ── Single-user single-campaign ───────────────────────────────────────────────

  // SM1: settleClaimsMulti with 1 user, 1 campaign produces same split as settleClaims
  it("SM1: 1 user × 1 campaign produces correct payment split", async function () {
    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user1.address, 1);

    const totalPmt = (BID_CPM * IMPRESSIONS) / 1000n;
    const pubPmt   = (totalPmt * BigInt(TAKE_RATE_BPS)) / 10000n;
    const rem      = totalPmt - pubPmt;
    const userPmt  = (rem * 7500n) / 10000n;
    const proto    = rem - userPmt;

    const pubBefore  = await vault.publisherBalance(publisher.address);
    const userBefore = await vault.userBalance(user1.address);
    const protoBefore = await vault.protocolBalance();

    await settlement.connect(user1).settleClaimsMulti([
      { user: user1.address, campaigns: [{ campaignId: cid, claims }] }
    ]);

    expect(await vault.publisherBalance(publisher.address)).to.equal(pubBefore + pubPmt);
    expect(await vault.userBalance(user1.address)).to.equal(userBefore + userPmt);
    expect(await vault.protocolBalance()).to.equal(protoBefore + proto);
  });

  // SM2: empty batches array is a no-op (no revert)
  it("SM2: empty batches array is accepted", async function () {
    await expect(settlement.connect(user1).settleClaimsMulti([])).to.not.be.reverted;
  });

  // SM3: empty campaigns array per user is accepted
  it("SM3: user with no campaigns is a no-op", async function () {
    await expect(
      settlement.connect(user1).settleClaimsMulti([
        { user: user1.address, campaigns: [] }
      ])
    ).to.not.be.reverted;
  });

  // ── Single-user multi-campaign ────────────────────────────────────────────────

  // SM4: 1 user, 3 campaigns — payment accumulates across all campaigns
  it("SM4: 1 user × 3 campaigns accumulates payment from all", async function () {
    const cid1 = await createCampaign();
    const cid2 = await createCampaign();
    const cid3 = await createCampaign();

    const claims1 = buildClaims(cid1, publisher.address, user2.address, 1);
    const claims2 = buildClaims(cid2, publisher.address, user2.address, 1);
    const claims3 = buildClaims(cid3, publisher.address, user2.address, 1);

    const userBefore = await vault.userBalance(user2.address);

    await settlement.connect(user2).settleClaimsMulti([{
      user: user2.address,
      campaigns: [
        { campaignId: cid1, claims: claims1 },
        { campaignId: cid2, claims: claims2 },
        { campaignId: cid3, claims: claims3 },
      ]
    }]);

    const perClaim = (BID_CPM * IMPRESSIONS) / 1000n;
    const rem = perClaim - (perClaim * BigInt(TAKE_RATE_BPS)) / 10000n;
    const perClaimUser = (rem * 7500n) / 10000n;

    expect(await vault.userBalance(user2.address)).to.equal(userBefore + perClaimUser * 3n);
  });

  // SM5: 1 user, 2 campaigns — settled count equals sum of both claims
  it("SM5: result.settledCount sums across all campaigns", async function () {
    const cid1 = await createCampaign();
    const cid2 = await createCampaign();

    const claims1 = buildClaims(cid1, publisher.address, user1.address, 2);
    const claims2 = buildClaims(cid2, publisher.address, user1.address, 1);

    const result = await settlement.connect(user1).settleClaimsMulti.staticCall([{
      user: user1.address,
      campaigns: [
        { campaignId: cid1, claims: claims1 },
        { campaignId: cid2, claims: claims2 },
      ]
    }]);

    expect(result.settledCount).to.equal(3n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // ── Multi-user multi-campaign ─────────────────────────────────────────────────

  // SM7: relay can settle for 2 users across different campaigns in one TX
  it("SM7: relay settles 2 users across 2 campaigns in single TX", async function () {
    const cid1 = await createCampaign();
    const cid2 = await createCampaign();

    const claims1 = buildClaims(cid1, publisher.address, user1.address, 1);
    const claims2 = buildClaims(cid2, publisher.address, user2.address, 1);

    const u1Before = await vault.userBalance(user1.address);
    const u2Before = await vault.userBalance(user2.address);

    await settlement.connect(relay).settleClaimsMulti([
      { user: user1.address, campaigns: [{ campaignId: cid1, claims: claims1 }] },
      { user: user2.address, campaigns: [{ campaignId: cid2, claims: claims2 }] },
    ]);

    const perClaimUser = (() => {
      const total = (BID_CPM * IMPRESSIONS) / 1000n;
      const pub = (total * BigInt(TAKE_RATE_BPS)) / 10000n;
      const rem = total - pub;
      return (rem * 7500n) / 10000n;
    })();

    expect(await vault.userBalance(user1.address)).to.equal(u1Before + perClaimUser);
    expect(await vault.userBalance(user2.address)).to.equal(u2Before + perClaimUser);
  });

  // SM8: users are independent — one user's claim hash state doesn't bleed into another
  it("SM8: user claim chains are independent across batch entries", async function () {
    const cid = await createCampaign();

    // Both users settle against the same campaign with fresh chains
    const u1Claims = buildClaims(cid, publisher.address, user1.address, 1);
    const u2Claims = buildClaims(cid, publisher.address, user2.address, 1);

    const result = await settlement.connect(relay).settleClaimsMulti.staticCall([
      { user: user1.address, campaigns: [{ campaignId: cid, claims: u1Claims }] },
      { user: user2.address, campaigns: [{ campaignId: cid, claims: u2Claims }] },
    ]);

    expect(result.settledCount).to.equal(2n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────────

  // SM9: user can settle their own batch
  it("SM9: user can self-settle", async function () {
    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user3.address, 1);
    await expect(
      settlement.connect(user3).settleClaimsMulti([
        { user: user3.address, campaigns: [{ campaignId: cid, claims }] }
      ])
    ).to.not.be.reverted;
  });

  // SM10: relay can settle for any user
  it("SM10: relay can settle for any user", async function () {
    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user3.address, 1);
    await expect(
      settlement.connect(relay).settleClaimsMulti([
        { user: user3.address, campaigns: [{ campaignId: cid, claims }] }
      ])
    ).to.not.be.reverted;
  });

  // SM11: wrong sender reverts E32
  it("SM11: unauthorized sender reverts E32", async function () {
    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user1.address, 1);
    await expect(
      settlement.connect(other).settleClaimsMulti([
        { user: user1.address, campaigns: [{ campaignId: cid, claims }] }
      ])
    ).to.be.revertedWith("E32");
  });

  // ── Batch limits ──────────────────────────────────────────────────────────────

  // SM12: >10 users in batches reverts E28
  it("SM12: >10 user entries reverts E28", async function () {
    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user1.address, 1);
    const batches = Array(11).fill({
      user: user1.address,
      campaigns: [{ campaignId: cid, claims }],
    });
    await expect(
      settlement.connect(relay).settleClaimsMulti(batches)
    ).to.be.revertedWith("E28");
  });

  // SM13: >10 campaigns per user reverts E28
  it("SM13: >10 campaigns per user reverts E28", async function () {
    const campaigns = [];
    for (let i = 0; i < 11; i++) {
      const cid = await createCampaign();
      campaigns.push({ campaignId: cid, claims: buildClaims(cid, publisher.address, user1.address, 1) });
    }
    await expect(
      settlement.connect(relay).settleClaimsMulti([
        { user: user1.address, campaigns }
      ])
    ).to.be.revertedWith("E28");
  });

  // ── FP-1 publisher stake integration ─────────────────────────────────────────

  // SM14: with publisherStake set, publisher without adequate stake gets rejection code 15
  it("SM14: unstaked publisher claims rejected with code 15", async function () {
    // Wire stake contract (publisher has 0 stake, base = 0.5 DOT)
    await settlement.setPublisherStake(await stakeContract.getAddress());

    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user1.address, 1);

    const result = await settlement.connect(user1).settleClaimsMulti.staticCall([
      { user: user1.address, campaigns: [{ campaignId: cid, claims }] }
    ]);

    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // SM15: adequately staked publisher's claims are accepted
  it("SM15: adequately staked publisher claims are accepted", async function () {
    // Publisher stakes sufficient DOT
    await stakeContract.connect(publisher).stake({ value: 5_000_000_000n });
    expect(await stakeContract.isAdequatelyStaked(publisher.address)).to.equal(true);

    const cid = await createCampaign();
    const claims = buildClaims(cid, publisher.address, user1.address, 1);

    const result = await settlement.connect(user1).settleClaimsMulti.staticCall([
      { user: user1.address, campaigns: [{ campaignId: cid, claims }] }
    ]);

    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);

    // Disable stake for remaining tests
    await settlement.setPublisherStake(ethers.ZeroAddress);
  });
});
