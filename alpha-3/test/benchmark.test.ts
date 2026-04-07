/**
 * Datum Alpha-3 — Complete Benchmark Suite
 * =========================================
 * Comprehensive functional + economic benchmarks for all 20 alpha-3 contracts.
 *
 * DOT price scenarios
 * -------------------
 * Tests run at three DOT price points using a common $1 CPM (USD per 1000 impressions):
 *
 *   DOT @ $2  → $1 CPM = 0.5 DOT/1000 imps  → clearingCpm = parseDOT("0.5")
 *   DOT @ $5  → $1 CPM = 0.2 DOT/1000 imps  → clearingCpm = parseDOT("0.2")
 *   DOT @ $10 → $1 CPM = 0.1 DOT/1000 imps  → clearingCpm = parseDOT("0.1")
 *
 * Revenue split (takeRate = 50%)
 * ------------------------------
 *   totalPayment     = clearingCpm × impressions / 1000
 *   publisherPayment = totalPayment × 50%         (5000 bps)
 *   userPayment      = remainder   × 75%          (7500 bps)
 *   protocolFee      = remainder   × 25%
 *
 *   At $1 CPM, 1000 impressions:
 *     DOT@$2:  total=$1.00  pub=$0.50  user=$0.375  protocol=$0.125
 *     DOT@$5:  total=$1.00  pub=$0.50  user=$0.375  protocol=$0.125
 *     DOT@$10: total=$1.00  pub=$0.50  user=$0.375  protocol=$0.125
 *   (Identical USD split — DOT price only affects planck denominations)
 *
 * Test IDs
 * --------
 *   BM-ECO-*  Economic correctness at each price point
 *   BM-SCALE-* Impression batch scaling (10 / 100 / 1000 impressions per claim)
 *   BM-ZK-*   ZK-proof-required campaigns (stub verifier: any non-empty proof accepted)
 *   BM-OPEN-* Open campaign (publisher = address(0), any publisher may settle)
 *   BM-RL-*   Rate limiter (BM-5: window-based per-publisher impression cap)
 *   BM-REP-*  Reputation tracking (BM-8/BM-9: settlement score, anomaly detection)
 *   BM-RPT-*  Community reports (DatumReports: page + ad reports)
 *   BM-TAG-*  Tag-based targeting (DatumTargetingRegistry + CampaignValidator)
 *   BM-GAS-*  Gas / weight measurements (logged to console, not asserting exact values)
 *   BM-LC-*   Full lifecycle: create → vote → activate → settle → complete → withdraw
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPublishers,
  DatumCampaigns,
  DatumGovernanceV2,
  DatumGovernanceSlash,
  DatumSettlement,
  DatumRelay,
  DatumPauseRegistry,
  DatumBudgetLedger,
  DatumPaymentVault,
  DatumCampaignLifecycle,
  DatumAttestationVerifier,
  DatumClaimValidator,
  DatumSettlementRateLimiter,
  DatumPublisherReputation,
  DatumReports,
  DatumTargetingRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT, formatDOT } from "./helpers/dot";
import { fundSigners, mineBlocks, isSubstrate } from "./helpers/mine";

// ---------------------------------------------------------------------------
// DOT price → planck CPM conversion ($1 CPM baseline)
// ---------------------------------------------------------------------------
// 1 DOT = 10^10 planck.  CPM is expressed per 1000 impressions.
// At DOT = $P/DOT:  $1 CPM = (1/P) DOT per 1000 imps.

const DOT_PRICE_SCENARIOS = [
  { label: "$2/DOT",  cpm: parseDOT("0.5"),   budget: parseDOT("50"),  dailyCap: parseDOT("10") },
  { label: "$5/DOT",  cpm: parseDOT("0.2"),   budget: parseDOT("20"),  dailyCap: parseDOT("4")  },
  { label: "$10/DOT", cpm: parseDOT("0.1"),   budget: parseDOT("10"),  dailyCap: parseDOT("2")  },
] as const;

// Standard take rate for all benchmark campaigns
const TAKE_RATE_BPS = 5000; // 50%

// Compute expected payment split for N impressions at a given CPM (50% takeRate)
function expectedPayments(cpm: bigint, impressions: bigint, claimCount: number) {
  const total = (cpm * impressions) / 1000n * BigInt(claimCount);
  const pub   = (total * 5000n) / 10000n;
  const rem   = total - pub;
  const user  = (rem * 7500n) / 10000n;
  const prot  = rem - user;
  return { total, pub, user, prot };
}

// Build a linked claim chain (keccak256 — EVM-compatible on Hardhat)
function buildClaims(
  campaignId: bigint,
  publisherAddr: string,
  userAddr: string,
  count: number,
  cpm: bigint,
  impressions: bigint,
  zkProof: string = "0x",
) {
  const claims = [];
  let prevHash = ethers.ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [campaignId, publisherAddr, userAddr, impressions, cpm, nonce, prevHash]
    );
    claims.push({
      campaignId,
      publisher: publisherAddr,
      impressionCount: impressions,
      clearingCpmPlanck: cpm,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof,
    });
    prevHash = hash;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Shared fixture — full 20-contract deployment
// ---------------------------------------------------------------------------

describe("Datum Alpha-3 Benchmark Suite", function () {
  // Contract instances
  let pauseReg:     DatumPauseRegistry;
  let publishers:   DatumPublishers;
  let ledger:       DatumBudgetLedger;
  let vault:        DatumPaymentVault;
  let campaigns:    DatumCampaigns;
  let lifecycle:    DatumCampaignLifecycle;
  let v2:           DatumGovernanceV2;
  let slash:        DatumGovernanceSlash;
  let claimVal:     DatumClaimValidator;
  let settlement:   DatumSettlement;
  let relay:        DatumRelay;
  let verifier:     DatumAttestationVerifier;
  let rateLimiter:  DatumSettlementRateLimiter;
  let reputation:   DatumPublisherReputation;
  let reports:      DatumReports;
  let targeting:    DatumTargetingRegistry;

  // Signers
  let owner:      HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher:  HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let user:       HardhatEthersSigner;
  let voter:      HardhatEthersSigner;
  let reporter:   HardhatEthersSigner;

  // Governance parameters (small values for fast tests)
  const QUORUM       = parseDOT("0.5");
  const SLASH_BPS    = 500n;
  const TERM_QUORUM  = parseDOT("0.5");
  const BASE_GRACE   = 5n;
  const GRACE_PER_Q  = 10n;
  const MAX_GRACE    = 30n;
  const MIN_CPM      = 0n;

  let PENDING_TIMEOUT: bigint;
  let TAKE_RATE_DELAY: bigint;

  // Campaign ID counter — incremented per test to avoid collisions
  let nextId = 1n;

  // ---------------------------------------------------------------------------
  // Deploy all 20 contracts and wire them
  // ---------------------------------------------------------------------------
  before(async function () {
    await fundSigners(10);
    const substrate = await isSubstrate();
    PENDING_TIMEOUT = substrate ? 3n : 50n;
    TAKE_RATE_DELAY = substrate ? 3n : 20n;

    [owner, advertiser, publisher, publisher2, user, voter, reporter] = await ethers.getSigners();

    // 1. Infrastructure
    pauseReg  = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, advertiser.address, publisher.address);
    publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(
      TAKE_RATE_DELAY, await pauseReg.getAddress()
    );
    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    vault  = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();

    // 2. Targeting registry (alpha-3 satellite)
    targeting = await (await ethers.getContractFactory("DatumTargetingRegistry")).deploy(
      await publishers.getAddress(), await pauseReg.getAddress()
    );

    // 3. Campaign validator + Campaigns
    const campVal = await (await ethers.getContractFactory("DatumCampaignValidator")).deploy(
      await publishers.getAddress(), await targeting.getAddress()
    );
    campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
      MIN_CPM, PENDING_TIMEOUT, await campVal.getAddress(), await pauseReg.getAddress()
    );

    // 4. Lifecycle, Governance
    lifecycle = await (await ethers.getContractFactory("DatumCampaignLifecycle")).deploy(
      await pauseReg.getAddress(), 432000n
    );
    v2 = await (await ethers.getContractFactory("DatumGovernanceV2")).deploy(
      await campaigns.getAddress(),
      QUORUM, SLASH_BPS, TERM_QUORUM, BASE_GRACE, GRACE_PER_Q, MAX_GRACE,
      await pauseReg.getAddress()
    );
    slash = await (await ethers.getContractFactory("DatumGovernanceSlash")).deploy(
      await v2.getAddress(), await campaigns.getAddress()
    );
    const govHelper = await (await ethers.getContractFactory("DatumGovernanceHelper")).deploy(
      await campaigns.getAddress()
    );

    // 5. Settlement stack (alpha-3 SE-1 architecture)
    const zkVerifier = await (await ethers.getContractFactory("MockZKVerifier")).deploy();
    claimVal = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
      await campaigns.getAddress(), await publishers.getAddress(), await pauseReg.getAddress()
    );
    settlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseReg.getAddress()
    );
    relay = await (await ethers.getContractFactory("DatumRelay")).deploy(
      await settlement.getAddress(), await campaigns.getAddress(), await pauseReg.getAddress()
    );
    verifier = await (await ethers.getContractFactory("DatumAttestationVerifier")).deploy(
      await settlement.getAddress(), await campaigns.getAddress(), await pauseReg.getAddress()
    );

    // 6. BM-5: Rate limiter (window=200, cap=50000 impressions)
    rateLimiter = await (await ethers.getContractFactory("DatumSettlementRateLimiter")).deploy(
      200n, 50000n
    );

    // 7. BM-8/9: Reputation
    reputation = await (await ethers.getContractFactory("DatumPublisherReputation")).deploy();

    // 8. Reports satellite
    reports = await (await ethers.getContractFactory("DatumReports")).deploy(
      await campaigns.getAddress()
    );

    // ---------------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------------
    await v2.setSlashContract(await slash.getAddress());
    await v2.setLifecycle(await lifecycle.getAddress());
    await v2.setHelper(await govHelper.getAddress());

    await campaigns.setGovernanceContract(await v2.getAddress());
    await campaigns.setSettlementContract(await settlement.getAddress());
    await campaigns.setLifecycleContract(await lifecycle.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());

    await ledger.setCampaigns(await campaigns.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await lifecycle.getAddress());

    await vault.setSettlement(await settlement.getAddress());

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await lifecycle.getAddress(),
      await relay.getAddress()
    );
    await settlement.setClaimValidator(await claimVal.getAddress());
    await settlement.setAttestationVerifier(await verifier.getAddress());
    await settlement.setRateLimiter(await rateLimiter.getAddress());

    await claimVal.setZKVerifier(await zkVerifier.getAddress());

    await lifecycle.setCampaigns(await campaigns.getAddress());
    await lifecycle.setBudgetLedger(await ledger.getAddress());
    await lifecycle.setGovernanceContract(await v2.getAddress());
    await lifecycle.setSettlementContract(await settlement.getAddress());

    // Reputation: authorize reporter
    await reputation.addReporter(reporter.address);

    // Register publishers
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
    await publishers.connect(publisher2).registerPublisher(TAKE_RATE_BPS);
  });

  // ---------------------------------------------------------------------------
  // Helper: activate a new campaign
  // ---------------------------------------------------------------------------
  async function newActiveCampaign(
    budget: bigint,
    dailyCap: bigint,
    cpm: bigint,
    pub: HardhatEthersSigner | string = publisher,
    requiredTags: string[] = [],
    requireZk: boolean = false,
  ): Promise<bigint> {
    const pubAddr = typeof pub === "string" ? pub : pub.address;
    const tx = await campaigns.connect(advertiser).createCampaign(
      pubAddr, dailyCap, cpm, requiredTags, requireZk, ethers.ZeroAddress, 0, { value: budget }
    );
    await tx.wait();
    const cid = await campaigns.nextCampaignId() - 1n;
    await v2.connect(voter).vote(cid, true, 0, { value: QUORUM });
    await v2.evaluateCampaign(cid);
    expect(await campaigns.getCampaignStatus(cid)).to.equal(1, `campaign ${cid} not Active`);
    return cid;
  }

  // ---------------------------------------------------------------------------
  // BM-ECO: Economic correctness at all three DOT price points
  // ---------------------------------------------------------------------------
  describe("BM-ECO: Economic correctness — $1 CPM at $2/$5/$10 DOT", function () {
    for (const scenario of DOT_PRICE_SCENARIOS) {
      it(`BM-ECO: ${scenario.label} — 1000 impressions payment split`, async function () {
        const cid = await newActiveCampaign(scenario.budget, scenario.dailyCap, scenario.cpm);
        const impressions = 1000n;
        const claimCount  = 1;

        const claims = buildClaims(cid, publisher.address, user.address, claimCount, scenario.cpm, impressions);
        const batch  = { user: user.address, campaignId: cid, claims };
        const result = await settlement.connect(user).settleClaims.staticCall([batch]);
        expect(result.settledCount).to.equal(BigInt(claimCount));
        expect(result.rejectedCount).to.equal(0n);
        await settlement.connect(user).settleClaims([batch]);

        const { total, pub: pubAmt, user: userAmt, prot } = expectedPayments(scenario.cpm, impressions, claimCount);

        expect(await vault.publisherBalance(publisher.address)).to.be.gte(pubAmt,
          `${scenario.label}: publisher balance too low`);
        expect(await vault.userBalance(user.address)).to.be.gte(userAmt,
          `${scenario.label}: user balance too low`);

        // Log for documentation
        const dotPrice = scenario.label.replace("/DOT", "").replace("$", "");
        console.log(`\n  [${scenario.label}] 1000 imps @ $1 CPM:`);
        console.log(`    totalPayment:      ${formatDOT(total)} DOT  ($1.00)`);
        console.log(`    publisher (50%):   ${formatDOT(pubAmt)} DOT  ($0.50)`);
        console.log(`    user (37.5%):      ${formatDOT(userAmt)} DOT  ($0.375)`);
        console.log(`    protocol (12.5%):  ${formatDOT(prot)} DOT  ($0.125)`);
      });
    }

    it("BM-ECO-MULTI: Multi-claim batch (3 claims × 1000 imps) at $5/DOT", async function () {
      const s = DOT_PRICE_SCENARIOS[1]; // $5/DOT
      const cid = await newActiveCampaign(s.budget, s.dailyCap, s.cpm);
      const impressions = 1000n;
      const claimCount  = 3;

      const pubBalBefore  = await vault.publisherBalance(publisher.address);
      const userBalBefore = await vault.userBalance(user.address);
      const protBalBefore = await vault.protocolBalance();

      const claims = buildClaims(cid, publisher.address, user.address, claimCount, s.cpm, impressions);
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(BigInt(claimCount));
      await settlement.connect(user).settleClaims([batch]);

      const { pub: pubAmt, user: userAmt, prot } = expectedPayments(s.cpm, impressions, claimCount);
      expect(await vault.publisherBalance(publisher.address) - pubBalBefore).to.equal(pubAmt);
      expect(await vault.userBalance(user.address) - userBalBefore).to.equal(userAmt);
      expect(await vault.protocolBalance() - protBalBefore).to.equal(prot);
    });
  });

  // ---------------------------------------------------------------------------
  // BM-SCALE: Impression count scaling (10 / 100 / 1000 per claim)
  // ---------------------------------------------------------------------------
  describe("BM-SCALE: Impression count scaling", function () {
    const CPM      = parseDOT("0.2"); // $1 at $5/DOT
    const BUDGET   = parseDOT("20");
    const DAILY    = parseDOT("4");

    for (const imps of [10n, 100n, 1000n]) {
      it(`BM-SCALE: 1 claim × ${imps} impressions at $1 CPM ($5/DOT)`, async function () {
        const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
        const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, imps);
        const batch  = { user: user.address, campaignId: cid, claims };
        const result = await settlement.connect(user).settleClaims.staticCall([batch]);
        expect(result.settledCount).to.equal(1n);
        expect(result.rejectedCount).to.equal(0n);

        const tx      = await settlement.connect(user).settleClaims([batch]);
        const receipt = await tx.wait();
        console.log(`\n  [BM-SCALE] ${imps} imps — gas: ${receipt?.gasUsed}`);
      });
    }

    it("BM-SCALE: 5 claims × 100 impressions (batch) at $1 CPM ($5/DOT)", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      const claims = buildClaims(cid, publisher.address, user.address, 5, CPM, 100n);
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(5n);

      const tx      = await settlement.connect(user).settleClaims([batch]);
      const receipt = await tx.wait();
      console.log(`\n  [BM-SCALE] 5×100 imps batch — gas: ${receipt?.gasUsed}`);
    });
  });

  // ---------------------------------------------------------------------------
  // BM-ZK: ZK-proof-required campaigns
  // Stub verifier (DatumZKVerifier) accepts any proof with length > 0.
  // Post-MVP: replace with real Groth16/PLONK verifier.
  // ---------------------------------------------------------------------------
  describe("BM-ZK: ZK-proof-required campaigns", function () {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("20");
    const DAILY  = parseDOT("4");

    it("BM-ZK-1: ZK campaign rejects claim with empty proof (reason 16)", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, publisher, [], true);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, "0x");
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.rejectedCount).to.equal(1n);
      const tx = await settlement.connect(user).settleClaims([batch]);
      await expect(tx)
        .to.emit(settlement, "ClaimRejected")
        .withArgs(cid, user.address, 1n, 16n); // reason 16 = ZK proof missing
    });

    it("BM-ZK-2: ZK campaign settles with non-empty stub proof", async function () {
      // Non-empty proof — stub verifier (length > 0 → valid)
      const ZK_STUB_PROOF = "0xdeadbeef01020304"; // 8 bytes — any non-empty value
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, publisher, [], true);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, ZK_STUB_PROOF);
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);
      await settlement.connect(user).settleClaims([batch]);
    });

    it("BM-ZK-3: Non-ZK campaign settles without proof (zkProof=0x)", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, publisher, [], false);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, "0x");
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([batch]);
    });

    it("BM-ZK-4: Mixed ZK/non-ZK batch across all price points", async function () {
      // Each scenario: 1 ZK-required campaign + stub proof → settles
      for (const s of DOT_PRICE_SCENARIOS) {
        const ZK_PROOF = "0xabcdef";
        const cid = await newActiveCampaign(s.budget, s.dailyCap, s.cpm, publisher, [], true);
        const claims = buildClaims(cid, publisher.address, user.address, 1, s.cpm, 100n, ZK_PROOF);
        const batch  = { user: user.address, campaignId: cid, claims };
        const r = await settlement.connect(user).settleClaims.staticCall([batch]);
        expect(r.settledCount).to.equal(1n, `${s.label}: ZK campaign should settle`);
        await settlement.connect(user).settleClaims([batch]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // BM-OPEN: Open campaign (publisher = address(0) — any registered publisher)
  // ---------------------------------------------------------------------------
  describe("BM-OPEN: Open campaign settlement", function () {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("20");
    const DAILY  = parseDOT("4");

    it("BM-OPEN-1: publisher1 settles open campaign", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, ethers.ZeroAddress);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n);
      const batch  = { user: user.address, campaignId: cid, claims };
      const r = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([batch]);
    });

    it("BM-OPEN-2: publisher2 also settles the same open campaign (different user)", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, ethers.ZeroAddress);

      // publisher1 settles for `user`
      const c1 = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims: c1 }]);

      // publisher2 settles for `voter` (different user → fresh claim chain state)
      const c2 = buildClaims(cid, publisher2.address, voter.address, 1, CPM, 50n);
      const r = await settlement.connect(voter).settleClaims.staticCall([
        { user: voter.address, campaignId: cid, claims: c2 }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(voter).settleClaims([{ user: voter.address, campaignId: cid, claims: c2 }]);
    });

    it("BM-OPEN-3: open campaign at all three price points", async function () {
      for (const s of DOT_PRICE_SCENARIOS) {
        const cid = await newActiveCampaign(s.budget, s.dailyCap, s.cpm, ethers.ZeroAddress);
        const claims = buildClaims(cid, publisher.address, user.address, 1, s.cpm, 100n);
        const r = await settlement.connect(user).settleClaims.staticCall([
          { user: user.address, campaignId: cid, claims }
        ]);
        expect(r.settledCount).to.equal(1n, `${s.label}: open campaign should settle`);
        await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // BM-RL: Rate limiter (BM-5)
  // Window = 200 blocks, cap = 50000 impressions/window.
  // Use tiny CPM (0.00001 DOT) so large impression counts don't exceed daily caps.
  // ---------------------------------------------------------------------------
  describe("BM-RL: Settlement rate limiter (BM-5)", function () {
    // Tiny CPM so impression-count tests don't hit daily budget caps.
    // 50000 imps × 0.00001 DOT CPM / 1000 = 0.0005 DOT total — far below any cap.
    const RL_CPM    = parseDOT("0.00001");
    const RL_BUDGET = parseDOT("1");
    const RL_DAILY  = parseDOT("1");

    it("BM-RL-1: claims within cap settle normally", async function () {
      const cid = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      const claims = buildClaims(cid, publisher.address, user.address, 1, RL_CPM, 100n);
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
    });

    it("BM-RL-2: claims exceeding cap rejected with reason 14", async function () {
      // Mine past current window so we get a fresh start
      await mineBlocks(210);

      const cid1 = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      // Use 49900 impressions (just under 50000 cap)
      const c1 = buildClaims(cid1, publisher.address, user.address, 1, RL_CPM, 49900n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid1, claims: c1 }]);

      // Next claim: 200 more → 50100 total > 50000 cap → rejected
      const cid2 = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [cid2, publisher.address, user.address, 200n, RL_CPM, 1n, ethers.ZeroHash]
      );
      const c2 = [{
        campaignId: cid2,
        publisher:  publisher.address,
        impressionCount: 200n,
        clearingCpmPlanck: RL_CPM,
        nonce: 1n,
        previousClaimHash: ethers.ZeroHash,
        claimHash: hash,
        zkProof: "0x",
      }];
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid2, claims: c2 }
      ]);
      expect(r.rejectedCount).to.equal(1n);
      const tx = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid2, claims: c2 }
      ]);
      await expect(tx).to.emit(settlement, "ClaimRejected").withArgs(cid2, user.address, 1n, 14n);
    });

    it("BM-RL-3: window reset allows fresh impressions after windowBlocks", async function () {
      await mineBlocks(210); // advance past window
      const cid = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      const claims = buildClaims(cid, publisher.address, user.address, 1, RL_CPM, 1000n);
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
    });

    it("BM-RL-4: disabling rate limiter (address(0)) allows impressions above cap", async function () {
      await mineBlocks(210); // ensure fresh window
      await settlement.setRateLimiter(ethers.ZeroAddress);
      const cid = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      // 50000 impressions — would exceed cap but limiter is disabled
      const claims = buildClaims(cid, publisher.address, user.address, 1, RL_CPM, 50000n);
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
      // Restore
      await settlement.setRateLimiter(await rateLimiter.getAddress());
    });
  });

  // ---------------------------------------------------------------------------
  // BM-REP: Publisher reputation (BM-8/BM-9)
  // ---------------------------------------------------------------------------
  describe("BM-REP: Publisher reputation tracking (BM-8/BM-9)", function () {
    it("BM-REP-1: fresh publisher scores 10000 (perfect)", async function () {
      expect(await reputation.getScore(publisher2.address)).to.equal(10000n);
    });

    it("BM-REP-2: recordSettlement updates score correctly", async function () {
      await reputation.connect(reporter).recordSettlement(publisher.address, 1n, 900n, 100n);
      // score = 900 / 1000 * 10000 = 9000
      expect(await reputation.getScore(publisher.address)).to.equal(9000n);
    });

    it("BM-REP-3: multiple campaigns accumulate per-campaign + global counters", async function () {
      await reputation.connect(reporter).recordSettlement(publisher.address, 2n, 400n, 100n);
      const [gs, gr] = [await reputation.totalSettled(publisher.address), await reputation.totalRejected(publisher.address)];
      expect(gs).to.equal(1300n); // 900+400
      expect(gr).to.equal(200n);  // 100+100

      const [cs, cr] = await reputation.getCampaignStats(publisher.address, 2n);
      expect(cs).to.equal(400n);
      expect(cr).to.equal(100n);
    });

    it("BM-REP-4: isAnomaly detects 2× global rejection rate", async function () {
      const Factory = await ethers.getContractFactory("DatumPublisherReputation");
      const rep = await Factory.deploy();
      await rep.addReporter(reporter.address);
      // Global: 90% acceptance (900 settled, 100 rejected)
      await rep.connect(reporter).recordSettlement(publisher.address, 1n, 900n, 100n);
      // Campaign 2: 40% acceptance (4 settled, 6 rejected) — >2× global rejection rate
      await rep.connect(reporter).recordSettlement(publisher.address, 2n, 4n, 6n);
      expect(await rep.isAnomaly(publisher.address, 2n)).to.equal(true);
    });

    it("BM-REP-5: isAnomaly false below MIN_SAMPLE (10 total)", async function () {
      const Factory = await ethers.getContractFactory("DatumPublisherReputation");
      const rep = await Factory.deploy();
      await rep.addReporter(reporter.address);
      await rep.connect(reporter).recordSettlement(publisher.address, 1n, 3n, 6n); // 9 total < 10
      expect(await rep.isAnomaly(publisher.address, 1n)).to.equal(false);
    });

    it("BM-REP-6: getPublisherStats returns (settled, rejected, score) triple", async function () {
      const [s, r, score] = await reputation.getPublisherStats(publisher.address);
      expect(s).to.equal(1300n);
      expect(r).to.equal(200n);
      const expected = (1300n * 10000n) / (1300n + 200n);
      expect(score).to.equal(expected);
    });

    it("BM-REP-7: reputation at each DOT price point — score invariant to denomination", async function () {
      // Reputation uses raw counts, not planck amounts → identical at all price points
      const Factory = await ethers.getContractFactory("DatumPublisherReputation");
      for (const s of DOT_PRICE_SCENARIOS) {
        const rep = await Factory.deploy();
        await rep.addReporter(reporter.address);
        await rep.connect(reporter).recordSettlement(publisher.address, 1n, 800n, 200n);
        // score = 800/1000*10000 = 8000 at all price points
        expect(await rep.getScore(publisher.address)).to.equal(8000n,
          `${s.label}: score should be 8000 regardless of DOT price`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // BM-RPT: Community reports (DatumReports)
  // ---------------------------------------------------------------------------
  describe("BM-RPT: Community reports (DatumReports)", function () {
    // Create a fixed campaign to report on — use mock-compatible createCampaign
    let reportCampaignId: bigint;
    const RPT_CPM    = parseDOT("0.2");
    const RPT_BUDGET = parseDOT("20");
    const RPT_DAILY  = parseDOT("4");

    before(async function () {
      reportCampaignId = await newActiveCampaign(RPT_BUDGET, RPT_DAILY, RPT_CPM);
    });

    it("BM-RPT-1: reportPage increments pageReports and emits event", async function () {
      const before = await reports.pageReports(reportCampaignId);
      await expect(reports.connect(user).reportPage(reportCampaignId, 1))
        .to.emit(reports, "PageReported")
        .withArgs(reportCampaignId, publisher.address, user.address, 1n);
      expect(await reports.pageReports(reportCampaignId)).to.equal(before + 1n);
    });

    it("BM-RPT-2: reportAd increments adReports and emits event", async function () {
      const before = await reports.adReports(reportCampaignId);
      await expect(reports.connect(user).reportAd(reportCampaignId, 3))
        .to.emit(reports, "AdReported")
        .withArgs(reportCampaignId, advertiser.address, user.address, 3n);
      expect(await reports.adReports(reportCampaignId)).to.equal(before + 1n);
    });

    it("BM-RPT-3: all 5 valid reason codes accepted", async function () {
      for (let r = 1; r <= 5; r++) {
        await expect(reports.connect(user).reportPage(reportCampaignId, r)).not.to.be.reverted;
        await expect(reports.connect(user).reportAd(reportCampaignId, r)).not.to.be.reverted;
      }
    });

    it("BM-RPT-4: invalid reason (0 or 6) reverts E68", async function () {
      await expect(reports.connect(user).reportPage(reportCampaignId, 0)).to.be.revertedWith("E68");
      await expect(reports.connect(user).reportPage(reportCampaignId, 6)).to.be.revertedWith("E68");
    });

    it("BM-RPT-5: non-existent campaign reverts E01", async function () {
      await expect(reports.connect(user).reportPage(999999n, 1)).to.be.revertedWith("E01");
    });
  });

  // ---------------------------------------------------------------------------
  // BM-TAG: Tag-based targeting (DatumTargetingRegistry + CampaignValidator)
  // ---------------------------------------------------------------------------
  describe("BM-TAG: Tag-based targeting", function () {
    const TAG_CPM    = parseDOT("0.2");
    const TAG_BUDGET = parseDOT("20");
    const TAG_DAILY  = parseDOT("4");

    before(async function () {
      // Set tags on publisher
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      const defiTag   = ethers.encodeBytes32String("topic:defi");
      await targeting.connect(publisher).setTags([cryptoTag, defiTag]);
    });

    it("BM-TAG-1: publisher with matching tags can create fixed campaign", async function () {
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      // Fixed campaign requiring tag — publisher has it → validation passes
      const cid = await newActiveCampaign(TAG_BUDGET, TAG_DAILY, TAG_CPM, publisher, [cryptoTag]);
      expect(cid).to.be.gt(0n);
      const claims = buildClaims(cid, publisher.address, user.address, 1, TAG_CPM, 100n);
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
    });

    it("BM-TAG-2: publisher without required tag cannot create fixed campaign", async function () {
      // publisher2 has no tags → creating a campaign requiring topic:crypto should revert
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      await expect(
        campaigns.connect(advertiser).createCampaign(
          publisher2.address, TAG_DAILY, TAG_CPM, [cryptoTag], false, ethers.ZeroAddress, 0, { value: TAG_BUDGET }
        )
      ).to.be.reverted; // E66 or validator rejection
    });

    it("BM-TAG-3: open campaign with required tags — no publisher validation at creation", async function () {
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      // Open campaign (publisher=0) with required tags: creation succeeds (no publisher to validate)
      const cid = await newActiveCampaign(TAG_BUDGET, TAG_DAILY, TAG_CPM, ethers.ZeroAddress, [cryptoTag]);
      expect(cid).to.be.gt(0n);
    });

    it("BM-TAG-4: publisher tags correctly returned by TargetingRegistry", async function () {
      const tags = await targeting.getTags(publisher.address);
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      const defiTag   = ethers.encodeBytes32String("topic:defi");
      expect(tags).to.include(cryptoTag);
      expect(tags).to.include(defiTag);
    });

    it("BM-TAG-5: hasAllTags returns true when publisher has all required tags", async function () {
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      expect(await targeting.hasAllTags(publisher.address, [cryptoTag])).to.be.true;
    });
  });

  // ---------------------------------------------------------------------------
  // BM-GAS: Gas benchmarks — log gas per operation (no hard assertions)
  // ---------------------------------------------------------------------------
  describe("BM-GAS: Gas per operation", function () {
    const CPM    = parseDOT("0.2");
    const BUDGET = parseDOT("20");
    const DAILY  = parseDOT("4");

    async function gasFor(label: string, fn: () => Promise<any>): Promise<bigint> {
      const tx      = await fn();
      const receipt = await tx.wait();
      const gas     = receipt?.gasUsed ?? 0n;
      console.log(`  [BM-GAS] ${label}: ${gas} gas`);
      return gas;
    }

    it("BM-GAS-1: publisher registration gas", async function () {
      // Use a fresh signer (voter) to avoid duplicate registration
      // Note: voter already registered if needed; use a fresh approach
      const [,,,,,, extra] = await ethers.getSigners();
      if (extra) {
        await gasFor("registerPublisher", () =>
          publishers.connect(extra).registerPublisher(TAKE_RATE_BPS)
        );
      }
    });

    it("BM-GAS-2: campaign creation gas", async function () {
      await gasFor("createCampaign (fixed publisher)", () =>
        campaigns.connect(advertiser).createCampaign(
          publisher.address, DAILY, CPM, [], false, ethers.ZeroAddress, 0, { value: BUDGET }
        )
      );
    });

    it("BM-GAS-3: governance vote gas", async function () {
      // Create a campaign to vote on
      const tx = await campaigns.connect(advertiser).createCampaign(
        publisher.address, DAILY, CPM, [], false, ethers.ZeroAddress, 0, { value: BUDGET }
      );
      await tx.wait();
      const cid = await campaigns.nextCampaignId() - 1n;
      await gasFor("governance vote (aye, conviction 0)", () =>
        v2.connect(voter).vote(cid, true, 0, { value: QUORUM })
      );
    });

    it("BM-GAS-4: settleClaims gas — 1 claim × 100 imps", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n);
      await gasFor("settleClaims (1 claim × 100 imps)", () =>
        settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }])
      );
    });

    it("BM-GAS-5: settleClaims gas — 5 claims × 100 imps", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      const claims = buildClaims(cid, publisher.address, user.address, 5, CPM, 100n);
      await gasFor("settleClaims (5 claims × 100 imps)", () =>
        settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }])
      );
    });

    it("BM-GAS-6: settleClaims gas — ZK claim × 100 imps", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, publisher, [], true);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, "0xdeadbeef");
      await gasFor("settleClaims (1 ZK claim × 100 imps)", () =>
        settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }])
      );
    });

    it("BM-GAS-7: reportPage gas", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      await gasFor("reportPage (reason 1)", () =>
        reports.connect(user).reportPage(cid, 1)
      );
    });

    it("BM-GAS-8: reputation.recordSettlement gas", async function () {
      await gasFor("reputation.recordSettlement", () =>
        reputation.connect(reporter).recordSettlement(publisher.address, 99n, 100n, 5n)
      );
    });

    it("BM-GAS-9: vault.withdraw (publisher) gas", async function () {
      // Ensure publisher has a balance to withdraw
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
      const bal = await vault.publisherBalance(publisher.address);
      if (bal > 0n) {
        await gasFor("vault.withdraw (publisher)", () =>
          vault.connect(publisher).withdrawPublisher()
        );
      } else {
        console.log("  [BM-GAS-9] skipped: no publisher balance to withdraw");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // BM-LC: Full lifecycle benchmark at each price point
  // create → vote → activate → settle → complete → withdraw
  // ---------------------------------------------------------------------------
  describe("BM-LC: Full campaign lifecycle at each DOT price point", function () {
    for (const s of DOT_PRICE_SCENARIOS) {
      it(`BM-LC: ${s.label} — full lifecycle (create→vote→activate→settle→complete)`, async function () {
        const tx = await campaigns.connect(advertiser).createCampaign(
          publisher.address, s.dailyCap, s.cpm, [], false, ethers.ZeroAddress, 0, { value: s.budget }
        );
        await tx.wait();
        const cid = await campaigns.nextCampaignId() - 1n;

        // Vote + activate
        await v2.connect(voter).vote(cid, true, 0, { value: QUORUM });
        await v2.evaluateCampaign(cid);
        expect(await campaigns.getCampaignStatus(cid)).to.equal(1);

        // Settle 2 claims × 1000 impressions
        const claims = buildClaims(cid, publisher.address, user.address, 2, s.cpm, 1000n);
        const batch  = { user: user.address, campaignId: cid, claims };
        const r = await settlement.connect(user).settleClaims.staticCall([batch]);
        expect(r.settledCount).to.equal(2n);
        await settlement.connect(user).settleClaims([batch]);

        // Verify payment split (2 claims × 1000 imps)
        const { pub: expectedPub } = expectedPayments(s.cpm, 1000n, 2);
        const pubBal = await vault.publisherBalance(publisher.address);
        expect(pubBal).to.be.gte(expectedPub);

        // Complete campaign
        await lifecycle.connect(advertiser).completeCampaign(cid);
        expect(await campaigns.getCampaignStatus(cid)).to.equal(3); // Completed

        // Resolve governance
        await v2.evaluateCampaign(cid);
        expect(await v2.resolved(cid)).to.be.true;

        // Publisher withdraws
        const withdrawTx  = await vault.connect(publisher).withdrawPublisher();
        const withdrawRec = await withdrawTx.wait();
        console.log(`\n  [BM-LC ${s.label}] withdraw gas: ${withdrawRec?.gasUsed}`);
      });
    }
  });
});
