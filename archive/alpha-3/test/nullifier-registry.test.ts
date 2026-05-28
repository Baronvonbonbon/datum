import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumNullifierRegistry,
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
import { fundSigners } from "./helpers/mine";

// NullifierRegistry tests (FP-5):
// NR1:  Deploy with windowBlocks — getter returns correct value
// NR2:  submitNullifier reverts if caller is not settlement (E18)
// NR3:  isUsed returns false before submission
// NR4:  submitNullifier marks nullifier as used + emits NullifierSubmitted
// NR5:  isUsed returns true after submission
// NR6:  Duplicate nullifier (same campaign) reverts with E73
// NR7:  Same nullifier on different campaign is allowed
// NR8:  bytes32(0) nullifier can be submitted (no special-casing in registry itself)
// NR9:  setWindowBlocks — owner updates value
// NR10: setWindowBlocks — non-owner reverts E18
// NR11: setWindowBlocks — zero value reverts
// NR12: setSettlement — owner updates; non-owner reverts E18
// NR13: 2-step ownership: transferOwnership + acceptOwnership
// NR14: acceptOwnership by wrong address reverts E18
// NR15: Settlement integration — duplicate nullifier causes ClaimRejected(reason=19), no revert
// NR16: Settlement integration — bytes32(0) nullifier is ignored by registry (settles normally)

const WINDOW_BLOCKS = 14400n;

describe("DatumNullifierRegistry", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let settlement: HardhatEthersSigner;
  let registry: DatumNullifierRegistry;

  before(async function () {
    await fundSigners();
    [owner, alice, settlement] = await ethers.getSigners();
  });

  async function deployRegistry(windowBlocks = WINDOW_BLOCKS): Promise<DatumNullifierRegistry> {
    const Factory = await ethers.getContractFactory("DatumNullifierRegistry");
    return Factory.connect(owner).deploy(windowBlocks) as Promise<DatumNullifierRegistry>;
  }

  // -----------------------------------------------------------------------
  // NR1: windowBlocks getter
  // -----------------------------------------------------------------------
  it("NR1: windowBlocks returns the value set at construction", async function () {
    registry = await deployRegistry(14400n);
    expect(await registry.windowBlocks()).to.equal(14400n);
  });

  it("NR1b: constructor reverts if windowBlocks is zero", async function () {
    const Factory = await ethers.getContractFactory("DatumNullifierRegistry");
    await expect(Factory.connect(owner).deploy(0n)).to.be.revertedWith("E11");
  });

  // -----------------------------------------------------------------------
  // NR2: auth — only settlement may call submitNullifier
  // -----------------------------------------------------------------------
  it("NR2: submitNullifier reverts E18 if caller is not settlement", async function () {
    registry = await deployRegistry();
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("test"));
    await expect(
      registry.connect(alice).submitNullifier(nullifier, 1n)
    ).to.be.revertedWith("E18");
  });

  // -----------------------------------------------------------------------
  // NR3-NR5: isUsed, submitNullifier, event
  // -----------------------------------------------------------------------
  it("NR3: isUsed returns false before submission", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr3"));
    expect(await registry.isUsed(1n, nullifier)).to.equal(false);
  });

  it("NR4: submitNullifier marks nullifier and emits NullifierSubmitted", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr4"));
    const tx = await registry.connect(settlement).submitNullifier(nullifier, 1n);
    await expect(tx)
      .to.emit(registry, "NullifierSubmitted")
      .withArgs(1n, nullifier);
  });

  it("NR5: isUsed returns true after submission", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr5"));
    await registry.connect(settlement).submitNullifier(nullifier, 1n);
    expect(await registry.isUsed(1n, nullifier)).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // NR6: duplicate nullifier
  // -----------------------------------------------------------------------
  it("NR6: duplicate nullifier on same campaign reverts E73", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr6"));
    await registry.connect(settlement).submitNullifier(nullifier, 1n);
    await expect(
      registry.connect(settlement).submitNullifier(nullifier, 1n)
    ).to.be.revertedWith("E73");
  });

  // -----------------------------------------------------------------------
  // NR7: same nullifier on different campaign is OK
  // -----------------------------------------------------------------------
  it("NR7: same nullifier on different campaign is allowed", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr7"));
    await registry.connect(settlement).submitNullifier(nullifier, 1n);
    // campaign 2 — should not revert
    await registry.connect(settlement).submitNullifier(nullifier, 2n);
    expect(await registry.isUsed(2n, nullifier)).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // NR8: bytes32(0) can be submitted at the registry level
  // -----------------------------------------------------------------------
  it("NR8: bytes32(0) nullifier can be submitted by settlement (no registry-level guard)", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    await registry.connect(settlement).submitNullifier(ethers.ZeroHash, 1n);
    expect(await registry.isUsed(1n, ethers.ZeroHash)).to.equal(true);
  });

  // -----------------------------------------------------------------------
  // NR9-NR11: setWindowBlocks
  // -----------------------------------------------------------------------
  it("NR9: setWindowBlocks updates the value (owner)", async function () {
    registry = await deployRegistry(14400n);
    await registry.connect(owner).setWindowBlocks(7200n);
    expect(await registry.windowBlocks()).to.equal(7200n);
  });

  it("NR10: setWindowBlocks reverts E18 for non-owner", async function () {
    registry = await deployRegistry();
    await expect(
      registry.connect(alice).setWindowBlocks(7200n)
    ).to.be.revertedWith("E18");
  });

  it("NR11: setWindowBlocks reverts if zero", async function () {
    registry = await deployRegistry();
    await expect(
      registry.connect(owner).setWindowBlocks(0n)
    ).to.be.revertedWith("E11");
  });

  // -----------------------------------------------------------------------
  // NR12: setSettlement
  // -----------------------------------------------------------------------
  it("NR12: setSettlement updates; non-owner reverts E18", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).setSettlement(settlement.address);
    expect(await registry.settlement()).to.equal(settlement.address);
    await expect(
      registry.connect(alice).setSettlement(alice.address)
    ).to.be.revertedWith("E18");
  });

  // -----------------------------------------------------------------------
  // NR13-NR14: 2-step ownership
  // -----------------------------------------------------------------------
  it("NR13: transferOwnership + acceptOwnership transfers owner", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).transferOwnership(alice.address);
    expect(await registry.pendingOwner()).to.equal(alice.address);
    await registry.connect(alice).acceptOwnership();
    expect(await registry.owner()).to.equal(alice.address);
    // restore
    await registry.connect(alice).transferOwnership(owner.address);
    await registry.connect(owner).acceptOwnership();
  });

  it("NR14: acceptOwnership by wrong address reverts E18", async function () {
    registry = await deployRegistry();
    await registry.connect(owner).transferOwnership(alice.address);
    await expect(
      registry.connect(settlement).acceptOwnership()
    ).to.be.revertedWith("E18");
  });
});

