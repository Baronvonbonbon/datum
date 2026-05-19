import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumStakeRoot } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// STAKE-ROOT V1 INVARIANTS
//
// Captured baseline behaviour that DatumStakeRootV2 (Resolution 2 from
// proposal-stakeroot-optimistic.md) MUST preserve. These tests
// complement the broader Path-A test suite in zk-path-a.test.ts; both
// must keep passing through the v2 work.
//
// The contract V2 must equal in semantics:
//   - rootAt[epoch] holds the canonical root once finalized
//   - latestEpoch advances monotonically
//   - first-finalized-wins per epoch
//   - isRecent(root) returns true for the last LOOKBACK_EPOCHS finalized roots
//   - isRecent(bytes32(0)) returns false
//   - threshold cannot exceed reporters.length at any time

describe("DatumStakeRoot — V1 baseline invariants for V2 work", function () {
  let v1: DatumStakeRoot;
  let owner: HardhatEthersSigner;
  let r1: HardhatEthersSigner;
  let r2: HardhatEthersSigner;
  let r3: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    await fundSigners();
    [owner, r1, r2, r3, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DatumStakeRoot");
    v1 = await F.deploy();
    await v1.addReporter(r1.address);
    await v1.addReporter(r2.address);
    await v1.addReporter(r3.address);
    await v1.setThreshold(2);
  });

  // ── Invariant: first-finalized-wins ─────────────────────────────────
  it("INV-1: first-finalized root for an epoch is canonical; later proposals revert", async function () {
    const root1 = ethers.id("root-a");
    const root2 = ethers.id("root-b");
    await v1.connect(r1).commitStakeRoot(1, root1);
    await v1.connect(r2).commitStakeRoot(1, root1); // finalizes
    expect(await v1.rootAt(1)).to.equal(root1);
    // Now a different reporter tries to finalize a DIFFERENT root for the same epoch
    await expect(
      v1.connect(r3).commitStakeRoot(1, root2)
    ).to.be.revertedWith("E22");
  });

  // ── Invariant: isRecent rejects zero ─────────────────────────────────
  it("INV-2: isRecent(bytes32(0)) returns false", async function () {
    expect(await v1.isRecent(ethers.ZeroHash)).to.be.false;
  });

  // ── Invariant: setThreshold rejects 0 ────────────────────────────────
  it("INV-3: setThreshold rejects 0 (would brick finalization)", async function () {
    await expect(v1.setThreshold(0)).to.be.revertedWith("E11");
  });

  // ── Invariant: setThreshold rejects > reporters.length ───────────────
  it("INV-4: setThreshold rejects threshold > reporters.length", async function () {
    await expect(v1.setThreshold(4)).to.be.revertedWith("E11");
  });

  // ── Invariant: removeReporter clamps threshold to keep contract alive ─
  it("INV-5: removeReporter clamps threshold if it would exceed remaining count", async function () {
    // 3 reporters, threshold=2. Remove r3 → 2 reporters, threshold=2 (still OK).
    await v1.removeReporter(r3.address);
    expect(await v1.threshold()).to.equal(2n);
    // Remove r2 → 1 reporter; threshold must clamp from 2 → 1.
    await v1.removeReporter(r2.address);
    expect(await v1.threshold()).to.equal(1n);
  });

  // ── Invariant: ZeroHash root rejected at propose time ────────────────
  it("INV-6: commitStakeRoot rejects bytes32(0) root", async function () {
    await expect(
      v1.connect(r1).commitStakeRoot(1, ethers.ZeroHash)
    ).to.be.revertedWith("E11");
  });

  // ── Invariant: latestEpoch advances monotonically ────────────────────
  it("INV-7: latestEpoch advances monotonically; same-epoch commits don't double-bump", async function () {
    expect(await v1.latestEpoch()).to.equal(0n);
    const root = ethers.id("r");
    await v1.connect(r1).commitStakeRoot(5, root);
    await v1.connect(r2).commitStakeRoot(5, root);
    expect(await v1.latestEpoch()).to.equal(5n);
    // Re-finalizing same epoch is blocked by INV-1 above; latestEpoch stays
    expect(await v1.latestEpoch()).to.equal(5n);
  });

  // ── Invariant: LOOKBACK_EPOCHS boundary ──────────────────────────────
  it("INV-8: roots at epoch latestEpoch - LOOKBACK_EPOCHS + 1 are still recent; older are not", async function () {
    // Commit roots at epochs 1..10
    const roots: string[] = [];
    for (let e = 1; e <= 10; e++) {
      const r = ethers.id(`epoch-${e}`);
      roots.push(r);
      await v1.connect(r1).commitStakeRoot(e, r);
      await v1.connect(r2).commitStakeRoot(e, r);
    }
    expect(await v1.latestEpoch()).to.equal(10n);
    // LOOKBACK_EPOCHS = 8 → epochs 3..10 are recent; epochs 1, 2 are NOT
    expect(await v1.isRecent(roots[2])).to.be.true;  // epoch 3
    expect(await v1.isRecent(roots[1])).to.be.false; // epoch 2
    expect(await v1.isRecent(roots[0])).to.be.false; // epoch 1
    expect(await v1.isRecent(roots[9])).to.be.true;  // epoch 10
  });

  // ── Invariant: backwards epoch rejected ──────────────────────────────
  it("INV-9: commitStakeRoot rejects epoch < latestEpoch", async function () {
    const r5 = ethers.id("r5");
    await v1.connect(r1).commitStakeRoot(5, r5);
    await v1.connect(r2).commitStakeRoot(5, r5);
    // Attempt to commit at epoch 4
    await expect(
      v1.connect(r1).commitStakeRoot(4, ethers.id("r4"))
    ).to.be.revertedWith("E64");
  });

  // ── Deprecation flag (Stage 6 of v2 migration) ───────────────────────
  it("DEPR-1: setDeprecated owner-only (E18)", async function () {
    await expect(v1.connect(r1).setDeprecated(true)).to.be.revertedWith("E18");
  });

  it("DEPR-2: deprecated commits still work but emit DeprecatedCommitAttempt", async function () {
    await v1.setDeprecated(true);
    const root = ethers.id("post-depr");
    // First commit emits warning + initial proposal
    await expect(v1.connect(r1).commitStakeRoot(1, root))
      .to.emit(v1, "DeprecatedCommitAttempt").withArgs(r1.address, 1);
    // Second commit finalizes (still emits warning)
    await expect(v1.connect(r2).commitStakeRoot(1, root))
      .to.emit(v1, "DeprecatedCommitAttempt").withArgs(r2.address, 1);
    // Root IS finalized — deprecation doesn't break the contract
    expect(await v1.rootAt(1)).to.equal(root);
  });

  it("DEPR-3: setDeprecated emits DeprecationFlagSet", async function () {
    await expect(v1.setDeprecated(true))
      .to.emit(v1, "DeprecationFlagSet").withArgs(true);
    await expect(v1.setDeprecated(false))
      .to.emit(v1, "DeprecationFlagSet").withArgs(false);
  });
});
