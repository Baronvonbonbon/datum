import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumGovernanceV2, DatumPauseRegistry, MockCampaigns, MockCampaignLifecycle } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Regression test for F-024 (slashed nay-voter funds stranded when a
// Completed campaign has zero aye-weight).
//
// Before the fix: when `resolvedWinningWeight == 0` (Completed campaign
// with no aye voters, or Terminated campaign with no nay voters),
// nay-voter withdraw() pushed slash into `slashCollected[campaignId]`.
// That pool could never leave: finalizeSlash reverts E61 (w == 0),
// sweepSlashPool reverts E54 (!slashFinalized), and there were no
// winners to claim against. The funds stranded permanently.
//
// After the fix: withdraw() detects the zero-winning-weight state and
// routes the slash directly to pendingOwnerSweep. Owner pulls via
// claimOwnerSweep / claimOwnerSweepTo. The Completed/Terminated
// evaluation branches also call _routeStuckPoolToOwnerSweep so any
// pre-evaluation residue (sweepUnrevealed forfeitures) is funneled too.

describe("Audit F-024: zero-winning-weight slash routed to ownerSweep", function () {
  let v2: DatumGovernanceV2;
  let mock: MockCampaigns;
  let mockLifecycle: MockCampaignLifecycle;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let nay1: HardhatEthersSigner;
  let nay2: HardhatEthersSigner;
  let pub: HardhatEthersSigner;

  const QUORUM = parseDOT("1");
  const SLASH_BPS = 1000n;
  const TERMINATION_QUORUM = parseDOT("0.5");
  const BASE_GRACE = 0n;
  const GRACE_PER_QUORUM = 0n;
  const MAX_GRACE = 0n;

  let nextCid = 1n;

  async function setupCampaign(status: number): Promise<bigint> {
    const cid = nextCid++;
    await mock.setCampaign(cid, owner.address, pub.address, parseDOT("0.01"), 5000, status);
    return cid;
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, nay1, nay2, pub] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, nay1.address, nay2.address);

    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await mock.getAddress(),
      QUORUM,
      SLASH_BPS,
      TERMINATION_QUORUM,
      BASE_GRACE,
      GRACE_PER_QUORUM,
      MAX_GRACE,
      await pauseReg.getAddress()
    );

    const LifecycleFactory = await ethers.getContractFactory("MockCampaignLifecycle");
    mockLifecycle = await LifecycleFactory.deploy(await mock.getAddress());
    await mockLifecycle.setGovernanceContract(await v2.getAddress());
    await mock.setLifecycleContract(await mockLifecycle.getAddress());

    await v2.setLifecycle(await mockLifecycle.getAddress());
    await mock.setGovernanceContract(await v2.getAddress());
  });

  it("Completed with zero aye: nay-voter withdraw routes slash to ownerSweep", async function () {
    // 1) Active campaign, nay voter locks DOT, no aye votes.
    const cid = await setupCampaign(1);
    await v2.connect(nay1).vote(cid, false, 0, { value: parseDOT("1") });
    expect(await v2.ayeWeighted(cid)).to.equal(0n);

    // 2) Campaign auto-completes (budget exhausted off-chain).
    await mock.setStatus(cid, 3);

    // 3) Resolve. resolvedWinningWeight = ayeWeighted = 0.
    await expect(v2.evaluateCampaign(cid))
      .to.emit(v2, "CampaignEvaluated").withArgs(cid, 3n);
    expect(await v2.resolvedWinningWeight(cid)).to.equal(0n);

    // 4) Nay voter withdraws. Pre-fix: slash → slashCollected (stranded).
    //    Post-fix: slash → pendingOwnerSweep + OwnerSweepQueued event.
    const slashAmt = (parseDOT("1") * SLASH_BPS) / 10000n;
    const sweepBefore = await v2.pendingOwnerSweep();

    await expect(v2.connect(nay1).withdraw(cid))
      .to.emit(v2, "OwnerSweepQueued").withArgs(cid, slashAmt);

    // pool is NOT used; the sweep accumulator is.
    expect(await v2.slashCollected(cid)).to.equal(0n);
    expect(await v2.pendingOwnerSweep()).to.equal(sweepBefore + slashAmt);
  });

  it("owner can pull the routed ownerSweep balance", async function () {
    const cid = await setupCampaign(1);
    await v2.connect(nay1).vote(cid, false, 0, { value: parseDOT("1") });
    await v2.connect(nay2).vote(cid, false, 0, { value: parseDOT("1") });
    await mock.setStatus(cid, 3);
    await v2.evaluateCampaign(cid);

    await v2.connect(nay1).withdraw(cid);
    await v2.connect(nay2).withdraw(cid);

    const slashTotal = (parseDOT("2") * SLASH_BPS) / 10000n;
    expect(await v2.pendingOwnerSweep()).to.equal(slashTotal);

    // Owner claims to themselves.
    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const tx = await v2.connect(owner).claimOwnerSweep();
    const rcpt = await tx.wait();
    const gasCost = rcpt!.gasUsed * rcpt!.gasPrice;
    const ownerAfter = await ethers.provider.getBalance(owner.address);

    expect(ownerAfter + gasCost - ownerBefore).to.equal(slashTotal);
    expect(await v2.pendingOwnerSweep()).to.equal(0n);
  });

  it("regression: non-zero-winning case still routes via slashCollected (no change)", async function () {
    // Active campaign with BOTH aye and nay voters. Aye wins by going
    // Completed. Nay loses; their slash goes to slashCollected (winners
    // can claim), NOT to ownerSweep. Confirms the F-024 branch doesn't
    // change behavior for the normal case.
    const cid = await setupCampaign(1);
    await v2.connect(nay1).vote(cid, true,  0, { value: parseDOT("1") });   // aye
    await v2.connect(nay2).vote(cid, false, 0, { value: parseDOT("1") });   // nay

    await mock.setStatus(cid, 3); // Completed
    await v2.evaluateCampaign(cid);
    expect(await v2.resolvedWinningWeight(cid)).to.equal(parseDOT("1")); // aye

    const slashAmt = (parseDOT("1") * SLASH_BPS) / 10000n;
    const sweepBefore = await v2.pendingOwnerSweep();

    // Loser withdraw — slash flows to slashCollected, NOT ownerSweep.
    await v2.connect(nay2).withdraw(cid);
    expect(await v2.slashCollected(cid)).to.equal(slashAmt);
    expect(await v2.pendingOwnerSweep()).to.equal(sweepBefore);
  });

  it("Terminated with zero nay (e.g. direct high-tier termination) also routes via the H4 + F-024 paths", async function () {
    // Pre-existing Audit-5 H4 already routes the slashCollected pool to
    // ownerSweep on Terminated+zero-nay via _routeStuckPoolToOwnerSweep.
    // F-024 generalises the principle to the withdraw path. We verify
    // both paths interoperate.
    const cid = await setupCampaign(1);
    await v2.connect(nay1).vote(cid, true, 0, { value: parseDOT("1") }); // ayes only

    // Simulate a direct high-tier termination (status flips to 4 without
    // any vote-driven flow).
    await mock.setStatus(cid, 4);
    await v2.evaluateCampaign(cid);
    expect(await v2.resolved(cid)).to.equal(true);
    expect(await v2.resolvedWinningWeight(cid)).to.equal(0n); // nayWeighted

    // Aye voter withdraws — they're now the "loser" (status==4 → nay
    // wins by definition in _computeSlash). With resolvedWinningWeight=0,
    // F-024 routes their slash directly.
    const slashAmt = (parseDOT("1") * SLASH_BPS) / 10000n;
    await expect(v2.connect(nay1).withdraw(cid))
      .to.emit(v2, "OwnerSweepQueued").withArgs(cid, slashAmt);
  });
});
