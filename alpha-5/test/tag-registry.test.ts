import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumTagRegistry, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners, mineBlocks } from "./helpers/mine";

// Three-lane tag-policy model (2026-05-14): StakeGated lane.
// Tests the full lifecycle: register → use → challenge → commit/reveal →
// resolve → expire. Schelling-jury commit-reveal arbitration. Symmetric
// bonds. 100%-to-caller expiry bounty.

describe("DatumTagRegistry (StakeGated lane)", function () {
  let registry: DatumTagRegistry;
  let datum: MockERC20;

  let owner: HardhatEthersSigner;
  let campaigns: HardhatEthersSigner; // stand-in for DatumCampaigns address
  let alice: HardhatEthersSigner;     // tag owner
  let bob: HardhatEthersSigner;       // challenger
  let j1: HardhatEthersSigner;
  let j2: HardhatEthersSigner;
  let j3: HardhatEthersSigner;
  let j4: HardhatEthersSigner;
  let j5: HardhatEthersSigner;
  let j6: HardhatEthersSigner;
  let j7: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const ONE = 10n ** 18n;
  const tag = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

  // The commit hash matches the on-chain check:
  //   keccak256(abi.encode(disputeId, juror, vote, salt))
  function commitHash(disputeId: bigint, juror: string, vote: number, salt: string): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint8", "bytes32"],
        [disputeId, juror, vote, salt],
      ),
    );
  }

  async function deployFresh() {
    datum = await (await ethers.getContractFactory("MockERC20")).deploy("Wrapped DATUM", "WDATUM");
    registry = await (await ethers.getContractFactory("DatumTagRegistry"))
      .deploy(await datum.getAddress()) as unknown as DatumTagRegistry;
    await registry.connect(owner).setCampaignsContract(campaigns.address);
  }

  async function mintAndApprove(who: HardhatEthersSigner, amount: bigint) {
    await datum.mint(who.address, amount);
    await datum.connect(who).approve(await registry.getAddress(), amount);
  }

  async function seedJurors(jurors: HardhatEthersSigner[], stake: bigint = 100n * ONE) {
    for (const j of jurors) {
      await datum.mint(j.address, stake);
      await datum.connect(j).approve(await registry.getAddress(), stake);
      await registry.connect(j).stakeAsJuror(stake);
    }
  }

  before(async function () {
    await fundSigners();
    [owner, campaigns, alice, bob, j1, j2, j3, j4, j5, j6, j7, outsider] = await ethers.getSigners();
  });

  // ---------------------------------------------------------------------
  // Constructor + initial parameters
  // ---------------------------------------------------------------------

  describe("Construction & initial parameters", function () {
    before(deployFresh);

    it("rejects zero address for staking token", async function () {
      await expect(
        (await ethers.getContractFactory("DatumTagRegistry")).deploy(ethers.ZeroAddress),
      ).to.be.revertedWith("E00");
    });

    it("initial parameters match conservative defaults", async function () {
      expect(await registry.minTagBond()).to.equal(10n * ONE);
      expect(await registry.jurorMinStake()).to.equal(5n * ONE);
      expect(await registry.commitWindow()).to.equal(14400n);
      expect(await registry.revealWindow()).to.equal(14400n);
      expect(await registry.jurySize()).to.equal(5n);
      expect(await registry.juryRewardBps()).to.equal(2000n);
      expect(await registry.jurorSlashBps()).to.equal(2000n);
      expect(await registry.expiryBlocks()).to.equal(432000n);
      expect(await registry.nextDisputeId()).to.equal(1n);
    });

    it("staking token is immutable and queryable", async function () {
      expect(await registry.datum()).to.equal(await datum.getAddress());
    });
  });

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  describe("registerTag", function () {
    beforeEach(deployFresh);

    it("succeeds and transfers bond when amount >= minTagBond", async function () {
      const T = tag("topic:crypto");
      const amount = 10n * ONE;
      await mintAndApprove(alice, amount);

      await expect(registry.connect(alice).registerTag(T, amount))
        .to.emit(registry, "TagRegistered").withArgs(T, alice.address, amount);

      expect(await registry.isTagBonded(T)).to.equal(true);
      expect(await registry.tagOwner(T)).to.equal(alice.address);
      expect(await registry.tagBond(T)).to.equal(amount);
      expect(await datum.balanceOf(await registry.getAddress())).to.equal(amount);
    });

    it("reverts T04 when bond below minTagBond", async function () {
      const T = tag("topic:low");
      const tooLow = ONE; // 1 WDATUM, below 10 WDATUM floor
      await mintAndApprove(alice, tooLow);
      await expect(registry.connect(alice).registerTag(T, tooLow))
        .to.be.revertedWith("T04");
    });

    it("reverts E00 on zero tag", async function () {
      await mintAndApprove(alice, 10n * ONE);
      await expect(registry.connect(alice).registerTag(ethers.ZeroHash, 10n * ONE))
        .to.be.revertedWith("E00");
    });

    it("reverts T05 if tag already Bonded", async function () {
      const T = tag("topic:dup");
      await mintAndApprove(alice, 20n * ONE);
      await registry.connect(alice).registerTag(T, 10n * ONE);
      await expect(registry.connect(alice).registerTag(T, 10n * ONE))
        .to.be.revertedWith("T05");
    });

    it("allows re-registration after expiry by a new owner", async function () {
      const T = tag("topic:reuse");
      await mintAndApprove(alice, 10n * ONE);
      await registry.connect(alice).registerTag(T, 10n * ONE);

      // Advance past expiry window and have outsider reap.
      await mineBlocks(432000n + 1n);
      await registry.connect(outsider).expireTag(T);
      expect(await registry.tagState(T)).to.equal(3n); // Expired

      // Bob now registers it fresh.
      await mintAndApprove(bob, 10n * ONE);
      await registry.connect(bob).registerTag(T, 10n * ONE);
      expect(await registry.tagOwner(T)).to.equal(bob.address);
      expect(await registry.tagState(T)).to.equal(1n); // Bonded
    });
  });

  // ---------------------------------------------------------------------
  // recordUsage
  // ---------------------------------------------------------------------

  describe("recordUsage", function () {
    beforeEach(deployFresh);

    it("reverts T06 from non-Campaigns caller", async function () {
      const T = tag("x");
      await expect(registry.connect(outsider).recordUsage(T))
        .to.be.revertedWith("T06");
    });

    it("silent no-op for non-Bonded tag (does not revert)", async function () {
      const T = tag("never-registered");
      // campaigns is wired in deployFresh; calling on unknown tag is a no-op.
      await expect(registry.connect(campaigns).recordUsage(T)).to.not.be.reverted;
    });

    it("refreshes lastUsedBlock on a Bonded tag", async function () {
      const T = tag("topic:active");
      await mintAndApprove(alice, 10n * ONE);
      await registry.connect(alice).registerTag(T, 10n * ONE);
      const original = await registry.tagLastUsedBlock(T);
      await mineBlocks(100n);
      await registry.connect(campaigns).recordUsage(T);
      expect(await registry.tagLastUsedBlock(T)).to.be.gt(original);
    });
  });

  // ---------------------------------------------------------------------
  // Expiry
  // ---------------------------------------------------------------------

  describe("expireTag", function () {
    beforeEach(deployFresh);

    it("reverts T07 if tag is not Bonded", async function () {
      const T = tag("nope");
      await expect(registry.connect(outsider).expireTag(T)).to.be.revertedWith("T07");
    });

    it("reverts T08 while the tag is still fresh", async function () {
      const T = tag("topic:fresh");
      await mintAndApprove(alice, 10n * ONE);
      await registry.connect(alice).registerTag(T, 10n * ONE);
      await mineBlocks(100n); // far short of 432000
      await expect(registry.connect(outsider).expireTag(T)).to.be.revertedWith("T08");
    });

    it("pays 100% bounty to caller after expiry window", async function () {
      const T = tag("topic:idle");
      const amount = 25n * ONE;
      await mintAndApprove(alice, amount);
      await registry.connect(alice).registerTag(T, amount);

      await mineBlocks(432000n + 1n);
      const balBefore = await datum.balanceOf(outsider.address);

      await expect(registry.connect(outsider).expireTag(T))
        .to.emit(registry, "TagExpired").withArgs(T, outsider.address, amount);

      expect(await datum.balanceOf(outsider.address)).to.equal(balBefore + amount);
      expect(await registry.tagState(T)).to.equal(3n); // Expired
      expect(await registry.tagBond(T)).to.equal(0n);
    });

    it("recordUsage extends expiry — fresh use defers garbage collection", async function () {
      const T = tag("topic:refreshed");
      await mintAndApprove(alice, 10n * ONE);
      await registry.connect(alice).registerTag(T, 10n * ONE);

      // Advance most of the window, then refresh.
      await mineBlocks(432000n - 10n);
      await registry.connect(campaigns).recordUsage(T);

      // Mine 100 more — was 100 *past* the original window but only 90 past
      // the refresh; not yet expirable.
      await mineBlocks(100n);
      await expect(registry.connect(outsider).expireTag(T)).to.be.revertedWith("T08");
    });
  });

  // ---------------------------------------------------------------------
  // Juror pool
  // ---------------------------------------------------------------------

  describe("Juror pool", function () {
    beforeEach(deployFresh);

    it("stakeAsJuror below min reverts T12", async function () {
      await datum.mint(j1.address, ONE);
      await datum.connect(j1).approve(await registry.getAddress(), ONE);
      await expect(registry.connect(j1).stakeAsJuror(ONE)).to.be.revertedWith("T12");
    });

    it("stakeAsJuror at min joins pool and emits event", async function () {
      await datum.mint(j1.address, 5n * ONE);
      await datum.connect(j1).approve(await registry.getAddress(), 5n * ONE);

      await expect(registry.connect(j1).stakeAsJuror(5n * ONE))
        .to.emit(registry, "JurorStaked").withArgs(j1.address, 5n * ONE, 5n * ONE);

      expect(await registry.jurorStake(j1.address)).to.equal(5n * ONE);
      expect(await registry.jurorPoolSize()).to.equal(1n);
      expect(await registry.jurorAt(0)).to.equal(j1.address);
    });

    it("additional stake compounds without re-adding to pool", async function () {
      await datum.mint(j1.address, 20n * ONE);
      await datum.connect(j1).approve(await registry.getAddress(), 20n * ONE);
      await registry.connect(j1).stakeAsJuror(10n * ONE);
      await registry.connect(j1).stakeAsJuror(10n * ONE);
      expect(await registry.jurorStake(j1.address)).to.equal(20n * ONE);
      expect(await registry.jurorPoolSize()).to.equal(1n);
    });

    it("unstakeJuror fully removes from pool", async function () {
      await seedJurors([j1, j2]);
      expect(await registry.jurorPoolSize()).to.equal(2n);
      await registry.connect(j1).unstakeJuror(100n * ONE);
      expect(await registry.jurorStake(j1.address)).to.equal(0n);
      expect(await registry.jurorPoolSize()).to.equal(1n);
    });

    it("partial unstake that would drop below min reverts T14", async function () {
      await seedJurors([j1]);
      // 100 WDATUM staked; jurorMinStake=5. Try to leave 1 → must fully exit.
      await expect(registry.connect(j1).unstakeJuror(99n * ONE)).to.be.revertedWith("T14");
    });

    it("unstake beyond free stake reverts T13", async function () {
      await seedJurors([j1]);
      await expect(registry.connect(j1).unstakeJuror(200n * ONE)).to.be.revertedWith("T13");
    });
  });

  // ---------------------------------------------------------------------
  // Challenge + commit/reveal/resolve
  // ---------------------------------------------------------------------

  describe("challenge → commit → reveal → resolve", function () {
    const T = tag("topic:disputed");
    const BOND = 10n * ONE;
    const COMMIT_WINDOW = 14400n;
    const REVEAL_WINDOW = 14400n;

    async function setupDispute(): Promise<bigint> {
      await deployFresh();
      // Set jury size to 5 (default). Seed 5 jurors.
      await seedJurors([j1, j2, j3, j4, j5]);

      // Alice bonds the tag.
      await mintAndApprove(alice, BOND);
      await registry.connect(alice).registerTag(T, BOND);

      // Bob challenges (symmetric bond).
      await mintAndApprove(bob, BOND);
      const rcpt = await (await registry.connect(bob).challengeTag(T)).wait();
      return 1n; // first dispute id
    }

    it("self-challenge reverts T10", async function () {
      await deployFresh();
      await seedJurors([j1, j2, j3, j4, j5]);
      await mintAndApprove(alice, 2n * BOND);
      await registry.connect(alice).registerTag(T, BOND);
      await expect(registry.connect(alice).challengeTag(T)).to.be.revertedWith("T10");
    });

    it("challenge with insufficient juror pool reverts T11", async function () {
      await deployFresh();
      await seedJurors([j1, j2]); // only 2, need 5
      await mintAndApprove(alice, BOND);
      await registry.connect(alice).registerTag(T, BOND);
      await mintAndApprove(bob, BOND);
      await expect(registry.connect(bob).challengeTag(T)).to.be.revertedWith("T11");
    });

    it("opens dispute, transitions tag to Disputed, transfers challenger bond", async function () {
      await setupDispute();
      expect(await registry.tagState(T)).to.equal(2n); // Disputed
      // Both bonds escrowed.
      expect(await datum.balanceOf(await registry.getAddress())).to.be.gte(2n * BOND);

      const jurors = await registry.disputeJurors(1n);
      expect(jurors.length).to.equal(5);
    });

    it("non-juror commit reverts T17", async function () {
      await setupDispute();
      const h = commitHash(1n, outsider.address, 1, ethers.ZeroHash);
      await expect(registry.connect(outsider).commitVote(1n, h)).to.be.revertedWith("T17");
    });

    it("late commit reverts T18", async function () {
      await setupDispute();
      const jurors = await registry.disputeJurors(1n);
      // Map address → signer.
      const map: Record<string, HardhatEthersSigner> = {};
      for (const s of [j1, j2, j3, j4, j5]) map[s.address] = s;
      const firstJuror = map[jurors[0]];
      await mineBlocks(COMMIT_WINDOW + 1n);
      const h = commitHash(1n, firstJuror.address, 1, ethers.ZeroHash);
      await expect(registry.connect(firstJuror).commitVote(1n, h)).to.be.revertedWith("T18");
    });

    it("double commit reverts T19", async function () {
      await setupDispute();
      const jurors = await registry.disputeJurors(1n);
      const map: Record<string, HardhatEthersSigner> = {};
      for (const s of [j1, j2, j3, j4, j5]) map[s.address] = s;
      const s = map[jurors[0]];
      const h = commitHash(1n, s.address, 1, ethers.encodeBytes32String("salt"));
      await registry.connect(s).commitVote(1n, h);
      await expect(registry.connect(s).commitVote(1n, h)).to.be.revertedWith("T19");
    });

    it("reveal with wrong salt/vote reverts T20f", async function () {
      await setupDispute();
      const jurors = await registry.disputeJurors(1n);
      const map: Record<string, HardhatEthersSigner> = {};
      for (const s of [j1, j2, j3, j4, j5]) map[s.address] = s;
      const s = map[jurors[0]];
      const salt = ethers.encodeBytes32String("real-salt");
      await registry.connect(s).commitVote(1n, commitHash(1n, s.address, 1, salt));
      await mineBlocks(COMMIT_WINDOW);
      const wrongSalt = ethers.encodeBytes32String("wrong-salt");
      await expect(registry.connect(s).revealVote(1n, 1, wrongSalt)).to.be.revertedWith("T20f");
    });

    async function fullVoteCycle(votes: number[]) {
      // votes: array indexed by jury position. 1=Keep, 2=Expire.
      const disputeId = await setupDispute();
      const jurors = await registry.disputeJurors(disputeId);
      const map: Record<string, HardhatEthersSigner> = {};
      for (const s of [j1, j2, j3, j4, j5]) map[s.address] = s;
      const salts: string[] = [];
      // Commit phase.
      for (let i = 0; i < jurors.length; i++) {
        const s = map[jurors[i]];
        const salt = ethers.encodeBytes32String(`salt-${i}`);
        salts.push(salt);
        await registry.connect(s).commitVote(disputeId, commitHash(disputeId, s.address, votes[i], salt));
      }
      await mineBlocks(COMMIT_WINDOW);
      // Reveal phase.
      for (let i = 0; i < jurors.length; i++) {
        if (votes[i] === 0) continue; // skip non-reveal
        const s = map[jurors[i]];
        await registry.connect(s).revealVote(disputeId, votes[i], salts[i]);
      }
      await mineBlocks(REVEAL_WINDOW);
      return { disputeId, jurors, map, salts };
    }

    it("KeepTag majority restores tag, pays owner challenger's bond minus jury reward", async function () {
      const { disputeId } = await fullVoteCycle([1, 1, 1, 2, 2]);
      const aliceBefore = await datum.balanceOf(alice.address);

      const tx = await registry.resolveDispute(disputeId);
      await expect(tx).to.emit(registry, "DisputeResolved");

      expect(await registry.tagState(T)).to.equal(1n); // Bonded
      // juryReward = 2 * BOND * 2000 / 10000 = 0.4 * BOND. Owner receives BOND - 0.4*BOND = 0.6*BOND.
      const expectedGain = BOND - (2n * BOND * 2000n) / 10000n;
      expect(await datum.balanceOf(alice.address)).to.equal(aliceBefore + expectedGain);
    });

    it("ExpireTag majority destroys tag and pays challenger 2*BOND - juryReward", async function () {
      const { disputeId } = await fullVoteCycle([2, 2, 2, 1, 1]);
      const bobBefore = await datum.balanceOf(bob.address);

      await registry.resolveDispute(disputeId);

      expect(await registry.tagState(T)).to.equal(3n); // Expired
      expect(await registry.tagOwner(T)).to.equal(ethers.ZeroAddress);
      expect(await registry.tagBond(T)).to.equal(0n);

      const juryReward = (2n * BOND * 2000n) / 10000n;
      const expectedGain = 2n * BOND - juryReward;
      expect(await datum.balanceOf(bob.address)).to.equal(bobBefore + expectedGain);
    });

    it("Tie (no reveals) refunds challenger, owner bond stays escrowed", async function () {
      const { disputeId } = await fullVoteCycle([0, 0, 0, 0, 0]); // nobody reveals
      const bobBefore = await datum.balanceOf(bob.address);
      const escrowBefore = await datum.balanceOf(await registry.getAddress());

      await registry.resolveDispute(disputeId);

      expect(await registry.tagState(T)).to.equal(1n); // Bonded (restored)
      expect(await datum.balanceOf(bob.address)).to.equal(bobBefore + BOND);
      // Registry retains alice's BOND (plus the rest of contract balance e.g. juror stakes).
      const escrowAfter = await datum.balanceOf(await registry.getAddress());
      expect(escrowAfter).to.equal(escrowBefore - BOND);
    });

    it("Majority jurors receive jury reward + slashed pool, minority/non-revealers slashed", async function () {
      const { disputeId, jurors, map } = await fullVoteCycle([1, 1, 1, 2, 0]);
      // 3 keep (majority), 1 expire (minority), 1 non-reveal.
      // jurorSlashBps = 2000; perJuror = 5 * ONE * 2000 / 10000 = 1 WDATUM.

      // Snapshot stakes before resolve.
      const stakeBefore: Record<string, bigint> = {};
      for (const a of jurors) stakeBefore[a] = await registry.jurorStake(a);

      await registry.resolveDispute(disputeId);

      // juryReward = 0.4 * BOND = 4 WDATUM. Plus slashed pool = 2 jurors × 1 WDATUM = 2 WDATUM.
      // Total = 6 WDATUM split across 3 majority jurors = 2 WDATUM each.
      const expectedPerMajority = 2n * ONE;
      const expectedSlash = ONE; // 1 WDATUM per non-majority juror

      for (let i = 0; i < jurors.length; i++) {
        const a = jurors[i];
        const before = stakeBefore[a];
        const after = await registry.jurorStake(a);
        if ([1, 1, 1, 2, 0][i] === 1) {
          // Majority — gained.
          expect(after).to.equal(before + expectedPerMajority);
        } else {
          // Slashed.
          expect(after).to.equal(before - expectedSlash);
        }
      }
    });

    it("cannot resolve twice (T20g)", async function () {
      const { disputeId } = await fullVoteCycle([1, 1, 1, 2, 2]);
      await registry.resolveDispute(disputeId);
      await expect(registry.resolveDispute(disputeId)).to.be.revertedWith("T20g");
    });

    it("cannot resolve before reveal deadline (T20h)", async function () {
      const disputeId = await setupDispute();
      await expect(registry.resolveDispute(disputeId)).to.be.revertedWith("T20h");
    });
  });

  // ---------------------------------------------------------------------
  // Governance setters — floors/ceilings enforced
  // ---------------------------------------------------------------------

  describe("Governance parameter floors and ceilings", function () {
    beforeEach(deployFresh);

    it("setMinTagBond below floor reverts T03", async function () {
      await expect(registry.connect(owner).setMinTagBond(ONE / 2n)).to.be.revertedWith("T03");
    });

    it("setMinTagBond above ceiling reverts T03", async function () {
      await expect(registry.connect(owner).setMinTagBond(1_000_001n * ONE)).to.be.revertedWith("T03");
    });

    it("setMinTagBond within range succeeds and emits event", async function () {
      await expect(registry.connect(owner).setMinTagBond(50n * ONE))
        .to.emit(registry, "MinTagBondSet").withArgs(50n * ONE);
      expect(await registry.minTagBond()).to.equal(50n * ONE);
    });

    it("setJurySize requires odd size in [3,21]", async function () {
      await expect(registry.connect(owner).setJurySize(2)).to.be.revertedWith("T03");
      await expect(registry.connect(owner).setJurySize(4)).to.be.revertedWith("T03"); // even
      await expect(registry.connect(owner).setJurySize(23)).to.be.revertedWith("T03"); // above max
      await expect(registry.connect(owner).setJurySize(7)).to.emit(registry, "JurySizeSet").withArgs(7);
    });

    it("setJuryRewardBps above 30% reverts", async function () {
      await expect(registry.connect(owner).setJuryRewardBps(3001)).to.be.revertedWith("T03");
      await expect(registry.connect(owner).setJuryRewardBps(3000)).to.not.be.reverted;
    });

    it("setJurorSlashBps above 50% reverts", async function () {
      await expect(registry.connect(owner).setJurorSlashBps(5001)).to.be.revertedWith("T03");
      await expect(registry.connect(owner).setJurorSlashBps(5000)).to.not.be.reverted;
    });

    it("setExpiryBlocks below 24h or above 1y reverts", async function () {
      await expect(registry.connect(owner).setExpiryBlocks(14399)).to.be.revertedWith("T03");
      await expect(registry.connect(owner).setExpiryBlocks(5_256_001)).to.be.revertedWith("T03");
      await expect(registry.connect(owner).setExpiryBlocks(14400)).to.not.be.reverted;
    });

    it("non-owner cannot tune", async function () {
      await expect(registry.connect(outsider).setMinTagBond(50n * ONE))
        .to.be.revertedWith("E18");
    });
  });

  // ---------------------------------------------------------------------
  // Lock-once: Campaigns pointer
  // ---------------------------------------------------------------------

  describe("Campaigns pointer lock", function () {
    beforeEach(async function () {
      datum = await (await ethers.getContractFactory("MockERC20")).deploy("Wrapped DATUM", "WDATUM");
      registry = await (await ethers.getContractFactory("DatumTagRegistry"))
        .deploy(await datum.getAddress()) as unknown as DatumTagRegistry;
    });

    it("rejects zero campaigns address", async function () {
      await expect(registry.connect(owner).setCampaignsContract(ethers.ZeroAddress))
        .to.be.revertedWith("E00");
    });

    it("can be re-set before lock", async function () {
      await registry.connect(owner).setCampaignsContract(campaigns.address);
      await expect(registry.connect(owner).setCampaignsContract(alice.address))
        .to.emit(registry, "CampaignsContractSet").withArgs(alice.address);
    });

    it("lockCampaigns requires the pointer to be set first", async function () {
      await expect(registry.connect(owner).lockCampaigns()).to.be.revertedWith("T02");
    });

    it("after lockCampaigns, setter reverts T01 forever", async function () {
      await registry.connect(owner).setCampaignsContract(campaigns.address);
      await expect(registry.connect(owner).lockCampaigns())
        .to.emit(registry, "CampaignsContractLocked");
      await expect(registry.connect(owner).setCampaignsContract(alice.address))
        .to.be.revertedWith("T01");
      await expect(registry.connect(owner).lockCampaigns()).to.be.revertedWith("T01");
    });
  });
});
