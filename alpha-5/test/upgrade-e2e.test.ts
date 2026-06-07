import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";

// End-to-end validation of the redeploy-migrate-rewire upgrade model on a real
// stateful + fund-holding contract (DatumPublisherStake), with state and native
// DOT loaded through the contract's NORMAL entry points — not synthetic hooks.
//
// Lifecycle exercised, exactly as a production governance upgrade would run it:
//   1. deploy v1, wire the governance router
//   2. load real state + funds (publishers stake())
//   3. freeze v1  (onlyGovernance)
//   4. deploy v2 (version bumped), wire the same router
//   5. v2.migrate(v1)          -> _migrate copies every staker's record
//   6. v1.migrateFundsTo(v2)   -> sweeps native DOT to v2.acceptMigration
//   7. assert: identical per-publisher state, identical balance, version bumped,
//      predecessor frozen, successor live (post-upgrade stake works)
describe("Upgrade E2E — bump version with loaded data (DatumPublisherStake)", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner;
  let pubA: HardhatEthersSigner, pubB: HardhatEthersSigner, pubC: HardhatEthersSigner;
  let router: any, v1: any, v2: any;

  const BASE = 1_000_000n;       // baseStakeWei
  const PER_IMP = 1_000n;        // planckPerImpression
  const DELAY = 10n;             // unstakeDelayBlocks

  const STAKE_A = 5_000_000n;
  const STAKE_B = 3_000_000n;
  const STAKE_B2 = 2_000_000n;   // pubB stakes twice

  beforeEach(async function () {
    [owner, gov, pubA, pubB, pubC] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);

    v1 = await (await ethers.getContractFactory("DatumPublisherStake")).deploy(BASE, PER_IMP, DELAY);
    await v1.setRouter(await router.getAddress());
  });

  it("carries every staker's state + the full native balance across a version bump, and stays live", async function () {
    // ── 2. load real state + funds through the normal stake() path ──
    await v1.connect(pubA).stake({ value: STAKE_A });
    await v1.connect(pubB).stake({ value: STAKE_B });
    await v1.connect(pubB).stake({ value: STAKE_B2 }); // accumulates
    // pubB also opens a pending unstake so we prove that record migrates too
    await v1.connect(pubB).requestUnstake(1_000_000n);

    const expectA = STAKE_A;
    const expectB = STAKE_B + STAKE_B2 - 1_000_000n;
    const totalOnChain = await ethers.provider.getBalance(await v1.getAddress());
    expect(await v1.staked(pubA.address)).to.equal(expectA);
    expect(await v1.staked(pubB.address)).to.equal(expectB);
    expect(totalOnChain).to.equal(STAKE_A + STAKE_B + STAKE_B2); // unstake is still escrowed until claimed
    const stakerCount = await v1.stakerCount();
    const pendingB = await v1.pendingUnstake(pubB.address);

    // ── 3. freeze v1 (onlyGovernance) ──
    await v1.connect(gov).freeze();
    expect(await v1.frozen()).to.equal(true);
    // frozen predecessor rejects new stakes
    await expect(v1.connect(pubC).stake({ value: 1_000_000n })).to.be.reverted;

    // ── 4. deploy v2 (version bumped) + wire same router ──
    v2 = await (await ethers.getContractFactory("MockPublisherStakeV2")).deploy(BASE, PER_IMP, DELAY);
    await v2.setRouter(await router.getAddress());
    expect(await v2.version()).to.be.greaterThan(await v1.version());

    // ── 5. migrate state (onlyGovernance, requires old frozen + lower version) ──
    await v2.connect(gov).migrate(await v1.getAddress());
    expect(await v2.migrated()).to.equal(true);
    expect(await v2.migrationSource()).to.equal(await v1.getAddress());

    // ── 6. sweep native DOT to the successor ──
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());
    expect(await v1.fundsMigratedOut()).to.equal(true);

    // ── 7. assert full carry-over ──
    // per-publisher state identical
    expect(await v2.staked(pubA.address)).to.equal(expectA);
    expect(await v2.staked(pubB.address)).to.equal(expectB);
    expect(await v2.stakerCount()).to.equal(stakerCount);
    // config params copied
    expect(await v2.baseStakeWei()).to.equal(BASE);
    expect(await v2.planckPerImpression()).to.equal(PER_IMP);
    expect(await v2.unstakeDelayBlocks()).to.equal(DELAY);
    // pending-unstake record copied
    const pendingB2 = await v2.pendingUnstake(pubB.address);
    expect(pendingB2.amount).to.equal(pendingB.amount);
    expect(pendingB2.availableBlock).to.equal(pendingB.availableBlock);
    // funds fully on the successor; predecessor drained
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(totalOnChain);
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);

    // ── liveness: the successor is the live contract; a NEW stake works ──
    await v2.connect(pubC).stake({ value: 4_000_000n });
    expect(await v2.staked(pubC.address)).to.equal(4_000_000n);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(totalOnChain + 4_000_000n);
  });

  it("rejects a downgrade and an unfrozen-predecessor migration", async function () {
    await v1.connect(pubA).stake({ value: STAKE_A });

    v2 = await (await ethers.getContractFactory("MockPublisherStakeV2")).deploy(BASE, PER_IMP, DELAY);
    await v2.setRouter(await router.getAddress());

    // predecessor not yet frozen -> migrate must refuse
    await expect(v2.connect(gov).migrate(await v1.getAddress())).to.be.revertedWith("old-not-frozen");

    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());

    // a third contract at the SAME version can't migrate FROM v2 (no downgrade / equal-version)
    const v2b = await (await ethers.getContractFactory("MockPublisherStakeV2")).deploy(BASE, PER_IMP, DELAY);
    await v2b.setRouter(await router.getAddress());
    await v2.connect(gov).freeze();
    await expect(v2b.connect(gov).migrate(await v2.getAddress())).to.be.revertedWith("downgrade");
  });

  it("migrate + freeze + fund sweep are governance-only", async function () {
    await v1.connect(pubA).stake({ value: STAKE_A });
    await expect(v1.connect(pubA).freeze()).to.be.reverted;          // not governor
    await v1.connect(gov).freeze();
    await expect(v1.connect(pubA).migrateFundsTo(owner.address)).to.be.reverted; // not governor
    v2 = await (await ethers.getContractFactory("MockPublisherStakeV2")).deploy(BASE, PER_IMP, DELAY);
    await v2.setRouter(await router.getAddress());
    await expect(v2.connect(pubA).migrate(await v1.getAddress())).to.be.reverted; // not governor
  });
});

