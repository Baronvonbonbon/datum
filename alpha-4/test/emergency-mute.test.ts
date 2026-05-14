import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumActivationBonds,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, fundSigners } from "./helpers/mine";

// MUTE: Phase 2b emergency mute bond. Anyone may post a bond to instantly
// halt an Active campaign while the existing open-tally demote vote runs.
// Mute upheld (campaign Terminated) → muter refunded. Mute rejected
// (campaign Active after muteMaxBlocks) → muter bond paid to advertiser.
// Expired/Completed → no-fault refund.
//
// MUTE-1: open/gate
// MUTE-2: isMuted view
// MUTE-3: resolution paths
// MUTE-4: timeout/grief protection
// MUTE-5: parameters

describe("DatumActivationBonds: emergency mute (Phase 2b)", function () {
  let bonds: DatumActivationBonds;
  let mock: MockCampaigns;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let muter: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  const MIN_BOND = parseDOT("0.1");
  const TIMELOCK = 100n;
  const MUTE_MAX_BLOCKS = 200n;

  let nextCid = 1n;

  async function setupActiveCampaign(): Promise<bigint> {
    const cid = nextCid++;
    // Set as Active so mute() passes the status check
    await mock.setCampaign(cid, advertiser.address, ethers.ZeroAddress, 0n, 5000, 1);
    return cid;
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, advertiser, muter, other, treasury] = await ethers.getSigners();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();
    await mock.setLifecycleContract(owner.address);

    const BondsFactory = await ethers.getContractFactory("DatumActivationBonds");
    bonds = await BondsFactory.deploy(MIN_BOND, TIMELOCK, 5000, 0, treasury.address);
    await bonds.setCampaignsContract(await mock.getAddress());
    await bonds.setMuteMaxBlocks(MUTE_MAX_BLOCKS);
  });

  // ---------------------------------------------------------------------------
  // MUTE-1: gating
  // ---------------------------------------------------------------------------
  describe("MUTE-1: gating", function () {
    it("requires Active status (E20)", async function () {
      const cid = nextCid++;
      // Pending campaign
      await mock.setCampaign(cid, advertiser.address, ethers.ZeroAddress, 0n, 5000, 0);
      await expect(
        bonds.connect(muter).mute(cid, { value: parseDOT("1") })
      ).to.be.revertedWith("E20");
    });

    it("requires bond ≥ muteMinBond (E11)", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await expect(
        bonds.connect(muter).mute(cid, { value: floor - 1n })
      ).to.be.revertedWith("E11");
    });

    it("advertiser cannot self-mute (E97)", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await expect(
        bonds.connect(advertiser).mute(cid, { value: floor })
      ).to.be.revertedWith("E97");
    });

    it("double-mute rejected (E94)", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await expect(
        bonds.connect(other).mute(cid, { value: floor })
      ).to.be.revertedWith("E94");
    });

    it("opens mute and records state", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await expect(bonds.connect(muter).mute(cid, { value: floor }))
        .to.emit(bonds, "Muted").withArgs(cid, muter.address, floor);

      expect(await bonds.isMuted(cid)).to.equal(true);
      expect(await bonds.muterOf(cid)).to.equal(muter.address);
      expect(await bonds.muteBondOf(cid)).to.equal(floor);
    });
  });

  // ---------------------------------------------------------------------------
  // MUTE-2: isMuted view exposed for validator consumption
  // ---------------------------------------------------------------------------
  describe("MUTE-2: isMuted view", function () {
    it("returns false for unmuted campaign", async function () {
      const cid = await setupActiveCampaign();
      expect(await bonds.isMuted(cid)).to.equal(false);
    });
    it("returns true while muted, false after settle", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      expect(await bonds.isMuted(cid)).to.equal(true);

      // Move to Terminated → settleMute upholds
      await mock.setCampaignStatus(cid, 4);
      await bonds.settleMute(cid);
      expect(await bonds.isMuted(cid)).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------
  // MUTE-3: resolution paths
  // ---------------------------------------------------------------------------
  describe("MUTE-3: resolution", function () {
    it("Terminated: mute upheld, muter refunded", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await mock.setCampaignStatus(cid, 4); // Terminated
      await expect(bonds.settleMute(cid))
        .to.emit(bonds, "MuteResolved").withArgs(cid, true, floor);
      expect(await bonds.pending(muter.address)).to.equal(floor);
    });

    it("still Active before timeout: cannot settle (E96)", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await expect(bonds.settleMute(cid)).to.be.revertedWith("E96");
    });

    it("still Active after muteMaxBlocks: bond paid to advertiser", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await mineBlocks(MUTE_MAX_BLOCKS);
      await expect(bonds.settleMute(cid))
        .to.emit(bonds, "MuteResolved").withArgs(cid, false, floor);
      expect(await bonds.pending(advertiser.address)).to.equal(floor);
      expect(await bonds.pending(muter.address)).to.equal(0);
    });

    it("Expired: no-fault refund to muter", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await mock.setCampaignStatus(cid, 5); // Expired
      await bonds.settleMute(cid);
      expect(await bonds.pending(muter.address)).to.equal(floor);
    });

    it("Completed: no-fault refund to muter", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await mock.setCampaignStatus(cid, 3); // Completed
      await bonds.settleMute(cid);
      expect(await bonds.pending(muter.address)).to.equal(floor);
    });

    it("Pending mid-vote: not yet resolvable (E98)", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      // Demote → Pending while still inside mute window: settleMute waits
      await mock.setCampaignStatus(cid, 0); // Pending
      await expect(bonds.settleMute(cid)).to.be.revertedWith("E98");
    });

    it("re-mute allowed after settle (single-shot lock cleared)", async function () {
      const cid = await setupActiveCampaign();
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await mock.setCampaignStatus(cid, 4); // Terminated
      await bonds.settleMute(cid);

      // Set Active again for a new mute (test fixture; in reality the campaign
      // would need to come back via governance — but tests only care about
      // the state machine).
      await mock.setCampaign(cid, advertiser.address, ethers.ZeroAddress, 0n, 5000, 1);
      await bonds.connect(other).mute(cid, { value: floor });
      expect(await bonds.isMuted(cid)).to.equal(true);
    });

    it("settleMute on never-muted campaign reverts (E95)", async function () {
      const cid = await setupActiveCampaign();
      await expect(bonds.settleMute(cid)).to.be.revertedWith("E95");
    });
  });

  // ---------------------------------------------------------------------------
  // MUTE-4: parameters
  // ---------------------------------------------------------------------------
  describe("MUTE-4: governable params", function () {
    it("muteMinBond default is 10× minBond", async function () {
      expect(await bonds.muteMinBond()).to.equal(MIN_BOND * 10n);
    });

    it("setMuteMinBond + setMuteMaxBlocks (owner only)", async function () {
      await expect(bonds.connect(other).setMuteMinBond(123)).to.be.revertedWith("E18");
      await expect(bonds.connect(other).setMuteMaxBlocks(123)).to.be.revertedWith("E18");

      await bonds.setMuteMinBond(parseDOT("5"));
      expect(await bonds.muteMinBond()).to.equal(parseDOT("5"));

      await bonds.setMuteMaxBlocks(50);
      expect(await bonds.muteMaxBlocks()).to.equal(50);
    });

    it("setMuteMaxBlocks rejects zero and > MAX_TIMELOCK_BLOCKS (E11)", async function () {
      await expect(bonds.setMuteMaxBlocks(0)).to.be.revertedWith("E11");
      const max = await bonds.MAX_TIMELOCK_BLOCKS();
      await expect(bonds.setMuteMaxBlocks(max + 1n)).to.be.revertedWith("E11");
    });
  });

  // ---------------------------------------------------------------------------
  // MUTE-V: ClaimValidator integration — muted campaign rejects with reason 22
  // ---------------------------------------------------------------------------
  describe("MUTE-V: validator rejection", function () {
    it("validateClaim returns reason 22 when campaign is bond-muted", async function () {
      const cid = await setupActiveCampaign();

      // Deploy a real DatumClaimValidator with our MockCampaigns as both the
      // campaigns and publishers ref (publishers is only consulted later in
      // the pipeline — our test only cares about the early mute short-circuit).
      const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
      const pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, muter.address);
      const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
      const validator = await ValidatorFactory.deploy(
        await mock.getAddress(),
        await mock.getAddress(), // mock doubles as publishers stub here
        await pauseReg.getAddress()
      );
      await validator.setActivationBonds(await bonds.getAddress());

      // Mute the campaign
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      expect(await bonds.isMuted(cid)).to.equal(true);

      // Construct a minimal claim — only the early validateClaim path runs.
      const claim = {
        campaignId: cid,
        publisher: muter.address,
        eventCount: 1n,
        ratePlanck: parseDOT("0.01"),
        actionType: 0,
        clickSessionHash: ethers.ZeroHash,
        nonce: 1n,
        previousClaimHash: ethers.ZeroHash,
        claimHash: ethers.ZeroHash,
        zkProof: Array(8).fill(ethers.ZeroHash) as any,
        nullifier: ethers.ZeroHash,
        stakeRootUsed: ethers.ZeroHash,
        actionSig: Array(3).fill(ethers.ZeroHash) as any,
        powNonce: ethers.ZeroHash,
      };
      const [ok, reason] = await validator.validateClaim(claim, muter.address, 1n, ethers.ZeroHash);
      expect(ok).to.equal(false);
      expect(reason).to.equal(22);

      // After settle, isMuted=false and the validator no longer returns 22.
      await mock.setCampaignStatus(cid, 4); // Terminated
      await bonds.settleMute(cid);
      // Restore to Active for the second assertion
      await mock.setCampaign(cid, advertiser.address, ethers.ZeroAddress, 0n, 5000, 1);
      const [ok2, reason2] = await validator.validateClaim(claim, muter.address, 1n, ethers.ZeroHash);
      expect(ok2).to.equal(false);
      expect(reason2).to.not.equal(22); // some downstream reason, not the mute one
    });
  });

  // ---------------------------------------------------------------------------
  // MUTE-5: fallback to treasury when advertiser unknown
  // ---------------------------------------------------------------------------
  describe("MUTE-5: advertiser fallback", function () {
    it("rejected mute with zero-advertiser campaign routes bond to treasury", async function () {
      const cid = nextCid++;
      // Active campaign with no advertiser (synthetic edge case)
      await mock.setCampaign(cid, ethers.ZeroAddress, ethers.ZeroAddress, 0n, 5000, 1);
      const floor = await bonds.muteMinBond();
      await bonds.connect(muter).mute(cid, { value: floor });
      await mineBlocks(MUTE_MAX_BLOCKS);
      await bonds.settleMute(cid);
      expect(await bonds.pending(treasury.address)).to.equal(floor);
    });
  });
});
