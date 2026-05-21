import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  DatumSettlement,
  DatumPauseRegistry,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumClaimValidator,
  MockCampaigns,
} from "../typechain-types";
import { parseDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
import { fundSigners } from "./helpers/mine";
import { wireSettlementLogic } from "./helpers/settlementLogic";

// Regression test for F-001 / F-002 (multi-publisher batch payment
// misallocation + reputation gate first-publisher only).
//
// Before the fix: LogicB._processBatch accepted a batch whose claims
// referenced different publisher addresses, then credited the entire
// per-batch publisher payment to claims[0].publisher (via the agg.publisher
// assignment) and used claims[0].publisher for the reputation canSettle
// gate. A malicious publisher could pack other publishers' claims into a
// batch and pocket their revenue while bypassing reputation throttling.
//
// After the fix (LogicB line 49-58): every claim must share
// claims[0].publisher, otherwise the batch reverts E34. DualSig and
// Relay's open-campaign path already enforced this; the LogicB-level
// check closes the user-EOA / attestation / targeted-multi-publisher gaps.

describe("Audit F-001 / F-002: single-publisher per batch enforcement", function () {
  let settlement: DatumSettlement;
  let mock: MockCampaigns;
  let pauseReg: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let pubA: HardhatEthersSigner;
  let pubB: HardhatEthersSigner;
  let relay: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM   = parseDOT("0.016");
  const BUDGET     = parseDOT("10");
  const DAILY_CAP  = parseDOT("1");
  const IMPRESSIONS = 1000n;

  let _nextId = 1n;
  function nextId(): bigint { return _nextId++; }

  // Build a chain where consecutive claims can target any publisher we
  // choose — the chain hash math links them by nonce / prevHash, not by
  // publisher identity. The point is to construct exactly the kind of
  // mixed-publisher batch the F-001 fix should reject.
  function buildClaim(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    nonce: bigint,
    prevHash: string
  ) {
    const hash = ethersKeccakAbi(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
      [campaignId, publisherAddr, userAddr, IMPRESSIONS, BID_CPM, 0, ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash]
    );
    return {
      claim: {
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
        stakeRootUsed: ethers.ZeroHash,
        actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        powNonce: ethers.ZeroHash,
      },
      hash,
    };
  }

  async function createCampaign(publisherAddr: string): Promise<bigint> {
    const id = nextId();
    await mock.setCampaign(id, owner.address, publisherAddr, BID_CPM, TAKE_RATE_BPS, 1);
    await mock.initBudget(id, 0, BUDGET, DAILY_CAP, { value: BUDGET });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, pubA, pubB, relay] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, user.address, relay.address);

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
    await wireSettlementLogic(settlement as any);

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await mock.getAddress(),
      relay.address
    );
    await settlement.setClaimValidator(await validator.getAddress());
    await settlement.setPublishers(await mock.getAddress());
    await settlement.setCampaigns(await mock.getAddress());

    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());

    await mock.setBudgetLedger(await ledger.getAddress());
    await vault.setSettlement(await settlement.getAddress());
  });

  it("reverts E34 when a batch mixes publisher addresses across claims", async function () {
    const cid = await createCampaign(pubA.address);

    // claim 0 = pubA, claim 1 = pubB — chain hashes are otherwise valid.
    const c0 = buildClaim(cid, pubA.address, user.address, 1n, ethers.ZeroHash);
    const c1 = buildClaim(cid, pubB.address, user.address, 2n, c0.hash);

    await expect(
      settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c0.claim, c1.claim] }
      ])
    ).to.be.revertedWithCustomError(settlement, "E34");
  });

  it("reverts E34 when an attacker tries to pack claims[0]=attacker with later claims=victim", async function () {
    const cid = await createCampaign(pubA.address);

    // pubB (attacker) submits a batch where slot 0 names pubB and slot 1
    // names pubA — pre-fix, aggregation would credit pubA's revenue to
    // pubB. Post-fix the batch is rejected.
    const c0 = buildClaim(cid, pubB.address, user.address, 1n, ethers.ZeroHash);
    const c1 = buildClaim(cid, pubA.address, user.address, 2n, c0.hash);

    await expect(
      settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c0.claim, c1.claim] }
      ])
    ).to.be.revertedWithCustomError(settlement, "E34");
  });

  it("accepts a batch where every claim shares the same publisher", async function () {
    const cid = await createCampaign(pubA.address);

    const c0 = buildClaim(cid, pubA.address, user.address, 1n, ethers.ZeroHash);
    const c1 = buildClaim(cid, pubA.address, user.address, 2n, c0.hash);

    await expect(
      settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c0.claim, c1.claim] }
      ])
    ).to.not.be.reverted;

    // F-002 corollary: with single-publisher enforcement, the reputation
    // canSettle gate (which reads claims[0].publisher) now matches every
    // claim in the batch — a publisher under reputation throttling can no
    // longer evade the gate by placing a clean publisher in slot 0.
    expect(await vault.publisherBalance(pubA.address)).to.be.gt(0);
    expect(await vault.publisherBalance(pubB.address)).to.equal(0);
  });

  it("single-claim batch is unaffected (claims.length > 1 guard)", async function () {
    const cid = await createCampaign(pubA.address);

    const c0 = buildClaim(cid, pubA.address, user.address, 1n, ethers.ZeroHash);

    await expect(
      settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c0.claim] }
      ])
    ).to.not.be.reverted;
  });

  it("settleClaimsMulti also rejects mixed-publisher batches", async function () {
    const cid = await createCampaign(pubA.address);

    const c0 = buildClaim(cid, pubA.address, user.address, 1n, ethers.ZeroHash);
    const c1 = buildClaim(cid, pubB.address, user.address, 2n, c0.hash);

    await expect(
      settlement.connect(user).settleClaimsMulti([
        { user: user.address, campaigns: [{ campaignId: cid, claims: [c0.claim, c1.claim] }] }
      ])
    ).to.be.revertedWithCustomError(settlement, "E34");
  });

  it("processVerifiedBatch path (dual-sig) also enforces single-publisher via LogicB", async function () {
    // DualSig already enforces single-publisher upstream of LogicB at
    // DatumDualSigSettlement.sol:191-195, so this is belt-and-suspenders
    // confirmation that LogicB's own check fires when the dual-sig caller
    // bypasses or is the gate (test-only: we call processVerifiedBatch
    // directly from a wired _dualSig).
    const cid = await createCampaign(pubA.address);

    // Wire owner as the dualSig caller for this test path.
    await settlement.connect(owner).setDualSig(owner.address);

    const c0 = buildClaim(cid, pubA.address, user.address, 1n, ethers.ZeroHash);
    const c1 = buildClaim(cid, pubB.address, user.address, 2n, c0.hash);

    await expect(
      settlement.connect(owner).processVerifiedBatch(user.address, cid, [c0.claim, c1.claim])
    ).to.be.revertedWithCustomError(settlement, "E34");
  });
});
