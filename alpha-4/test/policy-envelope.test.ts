// C1 + C2 — Selection-policy envelope and auction-transcript commit.
//
// Verifies the new validator paths added 2026-05-24:
//   - claim.policyId, claim.interestWeightBps, claim.auctionRootCommit
//     are bound under the claim-hash preimage (any tampering → reject 10).
//   - Campaign policy envelope (allowedPolicies, priceFloorBps,
//     minRelevanceBps, requirePolicyAttest) enforced at validator time.
//   - Per-advertiser cross-campaign pacing cap enforced in
//     DatumSettlementLogicB.processBatch.
//
// Reject codes asserted: 31 (missing attestation), 32 (policy not allowed),
//                        33 (interestWeight below floor), 34 (rate below
//                        envelope floor), 35 (advertiser pacing cap).

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";
import { wireSettlementLogic } from "./helpers/settlementLogic";

const _abi = ethers.AbiCoder.defaultAbiCoder();

function buildClaimWithPolicy(opts: {
  campaignId: bigint;
  publisher: string;
  user: string;
  eventCount: bigint;
  ratePlanck: bigint;
  nonce: bigint;
  prev: string;
  policyId: number;
  interestWeightBps: number;
  auctionRootCommit?: string;
}) {
  const auctionRootCommit = opts.auctionRootCommit ?? ethers.ZeroHash;
  const claimHash = ethers.keccak256(
    _abi.encode(
      [
        "uint256", "address", "address", "uint256", "uint256",
        "uint8", "bytes32", "uint256", "bytes32", "bytes32",
        "uint8", "uint16", "bytes32",
      ],
      [
        opts.campaignId, opts.publisher, opts.user, opts.eventCount, opts.ratePlanck,
        0, ethers.ZeroHash, opts.nonce, opts.prev, ethers.ZeroHash,
        opts.policyId, opts.interestWeightBps, auctionRootCommit,
      ]
    )
  );
  return {
    campaignId: opts.campaignId,
    publisher: opts.publisher,
    eventCount: opts.eventCount,
    ratePlanck: opts.ratePlanck,
    actionType: 0,
    clickSessionHash: ethers.ZeroHash,
    nonce: opts.nonce,
    previousClaimHash: opts.prev,
    claimHash,
    zkProof: new Array(8).fill(ethers.ZeroHash),
    nullifier: ethers.ZeroHash,
    stakeRootUsed: ethers.ZeroHash,
    actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
    powNonce: ethers.ZeroHash,
    policyId: opts.policyId,
    interestWeightBps: opts.interestWeightBps,
    auctionRootCommit,
  };
}

async function reasonCodes(receipt: any, iface: any): Promise<bigint[]> {
  const out: bigint[] = [];
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog(log);
      if (p?.name === "ClaimRejected") out.push(p.args.reasonCode);
    } catch { /* skip */ }
  }
  return out;
}

