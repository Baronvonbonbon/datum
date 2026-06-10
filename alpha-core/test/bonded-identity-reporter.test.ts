// DatumBondedIdentityReporter unit tests.
//
// Covers v1 design from narrative-analysis/bonded-reporter-identity.md:
//   - Reporter set lifecycle: join, exit-propose, finalize-exit
//   - Attestation flow: submit → approve → finalize (fast + slow paths)
//   - Challenge flow: challenge → owner slash / dismiss
//   - Cache write-through on finalize
//   - Parameter bounds + non-owner rejection
//   - Edge cases: double-submit nonces, post-exit slashing

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumBondedIdentityReporter,
  DatumPeopleChainIdentity,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const MIN_STAKE      = 1_000_000_000n;   // 0.1 PAS
const EXIT_DELAY     = 100n;             // blocks
const APPROVAL_BPS   = 5100n;            // 51%
const CHALLENGE_WIN  = 50n;              // blocks
const PROPOSER_BOND  = 100_000_000n;     // 0.01 PAS
const CHALLENGER_BOND= 100_000_000n;
const SLASH_CHAL_BPS = 5000n;            // 50% of slash to challenger
const SLASH_APP_BPS  = 2500n;            // 25% per approver stake slashed

const VALIDITY = 1000n;                  // > MIN_VALIDITY_BLOCKS (600)

