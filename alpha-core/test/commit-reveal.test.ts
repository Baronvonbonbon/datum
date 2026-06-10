import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumGovernanceV2,
  DatumActivationBonds,
  DatumPauseRegistry,
  MockCampaigns,
  MockCampaignLifecycle,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { mineBlocks, fundSigners } from "./helpers/mine";

// CR: commit-reveal on contested-Pending votes.
// Applies only when ActivationBonds is wired AND campaign is contested
// (challenger bond posted). Tests cover:
//   CR-1: phase gating (commit/reveal/evaluate windows)
//   CR-2: hash binding (mismatched reveals rejected)
//   CR-3: full lifecycle (commit → reveal → evaluate → outcome)
//   CR-4: non-revealer forfeit (sweepUnrevealed → slash pool)
//   CR-5: legacy vote() rejected on Pending when wired

describe("DatumGovernanceV2: commit-reveal (contested Pending)", function () {
  let v2: DatumGovernanceV2;
  let bonds: DatumActivationBonds;
  let mock: MockCampaigns;
  let lifecycle: MockCampaignLifecycle;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let creator: HardhatEthersSigner;
  let challenger: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let voter3: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const QUORUM = parseDOT("1");
  const SLASH_BPS = 1000n;
  const TERMINATION_QUORUM = parseDOT("0.5");
  const BASE_GRACE = 10n;
  const GRACE_PER_QUORUM = 20n;
  const MAX_GRACE = 50n;

  const MIN_BOND = parseDOT("0.1");
  const TIMELOCK = 100n;
  const COMMIT_BLOCKS = 50n;
  const REVEAL_BLOCKS = 50n;

  let nextCid = 1n;

  async function setupContestedCampaign(): Promise<bigint> {
    const cid = nextCid++;
    // Register as Pending
    await mock.setCampaign(cid, creator.address, ethers.ZeroAddress, 0n, 5000, 0);
    // Open bond on ActivationBonds
    await mock.callOpenBond(cid, creator.address, { value: MIN_BOND });
    // Challenge to contest
    await bonds.connect(challenger).challenge(cid, { value: MIN_BOND });
    return cid;
  }

  function commitHash(
    cid: bigint,
    voter: string,
    aye: boolean,
    conviction: number,
    salt: string
  ): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "bool", "uint8", "bytes32"],
      [cid, voter, aye, conviction, salt]
    );
  }
  function hashCommit(
    cid: bigint,
    voter: string,
    aye: boolean,
    conviction: number,
    salt: string
  ): string {
    return ethers.keccak256(commitHash(cid, voter, aye, conviction, salt));
  }

  beforeEach(async function () {
    await fundSigners();
    [owner, creator, challenger, voter1, voter2, voter3, other] =
      await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, voter1.address, voter2.address);

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();
    await mock.setLifecycleContract(owner.address); // owner can drive status

    const V2Factory = await ethers.getContractFactory("DatumGovernanceV2");
    v2 = await V2Factory.deploy(
      await mock.getAddress(),
      QUORUM, SLASH_BPS, TERMINATION_QUORUM,
      BASE_GRACE, GRACE_PER_QUORUM, MAX_GRACE,
      await pauseReg.getAddress()
    );
    await v2.setCommitRevealPhases(COMMIT_BLOCKS, REVEAL_BLOCKS);

    const LifecycleFactory = await ethers.getContractFactory("MockCampaignLifecycle");
    lifecycle = await LifecycleFactory.deploy(await mock.getAddress());
    await lifecycle.setGovernanceContract(await v2.getAddress());
    await mock.setLifecycleContract(await lifecycle.getAddress());
    // Restore owner as lifecycle source: in this test we need owner for
    // setCampaignStatus AND v2/lifecycle for real demotes. Use lifecycle's
    // governance wiring instead of bypassing.
    await v2.setLifecycle(await lifecycle.getAddress());
    await mock.setGovernanceContract(await v2.getAddress());

    const BondsFactory = await ethers.getContractFactory("DatumActivationBonds");
    bonds = await BondsFactory.deploy(MIN_BOND, TIMELOCK, 5000, 0, owner.address);
    await bonds.setCampaignsContract(await mock.getAddress());
    await mock.setActivationBonds(await bonds.getAddress());
    await v2.setActivationBonds(await bonds.getAddress());
  });

  // ---------------------------------------------------------------------------
  // CR-1: phase gating
  // ---------------------------------------------------------------------------
  describe("CR-1: phase gating", function () {
    it("commitVote requires contested status (E95)", async function () {
      const cid = nextCid++;
      await mock.setCampaign(cid, creator.address, ethers.ZeroAddress, 0n, 5000, 0);
      await mock.callOpenBond(cid, creator.address, { value: MIN_BOND });
      // No challenge: not contested
      const salt = ethers.id("salt");
      await expect(
        v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
          value: parseDOT("0.5"),
        })
      ).to.be.revertedWith("E95");
    });

    it("commitVote requires non-zero hash (E40) and value (E41)", async function () {
      const cid = await setupContestedCampaign();
      await expect(
        v2.connect(voter1).commitVote(cid, ethers.ZeroHash, { value: parseDOT("0.5") })
      ).to.be.revertedWith("E40");
      await expect(
        v2.connect(voter1).commitVote(cid, ethers.id("h"), { value: 0 })
      ).to.be.revertedWith("E41");
    });

    it("commit window closes after commitDeadline (E51)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      // First commit opens the window
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await mineBlocks(COMMIT_BLOCKS);
      // voter2 tries to commit after deadline
      await expect(
        v2.connect(voter2).commitVote(cid, hashCommit(cid, voter2.address, true, 0, salt), {
          value: parseDOT("0.5"),
        })
      ).to.be.revertedWith("E51");
    });

    it("revealVote before commitDeadline reverts (E51)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await expect(
        v2.connect(voter1).revealVote(cid, true, 0, salt)
      ).to.be.revertedWith("E51");
    });

    it("revealVote after revealDeadline reverts (E51)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await mineBlocks(COMMIT_BLOCKS + REVEAL_BLOCKS + 1n);
      await expect(
        v2.connect(voter1).revealVote(cid, true, 0, salt)
      ).to.be.revertedWith("E51");
    });
  });

  // ---------------------------------------------------------------------------
  // CR-2: hash binding
  // ---------------------------------------------------------------------------
  describe("CR-2: hash binding", function () {
    it("revealVote with wrong direction reverts (E53)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      // Try to reveal as nay — hash won't match
      await expect(
        v2.connect(voter1).revealVote(cid, false, 0, salt)
      ).to.be.revertedWith("E53");
    });

    it("revealVote with wrong conviction reverts (E53)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 2, salt), {
        value: parseDOT("0.5"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      await expect(
        v2.connect(voter1).revealVote(cid, true, 0, salt)
      ).to.be.revertedWith("E53");
    });

    it("revealVote by wrong sender reverts (E44 — no commit on record)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      await expect(
        v2.connect(voter2).revealVote(cid, true, 0, salt)
      ).to.be.revertedWith("E44");
    });

    it("double-commit reverts (E42)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await expect(
        v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, false, 0, salt), {
          value: parseDOT("0.5"),
        })
      ).to.be.revertedWith("E42");
    });

    it("double-reveal reverts (E44 — commit slot cleared on first reveal)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("salt");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("0.5"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      await v2.connect(voter1).revealVote(cid, true, 0, salt);
      await expect(
        v2.connect(voter1).revealVote(cid, true, 0, salt)
      ).to.be.revertedWith("E44");
    });
  });

  // ---------------------------------------------------------------------------
  // CR-3: lifecycle — commit, reveal, evaluate
  // ---------------------------------------------------------------------------
  describe("CR-3: full lifecycle", function () {
    it("aye wins: commit/reveal applied, evaluateCampaign activates after revealDeadline", async function () {
      const cid = await setupContestedCampaign();
      const saltA = ethers.id("saltA");
      const saltB = ethers.id("saltB");
      // Both voters commit aye with conviction 0 → weight = lockAmount × 1
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, saltA), {
        value: parseDOT("1"),
      });
      await v2.connect(voter2).commitVote(cid, hashCommit(cid, voter2.address, true, 0, saltB), {
        value: parseDOT("1"),
      });
      // While in commit window, tallies must be invisible (zero)
      expect(await v2.ayeWeighted(cid)).to.equal(0);
      expect(await v2.nayWeighted(cid)).to.equal(0);

      await mineBlocks(COMMIT_BLOCKS + 1n);

      // Reveal
      await v2.connect(voter1).revealVote(cid, true, 0, saltA);
      await v2.connect(voter2).revealVote(cid, true, 0, saltB);
      expect(await v2.ayeWeighted(cid)).to.equal(parseDOT("2"));

      // evaluate before revealDeadline reverts
      await expect(v2.evaluateCampaign(cid)).to.be.revertedWith("E51");

      await mineBlocks(REVEAL_BLOCKS + MAX_GRACE);
      await v2.evaluateCampaign(cid);
      expect(await mock.getCampaignStatus(cid)).to.equal(1); // Active
    });

    it("nay wins: terminate after grace; resolved=true", async function () {
      const cid = await setupContestedCampaign();
      const saltA = ethers.id("nayA");
      const saltB = ethers.id("nayB");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, false, 0, saltA), {
        value: parseDOT("1"),
      });
      await v2.connect(voter2).commitVote(cid, hashCommit(cid, voter2.address, false, 0, saltB), {
        value: parseDOT("1"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      await v2.connect(voter1).revealVote(cid, false, 0, saltA);
      await v2.connect(voter2).revealVote(cid, false, 0, saltB);
      await mineBlocks(REVEAL_BLOCKS + MAX_GRACE);
      await v2.evaluateCampaign(cid);
      expect(await mock.getCampaignStatus(cid)).to.equal(4); // Terminated
      expect(await v2.resolved(cid)).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // CR-4: non-revealer forfeit
  // ---------------------------------------------------------------------------
  describe("CR-4: non-revealer forfeit", function () {
    it("sweepUnrevealed before revealDeadline reverts (E51)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("s");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("1"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      await expect(v2.sweepUnrevealed(cid, voter1.address)).to.be.revertedWith("E51");
    });

    it("sweepUnrevealed moves full stake to slash pool after revealDeadline", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("s");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("1"),
      });
      await mineBlocks(COMMIT_BLOCKS + REVEAL_BLOCKS + 1n);

      await expect(v2.sweepUnrevealed(cid, voter1.address))
        .to.emit(v2, "UnrevealedSwept").withArgs(cid, voter1.address, parseDOT("1"));
      expect(await v2.slashCollected(cid)).to.equal(parseDOT("1"));
    });

    it("sweepUnrevealed on a revealed vote reverts (E44)", async function () {
      const cid = await setupContestedCampaign();
      const salt = ethers.id("s");
      await v2.connect(voter1).commitVote(cid, hashCommit(cid, voter1.address, true, 0, salt), {
        value: parseDOT("1"),
      });
      await mineBlocks(COMMIT_BLOCKS + 1n);
      await v2.connect(voter1).revealVote(cid, true, 0, salt);
      await mineBlocks(REVEAL_BLOCKS + 1n);
      await expect(v2.sweepUnrevealed(cid, voter1.address)).to.be.revertedWith("E44");
    });
  });
});
