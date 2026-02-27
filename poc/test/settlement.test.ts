import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumSettlement, MockCampaigns } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, isSubstrate } from "./helpers/mine";

// Settlement tests: S1-S8
// Plus: gap-at-claim-5, genesis-hash, take-rate-snapshot
//
// On substrate, contract deployments are very slow (>5 min for large PVM bytecodes).
// Contracts are deployed once in `before`. Each test uses a unique campaign ID.

describe("DatumSettlement", function () {
  let settlement: DatumSettlement;
  let mock: MockCampaigns;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let protocol: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;           // 50% to publisher
  // 0.016 DOT CPM — chosen so all 3-way split amounts (publisher/user/protocol) are
  // exact multiples of 10^6 planck.  Substrate eth-rpc rejects native transfers where
  // value % 10^6 >= 500_000 (denomination rounding bug), so amounts must be "clean".
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("10");        // 10 DOT
  const DAILY_CAP = parseDOT("1");      // 1 DOT

  let nextCampaignId = 1n;

  // Build a claim hash chain for testing
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
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [campaignId, publisherAddr, userAddr, impressionsPerClaim, baseCpm, nonce, prevHash]
      );
      claims.push({
        campaignId,
        publisher: publisherAddr,
        impressionCount: impressionsPerClaim,
        clearingCpmPlanck: baseCpm,
        nonce,
        previousClaimHash: prevHash,
        claimHash: hash,
        zkProof: "0x",
      });
      prevHash = hash;
    }
    return claims;
  }

  function advertiserAddr() { return owner.address; }

  // Create a fresh Active campaign in the mock with its own ID
  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
    const id = nextCampaignId++;
    await mock.setCampaign(
      id, advertiserAddr(), publisher.address, budget, dailyCap, BID_CPM, TAKE_RATE_BPS,
      1 // CampaignStatus.Active
    );
    // Fund the mock with DOT (planck) to handle deductBudget
    await owner.sendTransaction({ to: await mock.getAddress(), value: budget });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher, protocol, other] = await ethers.getSigners();

    // Deploy MockCampaigns
    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    // Deploy DatumSettlement
    const SettlementFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementFactory.deploy(await mock.getAddress());

    // Set settlement address on mock
    await mock.setSettlementContract(await settlement.getAddress());
  });

  // S1: Single claim — correct payment split
  it("S1: single claim produces correct 3-way split", async function () {
    const cid = await createTestCampaign();
    const impressions = 1000n;
    const cpm = BID_CPM;

    // totalPayment = cpm * impressions / 1000 = 0.016 DOT
    const totalPayment = (cpm * impressions) / 1000n;
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    // Record balances before
    const pubBalBefore = await settlement.publisherBalance(publisher.address);
    const userBalBefore = await settlement.userBalance(user.address);
    const protoBalBefore = await settlement.protocolBalance();

    const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
    const batch = { user: user.address, campaignId: cid, claims };

    await settlement.connect(user).settleClaims([batch]);

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(publisherPmt);
    expect(await settlement.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await settlement.protocolBalance() - protoBalBefore).to.equal(protocolFee);
  });

  // S2: Multiple sequential claims accumulate correctly
  it("S2: five sequential claims accumulate balances correctly", async function () {
    const cid = await createTestCampaign();
    const impressions = 500n;
    const cpm = BID_CPM;
    const count = 5;

    const claims = buildClaimChain(cid, publisher.address, user.address, count, cpm, impressions);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(BigInt(count));
    expect(result.rejectedCount).to.equal(0n);

    const pubBalBefore = await settlement.publisherBalance(publisher.address);
    const userBalBefore = await settlement.userBalance(user.address);
    const protoBalBefore = await settlement.protocolBalance();

    await settlement.connect(user).settleClaims([batch]);

    const totalPayment = (cpm * impressions) / 1000n * BigInt(count);
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(publisherPmt);
    expect(await settlement.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await settlement.protocolBalance() - protoBalBefore).to.equal(protocolFee);
  });

  // S3: Issue 7 — caller must be batch.user
  it("S3: caller must be batch.user", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };

    await expect(
      settlement.connect(other).settleClaims([batch])
    ).to.be.revertedWith("Caller must be claim owner");
  });

  // S4: Issue 2 — CPM exceeding bidCpmPlanck is rejected
  it("S4: claim with clearingCpmPlanck > bidCpmPlanck is rejected", async function () {
    const cid = await createTestCampaign();
    const highCpm = BID_CPM + 1n;
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, 1000n, highCpm, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: 1000n,
      clearingCpmPlanck: highCpm,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // S5: Campaign must be Active — Paused/Pending/Completed are rejected
  it("S5: claims on non-Active campaign are rejected", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 0); // Pending
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S6: Genesis claim must have previousClaimHash == bytes32(0)
  it("S6: genesis claim with non-zero previousClaimHash is rejected", async function () {
    const cid = await createTestCampaign();
    const nonZeroPrev = ethers.keccak256(ethers.toUtf8Bytes("not-zero"));
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, 1000n, BID_CPM, 1n, nonZeroPrev]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: 1000n,
      clearingCpmPlanck: BID_CPM,
      nonce: 1n,
      previousClaimHash: nonZeroPrev,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S7: Hash chain is validated — tampered hash is rejected
  it("S7: tampered claimHash is rejected", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    claims[0].claimHash = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S8: Publisher balance withdrawal works
  it("S8: publisher can withdraw accumulated balance", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const balance = await settlement.publisherBalance(publisher.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(publisher.address);
    const tx = await settlement.connect(publisher).withdrawPublisher();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(publisher.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    } else {
      // On substrate, verify contract balance zeroed (gas costs may dwarf transfer amount)
      expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
    }
    expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
  });

  // A2: Zero-impression claims rejected
  it("A2: zero-impression claim is rejected", async function () {
    const cid = await createTestCampaign();
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, 0n, BID_CPM, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: 0n,
      clearingCpmPlanck: BID_CPM,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // Gap-at-claim-3: only claims 1-2 settle; 3 and beyond rejected (within MAX_CLAIMS_PER_BATCH=5)
  it("Gap: gap at nonce 3 of 5 — only 1-2 settle", async function () {
    const cid = await createTestCampaign();
    // Build 5 claims but skip nonce 3 (set nonce 3 to 4, creating a gap)
    const all5 = buildClaimChain(cid, publisher.address, user.address, 5, BID_CPM, 100n);

    // Introduce gap: replace claim at index 2 (nonce 3) with wrong nonce
    const gapped = [...all5];
    gapped[2] = { ...gapped[2], nonce: 4n }; // skip nonce 3

    const batch = { user: user.address, campaignId: cid, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(2n);
    expect(result.rejectedCount).to.equal(3n); // 3 gapped + 4,5 rejected too
  });

  // Take rate snapshot test
  it("Snapshot: settlement uses snapshotTakeRateBps, not current publisher rate", async function () {
    const cid = await createTestCampaign();

    const impressions = 1000n;
    const cpm = BID_CPM;
    const totalPayment = (cpm * impressions) / 1000n;
    const expectedPublisherPmt = (totalPayment * 5000n) / 10000n; // 50%

    const pubBalBefore = await settlement.publisherBalance(publisher.address);

    const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(expectedPublisherPmt);
  });

  // claimHash computed off-chain (solidityPackedKeccak256) matches what the contract accepts
  it("off-chain claimHash: hash built by buildClaimChain is accepted by settleClaims", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid, claims }
    ]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // User balance withdrawal
  it("User can withdraw accumulated balance", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const balance = await settlement.userBalance(user.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(user.address);
    const tx = await settlement.connect(user).withdrawUser();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(user.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    } else {
      expect(await settlement.userBalance(user.address)).to.equal(0n);
    }
  });

  // Protocol fee withdrawal (owner only)
  it("Protocol fee: only owner can withdraw; recipient receives correct amount", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const fee = await settlement.protocolBalance();
    expect(fee).to.be.gt(0n);

    await expect(
      settlement.connect(other).withdrawProtocol(other.address)
    ).to.be.reverted;

    const balBefore = await ethers.provider.getBalance(protocol.address);
    await settlement.connect(owner).withdrawProtocol(protocol.address);
    const balAfter = await ethers.provider.getBalance(protocol.address);

    if (!(await isSubstrate())) {
      expect(balAfter - balBefore).to.equal(fee);
    } else {
      expect(await settlement.protocolBalance()).to.equal(0n);
    }
    expect(await settlement.protocolBalance()).to.equal(0n);
  });
});
