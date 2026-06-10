// U3 — gas-paginated migration for unbounded state (RUNBOOK Phase 2,
// PRE-MAINNET-CHECKLIST §U3). DatumPublishers' registry is unbounded (100k+
// publishers at mainnet scale) — the old single-call bulk _migrate() would not
// fit one block. The paginated migrate() override copies MIGRATION_BATCH_SIZE
// publishers per call, advancing migrationCursor, and only sets `migrated = true`
// on the final batch. This test proves: batches advance the cursor, the partial
// window is observable (migrated stays false + cursor trails + only the copied
// prefix is present), the final batch completes + matches a single-shot copy,
// and re-running after completion reverts.
import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";

describe("U3 — gas-paginated migration (DatumPublishers, unbounded registry)", function () {
  let owner: HardhatEthersSigner, governor: HardhatEthersSigner, guardian: HardhatEthersSigner;
  let router: any, pause: any, v1: any, v2: any;
  let pubs: any[];        // the registered publisher wallets, in registration order
  let BATCH: bigint;
  const N = 110;          // > 2 × batch → exercises a full, a full, and a partial batch

  before(async function () {
    [owner, governor, guardian] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(governor.address);
    const r = await router.getAddress();
    pause = await (await ethers.getContractFactory("DatumPauseRegistry"))
      .deploy(owner.address, governor.address, guardian.address);

    v1 = await (await ethers.getContractFactory("DatumPublishers")).deploy(100, await pause.getAddress());
    await v1.setRouter(r);
    BATCH = await v1.MIGRATION_BATCH_SIZE();

    // Register N publishers, each from its own funded wallet, with a varied take
    // rate so field preservation is spot-checkable.
    pubs = [];
    for (let i = 0; i < N; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await owner.sendTransaction({ to: w.address, value: parseDOT("0.1") });
      await v1.connect(w).registerPublisher(3000 + (i % 5) * 1000); // 3000..7000 (valid)
      pubs.push(w);
    }
    await v1.connect(governor).freeze();

    v2 = await (await ethers.getContractFactory("MockPublishersV2")).deploy(100, await pause.getAddress());
    await v2.setRouter(r);
  });

  it("registered N publishers (> 2 batches) on a frozen v1", async function () {
    expect(BATCH).to.equal(50n);
    expect(await v1.registeredCount()).to.equal(BigInt(N));
    expect(await v1.frozen()).to.equal(true);
  });

  it("copies in batches, advancing the cursor; only the copied prefix is present mid-flight", async function () {
    const v1Addr = await v1.getAddress();

    // ── Batch 1 ────────────────────────────────────────────────────────────
    await v2.connect(governor).migrate(v1Addr);
    expect(await v2.migrationCursor()).to.equal(BATCH);          // 50
    expect(await v2.migrated()).to.equal(false);                 // PARTIAL WINDOW — consumers gate on this
    expect(await v2.registeredCount()).to.equal(BATCH);          // only first 50 copied
    expect((await v2.getPublisher(pubs[0].address)).registered).to.equal(true);
    expect((await v2.getPublisher(pubs[60].address)).registered).to.equal(false); // not yet

    // ── Batch 2 ────────────────────────────────────────────────────────────
    await v2.connect(governor).migrate(v1Addr);
    expect(await v2.migrationCursor()).to.equal(BATCH * 2n);     // 100
    expect(await v2.migrated()).to.equal(false);
    expect(await v2.registeredCount()).to.equal(BATCH * 2n);
    expect((await v2.getPublisher(pubs[60].address)).registered).to.equal(true); // now present

    // ── Batch 3 (partial: 10 remaining) → completes ──────────────────────────
    await v2.connect(governor).migrate(v1Addr);
    expect(await v2.migrationCursor()).to.equal(BigInt(N));      // 110
    expect(await v2.migrated()).to.equal(true);                  // window closed
    expect(await v2.registeredCount()).to.equal(BigInt(N));

    // ── Full fidelity: every publisher present, take rates preserved ─────────
    for (let i = 0; i < N; i++) {
      const p = await v2.getPublisher(pubs[i].address);
      expect(p.registered, `pub ${i}`).to.equal(true);
      expect(p.takeRateBps, `pub ${i} rate`).to.equal(3000 + (i % 5) * 1000);
    }
    // scalar config carried too
    expect(await v2.takeRateUpdateDelayBlocks()).to.equal(await v1.takeRateUpdateDelayBlocks());

    // ── Done is done: a further batch reverts (no double-migrate) ────────────
    await expect(v2.connect(governor).migrate(v1Addr)).to.be.revertedWith("already migrated");
  });

  it("rejects a mismatched predecessor mid-migration and non-governor callers", async function () {
    const fresh = await (await ethers.getContractFactory("MockPublishersV2")).deploy(100, await pause.getAddress());
    await fresh.setRouter(await router.getAddress());

    // non-governor cannot drive a batch
    await expect(fresh.connect(owner).migrate(await v1.getAddress())).to.be.revertedWith("E19");

    // batch 1 anchors the predecessor; a different source on batch 2 is rejected
    await fresh.connect(governor).migrate(await v1.getAddress());
    expect(await fresh.migrated()).to.equal(false);
    const other = await (await ethers.getContractFactory("DatumPublishers")).deploy(100, await pause.getAddress());
    await other.setRouter(await router.getAddress());
    await other.connect(governor).freeze();
    await expect(fresh.connect(governor).migrate(await other.getAddress())).to.be.revertedWith("source-mismatch");
  });
});
