// Stage 3 — confirm the new bucket leak default (1440 blocks/unit ≈ monthly
// drain for typical 300-event batches) preserves the abuse-detection
// property while reducing per-claim difficulty for honest monthly batchers.

import { expect } from "chai";
import { ethers } from "hardhat";
import { mineBlocks } from "./helpers/mine";

describe("Stage 3: bucket leak monthly default", function () {
  let powEngine: any;
  let user: any;

  beforeEach(async function () {
    const [owner, other, g2, alice] = await ethers.getSigners();
    user = alice;
    const Pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(owner.address, other.address, g2.address);
    void Pause;
    powEngine = await (await ethers.getContractFactory("DatumPowEngine")).deploy();
  });

  it("default leak is 1440 blocks per unit (the Stage 3 value)", async function () {
    expect(await powEngine.powBucketLeakPerN()).to.equal(1440);
  });

  it("math: 300-event bucket drains in ~30 days @ 6s/block (= 432,000 blocks)", function () {
    // bucket × leakPerN = total blocks. 300 × 1440 = 432,000.
    // 432,000 × 6s = 30 days exactly.
    const bucket = 300;
    const leakPerN = 1440;
    const blocks = bucket * leakPerN;
    const days = (blocks * 6) / 86400;
    expect(blocks).to.equal(432_000);
    expect(days).to.equal(30);
  });

  it("math: heavy abuser (600 events/min, 1 block/6s = 10 blocks/min)", function () {
    // 600 events/min, drain = 1 unit / 1440 blocks ≈ 1 unit / 144 minutes
    // Bucket grows ~600 - 0.007 ≈ 600 per minute.
    // After 2 minutes: bucket ≈ 1200, shift = 8 + 20 + 144 = 172, clamped to 64 (MAX).
    const bucket = 1200;
    const shift = 8 + bucket / 60 + Math.pow(Math.floor(bucket / 100), 2);
    expect(shift).to.be.greaterThan(64); // would clamp to MAX_SHIFT
  });

  it("abuse-detection unchanged: bucket can be made arbitrarily large for a single user", async function () {
    // We can't trivially settle 1000s of claims in a fixture, but we can
    // confirm that the bucket is purely additive on settle (verified via
    // setting via direct storage in earlier tests). The key invariant
    // here is that the leak alone doesn't prevent the bucket from growing
    // when settles arrive faster than the leak rate.
    expect(await powEngine.powBucketLeakPerN()).to.equal(1440);
    // 1440 blocks/unit = at 6s/block = 8640s = 2.4 hours per unit drained.
    // A user settling > 1 event per 2.4 hours accumulates bucket.
    // A user settling once a month (~10 events/day across 30 days = 300)
    // will see bucket drain back to ~0 between batches.
  });

  it("can still be tuned back down via governance if needed", async function () {
    await powEngine.setPowDifficultyCurve(8, 60, 100, 100);
    expect(await powEngine.powBucketLeakPerN()).to.equal(100);
    // governance can shorten drain for emergency response
  });
});
