import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumSettlementRateLimiter } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Aggregate (protocol-wide) circuit breaker on DatumSettlementRateLimiter.
// `settlement` is wired to a plain signer so we can drive tryConsume directly.
describe("DatumSettlementRateLimiter — aggregate circuit breaker", function () {
  let rl: DatumSettlementRateLimiter;
  let owner: HardhatEthersSigner, settler: HardhatEthersSigner;
  let operator: HardhatEthersSigner, other: HardhatEthersSigner;
  const pubA = "0x000000000000000000000000000000000000A001";
  const pubB = "0x000000000000000000000000000000000000B002";

  beforeEach(async function () {
    [owner, settler, operator, other] = await ethers.getSigners();
    rl = await (await ethers.getContractFactory("DatumSettlementRateLimiter")).deploy();
    await rl.setSettlement(settler.address);
    await rl.setRateLimits(10, 1_000_000n); // window=10 blocks, per-pub cap high
    await rl.setGlobalRateLimit(100n);       // protocol-wide cap = 100 events/window
  });

  it("CB-1: settles under the global cap; latches open on breach", async function () {
    // 60 + 60 = 120 > 100 → second call trips the breaker and rejects.
    expect(await rl.connect(settler).tryConsume.staticCall(pubA, 60n)).to.equal(true);
    await rl.connect(settler).tryConsume(pubA, 60n);

    expect(await rl.connect(settler).tryConsume.staticCall(pubB, 60n)).to.equal(false);
    await expect(rl.connect(settler).tryConsume(pubB, 60n))
      .to.emit(rl, "GlobalBreakerTripped").withArgs(anyWindow(), 120n, 100n);

    expect(await rl.globalBreakerTripped()).to.equal(true);
  });

  it("CB-2: once tripped, ALL view settles reject until reset", async function () {
    await rl.connect(settler).tryConsume(pubA, 60n);
    await rl.connect(settler).tryConsume(pubB, 60n); // trips
    expect(await rl.connect(settler).tryConsume.staticCall(pubA, 1n)).to.equal(false);

    await rl.connect(owner).resetGlobalBreaker();
    expect(await rl.globalBreakerTripped()).to.equal(false);
    // After reset, fresh window accounting continues to allow under-cap settles.
    expect(await rl.connect(settler).tryConsume.staticCall(pubA, 1n)).to.equal(true);
  });

  it("CB-3: breaker operator can reset; owner can set the operator", async function () {
    await rl.connect(settler).tryConsume(pubA, 60n);
    await rl.connect(settler).tryConsume(pubB, 60n); // trips
    await rl.setBreakerOperator(operator.address);
    await expect(rl.connect(operator).resetGlobalBreaker())
      .to.emit(rl, "GlobalBreakerReset").withArgs(operator.address);
    expect(await rl.globalBreakerTripped()).to.equal(false);
  });

  it("CB-4: non-authority cannot reset; cap setter is owner-only", async function () {
    await expect(rl.connect(other).resetGlobalBreaker())
      .to.be.revertedWithCustomError(rl, "NotBreakerAuthority");
    await expect(rl.connect(other).setGlobalRateLimit(5n)).to.be.reverted; // onlyOwner
  });

  it("CB-5: disabled (cap=0) never trips", async function () {
    await rl.setGlobalRateLimit(0n);
    await rl.connect(settler).tryConsume(pubA, 1_000n);
    await rl.connect(settler).tryConsume(pubB, 1_000n);
    expect(await rl.globalBreakerTripped()).to.equal(false);
  });
});

// Helper: GlobalBreakerTripped's first arg is the windowId (block-dependent).
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
function anyWindow() { return anyValue; }
