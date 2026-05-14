import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumActivationBonds, MockCampaigns } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, fundSigners } from "./helpers/mine";

// AB: optimistic-activation collateral. The current vote-to-activate flow is
// replaced for routine campaigns by a creator bond + timelock + permissionless
// activate(). A challenger may post a counter-bond during the timelock to
// escalate the campaign into the GovernanceV2 vote path; bonds are
// slashed/refunded on resolution.
//
// AB-1: openBond gating + state transitions
// AB-2: optimistic activate path
// AB-3: challenge path → settle on Active (creator wins)
// AB-4: challenge path → settle on Terminated (challenger wins)
// AB-5: settle on Expired (no-fault)
// AB-6: pull-pattern claim
// AB-7: parameter governance

describe("DatumActivationBonds", function () {
  let bonds: DatumActivationBonds;
  let mock: MockCampaigns;

  let owner: HardhatEthersSigner;
  let creator: HardhatEthersSigner;
  let challenger: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let governance: HardhatEthersSigner;

  const MIN_BOND = parseDOT("0.1");
  const TIMELOCK = 100n; // blocks
  const WINNER_BONUS_BPS = 5000; // 50%
  const TREASURY_BPS = 0;

  let nextCid = 1n;

  // Open a bond for a fresh campaign id by forwarding through MockCampaigns
  // (which is wired as the canonical campaignsContract on ActivationBonds).
  async function openBondFor(creator_: HardhatEthersSigner, amount: bigint): Promise<bigint> {
    const cid = nextCid++;
    // Register the campaign in the mock as Pending so getCampaignForSettlement
    // returns status 0 for the optimistic-activate path.
    await mock.setCampaign(cid, creator_.address, ethers.ZeroAddress, 0n, 5000, 0);
    await mock.callOpenBond(cid, creator_.address, { value: amount });
    return cid;
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, creator, challenger, other, treasury, governance] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();
    await mock.setGovernanceContract(governance.address);
    // Wire owner as lifecycle so tests can drive status transitions directly.
    await mock.setLifecycleContract(owner.address);

    const BondsFactory = await ethers.getContractFactory("DatumActivationBonds");
    bonds = await BondsFactory.deploy(
      MIN_BOND, TIMELOCK, WINNER_BONUS_BPS, TREASURY_BPS, treasury.address
    );
    await bonds.setCampaignsContract(await mock.getAddress());
    await mock.setActivationBonds(await bonds.getAddress());
  });

  // -------------------------------------------------------------------------
  // AB-1: openBond gating + state
  // -------------------------------------------------------------------------

  describe("AB-1: openBond gating + state", function () {
    it("only Campaigns contract may call openBond (E19)", async function () {
      await expect(
        bonds.connect(other).openBond(1, creator.address, { value: MIN_BOND })
      ).to.be.revertedWith("E19");
    });

    it("rejects bonds below minBond (E11)", async function () {
      const cid = ++nextCid;
      await expect(
        mock.callOpenBond(cid, creator.address, { value: MIN_BOND - 1n })
      ).to.be.revertedWith("E11");
    });

    it("opens bond and sets phase=Open with timelock", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      expect(await bonds.phase(cid)).to.equal(1); // Open
      expect(await bonds.creatorOf(cid)).to.equal(creator.address);
      expect(await bonds.creatorBond(cid)).to.equal(MIN_BOND);
      const expiry = await bonds.timelockExpiry(cid);
      const cur = BigInt(await ethers.provider.getBlockNumber());
      expect(expiry).to.equal(cur + TIMELOCK);
    });

    it("rejects double-open on same campaignId (E94)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await expect(
        mock.callOpenBond(cid, creator.address, { value: MIN_BOND })
      ).to.be.revertedWith("E94");
    });
  });

  // -------------------------------------------------------------------------
  // AB-2: optimistic activate
  // -------------------------------------------------------------------------

  describe("AB-2: optimistic activate path", function () {
    it("permissionless activate after timelock flips status to Active and queues refund", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await mineBlocks(TIMELOCK);

      await expect(bonds.connect(other).activate(cid))
        .to.emit(bonds, "Activated").withArgs(cid, other.address)
        .and.to.emit(bonds, "Resolved").withArgs(cid, true, MIN_BOND, 0, 0);

      expect(await bonds.phase(cid)).to.equal(3); // Resolved
      expect(await mock.getCampaignStatus(cid)).to.equal(1); // Active
      expect(await bonds.pending(creator.address)).to.equal(MIN_BOND);
    });

    it("activate before timelock reverts (E96)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await expect(bonds.activate(cid)).to.be.revertedWith("E96");
    });

    it("activate on non-existent bond reverts (E95)", async function () {
      await expect(bonds.activate(999)).to.be.revertedWith("E95");
    });

    it("activate on contested bond reverts (E95)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await bonds.connect(challenger).challenge(cid, { value: MIN_BOND });
      await mineBlocks(TIMELOCK);
      await expect(bonds.activate(cid)).to.be.revertedWith("E95");
    });
  });

  // -------------------------------------------------------------------------
  // AB-3: challenge → creator wins via governance Active
  // -------------------------------------------------------------------------

  describe("AB-3: challenge + creator wins", function () {
    it("challenge requires bond ≥ creator bond (E97)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await expect(
        bonds.connect(challenger).challenge(cid, { value: MIN_BOND - 1n })
      ).to.be.revertedWith("E97");
    });

    it("creator cannot self-challenge (E97)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await expect(
        bonds.connect(creator).challenge(cid, { value: MIN_BOND })
      ).to.be.revertedWith("E97");
    });

    it("challenge after timelock reverts (E96)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await mineBlocks(TIMELOCK + 1n);
      await expect(
        bonds.connect(challenger).challenge(cid, { value: MIN_BOND })
      ).to.be.revertedWith("E96");
    });

    it("settle on Active: creator refunded full bond + 50% bonus, challenger keeps remainder", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await bonds.connect(challenger).challenge(cid, { value: MIN_BOND });
      expect(await bonds.phase(cid)).to.equal(2); // Contested

      // Governance vote upheld activation
      await mock.connect(governance).activateCampaign(cid);
      await bonds.settle(cid);

      // Creator gets own bond back + 50% of challenger bond
      expect(await bonds.pending(creator.address)).to.equal(MIN_BOND + MIN_BOND / 2n);
      // Challenger gets 50% back (no treasury cut)
      expect(await bonds.pending(challenger.address)).to.equal(MIN_BOND / 2n);
      expect(await bonds.phase(cid)).to.equal(3);
    });

    it("double-settle reverts (E94)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await bonds.connect(challenger).challenge(cid, { value: MIN_BOND });
      await mock.connect(governance).activateCampaign(cid);
      await bonds.settle(cid);
      await expect(bonds.settle(cid)).to.be.revertedWith("E94");
    });
  });

  // -------------------------------------------------------------------------
  // AB-4: challenge → challenger wins via Terminated
  // -------------------------------------------------------------------------

  describe("AB-4: challenge + challenger wins", function () {
    it("settle on Terminated: challenger refunded + 50% bonus, creator keeps remainder", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await bonds.connect(challenger).challenge(cid, { value: MIN_BOND });

      // Governance terminates campaign (status=4 Terminated)
      await mock.setCampaignStatus(cid, 4);
      await bonds.settle(cid);

      expect(await bonds.pending(challenger.address)).to.equal(MIN_BOND + MIN_BOND / 2n);
      expect(await bonds.pending(creator.address)).to.equal(MIN_BOND / 2n);
    });

    it("cannot settle as Terminated without prior challenge (E96)", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      // No challenger; campaign goes Terminated directly. settle on Terminated
      // requires Contested phase — otherwise it's a no-op terminated campaign
      // and creator should call the no-fault Expired path instead.
      await mock.setCampaignStatus(cid, 4);
      await expect(bonds.settle(cid)).to.be.revertedWith("E96");
    });
  });

  // -------------------------------------------------------------------------
  // AB-5: no-fault expiry
  // -------------------------------------------------------------------------

  describe("AB-5: Expired = no-fault refund", function () {
    it("settle on Expired refunds both parties", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await bonds.connect(challenger).challenge(cid, { value: MIN_BOND });
      await mock.setCampaignStatus(cid, 5); // Expired
      await bonds.settle(cid);
      expect(await bonds.pending(creator.address)).to.equal(MIN_BOND);
      expect(await bonds.pending(challenger.address)).to.equal(MIN_BOND);
    });

    it("settle on Expired refunds creator only when uncontested", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await mock.setCampaignStatus(cid, 5);
      await bonds.settle(cid);
      expect(await bonds.pending(creator.address)).to.equal(MIN_BOND);
    });
  });

  // -------------------------------------------------------------------------
  // AB-6: pull claim
  // -------------------------------------------------------------------------

  describe("AB-6: pull claim", function () {
    it("claim() transfers queued amount to msg.sender", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await mineBlocks(TIMELOCK);
      await bonds.activate(cid);
      const before = await ethers.provider.getBalance(creator.address);
      const tx = await bonds.connect(creator).claim();
      const rcpt = await tx.wait();
      const gas = rcpt!.gasUsed * rcpt!.gasPrice;
      const after = await ethers.provider.getBalance(creator.address);
      expect(after + gas - before).to.equal(MIN_BOND);
      expect(await bonds.pending(creator.address)).to.equal(0);
    });

    it("claim() with zero pending reverts (E03)", async function () {
      await expect(bonds.connect(other).claim()).to.be.revertedWith("E03");
    });

    it("claimTo() routes to alt recipient", async function () {
      const cid = await openBondFor(creator, MIN_BOND);
      await mineBlocks(TIMELOCK);
      await bonds.activate(cid);
      const before = await ethers.provider.getBalance(other.address);
      await bonds.connect(creator).claimTo(other.address);
      const after = await ethers.provider.getBalance(other.address);
      expect(after - before).to.equal(MIN_BOND);
    });
  });

  // -------------------------------------------------------------------------
  // AB-7: governable parameters
  // -------------------------------------------------------------------------

  describe("AB-7: governable parameters", function () {
    it("setPunishmentBps caps combined slash at MAX_PUNISHMENT_BPS (E11)", async function () {
      await expect(bonds.setPunishmentBps(8001, 0)).to.be.revertedWith("E11");
      await expect(bonds.setPunishmentBps(5000, 5000)).to.be.revertedWith("E11");
    });

    it("setTimelockBlocks rejects zero (E11)", async function () {
      await expect(bonds.setTimelockBlocks(0)).to.be.revertedWith("E11");
    });

    it("setTimelockBlocks rejects > MAX_TIMELOCK_BLOCKS (E11)", async function () {
      const max = await bonds.MAX_TIMELOCK_BLOCKS();
      await expect(bonds.setTimelockBlocks(max + 1n)).to.be.revertedWith("E11");
    });

    it("only owner can set parameters (E18)", async function () {
      await expect(bonds.connect(other).setMinBond(1)).to.be.revertedWith("E18");
      await expect(bonds.connect(other).setTimelockBlocks(50)).to.be.revertedWith("E18");
    });

    it("setCampaignsContract is lock-once", async function () {
      await expect(bonds.setCampaignsContract(other.address)).to.be.revertedWith("already set");
    });

    it("treasury cut routes to treasury account", async function () {
      // Redeploy with 50% bonus + 20% treasury cut
      const BondsFactory = await ethers.getContractFactory("DatumActivationBonds");
      const bonds2 = await BondsFactory.deploy(MIN_BOND, TIMELOCK, 5000, 2000, treasury.address);
      const MockFactory = await ethers.getContractFactory("MockCampaigns");
      const mock2 = await MockFactory.deploy();
      await mock2.setGovernanceContract(governance.address);
      await bonds2.setCampaignsContract(await mock2.getAddress());
      await mock2.setActivationBonds(await bonds2.getAddress());

      const cid = 1n;
      await mock2.setCampaign(cid, creator.address, ethers.ZeroAddress, 0n, 5000, 0);
      await mock2.callOpenBond(cid, creator.address, { value: MIN_BOND });
      await bonds2.connect(challenger).challenge(cid, { value: MIN_BOND });
      await mock2.connect(governance).activateCampaign(cid);
      await bonds2.settle(cid);

      // Creator: own bond + 50% bonus from challenger
      expect(await bonds2.pending(creator.address)).to.equal(MIN_BOND + (MIN_BOND * 5000n) / 10000n);
      // Treasury: 20% of challenger bond
      expect(await bonds2.pending(treasury.address)).to.equal((MIN_BOND * 2000n) / 10000n);
      // Challenger: remainder = 30%
      expect(await bonds2.pending(challenger.address)).to.equal((MIN_BOND * 3000n) / 10000n);
    });
  });
});
