import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// Regression test for F-026 (DatumWrapper.requestWrap DoS).
//
// Before the fix: `requestWrap(amount)` added to a global
// `totalCommittedCanonical` at no cost; anyone could inflate that field
// to brick the wrap path for everyone because the wrap invariant required
// `canonical >= totalSupply() + totalCommittedCanonical`.
//
// After the fix: `wrap(amount)` atomically pulls canonical from the
// caller via `precompile.transferFrom`. There is no commitment to inflate.
// `requestWrap` / `cancelWrapRequest` are kept as ABI-compatible no-ops.

describe("Audit F-026: Wrapper atomic wrap eliminates open-commitment DoS", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let precompile: any;
  let wrapper: any;
  const ASSET_ID = 31337n;

  beforeEach(async function () {
    await fundSigners();
    [owner, alice, attacker] = await ethers.getSigners();

    const Precompile = await ethers.getContractFactory("AssetHubPrecompileMock");
    precompile = await Precompile.deploy();
    await precompile.registerAsset(ASSET_ID, owner.address, "DATUM", "DAT", 10);

    const Wrapper = await ethers.getContractFactory("DatumWrapper");
    wrapper = await Wrapper.deploy(
      owner.address,            // mintAuthority — not used in these tests, only mintTo is gated by it
      await precompile.getAddress(),
      ASSET_ID,
      true                      // devnetUnwrapShimEnabled
    );

    // Seed alice with canonical DATUM (issuer-mint to alice).
    await precompile.mint(ASSET_ID, alice.address, 1_000_000n * 10n ** 10n);
  });

  it("attacker cannot DoS the wrap path by inflating totalCommittedCanonical", async function () {
    // Pre-fix repro: attacker calls requestWrap(huge) → bricks wrap for
    // all users. Post-fix: requestWrap is a no-op; totalCommittedCanonical
    // stays at zero regardless of caller behavior.
    const huge = 10n ** 50n;
    await wrapper.connect(attacker).requestWrap(huge);
    expect(await wrapper.totalCommittedCanonical()).to.equal(0n);

    // Alice can still wrap. She approves, then wraps; canonical is pulled
    // atomically from her account into the wrapper.
    const amount = 100n * 10n ** 10n;
    await precompile.connect(alice).approve(ASSET_ID, await wrapper.getAddress(), amount);
    await expect(wrapper.connect(alice).wrap(amount)).to.emit(wrapper, "Wrapped");

    expect(await wrapper.balanceOf(alice.address)).to.equal(amount);
    expect(await precompile.balanceOf(ASSET_ID, await wrapper.getAddress())).to.equal(amount);
  });

  it("wrap pulls canonical via transferFrom and mints WDATUM 1:1", async function () {
    const amount = 500n * 10n ** 10n;
    await precompile.connect(alice).approve(ASSET_ID, await wrapper.getAddress(), amount);

    const aliceBefore = await precompile.balanceOf(ASSET_ID, alice.address);
    await wrapper.connect(alice).wrap(amount);
    const aliceAfter = await precompile.balanceOf(ASSET_ID, alice.address);

    expect(aliceBefore - aliceAfter).to.equal(amount);
    expect(await wrapper.balanceOf(alice.address)).to.equal(amount);
    expect(await wrapper.totalSupply()).to.equal(amount);
  });

  it("wrap reverts when caller hasn't approved (no allowance)", async function () {
    const amount = 100n * 10n ** 10n;
    // No approve() — transferFrom on the mock requires allowance >= amount.
    await expect(wrapper.connect(alice).wrap(amount)).to.be.reverted;
  });

  it("wrap reverts when caller has insufficient canonical balance", async function () {
    const huge = 10n ** 30n;
    await precompile.connect(alice).approve(ASSET_ID, await wrapper.getAddress(), huge);
    await expect(wrapper.connect(alice).wrap(huge)).to.be.reverted;
  });

  it("requestWrap is a no-op (deprecated)", async function () {
    const amount = 100n * 10n ** 10n;
    // Emits the legacy event for off-chain compatibility but mutates no state.
    await expect(wrapper.connect(alice).requestWrap(amount))
      .to.emit(wrapper, "WrapRequested")
      .withArgs(alice.address, amount, 0n);
    expect(await wrapper.pendingWrap(alice.address)).to.equal(0n);
    expect(await wrapper.totalCommittedCanonical()).to.equal(0n);
  });

  it("cancelWrapRequest is a no-op (deprecated)", async function () {
    await expect(wrapper.connect(alice).cancelWrapRequest(100n))
      .to.emit(wrapper, "WrapRequestCancelled");
    expect(await wrapper.totalCommittedCanonical()).to.equal(0n);
  });

  it("the peg invariant holds after each wrap", async function () {
    const a1 = 200n * 10n ** 10n;
    const a2 = 300n * 10n ** 10n;
    await precompile.connect(alice).approve(ASSET_ID, await wrapper.getAddress(), a1 + a2);

    await wrapper.connect(alice).wrap(a1);
    await wrapper.connect(alice).wrap(a2);

    const ts = await wrapper.totalSupply();
    const bal = await precompile.balanceOf(ASSET_ID, await wrapper.getAddress());
    expect(ts).to.equal(a1 + a2);
    expect(bal).to.be.gte(ts);
  });
});