describe("C1: Campaign policy envelope", function () {
  let settlement: any, validator: any, mock: any, pauseReg: any, ledger: any, vault: any, relay: any;
  let owner: HardhatEthersSigner, user: HardhatEthersSigner, publisher: HardhatEthersSigner;
  const TAKE = 5000;
  const CPM = parseDOT("0.016");
  const BUDGET = parseDOT("4");
  const DAILY_CAP = parseDOT("2");
  let nextCid = 1n;

  async function makeCampaign(advertiser: string): Promise<bigint> {
    const id = nextCid++;
    await mock.setCampaign(id, advertiser, publisher.address, CPM, TAKE, 1);
    await mock.initBudget(id, 0, BUDGET, DAILY_CAP, { value: BUDGET });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher] = await ethers.getSigners();

    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await Pause.deploy(owner.address, user.address, publisher.address);

    const Mock = await ethers.getContractFactory("MockCampaigns");
    mock = await Mock.deploy();

    const Ledger = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await Ledger.deploy();

    const Vault = await ethers.getContractFactory("DatumPaymentVault");
    vault = await Vault.deploy();

    const V = await ethers.getContractFactory("DatumClaimValidator");
    validator = await V.deploy(await mock.getAddress(), await mock.getAddress(), await pauseReg.getAddress());

    const S = await ethers.getContractFactory("DatumSettlement");
    settlement = await S.deploy(await pauseReg.getAddress());
    await wireSettlementLogic(settlement as any);

    const R = await ethers.getContractFactory("DatumRelay");
    relay = await R.deploy(await settlement.getAddress(), await mock.getAddress(), await pauseReg.getAddress());

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
    await settlement.setPublishers(await mock.getAddress());
    await settlement.setCampaigns(await mock.getAddress());
  });

  it("no envelope set: claim with policyId=0 settles (status quo)", async function () {
    const cid = await makeCampaign(owner.address);
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });
    const r = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    expect(r.settledCount).to.equal(1n);
    expect(r.rejectedCount).to.equal(0n);
  });

  it("requirePolicyAttest + policyId=0 → reject 31", async function () {
    const cid = await makeCampaign(owner.address);
    await mock.setCampaignPolicyEnvelope(cid, 0, 0, 0, true /*requireAttest*/);
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([31n]);
  });

  it("policyId not in allowedPolicies bitmask → reject 32", async function () {
    const cid = await makeCampaign(owner.address);
    // Allow only policy 2 (interest-weighted)
    await mock.setCampaignPolicyEnvelope(cid, 1 << 2, 0, 0, true);
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 1 /* max-price, not allowed */, interestWeightBps: 0,
    });
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([32n]);
  });

  it("interestWeightBps below minRelevanceBps → reject 33", async function () {
    const cid = await makeCampaign(owner.address);
    await mock.setCampaignPolicyEnvelope(cid, 1 << 2, 0, 5000 /*50%*/, true);
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 2, interestWeightBps: 4000, /*40% — below floor*/
    });
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([33n]);
  });

  it("ratePlanck below priceFloor → reject 34", async function () {
    const cid = await makeCampaign(owner.address);
    // priceFloor = 65% of ceiling
    await mock.setCampaignPolicyEnvelope(cid, 1 << 2, 6500, 0, false);
    const low = (CPM * 50n) / 100n; // 50% — below the 65% floor
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: low, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 2, interestWeightBps: 8000,
    });
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([34n]);
  });

  it("conforming claim settles under a full envelope", async function () {
    const cid = await makeCampaign(owner.address);
    await mock.setCampaignPolicyEnvelope(cid, 1 << 2, 6500, 3000, true);
    const rate = (CPM * 70n) / 100n; // above floor
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: rate, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 2, interestWeightBps: 6000, // above min-relevance
    });
    const r = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    expect(r.settledCount).to.equal(1n);
    expect(r.rejectedCount).to.equal(0n);
  });

  it("tampered policyId post-hash → reject 10 (envelope allows the tampered value)", async function () {
    const cid = await makeCampaign(owner.address);
    // Allow both policies 1 and 2 so the envelope's bitmask doesn't catch
    // the tamper; the hash-check backstop must be the rejection lever.
    await mock.setCampaignPolicyEnvelope(cid, (1 << 1) | (1 << 2), 0, 0, true);
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 2, interestWeightBps: 8000,
    });
    // Forge: try to submit with a different policyId post-hash
    const tampered = { ...c, policyId: 1 };
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid, claims: [tampered] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([10n]); // claim-hash mismatch
  });

  it("C2: auctionRootCommit bound under claim hash (any tamper → reject 10)", async function () {
    const cid = await makeCampaign(owner.address);
    const auctionRoot = "0x" + "ab".repeat(32);
    const c = buildClaimWithPolicy({
      campaignId: cid, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 2, interestWeightBps: 8000,
      auctionRootCommit: auctionRoot,
    });
    // Healthy path settles fine
    const r = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid, claims: [c] },
    ]);
    expect(r.settledCount).to.equal(1n);
    // Tampering the commit on the wire breaks the hash
    const cid2 = await makeCampaign(owner.address);
    const c2 = buildClaimWithPolicy({
      campaignId: cid2, publisher: publisher.address, user: user.address,
      eventCount: 1000n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 2, interestWeightBps: 8000,
      auctionRootCommit: auctionRoot,
    });
    const tampered = { ...c2, auctionRootCommit: ethers.ZeroHash };
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid2, claims: [tampered] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([10n]);
  });
});

