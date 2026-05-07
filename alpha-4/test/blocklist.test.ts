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
import { advanceTime, fundSigners } from "./helpers/mine";

// S12: On-chain address blocklist + per-publisher allowlist tests
// C-5: unblock requires 48h delay (proposeUnblock → executeUnblock)

const UNBLOCK_DELAY = 172800; // 48 hours in seconds

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

  /** Helper: unblock an address via the C-5 propose/execute pattern */
  async function unblockAddress(addr: string) {
    await publishers.proposeUnblock(addr);
    await advanceTime(UNBLOCK_DELAY);
    await publishers.executeUnblock(addr);
  }

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, scammer, other, lifecycleMock] =
      await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, advertiser.address, publisher.address);

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

  it("BK2: proposeUnblock + executeUnblock removes address from blocklist (C-5)", async function () {
    expect(await publishers.isBlocked(other.address)).to.be.true;
    await unblockAddress(other.address);
    expect(await publishers.isBlocked(other.address)).to.be.false;
  });

  it("BK2b: executeUnblock emits AddressUnblocked event", async function () {
    // Block scammer, then unblock via propose/execute
    await publishers.proposeUnblock(scammer.address);
    await advanceTime(UNBLOCK_DELAY);
    await expect(publishers.executeUnblock(scammer.address))
      .to.emit(publishers, "AddressUnblocked")
      .withArgs(scammer.address);
    // Re-block for later tests
    await publishers.blockAddress(scammer.address);
  });

  it("BK2c: executeUnblock reverts before delay (E37)", async function () {
    await publishers.blockAddress(other.address);
    await publishers.proposeUnblock(other.address);
    await expect(publishers.executeUnblock(other.address)).to.be.revertedWith("E37");
    // Cleanup: advance and execute
    await advanceTime(UNBLOCK_DELAY);
    await publishers.executeUnblock(other.address);
  });

  it("BK2d: proposeUnblock on non-blocked address reverts (E01)", async function () {
    await expect(publishers.proposeUnblock(other.address)).to.be.revertedWith("E01");
  });

  it("BK2e: blockAddress cancels pending unblock", async function () {
    await publishers.blockAddress(other.address);
    await publishers.proposeUnblock(other.address);
    // Re-block cancels the pending unblock
    await expect(publishers.blockAddress(other.address))
      .to.emit(publishers, "UnblockCancelled")
      .withArgs(other.address);
    // executeUnblock should now fail (no pending)
    await expect(publishers.executeUnblock(other.address)).to.be.revertedWith("E01");
    // Cleanup
    await unblockAddress(other.address);
  });

  it("BK3: only owner can blockAddress (E18)", async function () {
    await expect(
      publishers.connect(other).blockAddress(scammer.address)
    ).to.be.revertedWith("E18");
  });

  it("BK3b: only owner can proposeUnblock (E18)", async function () {
    await expect(
      publishers.connect(other).proposeUnblock(scammer.address)
    ).to.be.revertedWith("E18");
  });

  it("BK3c: blockAddress rejects zero address (E00)", async function () {
    await expect(
      publishers.blockAddress(ethers.ZeroAddress)
    ).to.be.revertedWith("E00");
  });

  it("BK3d: proposeUnblock rejects zero address (E00)", async function () {
    await expect(
      publishers.proposeUnblock(ethers.ZeroAddress)
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
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");

    // Unblock for later tests
    await unblockAddress(advertiser.address);
  });

  it("BK5b: createCampaign targeting blocked publisher reverts (E62)", async function () {
    // Register scammer-publisher first, then block
    const scamPub = (await ethers.getSigners())[7];
    await publishers.connect(scamPub).registerPublisher(5000);
    await publishers.blockAddress(scamPub.address);

    await expect(
      campaigns.connect(advertiser).createCampaign(
        scamPub.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  it("BK6: unblocked address can registerPublisher and createCampaign", async function () {
    // advertiser was unblocked above
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("BK6b: open campaign (publisher=0) still checks advertiser blocklist", async function () {
    await publishers.blockAddress(advertiser.address);
    await expect(
      campaigns.connect(advertiser).createCampaign(
        ethers.ZeroAddress,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
    await unblockAddress(advertiser.address);
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
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("AL4: createCampaign rejects non-allowed advertiser (SE-3: E62)", async function () {
    // other is not on publisher's allowlist — validator returns (false, 0)
    await expect(
      campaigns.connect(other).createCampaign(
        publisher.address,
        [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
        [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
      )
    ).to.be.revertedWith("E62");
  });

  it("AL5: open campaign (publisher=0) bypasses allowlist", async function () {
    const tx = await campaigns.connect(other).createCampaign(
      ethers.ZeroAddress,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
    );
    await tx.wait();
    const id = await campaigns.nextCampaignId() - 1n;
    expect(id).to.be.gt(0n);
  });

  it("AL6: disabling allowlist lets anyone create campaigns again", async function () {
    await publishers.connect(publisher).setAllowlistEnabled(false);

    const tx = await campaigns.connect(other).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: BUDGET, dailyCapPlanck: DAILY_CAP, ratePlanck: BID_CPM, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n, { value: BUDGET }
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

    // Unpause via guardian approval (C-4: owner can only pause, not unpause)
    const pid = await pauseReg.connect(advertiser).propose.staticCall(2);
    await pauseReg.connect(advertiser).propose(2);
    await pauseReg.connect(publisher).approve(pid);
  });
});
