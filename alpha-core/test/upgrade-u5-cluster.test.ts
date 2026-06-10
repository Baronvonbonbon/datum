// U5 — golden-path COORDINATED funds-cluster rotation (RUNBOOK Phase 2,
// PRE-MAINNET-CHECKLIST §U5). The per-contract migration tests prove each
// fund-holder migrates in isolation; this proves the whole funds cluster can be
// rotated TOGETHER (the U4 "coordinated rotation as the upgrade unit") with:
//   - cluster-wide native-PAS conservation (no balance loss across the set),
//   - full per-entity state preserved on every v2,
//   - the v2 cluster solvent + functional (real claims succeed post-migration),
//   - the whole flow governance-gated at every step.
//
// Cluster (6 fund holders rotated as one unit):
//   DatumBudgetLedger  (advertiser escrow)        DatumPaymentVault (user/pub pull-pay)
//   DatumChallengeBonds (advertiser challenge)     DatumActivationBonds (activation pool)
//   DatumPublisherStake (publisher bond)           DatumAdvertiserStake (advertiser bond)
import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

describe("U5 — coordinated funds-cluster rotation (6 fund holders)", function () {
  let router: any;
  let ledgerV1: any, ledgerV2: any;
  let vaultV1: any, vaultV2: any;
  let cbV1: any, cbV2: any;     // ChallengeBonds
  let abV1: any, abV2: any;     // ActivationBonds
  let psV1: any, psV2: any;     // PublisherStake
  let asV1: any, asV2: any;     // AdvertiserStake

  let owner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let campaignsS: HardhatEthersSigner;
  let settlementS: HardhatEthersSigner;
  let lifecycleS: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let pub: HardhatEthersSigner;

  // Per-contract custodied amounts.
  const BUDGET_A = parseDOT("10");   // BudgetLedger: campaign 1 (live)
  const BUDGET_B = parseDOT("5");    // BudgetLedger: campaign 2 (drained → refund)
  const CAP = parseDOT("100");
  const PUB_AMT = parseDOT("3");     // PaymentVault
  const USER_AMT = parseDOT("2");
  const PROTO_AMT = parseDOT("1");
  const CB_BOND = parseDOT("5");     // ChallengeBonds (campaign 1, publisher=pub)
  const AB_BOND = parseDOT("4");     // ActivationBonds (campaign 7, creator=advertiser)
  const PS_STAKE = parseDOT("10");   // PublisherStake
  const AS_STAKE = parseDOT("8");    // AdvertiserStake

  // The cluster's total custodied native PAS at rest.
  const CLUSTER_PAS =
    BUDGET_A + BUDGET_B + PUB_AMT + USER_AMT + PROTO_AMT + CB_BOND + AB_BOND + PS_STAKE + AS_STAKE;

  let pairs: { name: string; v1: any; v2: any }[];

  beforeEach(async function () {
    await fundSigners();
    [owner, governor, campaignsS, settlementS, lifecycleS, advertiser, user, pub] =
      await ethers.getSigners();

    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(governor.address);
    const r = await router.getAddress();

    // ── v1 cluster + realistic state ──────────────────────────────────────────
    ledgerV1 = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    await ledgerV1.setRouter(r);
    await ledgerV1.setCampaigns(campaignsS.address);
    await ledgerV1.setSettlement(settlementS.address);
    await ledgerV1.setLifecycle(lifecycleS.address);
    await ledgerV1.connect(campaignsS).initializeBudget(1, 0, BUDGET_A, CAP, { value: BUDGET_A });
    await ledgerV1.connect(campaignsS).initializeBudget(2, 0, BUDGET_B, CAP, { value: BUDGET_B });
    await ledgerV1.connect(lifecycleS).drainToAdvertiser(2, advertiser.address); // queues refund B

    vaultV1 = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
    await vaultV1.setRouter(r);
    await vaultV1.setSettlement(settlementS.address);
    await vaultV1.connect(settlementS).creditSettlement(pub.address, PUB_AMT, user.address, USER_AMT, PROTO_AMT);
    await owner.sendTransaction({ to: await vaultV1.getAddress(), value: PUB_AMT + USER_AMT + PROTO_AMT });

    cbV1 = await (await ethers.getContractFactory("DatumChallengeBonds")).deploy();
    await cbV1.setRouter(r);
    await cbV1.setCampaignsContract(campaignsS.address);
    await cbV1.connect(campaignsS).lockBond(1, advertiser.address, pub.address, { value: CB_BOND });

    abV1 = await (await ethers.getContractFactory("DatumActivationBonds"))
      .deploy(parseDOT("1"), 100, 1000, 500, owner.address);
    await abV1.setRouter(r);
    await abV1.setCampaignsContract(campaignsS.address);
    await abV1.connect(campaignsS).openBond(7, advertiser.address, { value: AB_BOND });

    psV1 = await (await ethers.getContractFactory("DatumPublisherStake")).deploy(0, 0, 1);
    await psV1.setRouter(r);
    await psV1.setSettlementContract(settlementS.address);
    await psV1.connect(pub).stake({ value: PS_STAKE });
    await psV1.connect(settlementS).recordImpressions(pub.address, 5);

    asV1 = await (await ethers.getContractFactory("DatumAdvertiserStake")).deploy(0, 0, 1);
    await asV1.setRouter(r);
    await asV1.setSettlementContract(settlementS.address);
    await asV1.connect(advertiser).stake({ value: AS_STAKE });
    await asV1.connect(settlementS).recordBudgetSpent(advertiser.address, parseDOT("50")); // 50 DOT

    // ── v2 cluster (deployed, router-wired, not yet migrated) ──────────────────
    ledgerV2 = await (await ethers.getContractFactory("MockBudgetLedgerV2")).deploy();
    await ledgerV2.setRouter(r);
    await ledgerV2.setCampaigns(campaignsS.address);
    await ledgerV2.setSettlement(settlementS.address);
    await ledgerV2.setLifecycle(lifecycleS.address);

    vaultV2 = await (await ethers.getContractFactory("MockPaymentVaultV2")).deploy();
    await vaultV2.setRouter(r);
    await vaultV2.setSettlement(settlementS.address);

    cbV2 = await (await ethers.getContractFactory("MockChallengeBondsV2")).deploy();
    await cbV2.setRouter(r);
    await cbV2.setCampaignsContract(campaignsS.address);

    abV2 = await (await ethers.getContractFactory("MockActivationBondsV2"))
      .deploy(parseDOT("1"), 100, 1000, 500, owner.address);
    await abV2.setRouter(r);
    await abV2.setCampaignsContract(campaignsS.address);

    psV2 = await (await ethers.getContractFactory("MockPublisherStakeV2")).deploy(0, 0, 1);
    await psV2.setRouter(r);

    asV2 = await (await ethers.getContractFactory("MockAdvertiserStakeV2")).deploy(0, 0, 1);
    await asV2.setRouter(r);

    pairs = [
      { name: "BudgetLedger", v1: ledgerV1, v2: ledgerV2 },
      { name: "PaymentVault", v1: vaultV1, v2: vaultV2 },
      { name: "ChallengeBonds", v1: cbV1, v2: cbV2 },
      { name: "ActivationBonds", v1: abV1, v2: abV2 },
      { name: "PublisherStake", v1: psV1, v2: psV2 },
      { name: "AdvertiserStake", v1: asV1, v2: asV2 },
    ];
  });

  async function pasHeld(c: any): Promise<bigint> {
    return await ethers.provider.getBalance(await c.getAddress());
  }
  async function sumPas(side: "v1" | "v2"): Promise<bigint> {
    let total = 0n;
    for (const p of pairs) total += await pasHeld(p[side]);
    return total;
  }

  it("rotates all six together; conserves PAS cluster-wide; preserves state; v2 solvent + functional", async function () {
    // Pre-condition: the whole cluster's custodied PAS is accounted for on v1.
    expect(await sumPas("v1")).to.equal(CLUSTER_PAS);

    // ── COORDINATED ROTATION (governor drives the whole cluster as one unit) ──
    for (const p of pairs) await p.v1.connect(governor).freeze();                                  // 1. freeze all
    for (const p of pairs) await p.v2.connect(governor).migrate(await p.v1.getAddress());          // 2. migrate all
    for (const p of pairs) await p.v1.connect(governor).migrateFundsTo(await p.v2.getAddress());   // 3. sweep all

    // ── No balance loss: cluster-wide PAS is conserved across the rotation ────
    expect(await sumPas("v1")).to.equal(0n);
    expect(await sumPas("v2")).to.equal(CLUSTER_PAS);

    // ── No orphaned state: every per-entity record is present on its v2 ───────
    expect(await ledgerV2.getRemainingBudget(1, 0)).to.equal(BUDGET_A);
    expect(await ledgerV2.getRemainingBudget(2, 0)).to.equal(0n);
    expect(await ledgerV2.pendingAdvertiserRefund(advertiser.address)).to.equal(BUDGET_B);
    expect(await vaultV2.publisherBalance(pub.address)).to.equal(PUB_AMT);
    expect(await vaultV2.userBalance(user.address)).to.equal(USER_AMT);
    expect(await vaultV2.protocolBalance()).to.equal(PROTO_AMT);
    expect(await cbV2.bondForPublisher(1, pub.address)).to.equal(CB_BOND);
    expect(await abV2.creatorBond(7)).to.equal(AB_BOND);
    expect(await abV2.creatorOf(7)).to.equal(advertiser.address);
    expect(await psV2.staked(pub.address)).to.equal(PS_STAKE);
    expect(await psV2.cumulativeImpressions(pub.address)).to.equal(5n);
    expect(await asV2.staked(advertiser.address)).to.equal(AS_STAKE);
    expect(await asV2.cumulativeBudgetSpent(advertiser.address)).to.equal(50n); // whole DOT (18-dec migration)

    // ── v2 is solvent + functional: real claims succeed against the migrated set
    await expect(vaultV2.connect(user).withdrawUser())
      .to.emit(vaultV2, "UserWithdrawal").withArgs(user.address, USER_AMT);
    await expect(ledgerV2.connect(advertiser).claimAdvertiserRefund())
      .to.emit(ledgerV2, "AdvertiserRefundClaimed");

    // ── Residual PAS after the two payouts equals exactly what's still owed ───
    expect(await sumPas("v2")).to.equal(CLUSTER_PAS - USER_AMT - BUDGET_B);
  });

  it("the coordinated rotation is governance-gated at every step (all six)", async function () {
    for (const p of pairs) {
      await expect(p.v1.connect(owner).freeze(), `${p.name}.freeze`).to.be.revertedWith("E19");
    }
    for (const p of pairs) await p.v1.connect(governor).freeze();
    for (const p of pairs) {
      await expect(p.v2.connect(user).migrate(await p.v1.getAddress()), `${p.name}.migrate`).to.be.revertedWith("E19");
    }
    for (const p of pairs) await p.v2.connect(governor).migrate(await p.v1.getAddress());
    for (const p of pairs) {
      await expect(p.v1.connect(owner).migrateFundsTo(await p.v2.getAddress()), `${p.name}.sweep`).to.be.revertedWith("E19");
    }
  });
});