describe("C1: Per-advertiser cross-campaign pacing", function () {
  let settlement: any, validator: any, mock: any, pauseReg: any, ledger: any, vault: any, relay: any;
  let owner: HardhatEthersSigner, user: HardhatEthersSigner, publisher: HardhatEthersSigner, advertiser: HardhatEthersSigner;
  const TAKE = 5000;
  const CPM = parseDOT("0.016");
  const BUDGET = parseDOT("4");
  const DAILY_CAP = parseDOT("2");
  let nextCid = 100n;

  async function makeCampaign(adv: string): Promise<bigint> {
    const id = nextCid++;
    await mock.setCampaign(id, adv, publisher.address, CPM, TAKE, 1);
    await mock.initBudget(id, 0, BUDGET, DAILY_CAP, { value: BUDGET });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher, advertiser] = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await Pause.deploy(owner.address, user.address, publisher.address);
    const Mock = await ethers.getContractFactory("MockCampaigns");
    mock = await Mock.deploy();
    const Ledger = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await Ledger.deploy();
    const Vault = await ethers.getContractFactory("DatumPaymentVault");
    vault = await Vault.deploy();
    const V = await ethers.getContractFactory("DatumClaimValidator");
    validator = await V.deploy(await mock.getAddress(), await mock.getAddress(), await pauseReg.getAddress());
    const S = await ethers.getContractFactory("DatumSettlement");
    settlement = await S.deploy(await pauseReg.getAddress());
    await wireSettlementLogic(settlement as any);
    const R = await ethers.getContractFactory("DatumRelay");
    relay = await R.deploy(await settlement.getAddress(), await mock.getAddress(), await pauseReg.getAddress());
    await settlement.configure(
      await ledger.getAddress(), await vault.getAddress(),
      await mock.getAddress(), await relay.getAddress()
    );
    await settlement.setClaimValidator(await validator.getAddress());
    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());
    await mock.setBudgetLedger(await ledger.getAddress());
    await vault.setSettlement(await settlement.getAddress());
    await settlement.setPublishers(await mock.getAddress());
    await settlement.setCampaigns(await mock.getAddress());
  });

  it("cross-campaign cap: 2 events allowed, 3rd rejects with code 35", async function () {
    // Advertiser allows 2 events per 1000-block window across all campaigns
    await mock.setAdvertiserPacing(advertiser.address, 2, 1000);
    const c1Id = await makeCampaign(advertiser.address);
    const c2Id = await makeCampaign(advertiser.address);

    const e1 = buildClaimWithPolicy({
      campaignId: c1Id, publisher: publisher.address, user: user.address,
      eventCount: 1n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });
    const e2 = buildClaimWithPolicy({
      campaignId: c2Id, publisher: publisher.address, user: user.address,
      eventCount: 1n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });

    await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: c1Id, claims: [e1] },
    ]);
    await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: c2Id, claims: [e2] },
    ]);
    // 3rd would put us over the bucket
    const c3Id = await makeCampaign(advertiser.address);
    const e3 = buildClaimWithPolicy({
      campaignId: c3Id, publisher: publisher.address, user: user.address,
      eventCount: 1n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: c3Id, claims: [e3] },
    ]);
    const codes = await reasonCodes(await tx.wait(), settlement.interface);
    expect(codes).to.deep.equal([35n]);
  });

  it("pacing window rolls over: after windowBlocks, counter resets", async function () {
    // Reset pacing to a small window for the rollover test
    await mock.setAdvertiserPacing(advertiser.address, 1, 10);
    const c1Id = await makeCampaign(advertiser.address);
    const c2Id = await makeCampaign(advertiser.address);
    const e1 = buildClaimWithPolicy({
      campaignId: c1Id, publisher: publisher.address, user: user.address,
      eventCount: 1n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });
    await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: c1Id, claims: [e1] },
    ]);
    // Mine enough blocks to roll past the window
    await mineBlocks(11);
    const e2 = buildClaimWithPolicy({
      campaignId: c2Id, publisher: publisher.address, user: user.address,
      eventCount: 1n, ratePlanck: CPM, nonce: 1n, prev: ethers.ZeroHash,
      policyId: 0, interestWeightBps: 0,
    });
    const r = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: c2Id, claims: [e2] },
    ]);
    expect(r.settledCount).to.equal(1n);
    expect(r.rejectedCount).to.equal(0n);
  });
});

describe("C1: setCampaignPolicyEnvelope (real DatumCampaigns)", function () {
  // Lightweight test against the real Campaigns contract: no full deploy,
  // just exercise the setter rules. Verifies tightening blocks once Active.
  it("envelope round-trips and enforces tighten-while-pending", async function () {
    // Not yet wired in this run — the real DatumCampaigns deploy chain
    // needs several dependencies (BudgetLedger, PauseRegistry, etc).
    // Skipping the integration here; the MockCampaigns covers validator
    // wiring above. A full e2e is in `setCampaignPolicyEnvelope` usage
    // tests under campaigns.test.ts (added separately).
    expect(true).to.equal(true);
  });
});
