import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners, mineBlocks } from "./helpers/mine";

// Regression test for F-031 (ParameterRetuneGuard adoption on the 5
// highest-impact economic-parameter setters).
//
// Before the fix: setSlashBps, setQuorumWeighted, setMintRate were
// plain owner-only setters with no rate limit. A captured owner (or a
// genuine emergency) could snap-retune them in back-to-back blocks,
// destabilizing the slash economics, the governance quorum, and the
// per-DOT mint rate.
//
// After the fix: each setter calls `_guardRetune(key)`. The first call
// per (contract, key) is unrestricted (records the block). Subsequent
// calls within `retuneCooldownBlocks` revert RetuneCooldown(). Default
// cooldown is 0 (testnet posture); production sets a non-zero value
// via setRetuneCooldownBlocks before lock.

describe("Audit F-031: ParameterRetuneGuard on economic setters", function () {
  let owner: HardhatEthersSigner;

  beforeEach(async function () {
    await fundSigners();
    [owner] = await ethers.getSigners();
  });

  it("PublisherGovernance.setSlashBps is rate-limited under non-zero cooldown", async function () {
    const PubStake = await ethers.getContractFactory("DatumPublisherStake");
    const stake = await PubStake.deploy(1n, 0n, 100n);
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    const [_, g1, g2] = await ethers.getSigners();
    const pause = await Pause.deploy(owner.address, g1.address, g2.address);
    const Gov = await ethers.getContractFactory("DatumPublisherGovernance");
    const gov = await Gov.deploy(
      await stake.getAddress(),       // _publisherStake
      ethers.ZeroAddress,             // _challengeBonds
      await pause.getAddress(),       // _pauseRegistry
      0n,                              // _quorum
      1000n,                           // _slashBps
      0n,                              // _bondBonusBps
      0n,                              // _minGraceBlocks
      0n,                              // _proposeBond
    );

    // Default cooldown is 0; back-to-back retunes allowed.
    await gov.setSlashBps(2000n);
    await gov.setSlashBps(3000n);

    // Set a non-zero cooldown. Note: the prior setSlashBps already
    // recorded a recent lastRetuneBlock, so the NEXT call must wait the
    // cooldown out (the guard reads the existing lastRetuneBlock once cd
    // becomes non-zero). This is correct anti-snap-retune behavior.
    await gov.setRetuneCooldownBlocks(50n);
    await expect(gov.setSlashBps(4000n))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");

    // After the cooldown elapses, retune is allowed again.
    await mineBlocks(50n);
    await gov.setSlashBps(4000n);

    // Immediate follow-up reverts; wait again.
    await expect(gov.setSlashBps(5000n))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    await mineBlocks(50n);
    await gov.setSlashBps(5000n);
  });

  it("GovernanceV2.setSlashBps + setQuorumWeighted each have independent keys", async function () {
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    const [_, g1, g2] = await ethers.getSigners();
    const pause = await Pause.deploy(owner.address, g1.address, g2.address);
    const Camps = await ethers.getContractFactory("MockCampaigns");
    const camps = await Camps.deploy();
    const Gov = await ethers.getContractFactory("DatumGovernanceV2");
    const gov = await Gov.deploy(
      await camps.getAddress(),
      1n, 0n, 1n, 0n, 0n, 0n,
      await pause.getAddress(),
    );

    await gov.setRetuneCooldownBlocks(50n);
    // setSlashBps uses key "slashBps"; setQuorumWeighted uses key
    // "quorumWeighted" — keys are independent, so one doesn't block
    // the other.
    await gov.setSlashBps(2000n);
    await gov.setQuorumWeighted(100n);

    // Each key independently rate-limited.
    await expect(gov.setSlashBps(3000n))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");
    await expect(gov.setQuorumWeighted(200n))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");

    await mineBlocks(50n);
    await gov.setSlashBps(3000n);
    await gov.setQuorumWeighted(200n);
  });

  it("MintCoordinator.setMintRate is rate-limited under non-zero cooldown", async function () {
    const Mc = await ethers.getContractFactory("DatumMintCoordinator");
    const mc = await Mc.deploy();
    await mc.setRetuneCooldownBlocks(50n);

    await mc.setMintRate(10n * 10n ** 10n);
    await expect(mc.setMintRate(15n * 10n ** 10n))
      .to.be.revertedWithCustomError(mc, "RetuneCooldown");

    await mineBlocks(50n);
    await mc.setMintRate(15n * 10n ** 10n);
  });

  it("AdvertiserGovernance.setParams guards slashBps key", async function () {
    const AdvStake = await ethers.getContractFactory("DatumAdvertiserStake");
    const stake = await AdvStake.deploy(1n, 0n, 100n);
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    const [_, g1, g2] = await ethers.getSigners();
    const pause = await Pause.deploy(owner.address, g1.address, g2.address);
    const Gov = await ethers.getContractFactory("DatumAdvertiserGovernance");
    const gov = await Gov.deploy(
      0n,                              // _quorum
      1000n,                           // _slashBps
      0n,                              // _minGraceBlocks
      0n,                              // _proposeBond
      await pause.getAddress(),       // _pauseRegistry
    );

    await gov.setRetuneCooldownBlocks(50n);
    await gov.setParams(0n, 2000n, 0n, 0n);
    await expect(gov.setParams(0n, 3000n, 0n, 0n))
      .to.be.revertedWithCustomError(gov, "RetuneCooldown");

    await mineBlocks(50n);
    await gov.setParams(0n, 3000n, 0n, 0n);
  });

  it("retuneReadyAt view reports the next legal retune block", async function () {
    const Mc = await ethers.getContractFactory("DatumMintCoordinator");
    const mc = await Mc.deploy();
    expect(await mc.retuneReadyAt(ethers.id("mintRate"))).to.equal(0n); // cooldown=0

    await mc.setRetuneCooldownBlocks(100n);
    const tx = await mc.setMintRate(11n * 10n ** 10n);
    const rcpt = await tx.wait();
    expect(await mc.retuneReadyAt(ethers.encodeBytes32String("mintRate"))).to.equal(
      BigInt(rcpt!.blockNumber) + 100n
    );
  });
});