// ── Registry tier ───────────────────────────────────────────────────────────
// Campaigns + Lifecycle rotated together. Different mechanism from the fund
// holders: the campaign REGISTRY state lives in DatumCampaigns and migrates via
// the governance-gated DELEGATECALL passthrough (migrateDelegate →
// DatumCampaignsMigrationLogic.importCampaignFull), replaying each campaign's
// FULL state (struct + pots + every gate) read from the frozen predecessor.
// Lifecycle is a coordinator (campaign status lives ON Campaigns, no own state),
// so its rotation is freeze → migrate → rewire to the new Campaigns.
describe("U5 — coordinated registry-tier rotation (Campaigns + Lifecycle)", function () {
  let owner: HardhatEthersSigner, governor: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner, publisher: HardhatEthersSigner;
  let router: any, pause: any, publishers: any, ledger: any;
  let campaignsV1: any, campaignsV2: any, logic: any;
  let lifecycleV1: any, lifecycleV2: any;
  let cid: bigint;

  beforeEach(async function () {
    await fundSigners();
    [owner, governor, advertiser, publisher] = await ethers.getSigners();

    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(governor.address);
    const r = await router.getAddress();

    pause = await (await ethers.getContractFactory("DatumPauseRegistry"))
      .deploy(owner.address, advertiser.address, publisher.address);
    publishers = await (await ethers.getContractFactory("DatumPublishers"))
      .deploy(50n, await pause.getAddress());

    // ── Campaigns v1 + a REAL campaign (genuine registry state to migrate) ────
    campaignsV1 = await (await ethers.getContractFactory("DatumCampaigns"))
      .deploy(0n, 100n, await publishers.getAddress(), await pause.getAddress());
    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    await ledger.setCampaigns(await campaignsV1.getAddress());
    await campaignsV1.setBudgetLedger(await ledger.getAddress());
    await campaignsV1.setGovernanceContract(owner.address);
    await campaignsV1.setRouter(r);

    // Lifecycle v1 wired to Campaigns v1.
    lifecycleV1 = await (await ethers.getContractFactory("DatumCampaignLifecycle"))
      .deploy(await pause.getAddress(), 1000n);
    await lifecycleV1.setCampaigns(await campaignsV1.getAddress());
    await lifecycleV1.setRouter(r);
    await campaignsV1.setLifecycleContract(await lifecycleV1.getAddress());

    await publishers.connect(publisher).registerPublisher(5000);
    await campaignsV1.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetWei: 10n ** 18n, dailyCapWei: 10n ** 18n, rateWei: 1n, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n,
      { value: 10n ** 18n },
    );
    cid = (await campaignsV1.nextCampaignId()) - 1n;

    // ── v2 registry tier (deployed, router-wired, not migrated) ───────────────
    campaignsV2 = await (await ethers.getContractFactory("MockCampaignsV2"))
      .deploy(0n, 100n, await publishers.getAddress(), await pause.getAddress());
    await campaignsV2.setRouter(r);
    logic = await (await ethers.getContractFactory("DatumCampaignsMigrationLogic")).deploy();

    lifecycleV2 = await (await ethers.getContractFactory("DatumCampaignLifecycle"))
      .deploy(await pause.getAddress(), 1000n);
    await lifecycleV2.setRouter(r);
  });

  it("rotates Campaigns + Lifecycle together; replays full campaign state into v2; rewires Lifecycle", async function () {
    // Snapshot v1's full registry state (what the off-chain migrator reads).
    const core = await campaignsV1.getCampaignStruct(cid);
    const pots = await campaignsV1.getCampaignPots(cid);
    const fullImport = {
      core,
      pots,
      allowlistEnabled: await campaignsV1.campaignAllowlistEnabled(cid),
      assuranceLevel: await campaignsV1.campaignAssuranceLevel(cid),
      minStake: await campaignsV1.campaignMinStake(cid),
      requiredCategory: await campaignsV1.campaignRequiredCategory(cid),
      userEventCap: await campaignsV1.userEventCapPerWindow(cid),
      userCapWindow: await campaignsV1.userCapWindowBlocks(cid),
      minHistory: await campaignsV1.minUserSettledHistory(cid),
      minIdentityLevel: await campaignsV1.campaignMinIdentityLevel(cid),
    };

    // ── COORDINATED ROTATION: freeze the registry tier together ───────────────
    await campaignsV1.connect(governor).freeze();
    await lifecycleV1.connect(governor).freeze();

    // Campaigns: replay v1's FULL state into v2 via the delegatecall logic.
    await campaignsV2.connect(governor).setMigrationLogic(await logic.getAddress());
    await campaignsV2.connect(governor).migrateDelegate(
      logic.interface.encodeFunctionData("importCampaignFull", [cid, fullImport]),
    );
    await campaignsV2.connect(governor).migrateBumpNextId(await campaignsV1.nextCampaignId());
    // Lifecycle holds no own state (campaign status lives ON Campaigns) and has
    // no higher-version successor, so its rotation is freeze → replace → rewire
    // to the new registry — not a state-copy migrate.
    await lifecycleV2.setCampaigns(await campaignsV2.getAddress());

    // ── No orphaned state: the campaign is fully present on Campaigns v2 ───────
    const c2 = await campaignsV2.getCampaignStruct(cid);
    expect(c2.advertiser).to.equal(advertiser.address);
    expect(c2.publisher).to.equal(publisher.address);
    expect(c2.snapshotTakeRateBps).to.equal(core.snapshotTakeRateBps);
    expect(c2.status).to.equal(core.status);
    expect((await campaignsV2.getCampaignPots(cid)).length).to.equal(pots.length);
    expect(await campaignsV2.getCampaignAdvertiser(cid)).to.equal(advertiser.address);
    expect(await campaignsV2.nextCampaignId()).to.equal(await campaignsV1.nextCampaignId());

    // ── Lifecycle rotated (frozen) + rewired to the new registry ──────────────
    expect(await lifecycleV2.campaigns()).to.equal(await campaignsV2.getAddress());
    expect(await campaignsV1.frozen()).to.equal(true);
    expect(await lifecycleV1.frozen()).to.equal(true);
  });

  it("the registry-tier rotation is governance-gated", async function () {
    await expect(campaignsV1.connect(owner).freeze()).to.be.revertedWith("E19");
    await expect(lifecycleV1.connect(owner).freeze()).to.be.revertedWith("E19");
    await campaignsV1.connect(governor).freeze();
    await expect(campaignsV2.connect(owner).setMigrationLogic(await logic.getAddress())).to.be.revertedWith("E19");
    await expect(lifecycleV2.connect(owner).migrate(await lifecycleV1.getAddress())).to.be.revertedWith("E19");
  });
});
