import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumCampaigns,
  DatumPublishers,
  DatumPauseRegistry,
  DatumBudgetLedger,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// S12: On-chain address blocklist + per-publisher allowlist tests
// BK1-BK6: Global blocklist (add, remove, isBlocked, registerPublisher, createCampaign)
// AL1-AL6: Per-publisher advertiser allowlist

describe("S12: Blocklist & Allowlist", function () {
  let campaigns: DatumCampaigns;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;
  let ledger: DatumBudgetLedger;

  let owner: HardhatEthersSigner;
  let advertiser: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let scammer: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let lifecycleMock: HardhatEthersSigner;

  const BUDGET = parseDOT("2");
  const DAILY_CAP = parseDOT("1");
  const BID_CPM = parseDOT("0.01");
  const TAKE_RATE_BPS = 5000;

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, scammer, other, lifecycleMock] =
      await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

    const PublishersFactory = await ethers.getContractFactory("DatumPublishers");
    publishers = await PublishersFactory.deploy(50n, await pauseReg.getAddress());

    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await CampaignsFactory.deploy(
      0n,
      100n,
      await publishers.getAddress(),
      await pauseReg.getAddress()
    );

    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);

    // Register legitimate publisher
    await publishers.connect(publisher).registerPublisher(TAKE_RATE_BPS);
  });

  // =========================================================================
  // BK: Global blocklist
  // =========================================================================

  it("BK1: blockAddress adds address to blocklist", async function () {
    expect(await publishers.isBlocked(scammer.address)).to.be.false;
    await publishers.blockAddress(scammer.address);
    expect(await publishers.isBlocked(scammer.address)).to.be.true;
  });

  it("BK1b: blockAddress emits AddressBlocked event", async function () {
    await expect(publishers.blockAddress(other.address))
      .to.emit(publishers, "AddressBlocked")
      .withArgs(other.address);
  });

  it("BK2: unblockAddress removes address from blocklist", async function () {
    expect(await publishers.isBlocked(other.address)).to.be.true;
    await publishers.unblockAddress(other.address);
    expect(await publishers.isBlocked(other.address)).to.be.false;
  });

  it("BK2b: unblockAddress emits AddressUnblocked event", async function () {
    await expect(publishers.unblockAddress(scammer.address))
      .to.emit(publishers, "AddressUnblocked")
      .withArgs(scammer.address);
    // Re-block for later tests
    await publishers.blockAddress(scammer.address);
  });

  it("BK3: only owner can blockAddress (E18)", async function () {
    await expect(
      publishers.connect(other).blockAddress(scammer.address)
    ).to.be.revertedWithCustomError(publishers, "OwnableUnauthorizedAccount");
  });

  it("BK3b: only owner can unblockAddress (E18)", async function () {
    await expect(
      publishers.connect(other).unblockAddress(scammer.address)
    ).to.be.revertedWithCustomError(publishers, "OwnableUnauthorizedAccount");
  });

  it("BK3c: blockAddress rejects zero address (E00)", async function () {
    await expect(
      publishers.blockAddress(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  it("BK3d: unblockAddress rejects zero address (E00)", async function () {
    await expect(
      publishers.unblockAddress(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  it("BK4: blocked address cannot registerPublisher (E62)", async function () {
    await expect(
      publishers.connect(scammer).registerPublisher(5000)
    ).to.be.revertedWith("E62");
  });

  it("BK5: blocked advertiser cannot createCampaign (E62)", async function () {
    // Block the advertiser
    await publishers.blockAddress(advertiser.address);

    await expect(
      campaigns.connect(advertiser).createCampaign(
        publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");

    // Unblock for later tests
    await publishers.unblockAddress(advertiser.address);
  });

  it("BK5b: createCampaign targeting blocked publisher reverts (E62)", async function () {
    // Register scammer-publisher first, then block
    const scamPub = (await ethers.getSigners())[7];
    await publishers.connect(scamPub).registerPublisher(5000);
    await publishers.blockAddress(scamPub.address);

    await expect(
      campaigns.connect(advertiser).createCampaign(
        scamPub.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  it("BK6: unblocked address can registerPublisher and createCampaign", async function () {
    // Verify advertiser (unblocked above) can create campaigns
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("BK6b: open campaign (publisher=0) still checks advertiser blocklist", async function () {
    await publishers.blockAddress(advertiser.address);
    await expect(
      campaigns.connect(advertiser).createCampaign(
        ethers.ZeroAddress, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
    await publishers.unblockAddress(advertiser.address);
  });

  // =========================================================================
  // AL: Per-publisher allowlist
  // =========================================================================

  it("AL1: setAllowlistEnabled toggles allowlist", async function () {
    expect(await publishers.allowlistEnabled(publisher.address)).to.be.false;

    await publishers.connect(publisher).setAllowlistEnabled(true);
    expect(await publishers.allowlistEnabled(publisher.address)).to.be.true;

    await publishers.connect(publisher).setAllowlistEnabled(false);
    expect(await publishers.allowlistEnabled(publisher.address)).to.be.false;
  });

  it("AL1b: setAllowlistEnabled emits AllowlistToggled", async function () {
    await expect(publishers.connect(publisher).setAllowlistEnabled(true))
      .to.emit(publishers, "AllowlistToggled")
      .withArgs(publisher.address, true);
  });

  it("AL1c: only registered publisher can setAllowlistEnabled", async function () {
    await expect(
      publishers.connect(other).setAllowlistEnabled(true)
    ).to.be.revertedWith("Not registered");
  });

  it("AL2: setAllowedAdvertiser adds/removes advertiser", async function () {
    await publishers.connect(publisher).setAllowedAdvertiser(advertiser.address, true);
    expect(await publishers.isAllowedAdvertiser(publisher.address, advertiser.address)).to.be.true;

    await publishers.connect(publisher).setAllowedAdvertiser(advertiser.address, false);
    expect(await publishers.isAllowedAdvertiser(publisher.address, advertiser.address)).to.be.false;
  });

  it("AL2b: setAllowedAdvertiser emits AdvertiserAllowlistUpdated", async function () {
    await expect(
      publishers.connect(publisher).setAllowedAdvertiser(advertiser.address, true)
    ).to.emit(publishers, "AdvertiserAllowlistUpdated")
      .withArgs(publisher.address, advertiser.address, true);
  });

  it("AL2c: setAllowedAdvertiser rejects zero address (E00)", async function () {
    await expect(
      publishers.connect(publisher).setAllowedAdvertiser(ethers.ZeroAddress, true)
    ).to.be.revertedWith("E00");
  });

  it("AL2d: only registered publisher can setAllowedAdvertiser", async function () {
    await expect(
      publishers.connect(other).setAllowedAdvertiser(advertiser.address, true)
    ).to.be.revertedWith("Not registered");
  });

  it("AL3: createCampaign respects allowlist — allowed advertiser succeeds", async function () {
    // Allowlist is enabled, advertiser is allowed (from AL2b)
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("AL4: createCampaign rejects non-allowed advertiser (E63)", async function () {
    // other is not on publisher's allowlist
    await expect(
      campaigns.connect(other).createCampaign(
        publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
      )
    ).to.be.revertedWith("E63");
  });

  it("AL5: open campaign (publisher=0) bypasses allowlist", async function () {
    const tx = await campaigns.connect(other).createCampaign(
      ethers.ZeroAddress, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("AL6: disabling allowlist lets anyone create campaigns again", async function () {
    await publishers.connect(publisher).setAllowlistEnabled(false);

    const tx = await campaigns.connect(other).createCampaign(
      publisher.address, DAILY_CAP, BID_CPM, 0, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("AL6b: allowlist functions revert when paused", async function () {
    await pauseReg.pause();

    await expect(
      publishers.connect(publisher).setAllowlistEnabled(true)
    ).to.be.revertedWith("P");

    await expect(
      publishers.connect(publisher).setAllowedAdvertiser(advertiser.address, true)
    ).to.be.revertedWith("P");

    await pauseReg.unpause();
  });
});
