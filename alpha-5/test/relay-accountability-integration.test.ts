import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumRelay,
  DatumRelayStake,
  DatumPauseRegistry,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumRelay integration with DatumRelayStake (G-1 first close, pattern (b) augment)
// RI1–RI4:   setRelayStake() — owner-only, accepts address(0), event
// RI5–RI8:   isAuthorizedRelayer() — manual OR stake gate; both off; both on
// RI9–RI12:  settleClaimsFor gate respects augmented authorization
// RI13:      lockPlumbing freezes setRelayStake

describe("DatumRelay G-1 integration", function () {
  let relay: DatumRelay;
  let relayStake: DatumRelayStake;
  let pauseReg: DatumPauseRegistry;
  let mockCampaigns: MockCampaigns;

  let owner: HardhatEthersSigner;
  let manualRelay: HardhatEthersSigner;
  let stakedRelay: HardhatEthersSigner;
  let unauthorized: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const MIN_STAKE  = 10_000_000_000n;
  const EXIT_DELAY = 20n;
  const FUND_AMT   = 100_000_000_000n;

  beforeEach(async function () {
    await fundSigners();
    [owner, manualRelay, stakedRelay, unauthorized, other] = await ethers.getSigners();

    // Deploy minimal stack for DatumRelay constructor.
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, manualRelay.address, stakedRelay.address);

    const CampaignsFactory = await ethers.getContractFactory("MockCampaigns");
    mockCampaigns = await CampaignsFactory.deploy();

    // For settlement we use a placeholder (we don't exercise the settle path here)
    const placeholder = other.address;

    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(
      placeholder,                              // settlement placeholder
      await mockCampaigns.getAddress(),         // campaigns
      await pauseReg.getAddress()               // pauseRegistry
    );

    const StakeFactory = await ethers.getContractFactory("DatumRelayStake");
    relayStake = await StakeFactory.deploy(MIN_STAKE, EXIT_DELAY);
  });

  // ── setRelayStake ────────────────────────────────────────────────────

  it("RI1: setRelayStake from non-owner reverts E18", async function () {
    await expect(relay.connect(other).setRelayStake(relayStake.target))
      .to.be.revertedWith("E18");
  });

  it("RI2: setRelayStake from owner emits RelayStakeSet", async function () {
    await expect(relay.connect(owner).setRelayStake(relayStake.target))
      .to.emit(relay, "RelayStakeSet")
      .withArgs(await relayStake.getAddress());
    expect(await relay.relayStake()).to.equal(await relayStake.getAddress());
  });

  it("RI3: setRelayStake accepts address(0) to disable the gate", async function () {
    await relay.connect(owner).setRelayStake(relayStake.target);
    await relay.connect(owner).setRelayStake(ethers.ZeroAddress);
    expect(await relay.relayStake()).to.equal(ethers.ZeroAddress);
  });

  // ── isAuthorizedRelayer view ─────────────────────────────────────────

  it("RI4: isAuthorizedRelayer false when neither path authorizes", async function () {
    expect(await relay.isAuthorizedRelayer(unauthorized.address)).to.equal(false);
  });

  it("RI5: isAuthorizedRelayer true via manual allowlist", async function () {
    await relay.connect(owner).setRelayerAuthorized(manualRelay.address, true);
    expect(await relay.isAuthorizedRelayer(manualRelay.address)).to.equal(true);
  });

  it("RI6: isAuthorizedRelayer true via stake gate", async function () {
    await relay.connect(owner).setRelayStake(relayStake.target);
    await relayStake.connect(stakedRelay).stake({ value: FUND_AMT });
    expect(await relay.isAuthorizedRelayer(stakedRelay.address)).to.equal(true);
  });

  it("RI7: isAuthorizedRelayer respects BOTH paths (augment)", async function () {
    await relay.connect(owner).setRelayStake(relayStake.target);
    // manual allowlist
    await relay.connect(owner).setRelayerAuthorized(manualRelay.address, true);
    expect(await relay.isAuthorizedRelayer(manualRelay.address)).to.equal(true);
    // stake gate
    await relayStake.connect(stakedRelay).stake({ value: FUND_AMT });
    expect(await relay.isAuthorizedRelayer(stakedRelay.address)).to.equal(true);
    // neither
    expect(await relay.isAuthorizedRelayer(unauthorized.address)).to.equal(false);
  });

  it("RI8: isAuthorizedRelayer false after stake gate exit", async function () {
    await relay.connect(owner).setRelayStake(relayStake.target);
    await relayStake.connect(stakedRelay).stake({ value: FUND_AMT });
    expect(await relay.isAuthorizedRelayer(stakedRelay.address)).to.equal(true);
    await relayStake.connect(stakedRelay).requestExit();
    expect(await relay.isAuthorizedRelayer(stakedRelay.address)).to.equal(false);
  });

  it("RI9: isAuthorizedRelayer false when stake below floor", async function () {
    await relay.connect(owner).setRelayStake(relayStake.target);
    await relayStake.connect(stakedRelay).stake({ value: MIN_STAKE - 1n });
    expect(await relay.isAuthorizedRelayer(stakedRelay.address)).to.equal(false);
  });

  // ── lockPlumbing ─────────────────────────────────────────────────────

  it("RI10: setRelayStake reverts after lockPlumbing", async function () {
    const { wireOpenGovRouter } = await import("./helpers/openGovRouter");
    await wireOpenGovRouter(relay);
    await relay.connect(owner).lockPlumbing();
    await expect(relay.connect(owner).setRelayStake(relayStake.target))
      .to.be.revertedWith("locked");
  });
});
