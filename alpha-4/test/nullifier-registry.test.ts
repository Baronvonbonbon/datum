import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumSettlement,
  DatumPauseRegistry,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumClaimValidator,
  DatumRelay,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
import { fundSigners } from "./helpers/mine";

// Nullifier tests (FP-5, alpha-4 consolidation — merged into Settlement):
// NR1:  setNullifierWindowBlocks stores value correctly
// NR2:  setNullifierWindowBlocks only callable by owner
// NR3:  setNullifierWindowBlocks reverts on zero
// NR4:  isNullifierUsed returns false before any settlement
// NR5:  After settling a claim with nullifier, isNullifierUsed returns true
// NR6:  Same nullifier on different campaign is allowed
// NR7:  Duplicate nullifier causes ClaimRejected(reason=19)
// NR8:  bytes32(0) nullifier skips check — settles normally
// NR9:  NullifierSubmitted event emitted on successful settlement

const WINDOW_BLOCKS = 14400n;

describe("Settlement Nullifier (inline)", function () {
  const BID_CPM = parseDOT("0.001");
  const BUDGET = parseDOT("10");
  const DAILY_CAP = parseDOT("5");
  const TAKE_RATE = 1000; // 10%
  const IMPRESSIONS = 1000n;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let settlement: DatumSettlement;
  let pauseRegistry: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;
  let relay: DatumRelay;
  let mock: MockCampaigns;

  let campaignId: bigint;

  before(async function () {
    await fundSigners();
    [owner, user, publisher, other] = await ethers.getSigners();

    pauseRegistry = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
      owner.address, user.address, publisher.address
    ) as DatumPauseRegistry;

    mock = await (await ethers.getContractFactory("MockCampaigns")).deploy() as MockCampaigns;

    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy() as DatumBudgetLedger;
    vault = await (await ethers.getContractFactory("DatumPaymentVault")).deploy() as DatumPaymentVault;

    validator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
      await mock.getAddress(),
      await mock.getAddress(),
      await pauseRegistry.getAddress()
    ) as DatumClaimValidator;

    settlement = await (await ethers.getContractFactory("DatumSettlement")).deploy(
      await pauseRegistry.getAddress()
    ) as DatumSettlement;

    relay = await (await ethers.getContractFactory("DatumRelay")).deploy(
      await settlement.getAddress(),
      await mock.getAddress(),
      await pauseRegistry.getAddress()
    ) as DatumRelay;

    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await mock.getAddress(),
      await relay.getAddress()
    );
    await settlement.setClaimValidator(await validator.getAddress());
    await settlement.setPublishers(await mock.getAddress());

    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());
    await mock.setBudgetLedger(await ledger.getAddress());
    await vault.setSettlement(await settlement.getAddress());

    // Set nullifier window
    await settlement.setNullifierWindowBlocks(WINDOW_BLOCKS);

    // Create a test campaign
    campaignId = 1n;
    await mock.setCampaign(campaignId, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(campaignId, 0, BUDGET, DAILY_CAP, { value: BUDGET });
  });

  function buildClaim(cid: bigint, nonce: bigint, prevHash: string, nullifier: string): any {
    const hash = ethersKeccakAbi(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
      [cid, publisher.address, user.address, IMPRESSIONS, BID_CPM, 0, ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash]
    );
    return {
      campaignId: cid,
      publisher: publisher.address,
      eventCount: IMPRESSIONS,
      ratePlanck: BID_CPM,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof: new Array(8).fill(ethers.ZeroHash),
      nullifier,
      stakeRootUsed: ethers.ZeroHash,
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      powNonce: ethers.ZeroHash,
    };
  }

  // =========================================================================
  // NR1-NR3: Admin tests
  // =========================================================================

  it("NR1: setNullifierWindowBlocks stores value correctly", async function () {
    expect(await settlement.nullifierWindowBlocks()).to.equal(WINDOW_BLOCKS);
  });

  it("NR2: setNullifierWindowBlocks only callable by owner", async function () {
    await expect(
      settlement.connect(other).setNullifierWindowBlocks(7200n)
    ).to.be.revertedWith("E18");
  });

  it("NR3: setNullifierWindowBlocks reverts on zero", async function () {
    await expect(
      settlement.setNullifierWindowBlocks(0n)
    ).to.be.revertedWith("E11");
  });

  // =========================================================================
  // NR4-NR6: isNullifierUsed view
  // =========================================================================

  it("NR4: isNullifierUsed returns false before any settlement", async function () {
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr4-test"));
    expect(await settlement.isNullifierUsed(campaignId, nullifier)).to.equal(false);
  });

  it("NR5: after settling, isNullifierUsed returns true", async function () {
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr5-nullifier"));
    const claim = buildClaim(campaignId, 1n, ethers.ZeroHash, nullifier);

    await settlement.connect(user).settleClaims([
      { user: user.address, campaignId, claims: [claim] }
    ]);

    expect(await settlement.isNullifierUsed(campaignId, nullifier)).to.equal(true);
  });

  it("NR6: same nullifier on different campaign is allowed", async function () {
    // Create campaign 2
    const cid2 = 2n;
    await mock.setCampaign(cid2, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(cid2, 0, BUDGET, DAILY_CAP, { value: BUDGET });

    // Use same nullifier as NR5
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr5-nullifier"));
    const claim = buildClaim(cid2, 1n, ethers.ZeroHash, nullifier);

    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid2, claims: [claim] }
    ]);
    const receipt = await tx.wait();

    // Should NOT have ClaimRejected event
    const iface = settlement.interface;
    const rejectedEvents = receipt!.logs.filter(
      (log) => { try { return iface.parseLog(log)?.name === "ClaimRejected"; } catch { return false; } }
    );
    expect(rejectedEvents.length).to.equal(0);
    expect(await settlement.isNullifierUsed(cid2, nullifier)).to.equal(true);
  });

  // =========================================================================
  // NR7-NR9: Integration
  // =========================================================================

  it("NR7: duplicate nullifier causes ClaimRejected with reason=19", async function () {
    // Create campaign 3
    const cid3 = 3n;
    await mock.setCampaign(cid3, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(cid3, 0, BUDGET, DAILY_CAP, { value: BUDGET });

    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr7-dup"));

    // First claim settles
    const claim1 = buildClaim(cid3, 1n, ethers.ZeroHash, nullifier);
    await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid3, claims: [claim1] }
    ]);

    // Second claim with same nullifier — rejected with code 19
    const prevHash = await settlement.lastClaimHash(user.address, cid3, 0);
    const claim2 = buildClaim(cid3, 2n, prevHash, nullifier);
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid3, claims: [claim2] }
    ]);

    await expect(tx)
      .to.emit(settlement, "ClaimRejected")
      .withArgs(cid3, user.address, 2n, 19n);
  });

  it("NR8: bytes32(0) nullifier skips check and settles normally", async function () {
    // Create campaign 4
    const cid4 = 4n;
    await mock.setCampaign(cid4, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(cid4, 0, BUDGET, DAILY_CAP, { value: BUDGET });

    const claim = buildClaim(cid4, 1n, ethers.ZeroHash, ethers.ZeroHash);
    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid4, claims: [claim] }
    ]);
    const receipt = await tx.wait();

    // No ClaimRejected event
    const iface = settlement.interface;
    const rejectedEvents = receipt!.logs.filter(
      (log) => { try { return iface.parseLog(log)?.name === "ClaimRejected"; } catch { return false; } }
    );
    expect(rejectedEvents.length).to.equal(0);
  });

  it("NR9: NullifierSubmitted event emitted on successful settlement", async function () {
    // Create campaign 5
    const cid5 = 5n;
    await mock.setCampaign(cid5, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(cid5, 0, BUDGET, DAILY_CAP, { value: BUDGET });

    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr9-event"));
    const claim = buildClaim(cid5, 1n, ethers.ZeroHash, nullifier);

    const tx = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId: cid5, claims: [claim] }
    ]);

    await expect(tx)
      .to.emit(settlement, "NullifierSubmitted")
      .withArgs(cid5, nullifier);
  });
});