// End-to-end validation of the DatumCampaigns carve-out upgrade: campaigns are
// loaded through the REAL createCampaign path (with pots + advertiser gates),
// then carried into a version-bumped successor exactly as
// scripts/migrate-campaigns.ts would — setMigrationLogic + a migrateDelegate
// loop that replays each campaign's FULL state (struct + pots + every gate).
describe("Upgrade E2E — Campaigns carve-out, loaded via createCampaign", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, advertiser: HardhatEthersSigner, publisher: HardhatEthersSigner, lifecycleMock: HardhatEthersSigner;
  let router: any, pauseReg: any, publishers: any, ledger: any, v1: any;

  const MIN_CPM = 0n;
  const PENDING_TIMEOUT = 50n;
  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;
  const CAT = ethers.encodeBytes32String("news");

  function pot(): any {
    return { actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY_CAP, rateWei: BID_CPM, actionVerifier: ethers.ZeroAddress };
  }

  // Read one campaign's FULL state from a contract into the importCampaignFull shape.
  async function readFull(c: any, id: bigint): Promise<any> {
    return {
      core: await c.getCampaignStruct(id),
      pots: await c.getCampaignPots(id),
      allowlistEnabled: await c.campaignAllowlistEnabled(id),
      assuranceLevel: await c.campaignAssuranceLevel(id),
      minStake: await c.campaignMinStake(id),
      requiredCategory: await c.campaignRequiredCategory(id),
      userEventCap: await c.userEventCapPerWindow(id),
      userCapWindow: await c.userCapWindowBlocks(id),
      minHistory: await c.minUserSettledHistory(id),
      minIdentityLevel: await c.campaignMinIdentityLevel(id),
    };
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, advertiser, publisher, lifecycleMock] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);

    pauseReg = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, advertiser.address, publisher.address);
    publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(50n, await pauseReg.getAddress());
    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    v1 = await (await ethers.getContractFactory("DatumCampaigns")).deploy(MIN_CPM, PENDING_TIMEOUT, await publishers.getAddress(), await pauseReg.getAddress());
    await ledger.setCampaigns(await v1.getAddress());
    await v1.setBudgetLedger(await ledger.getAddress());
    await v1.setLifecycleContract(lifecycleMock.address);
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
    await v1.setRouter(await router.getAddress());
  });

  it("carries every campaign's full state (struct + pots + gates) across a version bump", async function () {
    // ── load: two real campaigns via createCampaign ──
    // closed campaign (registered publisher) with a full set of advertiser gates
    await v1.connect(advertiser).createCampaign(
      publisher.address, [pot()], [], true, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    await v1.connect(advertiser).setCampaignAssuranceLevel(1, 2);
    await v1.connect(advertiser).setCampaignMinStake(1, parseDOT("0.5"));
    await v1.connect(advertiser).setCampaignRequiredCategory(1, CAT);
    await v1.connect(advertiser).setCampaignUserCap(1, 7, 200);
    await v1.connect(advertiser).setCampaignMinHistory(1, 4);
    await v1.connect(advertiser).setCampaignMinIdentityLevel(1, 1);
    // open campaign (publisher = 0)
    await v1.connect(advertiser).createCampaign(
      ethers.ZeroAddress, [pot()], [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );

    const nextId: bigint = await v1.nextCampaignId();
    const snap = [await readFull(v1, 1n), await readFull(v1, 2n)];

    // ── freeze v1 ──
    await v1.connect(gov).freeze();
    expect(await v1.frozen()).to.equal(true);

    // ── deploy successor (version bumped) + the migration logic ──
    const v2 = await (await ethers.getContractFactory("MockCampaignsV2")).deploy(MIN_CPM, PENDING_TIMEOUT, await publishers.getAddress(), await pauseReg.getAddress());
    await v2.setRouter(await router.getAddress());
    expect(await v2.version()).to.be.greaterThan(await v1.version());
    const logic = await (await ethers.getContractFactory("DatumCampaignsMigrationLogic")).deploy();
    const logicIface = (await ethers.getContractFactory("DatumCampaignsMigrationLogic")).interface;
    await v2.connect(gov).setMigrationLogic(await logic.getAddress());

    // ── replay each campaign's full state via migrateDelegate (the script flow) ──
    for (let id = 1n; id < nextId; id++) {
      const fi = await readFull(v1, id);
      const data = logicIface.encodeFunctionData("importCampaignFull", [id, fi]);
      await v2.connect(gov).migrateDelegate(data);
    }
    await v2.connect(gov).migrateBumpNextId(nextId);

    // ── assert full carry-over on the successor ──
    expect(await v2.nextCampaignId()).to.equal(nextId);
    for (let id = 1n; id < nextId; id++) {
      const before = snap[Number(id) - 1];
      const after = await readFull(v2, id);
      expect(after.core.advertiser).to.equal(before.core.advertiser);
      expect(after.core.publisher).to.equal(before.core.publisher);
      expect(after.core.snapshotTakeRateBps).to.equal(before.core.snapshotTakeRateBps);
      expect(after.core.status).to.equal(before.core.status);
      expect(after.core.requiresZkProof).to.equal(before.core.requiresZkProof);
      expect(after.core.viewBid).to.equal(before.core.viewBid);
      expect(after.pots.length).to.equal(before.pots.length);
      expect(after.pots[0].rateWei).to.equal(before.pots[0].rateWei);
      expect(after.pots[0].budgetWei).to.equal(before.pots[0].budgetWei);
      expect(after.assuranceLevel).to.equal(before.assuranceLevel);
      expect(after.minStake).to.equal(before.minStake);
      expect(after.requiredCategory).to.equal(before.requiredCategory);
      expect(after.userEventCap).to.equal(before.userEventCap);
      expect(after.userCapWindow).to.equal(before.userCapWindow);
      expect(after.minHistory).to.equal(before.minHistory);
      expect(after.minIdentityLevel).to.equal(before.minIdentityLevel);
    }
    // gate values specifically (campaign 1)
    expect(await v2.campaignAssuranceLevel(1)).to.equal(2);
    expect(await v2.campaignMinStake(1)).to.equal(parseDOT("0.5"));
    expect(await v2.campaignRequiredCategory(1)).to.equal(CAT);
    expect(await v2.userEventCapPerWindow(1)).to.equal(7);
    expect(await v2.userCapWindowBlocks(1)).to.equal(200);
    expect(await v2.minUserSettledHistory(1)).to.equal(4);
    expect(await v2.campaignMinIdentityLevel(1)).to.equal(1);

    // ── liveness: rewire successor's budget ledger, new campaign gets a fresh id ──
    const ledger2 = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    await ledger2.setCampaigns(await v2.getAddress());
    await v2.setBudgetLedger(await ledger2.getAddress());
    await v2.setLifecycleContract(lifecycleMock.address);
    await v2.connect(advertiser).createCampaign(
      publisher.address, [pot()], [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    expect(await v2.nextCampaignId()).to.equal(nextId + 1n);
    expect(await v2.getCampaignAdvertiser(nextId)).to.equal(advertiser.address);
  });
});

// End-to-end validation of the conviction-governance vote-state migration — the
// densest pattern, where votes lock native DOT for up to a year. The failure
// mode is stranded funds: if a voter's locked DOT is swept to the successor but
// the vote record isn't migrated, the voter can never reclaim it. This test
// loads a real proposal + conviction vote, upgrades, and then proves the voter
// reclaims their migrated DOT FROM THE SUCCESSOR.
describe("Upgrade E2E — Governance vote-state (DatumRelayGovernance)", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, proposer: HardhatEthersSigner, voter: HardhatEthersSigner;
  let router: any, v1: any;
  const LOCKS: bigint[] = [100n, 1n, 3n, 7n, 21n, 90n, 180n, 270n, 365n];
  const LOCK_DOT = parseDOT("2");

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, proposer, voter] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);
    v1 = await (await ethers.getContractFactory("DatumRelayGovernance")).deploy(10, 100, 0, 5000, 2000, 1000);
    await v1.setRouter(await router.getAddress());
    await v1.setConvictionLockups(LOCKS);
  });

  it("migrates in-flight proposal + conviction vote + locked DOT, and the voter reclaims from the successor", async function () {
    // ── load real vote state: a proposal + a conviction vote locking 2 DOT ──
    const EVID = "0x" + "ee".repeat(32);
    await v1.connect(proposer).propose(owner.address, 1, EVID);     // proposalId 1
    await v1.connect(voter).vote(1, true, 1, { value: LOCK_DOT });  // conviction 1 -> short lock

    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(LOCK_DOT);
    const voteBefore = await v1.getVote(1, voter.address);
    expect(voteBefore.lockAmount).to.equal(LOCK_DOT);
    expect(voteBefore.direction).to.equal(1n);
    const nextPid = await v1.nextProposalId();

    // ── freeze + deploy successor + migrate + sweep locked DOT ──
    await v1.connect(gov).freeze();
    const v2 = await (await ethers.getContractFactory("MockRelayGovernanceNext")).deploy(0, 0, 0, 0, 0, 0);
    await v2.setRouter(await router.getAddress());
    expect(await v2.version()).to.be.greaterThan(await v1.version());
    await v2.connect(gov).migrate(await v1.getAddress());
    await v1.connect(gov).migrateFundsTo(await v2.getAddress());

    // ── carry-over: config + proposal + vote record + locked DOT ──
    expect(await v2.quorum()).to.equal(10n);
    expect(await v2.convictionLockup(8)).to.equal(365n);
    expect(await v2.nextProposalId()).to.equal(nextPid);
    expect((await v2.getProposal(1)).relay).to.equal(owner.address);
    expect(await v2.proposalVoterCount(1)).to.equal(1n);
    const voteAfter = await v2.getVote(1, voter.address);
    expect(voteAfter.lockAmount).to.equal(LOCK_DOT);
    expect(voteAfter.direction).to.equal(1n);
    expect(voteAfter.lockedUntilBlock).to.equal(voteBefore.lockedUntilBlock);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(LOCK_DOT);
    expect(await ethers.provider.getBalance(await v1.getAddress())).to.equal(0n);

    // ── THE anti-stranding proof: voter reclaims locked DOT FROM THE SUCCESSOR ──
    await mineBlocks(3); // let the conviction lock elapse
    const balBefore = await ethers.provider.getBalance(voter.address);
    const tx = await v2.connect(voter).withdrawVote(1);
    const rcpt = await tx.wait();
    const gasCost = rcpt!.gasUsed * rcpt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(voter.address);

    // voter got exactly their 2 DOT back (net of gas), the successor is drained,
    // and the vote record is cleared — no funds stranded across the upgrade.
    expect(balAfter).to.equal(balBefore + LOCK_DOT - gasCost);
    expect(await ethers.provider.getBalance(await v2.getAddress())).to.equal(0n);
    expect((await v2.getVote(1, voter.address)).direction).to.equal(0n);
  });
});