async function mineBlocks(n: bigint) {
  await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

describe("DatumBondedIdentityReporter", function () {
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let reporter1: HardhatEthersSigner;
  let reporter2: HardhatEthersSigner;
  let reporter3: HardhatEthersSigner;
  let challenger: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  let reporter: DatumBondedIdentityReporter;
  let cache: DatumPeopleChainIdentity;

  beforeEach(async () => {
    [owner, treasury, reporter1, reporter2, reporter3, challenger, user, other]
      = await ethers.getSigners();

    const CacheF = await ethers.getContractFactory("DatumPeopleChainIdentity");
    cache = await CacheF.deploy();

    const RepF = await ethers.getContractFactory("DatumBondedIdentityReporter");
    reporter = await RepF.deploy(
      treasury.address,
      MIN_STAKE,
      EXIT_DELAY,
      APPROVAL_BPS,
      CHALLENGE_WIN,
      PROPOSER_BOND,
      CHALLENGER_BOND,
      SLASH_CHAL_BPS,
      SLASH_APP_BPS,
    );

    await reporter.connect(owner).setCache(await cache.getAddress());
    // Wire bonded reporter as the cache's xcmDispatcher so submitAttestation
    // accepts writes from it.
    await cache.connect(owner).setXcmDispatcher(await reporter.getAddress());
  });

  // ─────────────────────────────────────────────────────────────────────
  // Reporter lifecycle
  // ─────────────────────────────────────────────────────────────────────
  describe("reporter lifecycle", () => {
    it("joinReporters with sufficient bond adds reporter", async () => {
      await expect(reporter.connect(reporter1).joinReporters({ value: MIN_STAKE }))
        .to.emit(reporter, "ReporterJoined").withArgs(reporter1.address, MIN_STAKE);
      expect(await reporter.isActiveReporter(reporter1.address)).to.equal(true);
      expect(await reporter.reporterCount()).to.equal(1n);
      expect(await reporter.totalReporterStake()).to.equal(MIN_STAKE);
    });

    it("joinReporters with insufficient stake reverts E11", async () => {
      await expect(reporter.connect(reporter1).joinReporters({ value: MIN_STAKE - 1n }))
        .to.be.revertedWith("E11");
    });

    it("double join reverts E22", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await expect(reporter.connect(reporter1).joinReporters({ value: MIN_STAKE }))
        .to.be.revertedWith("E22");
    });

    it("proposeReporterExit decrements totalReporterStake immediately", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter2).joinReporters({ value: MIN_STAKE });
      expect(await reporter.totalReporterStake()).to.equal(MIN_STAKE * 2n);
      await reporter.connect(reporter1).proposeReporterExit();
      expect(await reporter.totalReporterStake()).to.equal(MIN_STAKE);
      expect(await reporter.isActiveReporter(reporter1.address)).to.equal(false);
    });

    it("finalizeReporterExit refunds stake after delay", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter1).proposeReporterExit();
      await expect(reporter.connect(reporter1).finalizeReporterExit())
        .to.be.revertedWith("E96");
      await mineBlocks(EXIT_DELAY);
      await reporter.connect(reporter1).finalizeReporterExit();
      expect(await reporter.pending(reporter1.address)).to.equal(MIN_STAKE);
    });

    it("claim pulls pending balance", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter1).proposeReporterExit();
      await mineBlocks(EXIT_DELAY);
      await reporter.connect(reporter1).finalizeReporterExit();
      const balBefore = await ethers.provider.getBalance(other.address);
      await reporter.connect(reporter1).claimTo(other.address);
      const balAfter = await ethers.provider.getBalance(other.address);
      expect(balAfter - balBefore).to.equal(MIN_STAKE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Attestation flow — slow path (challenge window)
  // ─────────────────────────────────────────────────────────────────────
  describe("attestation slow path (challenge window)", () => {
    beforeEach(async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
    });

    it("submit + window expiry → finalize writes to cache", async () => {
      const tx = await reporter.connect(reporter1).submitAttestation(
        user.address, 1, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      // Extract key from event
      const log = receipt!.logs.find(l => {
        try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
        catch { return false; }
      });
      const key = reporter.interface.parseLog(log!)!.args[0];

      // Cannot finalize before window
      await expect(reporter.finalizeAttestation(key)).to.be.revertedWith("E96");

      await mineBlocks(CHALLENGE_WIN);

      expect(await cache.isVerified(user.address, 1)).to.equal(false);

      await expect(reporter.finalizeAttestation(key))
        .to.emit(reporter, "AttestationFinalized").withArgs(key)
        .and.to.emit(cache, "IdentityAttested");

      expect(await cache.isVerified(user.address, 1)).to.equal(true);
      // Proposer bond refunded into pending
      expect(await reporter.pending(reporter1.address)).to.equal(PROPOSER_BOND);
    });

    it("submit by non-reporter reverts E01", async () => {
      await expect(
        reporter.connect(other).submitAttestation(user.address, 1, VALIDITY,
          { value: PROPOSER_BOND }),
      ).to.be.revertedWith("E01");
    });

    it("submit with insufficient bond reverts E11", async () => {
      await expect(
        reporter.connect(reporter1).submitAttestation(user.address, 1, VALIDITY,
          { value: PROPOSER_BOND - 1n }),
      ).to.be.revertedWith("E11");
    });

    it("submit with level > 2 reverts E11", async () => {
      await expect(
        reporter.connect(reporter1).submitAttestation(user.address, 3, VALIDITY,
          { value: PROPOSER_BOND }),
      ).to.be.revertedWith("E11");
    });

    it("submit with validity out of bounds reverts E11", async () => {
      await expect(
        reporter.connect(reporter1).submitAttestation(user.address, 1, 100,
          { value: PROPOSER_BOND }),
      ).to.be.revertedWith("E11");
      await expect(
        reporter.connect(reporter1).submitAttestation(user.address, 1, 99_999_999,
          { value: PROPOSER_BOND }),
      ).to.be.revertedWith("E11");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Attestation flow — fast path (approval threshold)
  // ─────────────────────────────────────────────────────────────────────
  describe("attestation fast path (approval-threshold)", () => {
    async function submitAndGetKey(by: HardhatEthersSigner, lvl: number) {
      const tx = await reporter.connect(by).submitAttestation(
        user.address, lvl, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const log = receipt!.logs.find(l => {
        try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
        catch { return false; }
      });
      return reporter.interface.parseLog(log!)!.args[0];
    }

    it("approve from another reporter accumulates approvedStake", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter2).joinReporters({ value: MIN_STAKE });
      const key = await submitAndGetKey(reporter1, 1);
      await expect(reporter.connect(reporter2).approveAttestation(key))
        .to.emit(reporter, "AttestationApproved").withArgs(key, reporter2.address, MIN_STAKE);
    });

    it("proposer cannot self-approve", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      const key = await submitAndGetKey(reporter1, 1);
      await expect(reporter.connect(reporter1).approveAttestation(key))
        .to.be.revertedWith("E18");
    });

    it("double-approve from same reporter reverts E22", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter2).joinReporters({ value: MIN_STAKE });
      const key = await submitAndGetKey(reporter1, 1);
      await reporter.connect(reporter2).approveAttestation(key);
      await expect(reporter.connect(reporter2).approveAttestation(key))
        .to.be.revertedWith("E22");
    });

    it("threshold met → finalize works before window expires", async () => {
      // 3 reporters with equal stake. APPROVAL_BPS=5100. Total=3*MIN_STAKE.
      // One approver = MIN_STAKE = ~33% < 51%. Two approvers = 66% > 51%.
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter2).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter3).joinReporters({ value: MIN_STAKE });

      const key = await submitAndGetKey(reporter1, 2);

      // Single approver below threshold → still requires window
      await reporter.connect(reporter2).approveAttestation(key);
      await expect(reporter.finalizeAttestation(key)).to.be.revertedWith("E96");

      // Second approver pushes past threshold → finalize works
      await reporter.connect(reporter3).approveAttestation(key);
      await reporter.finalizeAttestation(key);

      expect(await cache.isVerified(user.address, 2)).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Challenge flow
  // ─────────────────────────────────────────────────────────────────────
  describe("challenge flow (governance-arbitrated)", () => {
    async function submitAndChallenge(level: number) {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      const tx = await reporter.connect(reporter1).submitAttestation(
        user.address, level, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const log = receipt!.logs.find(l => {
        try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
        catch { return false; }
      });
      const key = reporter.interface.parseLog(log!)!.args[0];
      await reporter.connect(challenger).challengeAttestation(key, { value: CHALLENGER_BOND });
      return key;
    }

    it("challenge moves status to Challenged and blocks finalize", async () => {
      const key = await submitAndChallenge(2);
      const a = await reporter.attestations(key);
      expect(a.status).to.equal(2n); // AttestStatus.Challenged
      expect(a.challenger).to.equal(challenger.address);
      // Finalize must fail (status != Pending)
      await mineBlocks(CHALLENGE_WIN);
      await expect(reporter.finalizeAttestation(key)).to.be.revertedWith("E22");
    });

    it("challenge by proposer reverts E18", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      const tx = await reporter.connect(reporter1).submitAttestation(
        user.address, 1, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const key = reporter.interface.parseLog(
        receipt!.logs.find(l => {
          try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
          catch { return false; }
        })!,
      )!.args[0];
      await expect(reporter.connect(reporter1).challengeAttestation(key, { value: CHALLENGER_BOND }))
        .to.be.revertedWith("E18");
    });

    it("challenge after window reverts E96", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      const tx = await reporter.connect(reporter1).submitAttestation(
        user.address, 1, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const key = reporter.interface.parseLog(
        receipt!.logs.find(l => {
          try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
          catch { return false; }
        })!,
      )!.args[0];
      await mineBlocks(CHALLENGE_WIN);
      await expect(reporter.connect(challenger).challengeAttestation(key, { value: CHALLENGER_BOND }))
        .to.be.revertedWith("E96");
    });

    it("owner slash routes bonds to challenger + treasury", async () => {
      const key = await submitAndChallenge(2);

      // Proposer stake before slash
      const propStakeBefore = (await reporter.reporterStake(reporter1.address)).amount;
      const treasuryPendingBefore = await reporter.pending(treasury.address);
      const challengerPendingBefore = await reporter.pending(challenger.address);

      await expect(reporter.connect(owner).slashAttestation(key))
        .to.emit(reporter, "AttestationSlashed");

      const propStakeAfter = (await reporter.reporterStake(reporter1.address)).amount;
      const expectedPropSlash = (propStakeBefore * SLASH_APP_BPS) / 10000n;
      expect(propStakeBefore - propStakeAfter).to.equal(expectedPropSlash);

      // Total slashed = proposerBond + propStakeSlash (no approvers in this test)
      const totalSlash = PROPOSER_BOND + expectedPropSlash;
      const toChallenger = (totalSlash * SLASH_CHAL_BPS) / 10000n;
      const toTreasury   = totalSlash - toChallenger;

      // Challenger gets bond back + share
      expect(await reporter.pending(challenger.address) - challengerPendingBefore)
        .to.equal(CHALLENGER_BOND + toChallenger);
      expect(await reporter.pending(treasury.address) - treasuryPendingBefore)
        .to.equal(toTreasury);

      const a = await reporter.attestations(key);
      expect(a.status).to.equal(4n); // AttestStatus.Slashed
    });

    it("owner dismiss returns attestation to Pending and forfeits challenger bond", async () => {
      const key = await submitAndChallenge(2);
      const treasuryPendingBefore = await reporter.pending(treasury.address);

      await expect(reporter.connect(owner).dismissChallenge(key))
        .to.emit(reporter, "ChallengeDismissed").withArgs(key);

      const a = await reporter.attestations(key);
      expect(a.status).to.equal(1n); // AttestStatus.Pending
      expect(a.challenger).to.equal(ethers.ZeroAddress);
      expect(await reporter.pending(treasury.address) - treasuryPendingBefore)
        .to.equal(CHALLENGER_BOND);

      // After dismiss + window passing, attestation finalizes normally
      await mineBlocks(CHALLENGE_WIN);
      await reporter.finalizeAttestation(key);
      expect(await cache.isVerified(user.address, 2)).to.equal(true);
    });

    it("non-owner cannot slash or dismiss", async () => {
      const key = await submitAndChallenge(2);
      await expect(reporter.connect(other).slashAttestation(key)).to.be.revertedWith("E18");
      await expect(reporter.connect(other).dismissChallenge(key)).to.be.revertedWith("E18");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Approver slashing on slash
  // ─────────────────────────────────────────────────────────────────────
  describe("approver slashing", () => {
    it("approvers lose stake proportional to slashApproverBps", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter2).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter3).joinReporters({ value: MIN_STAKE });

      const tx = await reporter.connect(reporter1).submitAttestation(
        user.address, 2, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const key = reporter.interface.parseLog(
        receipt!.logs.find(l => {
          try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
          catch { return false; }
        })!,
      )!.args[0];

      await reporter.connect(reporter2).approveAttestation(key);
      await reporter.connect(reporter3).approveAttestation(key);
      await reporter.connect(challenger).challengeAttestation(key, { value: CHALLENGER_BOND });

      const r2StakeBefore = (await reporter.reporterStake(reporter2.address)).amount;
      const r3StakeBefore = (await reporter.reporterStake(reporter3.address)).amount;

      await reporter.connect(owner).slashAttestation(key);

      const r2StakeAfter = (await reporter.reporterStake(reporter2.address)).amount;
      const r3StakeAfter = (await reporter.reporterStake(reporter3.address)).amount;
      const expectedSlashEach = (r2StakeBefore * SLASH_APP_BPS) / 10000n;

      expect(r2StakeBefore - r2StakeAfter).to.equal(expectedSlashEach);
      expect(r3StakeBefore - r3StakeAfter).to.equal(expectedSlashEach);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Owner-only setters + bounds
  // ─────────────────────────────────────────────────────────────────────
  describe("owner setters", () => {
    it("setCache is lock-once", async () => {
      // Already wired in beforeEach. Try to swap.
      await expect(reporter.connect(owner).setCache(other.address)).to.not.be.reverted;
      // F-004 fix: lockCache is phase-gated; wire a Phase-2 router.
      const { wireOpenGovRouter } = await import("./helpers/openGovRouter");
      await wireOpenGovRouter(reporter);
      await reporter.connect(owner).lockCache();
      await expect(reporter.connect(owner).setCache(other.address))
        .to.be.revertedWith("cache-locked");
    });

    it("setReporterMinStake bounded > 0", async () => {
      await expect(reporter.connect(owner).setReporterMinStake(0)).to.be.revertedWith("E11");
      await reporter.connect(owner).setReporterMinStake(MIN_STAKE * 2n);
      expect(await reporter.reporterMinStake()).to.equal(MIN_STAKE * 2n);
    });

    it("non-owner setters revert E18", async () => {
      await expect(reporter.connect(other).setTreasury(other.address)).to.be.revertedWith("E18");
      await expect(reporter.connect(other).setReporterMinStake(MIN_STAKE)).to.be.revertedWith("E18");
      await expect(reporter.connect(other).setCache(other.address)).to.be.revertedWith("E18");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("multiple attestations from same proposer for same user use distinct nonces", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      await reporter.connect(reporter1).submitAttestation(
        user.address, 1, VALIDITY, { value: PROPOSER_BOND },
      );
      // Second submission with same args succeeds (different nonce)
      await reporter.connect(reporter1).submitAttestation(
        user.address, 2, VALIDITY, { value: PROPOSER_BOND },
      );
      // Both keys derivable
      const k1 = await reporter.attestationKey(reporter1.address, user.address, 0);
      const k2 = await reporter.attestationKey(reporter1.address, user.address, 1);
      expect(k1).to.not.equal(k2);
      expect((await reporter.attestations(k1)).level).to.equal(1);
      expect((await reporter.attestations(k2)).level).to.equal(2);
    });

    it("exit-proposed reporter can still be slashed but not double-decremented", async () => {
      await reporter.connect(reporter1).joinReporters({ value: MIN_STAKE });
      const tx = await reporter.connect(reporter1).submitAttestation(
        user.address, 2, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const key = reporter.interface.parseLog(
        receipt!.logs.find(l => {
          try { return reporter.interface.parseLog(l)?.name === "AttestationSubmitted"; }
          catch { return false; }
        })!,
      )!.args[0];
      await reporter.connect(challenger).challengeAttestation(key, { value: CHALLENGER_BOND });
      // Reporter exit-proposes BEFORE slash resolves
      await reporter.connect(reporter1).proposeReporterExit();
      const totalBefore = await reporter.totalReporterStake();  // already 0 since only reporter
      await reporter.connect(owner).slashAttestation(key);
      const totalAfter = await reporter.totalReporterStake();
      // No double-decrement (R1 was already exit-proposed; totalReporterStake stays 0)
      expect(totalAfter).to.equal(totalBefore);
    });

    it("finalize fails when cache is unset", async () => {
      // Fresh reporter without cache wired
      const RepF = await ethers.getContractFactory("DatumBondedIdentityReporter");
      const fresh = await RepF.deploy(
        treasury.address, MIN_STAKE, EXIT_DELAY, APPROVAL_BPS, CHALLENGE_WIN,
        PROPOSER_BOND, CHALLENGER_BOND, SLASH_CHAL_BPS, SLASH_APP_BPS,
      );
      await fresh.connect(reporter1).joinReporters({ value: MIN_STAKE });
      const tx = await fresh.connect(reporter1).submitAttestation(
        user.address, 1, VALIDITY, { value: PROPOSER_BOND },
      );
      const receipt = await tx.wait();
      const key = fresh.interface.parseLog(
        receipt!.logs.find(l => {
          try { return fresh.interface.parseLog(l)?.name === "AttestationSubmitted"; }
          catch { return false; }
        })!,
      )!.args[0];
      await mineBlocks(CHALLENGE_WIN);
      await expect(fresh.finalizeAttestation(key)).to.be.revertedWith("cache-unset");
    });
  });
});
