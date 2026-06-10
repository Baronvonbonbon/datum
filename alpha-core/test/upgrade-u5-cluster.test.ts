// U5 — golden-path COORDINATED funds-cluster rotation (RUNBOOK Phase 2,
// PRE-MAINNET-CHECKLIST §U5). The per-contract migration tests prove each
// fund-holder migrates in isolation; this proves the funds cluster can be
// rotated TOGETHER (the U4 "coordinated rotation as the upgrade unit") with:
//   - cluster-wide native-PAS conservation (no balance loss across the set),
//   - full per-entity state preserved on every v2,
//   - the v2 cluster solvent + functional (advertiser refund + user withdrawal
//     succeed against the migrated contracts),
//   - the whole flow governance-gated end-to-end.
//
// Cluster covered here: DatumBudgetLedger (advertiser escrow) + DatumPaymentVault
// (user/publisher pull-payments) — the two highest-value fund holders. Extending
// to ChallengeBonds / ActivationBonds / Campaigns is the same pattern (follow-up).
import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

describe("U5 — coordinated funds-cluster rotation (BudgetLedger + PaymentVault)", function () {
  let router: any;
  let ledgerV1: any, ledgerV2: any;
  let vaultV1: any, vaultV2: any;

  let owner: HardhatEthersSigner;
  let governor: HardhatEthersSigner;
  let campaignsS: HardhatEthersSigner;   // EOA stand-in for the Campaigns contract
  let settlementS: HardhatEthersSigner;  // EOA stand-in for Settlement
  let lifecycleS: HardhatEthersSigner;   // EOA stand-in for Lifecycle
  let advertiser: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let pub: HardhatEthersSigner;

  // BudgetLedger state: campaign 1 stays live, campaign 2 is drained → refund.
  const BUDGET_A = parseDOT("10");
  const BUDGET_B = parseDOT("5");
  const CAP = parseDOT("100");
  // PaymentVault state.
  const PUB_AMT = parseDOT("3");
  const USER_AMT = parseDOT("2");
  const PROTO_AMT = parseDOT("1");

  // The cluster's total custodied native PAS at rest.
  const CLUSTER_PAS = BUDGET_A + BUDGET_B + PUB_AMT + USER_AMT + PROTO_AMT;

  beforeEach(async function () {
    await fundSigners();
    [owner, governor, campaignsS, settlementS, lifecycleS, advertiser, user, pub] =
      await ethers.getSigners();

    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(governor.address);
    const routerAddr = await router.getAddress();

    // ── v1 cluster ──────────────────────────────────────────────────────────
    ledgerV1 = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
    await ledgerV1.setRouter(routerAddr);
    await ledgerV1.setCampaigns(campaignsS.address);
    await ledgerV1.setSettlement(settlementS.address);
    await ledgerV1.setLifecycle(lifecycleS.address);

    vaultV1 = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
    await vaultV1.setRouter(routerAddr);
    await vaultV1.setSettlement(settlementS.address);

    // ── load realistic state ────────────────────────────────────────────────
    await ledgerV1.connect(campaignsS).initializeBudget(1, 0, BUDGET_A, CAP, { value: BUDGET_A });
    await ledgerV1.connect(campaignsS).initializeBudget(2, 0, BUDGET_B, CAP, { value: BUDGET_B });
    await ledgerV1.connect(lifecycleS).drainToAdvertiser(2, advertiser.address); // queues refund B
    // creditSettlement records accounting; the vault is backed by a separate
    // native send (mirrors how Settlement funds it in production).
    await vaultV1.connect(settlementS).creditSettlement(
      pub.address, PUB_AMT, user.address, USER_AMT, PROTO_AMT,
    );
    await owner.sendTransaction({ to: await vaultV1.getAddress(), value: PUB_AMT + USER_AMT + PROTO_AMT });

    // ── v2 cluster (deployed, router-wired, not yet migrated) ─────────────────
    ledgerV2 = await (await ethers.getContractFactory("MockBudgetLedgerV2")).deploy();
    await ledgerV2.setRouter(routerAddr);
    await ledgerV2.setCampaigns(campaignsS.address);
    await ledgerV2.setSettlement(settlementS.address);
    await ledgerV2.setLifecycle(lifecycleS.address);

    vaultV2 = await (await ethers.getContractFactory("MockPaymentVaultV2")).deploy();
    await vaultV2.setRouter(routerAddr);
    await vaultV2.setSettlement(settlementS.address);
  });

  async function pasHeld(c: any): Promise<bigint> {
    return await ethers.provider.getBalance(await c.getAddress());
  }

  it("rotates the cluster together; conserves PAS cluster-wide; preserves state; v2 solvent + functional", async function () {
    // Pre-condition: the whole cluster's custodied PAS is accounted for.
    expect((await pasHeld(ledgerV1)) + (await pasHeld(vaultV1))).to.equal(CLUSTER_PAS);

    const ledgerV2Addr = await ledgerV2.getAddress();
    const vaultV2Addr = await vaultV2.getAddress();

    // ── COORDINATED ROTATION (governor drives the whole cluster as one unit) ──
    // 1. Freeze every v1 member (state becomes read-only; writes blocked).
    await ledgerV1.connect(governor).freeze();
    await vaultV1.connect(governor).freeze();
    // 2. Each v2 pulls accounting from its frozen predecessor.
    await ledgerV2.connect(governor).migrate(await ledgerV1.getAddress());
    await vaultV2.connect(governor).migrate(await vaultV1.getAddress());
    // 3. Sweep native PAS from each v1 to its successor.
    await ledgerV1.connect(governor).migrateFundsTo(ledgerV2Addr);
    await vaultV1.connect(governor).migrateFundsTo(vaultV2Addr);

    // ── No balance loss: cluster-wide PAS is conserved across the rotation ────
    expect((await pasHeld(ledgerV1))).to.equal(0n);
    expect((await pasHeld(vaultV1))).to.equal(0n);
    expect((await pasHeld(ledgerV2)) + (await pasHeld(vaultV2))).to.equal(CLUSTER_PAS);

    // ── No orphaned state: every per-entity record is present on v2 ───────────
    expect(await ledgerV2.getRemainingBudget(1, 0)).to.equal(BUDGET_A);   // live budget carried
    expect(await ledgerV2.getRemainingBudget(2, 0)).to.equal(0n);          // drained
    expect(await ledgerV2.pendingAdvertiserRefund(advertiser.address)).to.equal(BUDGET_B);
    expect(await vaultV2.publisherBalance(pub.address)).to.equal(PUB_AMT);
    expect(await vaultV2.userBalance(user.address)).to.equal(USER_AMT);
    expect(await vaultV2.protocolBalance()).to.equal(PROTO_AMT);
    expect(await vaultV2.holderCount()).to.equal(2n);

    // ── v2 is solvent + functional: real claims succeed against the migrated set
    await expect(vaultV2.connect(user).withdrawUser())
      .to.emit(vaultV2, "UserWithdrawal").withArgs(user.address, USER_AMT);
    await expect(ledgerV2.connect(advertiser).claimAdvertiserRefund())
      .to.emit(ledgerV2, "AdvertiserRefundClaimed");
    expect(await ledgerV2.pendingAdvertiserRefund(advertiser.address)).to.equal(0n);

    // ── Residual PAS after the two payouts equals exactly what's still owed ───
    // (live budget A in the ledger + publisher + protocol balances in the vault).
    expect((await pasHeld(ledgerV2)) + (await pasHeld(vaultV2)))
      .to.equal(CLUSTER_PAS - USER_AMT - BUDGET_B);
  });

  it("the coordinated rotation is governance-gated at every step", async function () {
    // freeze
    await expect(ledgerV1.connect(owner).freeze()).to.be.revertedWith("E19");
    await expect(vaultV1.connect(user).freeze()).to.be.revertedWith("E19");
    await ledgerV1.connect(governor).freeze();
    await vaultV1.connect(governor).freeze();
    // migrate
    await expect(ledgerV2.connect(owner).migrate(await ledgerV1.getAddress())).to.be.revertedWith("E19");
    await expect(vaultV2.connect(user).migrate(await vaultV1.getAddress())).to.be.revertedWith("E19");
    await ledgerV2.connect(governor).migrate(await ledgerV1.getAddress());
    await vaultV2.connect(governor).migrate(await vaultV1.getAddress());
    // fund sweep
    await expect(ledgerV1.connect(owner).migrateFundsTo(await ledgerV2.getAddress())).to.be.revertedWith("E19");
    await expect(vaultV1.connect(user).migrateFundsTo(await vaultV2.getAddress())).to.be.revertedWith("E19");
  });
});
