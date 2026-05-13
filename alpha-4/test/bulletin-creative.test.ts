// Tests for Phase A Bulletin Chain creative storage (audit pass 3.7).
// Covers: set / renew / expiry / escrow / renewer-trust-gradient / bounds.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumCampaigns,
  DatumPublishers,
  DatumPauseRegistry,
  DatumBudgetLedger,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";

describe("DatumCampaigns — Bulletin Chain creative storage", function () {
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let renewer1: HardhatEthersSigner;
  let renewer2: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let lifecycleMock: HardhatEthersSigner;

  const PENDING_TIMEOUT = 100_000n;
  const MIN_CPM = 0n;
  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

  const CID_BLAKE2B_RAW = 0;
  const SAMPLE_CID = "0x" + "ab".repeat(32);
  const SAMPLE_CID_2 = "0x" + "cd".repeat(32);

  // Match the contract constants
  const MAX_RETENTION_ADVANCE_BLOCKS = 220_000n;
  const BULLETIN_RENEWAL_LEAD_BLOCKS = 14_400n;
  const METADATA_COOLDOWN_BLOCKS = 14_400n;

  async function createCampaign(): Promise<bigint> {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n,
      { value: BUDGET }
    );
    await tx.wait();
    return (await campaigns.nextCampaignId()) - 1n;
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, advertiser, publisher, renewer1, renewer2, stranger, lifecycleMock] =
      await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, publisher.address);

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(
      MIN_CPM, PENDING_TIMEOUT,
      await publishers.getAddress(), await pauseReg.getAddress()
    );

    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);

    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // ─── B1: Initial registration ─────────────────────────────────────────────

  it("B1: advertiser registers a Bulletin Chain creative", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;

    await expect(
      campaigns.connect(advertiser).setBulletinCreative(
        id, SAMPLE_CID, CID_BLAKE2B_RAW, 100, 0, horizon
      )
    ).to.emit(campaigns, "BulletinCreativeSet");

    const ref = await campaigns.getBulletinCreative(id);
    expect(ref.cidDigest).to.equal(SAMPLE_CID);
    expect(ref.cidCodec).to.equal(0);
    expect(ref.bulletinBlock).to.equal(100);
    expect(ref.bulletinIndex).to.equal(0);
    expect(ref.retentionHorizonBlock).to.equal(horizon);
    expect(ref.version).to.equal(1);
  });

  it("B2: non-advertiser cannot setBulletinCreative", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await expect(
      campaigns.connect(stranger).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon)
    ).to.be.revertedWith("E21");
  });

  it("B3: zero CID digest reverts E00", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await expect(
      campaigns.connect(advertiser).setBulletinCreative(id, ethers.ZeroHash, 0, 100, 0, horizon)
    ).to.be.revertedWith("E00");
  });

  it("B4: zero bulletinBlock reverts E11", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await expect(
      campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 0, 0, horizon)
    ).to.be.revertedWith("E11");
  });

  it("B5: past retention horizon reverts E11", async function () {
    const id = await createCampaign();
    const cur = BigInt(await ethers.provider.getBlockNumber());
    await expect(
      campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, cur)
    ).to.be.revertedWith("E11");
  });

  it("B6: nonexistent campaign reverts E01", async function () {
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await expect(
      campaigns.connect(advertiser).setBulletinCreative(9999, SAMPLE_CID, 0, 100, 0, horizon)
    ).to.be.revertedWith("E01");
  });

  // ─── B7-B9: Renewal — advertiser path ─────────────────────────────────────

  it("B7: advertiser can confirmBulletinRenewal for free (no escrow needed)", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);

    await expect(
      campaigns.connect(advertiser).confirmBulletinRenewal(id, 200, 5)
    ).to.emit(campaigns, "BulletinCreativeRenewed");

    const ref = await campaigns.getBulletinCreative(id);
    expect(ref.bulletinBlock).to.equal(200);
    expect(ref.bulletinIndex).to.equal(5);
    expect(ref.cidDigest).to.equal(SAMPLE_CID); // unchanged on renewal
    expect(ref.version).to.equal(2);
  });

  it("B8: non-monotonic bulletinBlock on renewal reverts", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);

    await expect(
      campaigns.connect(advertiser).confirmBulletinRenewal(id, 100, 0)
    ).to.be.revertedWith("E11");
    await expect(
      campaigns.connect(advertiser).confirmBulletinRenewal(id, 50, 0)
    ).to.be.revertedWith("E11");
  });

  it("B9: renewal on unset creative reverts E01", async function () {
    const id = await createCampaign();
    await expect(
      campaigns.connect(advertiser).confirmBulletinRenewal(id, 200, 5)
    ).to.be.revertedWith("E01");
  });

  // ─── B10-B13: Renewer trust gradient ──────────────────────────────────────

  it("B10: default mode rejects non-advertiser renewer with E18", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);

    await expect(
      campaigns.connect(renewer1).confirmBulletinRenewal(id, 200, 0)
    ).to.be.revertedWith("E18");
  });

  it("B11: approved renewer can confirmBulletinRenewal", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await campaigns.connect(advertiser).setApprovedBulletinRenewer(id, renewer1.address, true);

    await expect(
      campaigns.connect(renewer1).confirmBulletinRenewal(id, 200, 0)
    ).to.emit(campaigns, "BulletinCreativeRenewed");

    // Revoking removes the right
    await campaigns.connect(advertiser).setApprovedBulletinRenewer(id, renewer1.address, false);
    await expect(
      campaigns.connect(renewer1).confirmBulletinRenewal(id, 300, 0)
    ).to.be.revertedWith("E18");
  });

  it("B12: open renewal mode lets anyone confirmBulletinRenewal", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await campaigns.connect(advertiser).setOpenBulletinRenewal(id, true);

    await expect(
      campaigns.connect(stranger).confirmBulletinRenewal(id, 200, 0)
    ).to.emit(campaigns, "BulletinCreativeRenewed");

    // Toggling open back off blocks subsequent renewers
    await campaigns.connect(advertiser).setOpenBulletinRenewal(id, false);
    await expect(
      campaigns.connect(stranger).confirmBulletinRenewal(id, 300, 0)
    ).to.be.revertedWith("E18");
  });

  it("B13: non-advertiser cannot setApprovedBulletinRenewer or setOpenBulletinRenewal", async function () {
    const id = await createCampaign();
    await expect(
      campaigns.connect(stranger).setApprovedBulletinRenewer(id, renewer1.address, true)
    ).to.be.revertedWith("E21");
    await expect(
      campaigns.connect(stranger).setOpenBulletinRenewal(id, true)
    ).to.be.revertedWith("E21");
  });

  // ─── B14-B17: Escrow + renewer reimbursement ──────────────────────────────

  it("B14: fundBulletinRenewalEscrow accepts DOT from anyone", async function () {
    const id = await createCampaign();
    await expect(
      campaigns.connect(stranger).fundBulletinRenewalEscrow(id, { value: parseDOT("0.5") })
    ).to.emit(campaigns, "BulletinRenewalEscrowFunded");
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(parseDOT("0.5"));

    // Subsequent funding accumulates
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("0.3") });
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(parseDOT("0.8"));
  });

  it("B15: approved renewer is paid bulletinRenewerReward from escrow", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await campaigns.connect(advertiser).setApprovedBulletinRenewer(id, renewer1.address, true);
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("1") });

    const reward = await campaigns.bulletinRenewerReward(); // default 0.01 DOT = 10^8
    const balBefore = await ethers.provider.getBalance(renewer1.address);
    const tx = await campaigns.connect(renewer1).confirmBulletinRenewal(id, 200, 0);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(renewer1.address);

    expect(balAfter - balBefore + gas).to.equal(reward);
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(parseDOT("1") - reward);
  });

  it("B16: advertiser pays no reward (self-renewal is free)", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("1") });
    const escrowBefore = await campaigns.bulletinRenewalEscrow(id);
    await campaigns.connect(advertiser).confirmBulletinRenewal(id, 200, 0);
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(escrowBefore);
  });

  it("B17: escrow under reward does not pay (graceful underfund)", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await campaigns.connect(advertiser).setOpenBulletinRenewal(id, true);
    // Fund less than the 0.01 DOT reward
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: 1n });

    const balBefore = await ethers.provider.getBalance(renewer1.address);
    const tx = await campaigns.connect(renewer1).confirmBulletinRenewal(id, 200, 0);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(renewer1.address);
    // Renewer not reimbursed (only paid gas); escrow untouched
    expect(balBefore - balAfter).to.equal(gas);
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(1n);
  });

  it("B18: advertiser can withdraw escrow to chosen recipient", async function () {
    const id = await createCampaign();
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("1") });
    const recipient = renewer2.address;
    const balBefore = await ethers.provider.getBalance(recipient);

    await campaigns.connect(advertiser).withdrawBulletinRenewalEscrow(id, recipient, parseDOT("0.4"));

    const balAfter = await ethers.provider.getBalance(recipient);
    expect(balAfter - balBefore).to.equal(parseDOT("0.4"));
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(parseDOT("0.6"));
  });

  it("B19: non-advertiser cannot withdraw escrow", async function () {
    const id = await createCampaign();
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("1") });
    await expect(
      campaigns.connect(stranger).withdrawBulletinRenewalEscrow(id, stranger.address, parseDOT("0.1"))
    ).to.be.revertedWith("E21");
  });

  it("B20: withdraw above escrow balance reverts E11", async function () {
    const id = await createCampaign();
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("0.1") });
    await expect(
      campaigns.connect(advertiser).withdrawBulletinRenewalEscrow(id, advertiser.address, parseDOT("1"))
    ).to.be.revertedWith("E11");
  });

  // ─── B21-B23: Expiry advancement bound ────────────────────────────────────

  it("B21: expiry advances by exactly MAX_RETENTION_ADVANCE_BLOCKS per renewal", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 5_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);

    const ref1 = await campaigns.getBulletinCreative(id);
    const blockAfterSet = BigInt(await ethers.provider.getBlockNumber());
    expect(ref1.expiryHubBlock).to.equal(blockAfterSet + MAX_RETENTION_ADVANCE_BLOCKS);

    await campaigns.connect(advertiser).confirmBulletinRenewal(id, 200, 0);
    const ref2 = await campaigns.getBulletinCreative(id);
    const blockAfterRenew = BigInt(await ethers.provider.getBlockNumber());
    expect(ref2.expiryHubBlock).to.equal(blockAfterRenew + MAX_RETENTION_ADVANCE_BLOCKS);
  });

  // ─── B24-B26: requestBulletinRenewal + markBulletinExpired ────────────────

  it("B22: requestBulletinRenewal reverts before lead window", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await expect(campaigns.requestBulletinRenewal(id)).to.be.revertedWith("E22");
  });

  it("B23: requestBulletinRenewal emits Due when in lead window", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    // Advance to within the lead window (expiry = block.number + 220_000)
    // Mine to expiry - 1000 (well within the 14_400 lead window)
    const ref = await campaigns.getBulletinCreative(id);
    const target = ref.expiryHubBlock - 1000n;
    const cur = BigInt(await ethers.provider.getBlockNumber());
    await mineBlocks(Number(target - cur));

    await expect(campaigns.requestBulletinRenewal(id))
      .to.emit(campaigns, "BulletinRenewalDue");
    expect(await campaigns.isBulletinRenewalDue(id)).to.equal(true);
  });

  it("B24: markBulletinExpired clears digest after expiry; pre-expiry reverts", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);

    await expect(campaigns.markBulletinExpired(id)).to.be.revertedWith("E22");

    // Mine past expiry
    const ref = await campaigns.getBulletinCreative(id);
    const cur = BigInt(await ethers.provider.getBlockNumber());
    await mineBlocks(Number(ref.expiryHubBlock - cur));

    await expect(campaigns.markBulletinExpired(id))
      .to.emit(campaigns, "BulletinCreativeExpired");
    const refAfter = await campaigns.getBulletinCreative(id);
    expect(refAfter.cidDigest).to.equal(ethers.ZeroHash);
  });

  // ─── B25-B27: Owner-tunable reward bound ──────────────────────────────────

  it("B25: setBulletinRenewerReward owner-only", async function () {
    await expect(
      campaigns.connect(stranger).setBulletinRenewerReward(parseDOT("0.1"))
    ).to.be.revertedWith("E18");
  });

  it("B26: setBulletinRenewerReward respects MAX cap", async function () {
    const cap = await campaigns.MAX_BULLETIN_RENEWER_REWARD();
    await campaigns.connect(owner).setBulletinRenewerReward(cap);
    expect(await campaigns.bulletinRenewerReward()).to.equal(cap);

    await expect(
      campaigns.connect(owner).setBulletinRenewerReward(cap + 1n)
    ).to.be.revertedWith("above cap");
  });

  it("B27: setBulletinRenewerReward to zero disables reward", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    await campaigns.connect(advertiser).setApprovedBulletinRenewer(id, renewer1.address, true);
    await campaigns.connect(advertiser).fundBulletinRenewalEscrow(id, { value: parseDOT("1") });

    await campaigns.connect(owner).setBulletinRenewerReward(0);
    const escrowBefore = await campaigns.bulletinRenewalEscrow(id);
    await campaigns.connect(renewer1).confirmBulletinRenewal(id, 200, 0);
    // Escrow untouched when reward is zero
    expect(await campaigns.bulletinRenewalEscrow(id)).to.equal(escrowBefore);
  });

  // ─── B28: CID swap (creative replacement) ────────────────────────────────

  it("B28: swapping CID bumps version and clears the version-bounded gate", async function () {
    const id = await createCampaign();
    const horizon = BigInt(await ethers.provider.getBlockNumber()) + 1_000_000n;
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID, 0, 100, 0, horizon);
    expect((await campaigns.getBulletinCreative(id)).version).to.equal(1);
    // While Pending, free updates
    await campaigns.connect(advertiser).setBulletinCreative(id, SAMPLE_CID_2, 0, 200, 1, horizon);
    expect((await campaigns.getBulletinCreative(id)).version).to.equal(2);
    expect((await campaigns.getBulletinCreative(id)).cidDigest).to.equal(SAMPLE_CID_2);
  });
});