// End-to-end validation of a MULTI-CONTRACT rewire: upgrade a dependency
// (DatumPublishers) underneath a live dependent (DatumCampaigns), migrate the
// dependency's state, then re-point the dependent's structural ref via the
// phase-conditional `whenPlumbingUnlocked` setter — proving (a) the ref is
// re-pointable while plumbing is unlocked, (b) the dependent's cross-calls now
// route to the NEW dependency, and (c) lockPlumbing() freezes the ref forever
// (the cypherpunk end-state).
describe("Upgrade E2E — multi-contract rewire (Campaigns -> Publishers)", function () {
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, advertiser: HardhatEthersSigner;
  let pubA: HardhatEthersSigner, pubB: HardhatEthersSigner, lifecycleMock: HardhatEthersSigner, stranger: HardhatEthersSigner;
  let router: any, pause: any, pubsV1: any, ledger: any, campaigns: any;

  const MIN_CPM = 0n, PENDING_TIMEOUT = 50n, RATE = 5000;
  const BUDGET = parseDOT("2"), DAILY_CAP = parseDOT("1"), BID_CPM = parseDOT("0.01");
  function pot(): any { return { actionType: 0, budgetWei: BUDGET, dailyCapWei: DAILY_CAP, rateWei: BID_CPM, actionVerifier: ethers.ZeroAddress }; }
  function create(who: HardhatEthersSigner, publisher: string) {
    return campaigns.connect(advertiser).createCampaign(publisher, [pot()], [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET });
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, gov, advertiser, pubA, pubB, lifecycleMock, stranger] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy(); // phase=2 (OpenGov) by default
    await router.setGovernor(gov.address);
    pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, advertiser.address, pubA.address);

    pubsV1 = await (await ethers.getContractFactory("DatumPublishers")).deploy(50n, await pause.getAddress());
    await pubsV1.setRouter(await router.getAddress());
    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(MIN_CPM, PENDING_TIMEOUT, await pubsV1.getAddress(), await pause.getAddress());
    await campaigns.setRouter(await router.getAddress());
    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);

    await pubsV1.connect(pubA).registerPublisher(RATE); // pubA known only to v1 so far
  });

  it("re-points Campaigns to an upgraded Publishers; cross-calls route to the new one; lockPlumbing freezes it", async function () {
    // baseline: createCampaign routes into Publishers v1
    await create(advertiser, pubA.address);
    expect(await campaigns.nextCampaignId()).to.equal(2n);

    // ── upgrade the dependency: freeze v1, deploy v2, migrate registrations ──
    await pubsV1.connect(gov).freeze();
    const pubsV2 = await (await ethers.getContractFactory("MockPublishersV2")).deploy(50n, await pause.getAddress());
    await pubsV2.setRouter(await router.getAddress());
    await pubsV2.connect(gov).migrate(await pubsV1.getAddress());
    expect(await pubsV2.version()).to.be.greaterThan(await pubsV1.version());
    expect((await pubsV2.getPublisher(pubA.address)).registered).to.equal(true); // migrated

    // dependent still points at the OLD dependency until re-pointed
    expect(await campaigns.publishers()).to.equal(await pubsV1.getAddress());

    // ── REWIRE: re-point the structural ref (whenPlumbingUnlocked, owner) ──
    await campaigns.connect(owner).setPublishers(await pubsV2.getAddress());
    expect(await campaigns.publishers()).to.equal(await pubsV2.getAddress());

    // ── routing proof: createCampaign now reads Publishers v2 ──
    // (a) the migrated publisher still works
    await create(advertiser, pubA.address);
    // (b) a publisher registered ONLY on v2 works -> proves the cross-call hits v2
    await pubsV2.connect(pubB).registerPublisher(RATE);
    await create(advertiser, pubB.address);
    expect(await campaigns.nextCampaignId()).to.equal(4n);
    // (c) the gate still fires through v2: an unregistered publisher is rejected
    await expect(create(advertiser, stranger.address)).to.be.revertedWithCustomError(campaigns, "E62");

    // predecessor is frozen and out of the loop
    expect(await pubsV1.frozen()).to.equal(true);

    // ── lockPlumbing freezes the structural ref forever (cypherpunk end-state) ──
    // router.phase() == 2 (OpenGov) by default, so the OpenGov-gated lock fires.
    await campaigns.connect(owner).lockPlumbing();
    expect(await campaigns.plumbingLocked()).to.equal(true);
    await expect(campaigns.connect(owner).setPublishers(await pubsV1.getAddress())).to.be.revertedWith("locked");
    // but the ref still works post-lock — it's frozen at v2, not broken
    await create(advertiser, pubA.address);
    expect(await campaigns.nextCampaignId()).to.equal(5n);
  });

  it("re-pointing is owner-gated and rejected once plumbing is locked", async function () {
    const pubsV2 = await (await ethers.getContractFactory("MockPublishersV2")).deploy(50n, await pause.getAddress());
    await pubsV2.setRouter(await router.getAddress());
    // non-owner cannot re-point
    await expect(campaigns.connect(gov).setPublishers(await pubsV2.getAddress())).to.be.reverted;
    // owner can, while unlocked
    await campaigns.connect(owner).setPublishers(await pubsV2.getAddress());
    // after lock, even owner cannot
    await campaigns.connect(owner).lockPlumbing();
    await expect(campaigns.connect(owner).setPublishers(await pubsV1.getAddress())).to.be.revertedWith("locked");
  });
});
