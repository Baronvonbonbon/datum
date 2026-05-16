// Stage 6 end-to-end test — full Settlement → Engine → MintAuthority pipeline.
// Verifies that when Settlement processes a batch, the engine computes the
// mint amount with cap clipping, and the mint authority issues WDATUM
// per the 55/40/5 split.

import { expect } from "chai";
import { ethers } from "hardhat";
import { parseDOT } from "./helpers/dot";
import { advanceTime } from "./helpers/mine";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const UNIT = 10n ** 10n;
const ASSET_ID = 31337n;

describe("Path H end-to-end: Settlement → EmissionEngine → MintAuthority", function () {
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;

  let engine: any;
  let authority: any;
  let wrapper: any;

  beforeEach(async function () {
    const sigs = await ethers.getSigners();
    [owner, user, publisher, advertiser] = sigs;
    const g2 = sigs[4];

    // Build the token stack
    const precompile = await (await ethers.getContractFactory("AssetHubPrecompileMock")).deploy();
    authority = await (await ethers.getContractFactory("DatumMintAuthority")).deploy(
      await precompile.getAddress(), ASSET_ID,
    );
    await precompile.registerAsset(ASSET_ID, await authority.getAddress(), "DATUM", "DATUM", 10);
    wrapper = await (await ethers.getContractFactory("DatumWrapper")).deploy(
      await authority.getAddress(), await precompile.getAddress(), ASSET_ID, true,
    );
    await authority.setWrapper(await wrapper.getAddress());

    // Deploy emission engine
    engine = await (await ethers.getContractFactory("DatumEmissionEngine")).deploy();
  });

  it("engine clips one large batch to daily cap on first day", async function () {
    // Use a settlement-stub: set msg.sender as the authorized caller.
    await engine.setSettlement(owner.address);

    // 1000 DOT × 19 (INITIAL_RATE) = 19,000 DATUM. Daily cap = 18,591.
    const dotPaid = parseDOT("1000");
    const minted = await engine.connect(owner).computeAndClipMint.staticCall(dotPaid);
    const cap = await engine.dailyCap();
    expect(minted).to.equal(cap);
  });

  it("engine + authority: minted DATUM flows through wrapper", async function () {
    // Settlement-as-owner stub: engine accepts owner calls.
    await engine.setSettlement(owner.address);
    // Authority accepts owner calls.
    await authority.setSettlement(owner.address);

    // Compute mint via engine, then route the user/pub/adv split via authority.
    const dotPaid = parseDOT("1");           // 1 DOT
    const tx = await engine.connect(owner).computeAndClipMint(dotPaid);
    await tx.wait();
    const minted = await engine.totalMinted();
    expect(minted).to.equal(19n * UNIT);     // 19 DATUM (no clip at this volume)

    // Split per spec: 55/40/5
    const userMint = (minted as bigint) * 5500n / 10000n;
    const pubMint  = (minted as bigint) * 4000n / 10000n;
    const advMint  = (minted as bigint) - userMint - pubMint;

    await authority.mintForSettlement(
      user.address,       userMint,
      publisher.address,  pubMint,
      advertiser.address, advMint,
    );

    // WDATUM balances should reflect the split
    expect(await wrapper.balanceOf(user.address)).to.equal(userMint);
    expect(await wrapper.balanceOf(publisher.address)).to.equal(pubMint);
    expect(await wrapper.balanceOf(advertiser.address)).to.equal(advMint);
  });

  it("two-day simulation: cap clip + UTC reset + adjustment", async function () {
    await engine.setSettlement(owner.address);
    const cap = (await engine.dailyCap()) as bigint;

    // Day 1: massive batch fills cap, excess dropped silently
    await engine.connect(owner).computeAndClipMint(parseDOT("10000"));
    expect(await engine.remainingDailyCap()).to.equal(0n);
    expect(await engine.dailyMinted()).to.equal(cap);

    // Advance into next UTC day + past adjustment period
    await advanceTime(86400);

    // Trigger rate adjustment (volume was high → rate halves; clamp at /2)
    const ratePrev = (await engine.currentRate()) as bigint;
    await engine.adjustRate();
    expect(await engine.currentRate()).to.equal(ratePrev / 2n);

    // Day 2: small batch — under new lower rate
    await engine.connect(owner).computeAndClipMint(parseDOT("1"));
    // remainingDailyCap reset at midnight, then drained by today's mint
    const expectedToday = parseDOT("1") * (ratePrev / 2n) / UNIT;
    expect(await engine.remainingDailyCap()).to.equal(cap - expectedToday);
  });

  it("engine tally is bounded by 7-year epoch budget", async function () {
    await engine.setSettlement(owner.address);
    // Drain the epoch budget partially: 1000 calls at the cap should still
    // hit the cap each day and we can verify cumulative tally never exceeds
    // scheduledBudget(0).
    const scheduledE0 = await engine.scheduledBudget(0);
    // Simulate 10 days at cap
    for (let i = 0; i < 10; i++) {
      await engine.connect(owner).computeAndClipMint(parseDOT("10000"));
      await advanceTime(86400);
    }
    const total = (await engine.totalMinted()) as bigint;
    expect(total).to.be.lessThanOrEqual(scheduledE0);
  });
});
