import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumSettlement, MockCampaigns } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";

// Settlement tests: S1-S8
// Plus: gap-at-claim-5, genesis-hash, take-rate-snapshot

describe("DatumSettlement", function () {
  let settlement: DatumSettlement;
  let mock: MockCampaigns;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let protocol: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const CAMPAIGN_ID = 1n;
  const TAKE_RATE_BPS = 5000;           // 50% to publisher
  const BID_CPM = parseDOT("0.01");     // 0.01 DOT per 1000 impressions
  const BUDGET = parseDOT("10");        // 10 DOT
  const DAILY_CAP = parseDOT("1");      // 1 DOT

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

  beforeEach(async function () {
    [owner, user, publisher, protocol, other] = await ethers.getSigners();

    // Deploy MockCampaigns
    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    // Deploy DatumSettlement
    const SettlementFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementFactory.deploy(await mock.getAddress());

    // Set settlement address on mock
    await mock.setSettlementContract(await settlement.getAddress());

    // Set up a default Active campaign in the mock
    await mock.setCampaign(
      1, advertiserAddr(), publisher.address, BUDGET, DAILY_CAP, BID_CPM, TAKE_RATE_BPS,
      1 // CampaignStatus.Active
    );
    // Fund the mock with DOT (planck) to handle deductBudget
    await owner.sendTransaction({ to: await mock.getAddress(), value: BUDGET });
  });

  function advertiserAddr() { return owner.address; }

  // S1: Single claim — correct payment split
  it("S1: single claim produces correct 3-way split", async function () {
    const impressions = 1000n;
    const cpm = BID_CPM;

    // totalPayment = cpm * impressions / 1000 = 0.01 DOT
    const totalPayment = (cpm * impressions) / 1000n;
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, cpm, impressions);
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };

    await settlement.connect(user).settleClaims([batch]);

    expect(await settlement.publisherBalance(publisher.address)).to.equal(publisherPmt);
    expect(await settlement.userBalance(user.address)).to.equal(userPmt);
    expect(await settlement.protocolBalance()).to.equal(protocolFee);
  });

  // S2: Multiple sequential claims accumulate correctly
  it("S2: five sequential claims accumulate balances correctly", async function () {
    const impressions = 500n;
    const cpm = BID_CPM;
    const count = 5;

    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, count, cpm, impressions);
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(BigInt(count));
    expect(result.rejectedCount).to.equal(0n);

    await settlement.connect(user).settleClaims([batch]);

    const totalPayment = (cpm * impressions) / 1000n * BigInt(count);
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    expect(await settlement.publisherBalance(publisher.address)).to.equal(publisherPmt);
    expect(await settlement.userBalance(user.address)).to.equal(userPmt);
    expect(await settlement.protocolBalance()).to.equal(protocolFee);
  });

  // S3: Issue 7 — caller must be batch.user
  it("S3: caller must be batch.user", async function () {
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };

    await expect(
      settlement.connect(other).settleClaims([batch])
    ).to.be.revertedWith("Caller must be claim owner");
  });

  // S4: Issue 2 — CPM exceeding bidCpmPlanck is rejected
  it("S4: claim with clearingCpmPlanck > bidCpmPlanck is rejected", async function () {
    const highCpm = BID_CPM + 1n;
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [CAMPAIGN_ID, publisher.address, user.address, 1000n, highCpm, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: CAMPAIGN_ID,
      publisher: publisher.address,
      impressionCount: 1000n,
      clearingCpmPlanck: highCpm,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // S5: Campaign must be Active — Paused/Pending/Completed are rejected
  it("S5: claims on non-Active campaign are rejected", async function () {
    await mock.setStatus(CAMPAIGN_ID, 0); // Pending
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S6: Genesis claim must have previousClaimHash == bytes32(0)
  it("S6: genesis claim with non-zero previousClaimHash is rejected", async function () {
    const nonZeroPrev = ethers.keccak256(ethers.toUtf8Bytes("not-zero"));
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [CAMPAIGN_ID, publisher.address, user.address, 1000n, BID_CPM, 1n, nonZeroPrev]
    );
    const claims = [{
      campaignId: CAMPAIGN_ID,
      publisher: publisher.address,
      impressionCount: 1000n,
      clearingCpmPlanck: BID_CPM,
      nonce: 1n,
      previousClaimHash: nonZeroPrev,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S7: Hash chain is validated — tampered hash is rejected
  it("S7: tampered claimHash is rejected", async function () {
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    claims[0].claimHash = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S8: Publisher balance withdrawal works
  it("S8: publisher can withdraw accumulated balance", async function () {
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: CAMPAIGN_ID, claims }]);

    const balance = await settlement.publisherBalance(publisher.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(publisher.address);
    const tx = await settlement.connect(publisher).withdrawPublisherPayment();
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(publisher.address);

    expect(balAfter - balBefore + gasUsed).to.equal(balance);
    expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
  });

  // A2: Zero-impression claims rejected
  it("A2: zero-impression claim is rejected", async function () {
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [CAMPAIGN_ID, publisher.address, user.address, 0n, BID_CPM, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: CAMPAIGN_ID,
      publisher: publisher.address,
      impressionCount: 0n,
      clearingCpmPlanck: BID_CPM,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // Gap-at-claim-5: only claims 1-4 settle; 5 and beyond rejected
  it("Gap: gap at nonce 5 of 10 — only 1-4 settle", async function () {
    // Build 10 claims but skip nonce 5 (set nonce 5 to 6, creating a gap)
    const all10 = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 10, BID_CPM, 100n);

    // Introduce gap: replace claim at index 4 (nonce 5) with wrong nonce
    const gapped = [...all10];
    gapped[4] = { ...gapped[4], nonce: 6n }; // skip nonce 5

    const batch = { user: user.address, campaignId: CAMPAIGN_ID, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(4n);
    expect(result.rejectedCount).to.equal(6n); // 5 gapped + 6,7,8,9,10 rejected too
  });

  // Take rate snapshot test
  it("Snapshot: settlement uses snapshotTakeRateBps, not current publisher rate", async function () {
    // Campaign has 50% snapshot
    // Simulate publisher update to 80% — but mock already has snapshot baked in
    // Verify the split uses 5000 bps

    const impressions = 1000n;
    const cpm = BID_CPM;
    const totalPayment = (cpm * impressions) / 1000n;
    const expectedPublisherPmt = (totalPayment * 5000n) / 10000n; // 50%

    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, cpm, impressions);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: CAMPAIGN_ID, claims }]);

    expect(await settlement.publisherBalance(publisher.address)).to.equal(expectedPublisherPmt);
  });

  // claimHash computed off-chain (solidityPackedKeccak256) matches what the contract accepts
  it("off-chain claimHash: hash built by buildClaimChain is accepted by settleClaims", async function () {
    // If the off-chain hash formula were wrong, settleClaims would reject with reasonCode 10.
    // A successful settlement (settledCount == 1) proves the hash matches.
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: CAMPAIGN_ID, claims }
    ]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // User balance withdrawal
  it("User can withdraw accumulated balance", async function () {
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: CAMPAIGN_ID, claims }]);

    const balance = await settlement.userBalance(user.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(user.address);
    const tx = await settlement.connect(user).withdrawUserPayment();
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(user.address);

    expect(balAfter - balBefore + gasUsed).to.equal(balance);
  });

  // Protocol fee withdrawal (owner only)
  it("Protocol fee: only owner can withdraw; recipient receives correct amount", async function () {
    const claims = buildClaimChain(CAMPAIGN_ID, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: CAMPAIGN_ID, claims }]);

    const fee = await settlement.protocolBalance();
    expect(fee).to.be.gt(0n);

    await expect(
      settlement.connect(other).withdrawProtocolFee(other.address)
    ).to.be.reverted;

    const balBefore = await ethers.provider.getBalance(protocol.address);
    await settlement.connect(owner).withdrawProtocolFee(protocol.address);
    const balAfter = await ethers.provider.getBalance(protocol.address);

    expect(balAfter - balBefore).to.equal(fee);
    expect(await settlement.protocolBalance()).to.equal(0n);
  });
});
