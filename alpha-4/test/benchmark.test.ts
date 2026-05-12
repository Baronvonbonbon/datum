/**
 * Datum Alpha-3 — Complete Benchmark Suite
 * =========================================
 * Comprehensive functional + economic benchmarks for all 20 alpha-4 contracts.
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
 *   BM-RPT-*  Community reports (inline in DatumCampaigns: page + ad reports)
 *   BM-TAG-*  Tag-based targeting (inline in DatumCampaigns)
 *   BM-GAS-*  Gas / weight measurements (logged to console, not asserting exact values)
 *   BM-LC-*   Full lifecycle: create → vote → activate → settle → complete → withdraw
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumPublishers,
  DatumCampaigns,
  DatumGovernanceV2,
  DatumSettlement,
  DatumRelay,
  DatumPauseRegistry,
  DatumBudgetLedger,
  DatumPaymentVault,
  DatumCampaignLifecycle,
  DatumAttestationVerifier,
  DatumClaimValidator,
  DatumTokenRewardVault,
  DatumSettlement,
  MockERC20,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT, formatDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
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
const ZK_EMPTY = new Array(8).fill(ethers.ZeroHash) as string[];
const ZK_STUB  = ["0x0000000000000000000000000000000000000000000000000000000000000001", ...new Array(7).fill(ethers.ZeroHash)] as string[];
const NO_SIG   = [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash] as string[];

function buildClaims(
  campaignId: bigint,
  publisherAddr: string,
  userAddr: string,
  count: number,
  cpm: bigint,
  impressions: bigint,
  zkProof: string[] = ZK_EMPTY,
) {
  const claims = [];
  let prevHash = ethers.ZeroHash;
  for (let i = 1; i <= count; i++) {
    const nonce = BigInt(i);
    const hash = ethersKeccakAbi(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
      [campaignId, publisherAddr, userAddr, impressions, cpm, 0, ethers.ZeroHash, nonce, prevHash]
    );
    claims.push({
      campaignId,
      publisher: publisherAddr,
      eventCount: impressions,
      ratePlanck: cpm,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof,
      nullifier: ethers.ZeroHash,
      actionSig: NO_SIG,
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
  let claimVal:     DatumClaimValidator;
  let settlement:   DatumSettlement;
  let relay:        DatumRelay;
  let verifier:     DatumAttestationVerifier;
  let tokenRewardVault: DatumTokenRewardVault;
  let mockERC20:    MockERC20;

  // Signers
  let owner:      HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher:  HardhatEthersSigner;
  let publisher2: HardhatEthersSigner;
  let user:       HardhatEthersSigner;
  let voter:      HardhatEthersSigner;
  let repSettlement: HardhatEthersSigner;

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

    [owner, advertiser, publisher, publisher2, user, voter, repSettlement] = await ethers.getSigners();

    // 1. Infrastructure
    pauseReg  = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, advertiser.address, publisher.address);
    publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(
      TAKE_RATE_DELAY, await pauseReg.getAddress()
    );
    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    vault  = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();

    // 2. Campaigns (targeting + validation now inline)
    campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
      MIN_CPM, PENDING_TIMEOUT, await publishers.getAddress(), await pauseReg.getAddress()
    );

    // 3. Lifecycle, Governance (slash + helper now inline in V2)
    lifecycle = await (await ethers.getContractFactory("DatumCampaignLifecycle")).deploy(
      await pauseReg.getAddress(), 432000n
    );
    v2 = await (await ethers.getContractFactory("DatumGovernanceV2")).deploy(
      await campaigns.getAddress(),
      QUORUM, SLASH_BPS, TERM_QUORUM, BASE_GRACE, GRACE_PER_Q, MAX_GRACE,
      await pauseReg.getAddress()
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

    // 6. BM-5: Rate limiter (inline in Settlement: window=200, cap=50000)
    await settlement.setRateLimits(200n, 50000n);

    // ---------------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------------
    await v2.setLifecycle(await lifecycle.getAddress());

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

    await claimVal.setZKVerifier(await zkVerifier.getAddress());

    await lifecycle.setCampaigns(await campaigns.getAddress());
    await lifecycle.setBudgetLedger(await ledger.getAddress());
    await lifecycle.setGovernanceContract(await v2.getAddress());
    await lifecycle.setSettlementContract(await settlement.getAddress());

    // Reputation now updates only inline via _processBatch; no reporter wiring needed.

    // 9. Token reward vault (ERC-20 sidecar)
    mockERC20 = await (await ethers.getContractFactory("MockERC20")).deploy("Test USD", "TUSD");
    tokenRewardVault = await (await ethers.getContractFactory("DatumTokenRewardVault")).deploy(await campaigns.getAddress());
    await settlement.setTokenRewardVault(await tokenRewardVault.getAddress());
    await settlement.setCampaigns(await campaigns.getAddress());
    await tokenRewardVault.setSettlement(await settlement.getAddress());

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
      pubAddr,
      [{ actionType: 0, budgetPlanck: budget, dailyCapPlanck: dailyCap, ratePlanck: cpm, actionVerifier: ethers.ZeroAddress }],
      requiredTags, requireZk, ethers.ZeroAddress, 0n, 0n, { value: budget }
    );
    await tx.wait();
    const cid = await campaigns.nextCampaignId() - 1n;
    await v2.connect(voter).vote(cid, true, 0, { value: QUORUM });
    await mineBlocks(MAX_GRACE + 1n); // AUDIT-011: symmetric grace period requires block cooldown
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
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, ZK_EMPTY);
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.rejectedCount).to.equal(1n);
      const tx = await settlement.connect(user).settleClaims([batch]);
      await expect(tx)
        .to.emit(settlement, "ClaimRejected")
        .withArgs(cid, user.address, 1n, 16n); // reason 16 = ZK proof missing
    });

    it("BM-ZK-2: ZK campaign settles with non-empty stub proof", async function () {
      // Non-zero bytes32[8] — stub verifier (any non-zero element → valid)
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, publisher, [], true);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, ZK_STUB);
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);
      await settlement.connect(user).settleClaims([batch]);
    });

    it("BM-ZK-3: Non-ZK campaign settles without proof (zkProof=empty)", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM, publisher, [], false);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, ZK_EMPTY);
      const batch  = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([batch]);
    });

    it("BM-ZK-4: Mixed ZK/non-ZK batch across all price points", async function () {
      // Each scenario: 1 ZK-required campaign + stub proof → settles
      for (const s of DOT_PRICE_SCENARIOS) {
        const cid = await newActiveCampaign(s.budget, s.dailyCap, s.cpm, publisher, [], true);
        const claims = buildClaims(cid, publisher.address, user.address, 1, s.cpm, 100n, ZK_STUB);
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
      // Create both campaigns first (before window mining) so the two settlements
      // are in the same window — newActiveCampaign mines ~52 blocks for AUDIT-011 grace,
      // which could cross a 200-block window boundary if done between settlements.
      const cid1 = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      const cid2 = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);

      // Align to the start of a fresh 200-block window with full headroom.
      // Otherwise upstream test counts can leave us near a boundary and the
      // two settlements below straddle two windows, masking the rate-limit hit.
      const cur = BigInt(await ethers.provider.getBlockNumber());
      const win = 200n;
      const next = ((cur / win) + 1n) * win;
      await mineBlocks(next - cur + 10n);

      // Use 49900 impressions (just under 50000 cap)
      const c1 = buildClaims(cid1, publisher.address, user.address, 1, RL_CPM, 49900n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid1, claims: c1 }]);

      // Next claim: 200 more → 50100 total > 50000 cap → rejected
      const hash = ethersKeccakAbi(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
        [cid2, publisher.address, user.address, 200n, RL_CPM, 0, ethers.ZeroHash, 1n, ethers.ZeroHash]
      );
      const c2 = [{
        campaignId: cid2,
        publisher:  publisher.address,
        eventCount: 200n,
        ratePlanck: RL_CPM,
        actionType: 0,
        clickSessionHash: ethers.ZeroHash,
        nonce: 1n,
        previousClaimHash: ethers.ZeroHash,
        claimHash: hash,
        zkProof: ZK_EMPTY,
        nullifier: ethers.ZeroHash,
        actionSig: NO_SIG,
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

    it("BM-RL-4: raising cap allows impressions above previous limit", async function () {
      await mineBlocks(210); // ensure fresh window
      await settlement.setRateLimits(200n, 100000000n); // effectively unlimited
      const cid = await newActiveCampaign(RL_BUDGET, RL_DAILY, RL_CPM);
      // 50000 impressions — would exceed old cap but new cap is very high
      const claims = buildClaims(cid, publisher.address, user.address, 1, RL_CPM, 50000n);
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(r.settledCount).to.equal(1n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
      // Restore
      await settlement.setRateLimits(200n, 50000n);
    });
  });

  // BM-REP block removed: the external recordSettlement() entry was dropped in
  // the threat-model #4 fix. Reputation now updates only inline via
  // _processBatch, which is implicitly exercised by every successful settle in
  // settlement.test.ts (S1-S8, R1-R10, etc.). The view formulas
  // (getReputationScore, isAnomaly, getPublisherStats) are simple bps math
  // over the same mappings.

  // ---------------------------------------------------------------------------
  // BM-RPT: Community reports (inline in DatumCampaigns)
  // ---------------------------------------------------------------------------
  describe("BM-RPT: Community reports (inline in DatumCampaigns)", function () {
    // Create a fixed campaign to report on — use mock-compatible createCampaign
    let reportCampaignId: bigint;
    // Extra campaigns for BM-RPT-3: dedup prevents same address from reporting same campaignId twice (AUDIT-023)
    let rptPageCampaignIds: bigint[];
    let rptAdCampaignIds: bigint[];
    const RPT_CPM    = parseDOT("0.2");
    const RPT_BUDGET = parseDOT("20");
    const RPT_DAILY  = parseDOT("4");

    before(async function () {
      reportCampaignId = await newActiveCampaign(RPT_BUDGET, RPT_DAILY, RPT_CPM);
      // 5 separate campaigns per reporter for each reason code in BM-RPT-3
      // (AUDIT-023 dedup: same address cannot report same campaign twice)
      rptPageCampaignIds = [];
      rptAdCampaignIds   = [];
      for (let i = 0; i < 5; i++) {
        rptPageCampaignIds.push(await newActiveCampaign(RPT_BUDGET, RPT_DAILY, RPT_CPM));
        rptAdCampaignIds.push(await newActiveCampaign(RPT_BUDGET, RPT_DAILY, RPT_CPM));
      }
    });

    it("BM-RPT-1: reportPage increments pageReports and emits event", async function () {
      const before = await campaigns.pageReports(reportCampaignId);
      await expect(campaigns.connect(user).reportPage(reportCampaignId, 1))
        .to.emit(campaigns, "PageReported")
        .withArgs(reportCampaignId, publisher.address, user.address, 1n);
      expect(await campaigns.pageReports(reportCampaignId)).to.equal(before + 1n);
    });

    it("BM-RPT-2: reportAd increments adReports and emits event", async function () {
      const before = await campaigns.adReports(reportCampaignId);
      await expect(campaigns.connect(user).reportAd(reportCampaignId, 3))
        .to.emit(campaigns, "AdReported")
        .withArgs(reportCampaignId, advertiser.address, user.address, 3n);
      expect(await campaigns.adReports(reportCampaignId)).to.equal(before + 1n);
    });

    it("BM-RPT-3: all 5 valid reason codes accepted", async function () {
      // Use separate campaigns per iteration — AUDIT-023 dedup prevents re-reporting same campaign
      for (let r = 1; r <= 5; r++) {
        await expect(campaigns.connect(user).reportPage(rptPageCampaignIds[r - 1], r)).not.to.be.reverted;
        await expect(campaigns.connect(user).reportAd(rptAdCampaignIds[r - 1], r)).not.to.be.reverted;
      }
    });

    it("BM-RPT-4: invalid reason (0 or 6) reverts E68", async function () {
      await expect(campaigns.connect(user).reportPage(reportCampaignId, 0)).to.be.revertedWith("E68");
      await expect(campaigns.connect(user).reportPage(reportCampaignId, 6)).to.be.revertedWith("E68");
    });

    it("BM-RPT-5: non-existent campaign reverts E01", async function () {
      await expect(campaigns.connect(user).reportPage(999999n, 1)).to.be.revertedWith("E01");
    });
  });

  // ---------------------------------------------------------------------------
  // BM-TAG: Tag-based targeting (inline in DatumCampaigns)
  // ---------------------------------------------------------------------------
  describe("BM-TAG: Tag-based targeting", function () {
    const TAG_CPM    = parseDOT("0.2");
    const TAG_BUDGET = parseDOT("20");
    const TAG_DAILY  = parseDOT("4");

    before(async function () {
      // Set tags on publisher
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      const defiTag   = ethers.encodeBytes32String("topic:defi");
      await campaigns.connect(publisher).setPublisherTags([cryptoTag, defiTag]);
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
          publisher2.address,
          [{ actionType: 0, budgetPlanck: TAG_BUDGET, dailyCapPlanck: TAG_DAILY, ratePlanck: TAG_CPM, actionVerifier: ethers.ZeroAddress }],
          [cryptoTag], false, ethers.ZeroAddress, 0n, 0n, { value: TAG_BUDGET }
        )
      ).to.be.reverted; // E66 or validator rejection
    });

    it("BM-TAG-3: open campaign with required tags — no publisher validation at creation", async function () {
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      // Open campaign (publisher=0) with required tags: creation succeeds (no publisher to validate)
      const cid = await newActiveCampaign(TAG_BUDGET, TAG_DAILY, TAG_CPM, ethers.ZeroAddress, [cryptoTag]);
      expect(cid).to.be.gt(0n);
    });

    it("BM-TAG-4: publisher tags correctly returned by Campaigns", async function () {
      const tags = await campaigns.getPublisherTags2(publisher.address);
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      const defiTag   = ethers.encodeBytes32String("topic:defi");
      expect(tags).to.include(cryptoTag);
      expect(tags).to.include(defiTag);
    });

    it("BM-TAG-5: hasAllTags returns true when publisher has all required tags", async function () {
      const cryptoTag = ethers.encodeBytes32String("topic:crypto");
      expect(await campaigns.hasAllTags(publisher.address, [cryptoTag])).to.be.true;
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
          publisher.address,
          [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
          [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
        )
      );
    });

    it("BM-GAS-3: governance vote gas", async function () {
      // Create a campaign to vote on
      const tx = await campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
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
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n, ZK_STUB);
      await gasFor("settleClaims (1 ZK claim × 100 imps)", () =>
        settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }])
      );
    });

    it("BM-GAS-7: reportPage gas", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      await gasFor("reportPage (reason 1)", () =>
        campaigns.connect(user).reportPage(cid, 1)
      );
    });

    // BM-GAS-8 (settlement.recordSettlement) removed — the external reporter
    // entry was deleted in the threat-model #4 fix. Reputation cost is now
    // amortized inside _processBatch and shows up in BM-GAS-3 (settleClaims).

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
          publisher.address,
          [{ actionType: 0, budgetPlanck: s.budget, dailyCapPlanck: s.dailyCap, ratePlanck: s.cpm, actionVerifier: ethers.ZeroAddress }],
          [], false, ethers.ZeroAddress, 0n, 0n, { value: s.budget }
        );
        await tx.wait();
        const cid = await campaigns.nextCampaignId() - 1n;

        // Vote + activate
        await v2.connect(voter).vote(cid, true, 0, { value: QUORUM });
        await mineBlocks(MAX_GRACE + 1n); // AUDIT-011: symmetric grace period
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

  // ---------------------------------------------------------------------------
  // BM-META: IPFS-infused campaign metadata (bytes32 CID hash round-trip)
  // ---------------------------------------------------------------------------
  // CIDv0 ↔ bytes32: strip 0x1220 multihash prefix from SHA-256 digest.
  // cidToBytes32("Qm...") = keccak256 of the path for test purposes —
  // the real extension strips the 0x1220 prefix from base58-decoded CID bytes.
  // For benchmark we use a known 32-byte digest directly.
  describe("BM-META: IPFS metadata campaigns", function () {
    // Known CIDv0 SHA-256 digest (bytes32 without 0x1220 multihash prefix)
    const IPFS_HASH = "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" as const;
    const CPM    = parseDOT("0.016");
    const BUDGET = parseDOT("5");
    const DAILY  = parseDOT("1");

    it("BM-META-1: setMetadata stores bytes32 CID digest on-chain", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      const tx = await campaigns.connect(advertiser).setMetadata(cid, IPFS_HASH);
      const receipt = await tx.wait();
      console.log(`\n  [BM-META-1] setMetadata gas: ${receipt?.gasUsed}`);

      expect(await campaigns.getCampaignMetadata(cid)).to.equal(IPFS_HASH);
    });

    it("BM-META-2: getCampaignMetadata returns zero for campaigns without metadata", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      expect(await campaigns.getCampaignMetadata(cid)).to.equal(ethers.ZeroHash);
    });

    it("BM-META-3: setMetadata emits CampaignMetadataSet event", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      await expect(campaigns.connect(advertiser).setMetadata(cid, IPFS_HASH))
        .to.emit(campaigns, "CampaignMetadataSet")
        .withArgs(cid, IPFS_HASH, 1n);
    });

    it("BM-META-4: metadata survives settlement (immutable tag data)", async function () {
      const cid = await newActiveCampaign(BUDGET, DAILY, CPM);
      await campaigns.connect(advertiser).setMetadata(cid, IPFS_HASH);

      // Settle 1 claim
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

      // Metadata unchanged
      expect(await campaigns.getCampaignMetadata(cid)).to.equal(IPFS_HASH);
    });

    it("BM-META-5: two campaigns with different IPFS hashes coexist independently", async function () {
      const hash1 = "0x" + "ab".repeat(32);
      const hash2 = "0x" + "cd".repeat(32);
      const cid1 = await newActiveCampaign(BUDGET, DAILY, CPM);
      const cid2 = await newActiveCampaign(BUDGET, DAILY, CPM);
      await campaigns.connect(advertiser).setMetadata(cid1, hash1);
      await campaigns.connect(advertiser).setMetadata(cid2, hash2);
      expect(await campaigns.getCampaignMetadata(cid1)).to.equal(hash1);
      expect(await campaigns.getCampaignMetadata(cid2)).to.equal(hash2);
    });

    it("BM-META-6: gas comparison — settle IPFS campaign vs. no-metadata campaign", async function () {
      // Campaign A: with metadata
      const cidA = await newActiveCampaign(BUDGET, DAILY, CPM);
      await campaigns.connect(advertiser).setMetadata(cidA, IPFS_HASH);
      const claimsA = buildClaims(cidA, publisher.address, user.address, 1, CPM, 500n);
      const txA = await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cidA, claims: claimsA }]);
      const recA = await txA.wait();

      // Campaign B: without metadata
      const cidB = await newActiveCampaign(BUDGET, DAILY, CPM);
      const claimsB = buildClaims(cidB, publisher.address, user.address, 1, CPM, 500n);
      const txB = await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cidB, claims: claimsB }]);
      const recB = await txB.wait();

      console.log(`\n  [BM-META-6] settle w/ metadata: ${recA?.gasUsed} gas`);
      console.log(`  [BM-META-6] settle no metadata:  ${recB?.gasUsed} gas`);
      // Metadata is stored off-chain (IPFS); settlement gas should be equivalent
      // Allow ±10% tolerance
      const gasA = Number(recA?.gasUsed ?? 0n);
      const gasB = Number(recB?.gasUsed ?? 0n);
      expect(gasA).to.be.within(gasB * 0.9, gasB * 1.1);
    });
  });

  // ---------------------------------------------------------------------------
  // BM-TOKEN: ERC-20 sidecar reward campaigns
  // ---------------------------------------------------------------------------
  // DatumTokenRewardVault: advertiser deposits ERC-20 budget; settlement credits
  // per-impression amounts non-critically; user pulls via withdraw(token).
  describe("BM-TOKEN: ERC-20 sidecar reward campaigns", function () {
    const CPM              = parseDOT("0.016");
    const BUDGET           = parseDOT("5");
    const DAILY            = parseDOT("1");
    const TOKEN_DECIMALS   = 18n;
    const REWARD_PER_IMP   = 10n ** TOKEN_DECIMALS / 1000n; // 0.001 TUSD per impression
    const TOKEN_BUDGET     = 1000n * REWARD_PER_IMP * 1000n; // 1000 TUSD (for 1M impressions)

    async function newTokenCampaign(): Promise<bigint> {
      const pubAddr = publisher.address;
      const tx = await campaigns.connect(advertiser).createCampaign(
        pubAddr,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
        [], false,
        await mockERC20.getAddress(),
        REWARD_PER_IMP,
        0n,
        { value: BUDGET }
      );
      await tx.wait();
      const cid = await campaigns.nextCampaignId() - 1n;
      await v2.connect(voter).vote(cid, true, 0, { value: QUORUM });
      await mineBlocks(MAX_GRACE + 1n);
      await v2.evaluateCampaign(cid);
      expect(await campaigns.getCampaignStatus(cid)).to.equal(1);
      return cid;
    }

    it("BM-TOKEN-1: campaign created with ERC-20 reward token", async function () {
      const cid = await newTokenCampaign();
      expect(await campaigns.getCampaignRewardToken(cid)).to.equal(await mockERC20.getAddress());
      expect(await campaigns.getCampaignRewardPerImpression(cid)).to.equal(REWARD_PER_IMP);
    });

    it("BM-TOKEN-2: advertiser deposits ERC-20 budget to vault", async function () {
      const cid = await newTokenCampaign();
      await mockERC20.mint(advertiser.address, TOKEN_BUDGET);
      await mockERC20.connect(advertiser).approve(await tokenRewardVault.getAddress(), TOKEN_BUDGET);
      const tx = await tokenRewardVault.connect(advertiser).depositCampaignBudget(
        cid, await mockERC20.getAddress(), TOKEN_BUDGET
      );
      const receipt = await tx.wait();
      console.log(`\n  [BM-TOKEN-2] depositCampaignBudget gas: ${receipt?.gasUsed}`);

      expect(await tokenRewardVault.campaignTokenBudget(await mockERC20.getAddress(), cid))
        .to.equal(TOKEN_BUDGET);
    });

    it("BM-TOKEN-3: settle credits ERC-20 reward to user balance", async function () {
      const cid = await newTokenCampaign();
      const impressions = 1000n;

      // Fund vault
      await mockERC20.mint(advertiser.address, TOKEN_BUDGET);
      await mockERC20.connect(advertiser).approve(await tokenRewardVault.getAddress(), TOKEN_BUDGET);
      await tokenRewardVault.connect(advertiser).depositCampaignBudget(
        cid, await mockERC20.getAddress(), TOKEN_BUDGET
      );

      const tokenBalBefore = await tokenRewardVault.userTokenBalance(
        await mockERC20.getAddress(), user.address
      );

      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, impressions);
      const tx = await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
      const receipt = await tx.wait();
      console.log(`\n  [BM-TOKEN-3] settle w/ ERC-20 credit gas: ${receipt?.gasUsed}`);

      const expectedReward = REWARD_PER_IMP * impressions;
      const tokenBalAfter = await tokenRewardVault.userTokenBalance(
        await mockERC20.getAddress(), user.address
      );
      expect(tokenBalAfter - tokenBalBefore).to.equal(expectedReward);
    });

    it("BM-TOKEN-4: user withdraws ERC-20 reward", async function () {
      const cid = await newTokenCampaign();
      const impressions = 500n;

      // Fund vault and settle
      await mockERC20.mint(advertiser.address, TOKEN_BUDGET);
      await mockERC20.connect(advertiser).approve(await tokenRewardVault.getAddress(), TOKEN_BUDGET);
      await tokenRewardVault.connect(advertiser).depositCampaignBudget(
        cid, await mockERC20.getAddress(), TOKEN_BUDGET
      );
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, impressions);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

      const creditedAmount = await tokenRewardVault.userTokenBalance(
        await mockERC20.getAddress(), user.address
      );
      expect(creditedAmount).to.be.gt(0n);

      const walletBefore = await mockERC20.balanceOf(user.address);
      const tx = await tokenRewardVault.connect(user).withdraw(await mockERC20.getAddress());
      const receipt = await tx.wait();
      console.log(`\n  [BM-TOKEN-4] ERC-20 withdraw gas: ${receipt?.gasUsed}`);

      const walletAfter = await mockERC20.balanceOf(user.address);
      expect(walletAfter - walletBefore).to.equal(creditedAmount);
      expect(await tokenRewardVault.userTokenBalance(
        await mockERC20.getAddress(), user.address
      )).to.equal(0n);
    });

    it("BM-TOKEN-5: settle continues (non-critical) when vault budget exhausted", async function () {
      const cid = await newTokenCampaign();
      // Deposit only 1 token unit — far less than reward for 1000 impressions
      await mockERC20.mint(advertiser.address, 1n);
      await mockERC20.connect(advertiser).approve(await tokenRewardVault.getAddress(), 1n);
      await tokenRewardVault.connect(advertiser).depositCampaignBudget(
        cid, await mockERC20.getAddress(), 1n
      );

      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 1000n);
      // Settlement must NOT revert even though token budget is insufficient
      const result = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
      // DOT payment still went through; token credit was skipped silently
      expect(await vault.userBalance(user.address)).to.be.gt(0n);
    });

    it("BM-TOKEN-6: native asset precompile address accepted as reward token (no metadata calls)", async function () {
      // USDT precompile address on Asset Hub — no name/symbol/decimals ABI
      const USDT_PRECOMPILE = "0x000007C000000000000000000000000001200000";
      const pubAddr = publisher.address;
      // createCampaign with native asset address — should not revert (no metadata validation in contract)
      const tx = await campaigns.connect(advertiser).createCampaign(
        pubAddr,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM, actionVerifier: ethers.ZeroAddress }],
        [], false,
        USDT_PRECOMPILE,
        REWARD_PER_IMP,
        0n,
        { value: BUDGET }
      );
      await tx.wait();
      const cid = await campaigns.nextCampaignId() - 1n;
      expect((await campaigns.getCampaignRewardToken(cid)).toLowerCase()).to.equal(USDT_PRECOMPILE.toLowerCase());
      // Settlement will attempt creditReward; low-level call to precompile will silently fail on EVM
      // This validates the non-critical path handles unknown ERC-20 gracefully
      await v2.connect(voter).vote(cid, true, 0, { value: QUORUM });
      await mineBlocks(MAX_GRACE + 1n);
      await v2.evaluateCampaign(cid);
      const claims = buildClaims(cid, publisher.address, user.address, 1, CPM, 100n);
      const result = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims }
      ]);
      // DOT settlement succeeds; ERC-20 credit silently skipped for unknown precompile
      expect(result.settledCount).to.equal(1n);
    });
  });

  // ---------------------------------------------------------------------------
  // BM-COMP: Multi-campaign CPM price competition
  // ---------------------------------------------------------------------------
  // Three concurrent campaigns with different CPM bids from the same advertiser.
  // Publisher and user settle all three simultaneously to demonstrate that:
  //   (a) each campaign honours its own CPM independently,
  //   (b) a second-price auction dynamic is observable: higher-CPM campaign
  //       pays the per-claim amount matching its own bid,
  //   (c) gas cost scales linearly with campaign count in a multi-batch.
  describe("BM-COMP: Competing campaign CPM price scenarios", function () {
    const BUDGET = parseDOT("20");
    const DAILY  = parseDOT("4");
    // Three campaigns at different CPM: premium, mid, budget
    const CPM_PREMIUM = parseDOT("0.5");   // $1 CPM at DOT $2 (premium)
    const CPM_MID     = parseDOT("0.2");   // $1 CPM at DOT $5 (mid)
    const CPM_BUDGET  = parseDOT("0.1");   // $1 CPM at DOT $10 (economy)

    it("BM-COMP-1: three campaigns at different CPMs settle independently with correct payouts", async function () {
      const cidP = await newActiveCampaign(BUDGET, DAILY, CPM_PREMIUM);
      const cidM = await newActiveCampaign(BUDGET, DAILY, CPM_MID);
      const cidB = await newActiveCampaign(BUDGET, DAILY, CPM_BUDGET);

      const impressions = 1000n;

      const pubBalBefore  = await vault.publisherBalance(publisher.address);
      const userBalBefore = await vault.userBalance(user.address);

      // Settle all three in a single multi-campaign call (settleClaimsMulti pattern via three batches)
      const batchP = { user: user.address, campaignId: cidP, claims: buildClaims(cidP, publisher.address, user.address, 1, CPM_PREMIUM, impressions) };
      const batchM = { user: user.address, campaignId: cidM, claims: buildClaims(cidM, publisher.address, user.address, 1, CPM_MID,     impressions) };
      const batchB = { user: user.address, campaignId: cidB, claims: buildClaims(cidB, publisher.address, user.address, 1, CPM_BUDGET,  impressions) };

      const result = await settlement.connect(user).settleClaims.staticCall([batchP, batchM, batchB]);
      expect(result.settledCount).to.equal(3n);
      expect(result.rejectedCount).to.equal(0n);

      const tx = await settlement.connect(user).settleClaims([batchP, batchM, batchB]);
      const receipt = await tx.wait();
      console.log(`\n  [BM-COMP-1] 3-campaign batch settle gas: ${receipt?.gasUsed}`);

      const { pub: pubP, user: userP } = expectedPayments(CPM_PREMIUM, impressions, 1);
      const { pub: pubM, user: userM } = expectedPayments(CPM_MID,     impressions, 1);
      const { pub: pubB, user: userB } = expectedPayments(CPM_BUDGET,  impressions, 1);

      const pubDelta  = (await vault.publisherBalance(publisher.address)) - pubBalBefore;
      const userDelta = (await vault.userBalance(user.address)) - userBalBefore;

      const expectedPubTotal  = pubP  + pubM  + pubB;
      const expectedUserTotal = userP + userM + userB;

      expect(pubDelta).to.equal(expectedPubTotal,  "publisher total payout mismatch");
      expect(userDelta).to.equal(expectedUserTotal, "user total payout mismatch");

      console.log(`  [BM-COMP-1] premium CPM (${formatDOT(CPM_PREMIUM)}): pub +${formatDOT(pubP)} DOT`);
      console.log(`  [BM-COMP-1] mid CPM     (${formatDOT(CPM_MID)}): pub +${formatDOT(pubM)} DOT`);
      console.log(`  [BM-COMP-1] budget CPM  (${formatDOT(CPM_BUDGET)}): pub +${formatDOT(pubB)} DOT`);
    });

    it("BM-COMP-2: per-campaign CPM honoured — premium pays 5× more than budget", async function () {
      const cidP = await newActiveCampaign(BUDGET, DAILY, CPM_PREMIUM);
      const cidB = await newActiveCampaign(BUDGET, DAILY, CPM_BUDGET);
      const impressions = 1000n;

      const pubBefore = await vault.publisherBalance(publisher.address);
      await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cidP, claims: buildClaims(cidP, publisher.address, user.address, 1, CPM_PREMIUM, impressions) },
      ]);
      const pubAfterP = await vault.publisherBalance(publisher.address);

      const pubBefore2 = await vault.publisherBalance(publisher.address);
      await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cidB, claims: buildClaims(cidB, publisher.address, user.address, 1, CPM_BUDGET,  impressions) },
      ]);
      const pubAfterB = await vault.publisherBalance(publisher.address);

      const premiumPub = pubAfterP - pubBefore;
      const budgetPub  = pubAfterB - pubBefore2;

      expect(premiumPub).to.equal(budgetPub * 5n,
        `premium CPM (${formatDOT(CPM_PREMIUM)}) should pay exactly 5× budget CPM (${formatDOT(CPM_BUDGET)})`);
    });

    it("BM-COMP-3: IPFS campaign + ERC-20 sidecar campaign + plain campaign compete", async function () {
      // Campaign A: has IPFS metadata
      const cidA = await newActiveCampaign(BUDGET, DAILY, CPM_MID);
      const IPFS_HASH = "0x" + "aa".repeat(32);
      await campaigns.connect(advertiser).setMetadata(cidA, IPFS_HASH);

      // Campaign B: ERC-20 sidecar
      const rewardPerImp = 10n ** 15n; // 0.001 TUSD per impression (18 dec)
      const tokenBudget  = rewardPerImp * 5000n;
      await mockERC20.mint(advertiser.address, tokenBudget);
      const txB = await campaigns.connect(advertiser).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY, ratePlanck: CPM_PREMIUM, actionVerifier: ethers.ZeroAddress }],
        [], false,
        await mockERC20.getAddress(), rewardPerImp, 0n, { value: BUDGET }
      );
      await txB.wait();
      const cidB = await campaigns.nextCampaignId() - 1n;
      await v2.connect(voter).vote(cidB, true, 0, { value: QUORUM });
      await mineBlocks(MAX_GRACE + 1n);
      await v2.evaluateCampaign(cidB);
      await mockERC20.connect(advertiser).approve(await tokenRewardVault.getAddress(), tokenBudget);
      await tokenRewardVault.connect(advertiser).depositCampaignBudget(
        cidB, await mockERC20.getAddress(), tokenBudget
      );

      // Campaign C: plain
      const cidC = await newActiveCampaign(BUDGET, DAILY, CPM_BUDGET);

      const userTokenBefore = await tokenRewardVault.userTokenBalance(
        await mockERC20.getAddress(), user.address
      );

      const impressions = 1000n;
      const batchA = { user: user.address, campaignId: cidA, claims: buildClaims(cidA, publisher.address, user.address, 1, CPM_MID,     impressions) };
      const batchB = { user: user.address, campaignId: cidB, claims: buildClaims(cidB, publisher.address, user.address, 1, CPM_PREMIUM, impressions) };
      const batchC = { user: user.address, campaignId: cidC, claims: buildClaims(cidC, publisher.address, user.address, 1, CPM_BUDGET,  impressions) };

      const tx = await settlement.connect(user).settleClaims([batchA, batchB, batchC]);
      const receipt = await tx.wait();
      console.log(`\n  [BM-COMP-3] mixed 3-campaign settle gas: ${receipt?.gasUsed}`);

      // IPFS campaign: metadata persisted
      expect(await campaigns.getCampaignMetadata(cidA)).to.equal(IPFS_HASH);

      // ERC-20 sidecar campaign: token credited
      const userTokenAfter = await tokenRewardVault.userTokenBalance(
        await mockERC20.getAddress(), user.address
      );
      expect(userTokenAfter - userTokenBefore).to.equal(rewardPerImp * impressions);

      // All three settled
      const { pub: pA } = expectedPayments(CPM_MID,     impressions, 1);
      const { pub: pB } = expectedPayments(CPM_PREMIUM, impressions, 1);
      const { pub: pC } = expectedPayments(CPM_BUDGET,  impressions, 1);
      console.log(`  [BM-COMP-3] IPFS mid-CPM pub payout:    ${formatDOT(pA)} DOT`);
      console.log(`  [BM-COMP-3] ERC-20 premium-CPM payout:  ${formatDOT(pB)} DOT`);
      console.log(`  [BM-COMP-3] plain budget-CPM payout:    ${formatDOT(pC)} DOT`);
    });

    it("BM-COMP-4: gas scales linearly — 1 vs 3 campaigns in one settleClaims call", async function () {
      const cidSingle = await newActiveCampaign(BUDGET, DAILY, CPM_MID);
      const cid2      = await newActiveCampaign(BUDGET, DAILY, CPM_MID);
      const cid3      = await newActiveCampaign(BUDGET, DAILY, CPM_MID);
      const impressions = 100n;

      // Single campaign
      const txSingle = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cidSingle, claims: buildClaims(cidSingle, publisher.address, user.address, 1, CPM_MID, impressions) }
      ]);
      const recSingle = await txSingle.wait();

      // Three campaigns
      const txTriple = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid2, claims: buildClaims(cid2, publisher.address, user.address, 1, CPM_MID, impressions) },
        { user: user.address, campaignId: cid3, claims: buildClaims(cid3, publisher.address, user.address, 1, CPM_MID, impressions) },
        { user: user.address, campaignId: cidSingle, claims: buildClaims(cidSingle, publisher.address, user.address, 1, CPM_MID, impressions) },
      ]);
      const recTriple = await txTriple.wait();

      const gasSingle = Number(recSingle?.gasUsed ?? 0n);
      const gasTriple = Number(recTriple?.gasUsed ?? 0n);

      console.log(`\n  [BM-COMP-4] 1-campaign settle: ${gasSingle} gas`);
      console.log(`  [BM-COMP-4] 3-campaign settle: ${gasTriple} gas`);
      console.log(`  [BM-COMP-4] per-campaign overhead: ~${Math.round((gasTriple - gasSingle) / 2)} gas`);

      // Triple should be 2–4× single (linear ± overhead)
      expect(gasTriple).to.be.within(gasSingle * 1.5, gasSingle * 4.5);
    });
  });
});