// -------------------------------------------------------------------------
// Settlement integration tests for FP-5 nullifier replay
// -------------------------------------------------------------------------
describe("DatumNullifierRegistry — Settlement integration", function () {
  const BID_CPM    = parseDOT("0.001");
  const BUDGET     = parseDOT("10");
  const DAILY_CAP  = parseDOT("5");
  const TAKE_RATE  = 1000; // 10%
  const IMPRESSIONS = 1000n;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  let settlement: DatumSettlement;
  let pauseRegistry: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;
  let relay: DatumRelay;
  let mock: MockCampaigns;
  let registry: DatumNullifierRegistry;

  let campaignId: bigint;

  before(async function () {
    await fundSigners();
    [owner, user, publisher] = await ethers.getSigners();

    // Mirrors settlement.test.ts setup pattern
    pauseRegistry = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
      owner.address, user.address, publisher.address
    ) as DatumPauseRegistry;

    mock = await (await ethers.getContractFactory("MockCampaigns")).deploy() as MockCampaigns;

    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy() as DatumBudgetLedger;
    vault  = await (await ethers.getContractFactory("DatumPaymentVault")).deploy() as DatumPaymentVault;

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

    // Deploy NullifierRegistry and wire to settlement
    registry = await (await ethers.getContractFactory("DatumNullifierRegistry")).deploy(14400n) as DatumNullifierRegistry;
    await settlement.setNullifierRegistry(await registry.getAddress());
    await registry.setSettlement(await settlement.getAddress());

    // Create a test campaign
    campaignId = 1n;
    await mock.setCampaign(campaignId, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(campaignId, 0, BUDGET, DAILY_CAP, { value: BUDGET });
  });

  function buildClaim(nonce: bigint, prevHash: string, nullifier: string): any {
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
      [campaignId, publisher.address, user.address, IMPRESSIONS, BID_CPM, 0, ethers.ZeroHash, nonce, prevHash]
    );
    return {
      campaignId,
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
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
    };
  }

  // NR15: duplicate nullifier causes ClaimRejected(reason=19) — no revert
  it("NR15: duplicate nullifier causes ClaimRejected with reason=19", async function () {
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nr15-nullifier"));

    // First claim settles normally
    const claim1 = buildClaim(1n, ethers.ZeroHash, nullifier);
    const tx1 = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId, claims: [claim1] }
    ]);
    await tx1.wait();

    // Second claim with same nullifier — should be rejected, not revert
    const prevHash = await settlement.lastClaimHash(user.address, campaignId, 0);
    const claim2 = buildClaim(2n, prevHash, nullifier);
    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId, claims: [claim2] }
    ]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);

    // Emits ClaimRejected with reason 19
    const tx2 = await settlement.connect(user).settleClaims([
      { user: user.address, campaignId, claims: [claim2] }
    ]);
    await expect(tx2)
      .to.emit(settlement, "ClaimRejected")
      .withArgs(campaignId, user.address, 2n, 19n);
  });

  // NR16: bytes32(0) nullifier skips registry — settles normally
  it("NR16: bytes32(0) nullifier skips registry and settles normally", async function () {
    // Use campaign 2 to avoid nonce collisions with NR15
    const cid2 = 2n;
    await mock.setCampaign(cid2, owner.address, publisher.address, BID_CPM, TAKE_RATE, 1);
    await mock.initBudget(cid2, 0, BUDGET, DAILY_CAP, { value: BUDGET });

    const claimHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32"],
      [cid2, publisher.address, user.address, IMPRESSIONS, BID_CPM, 0, ethers.ZeroHash, 1n, ethers.ZeroHash]
    );
    const claim = {
      campaignId: cid2,
      publisher: publisher.address,
      eventCount: IMPRESSIONS,
      ratePlanck: BID_CPM,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce: 1n,
      previousClaimHash: ethers.ZeroHash,
      claimHash,
      zkProof: new Array(8).fill(ethers.ZeroHash),
      nullifier: ethers.ZeroHash,  // skip registry
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
    };

    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid2, claims: [claim] }
    ]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });
});
