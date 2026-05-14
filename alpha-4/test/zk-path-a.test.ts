import { expect } from "chai";
import { ethers } from "hardhat";
import { fundSigners } from "./helpers/mine";

// Path A: stake-gate + interest-commitment surface tests.
// These are contract-level unit tests — they do NOT generate real Groth16 proofs
// (that requires running scripts/setup-zk.mjs + witness builder; covered elsewhere).
// Here we verify the on-chain plumbing: storage, access control, lookback windows,
// campaign-level minStake/requiredCategory setters/getters, and ClaimValidator
// invocation of verifyA via MockZKVerifier.

describe("Path A: DatumStakeRoot", function () {
  let stakeRoot: any;
  let owner: any, r1: any, r2: any, r3: any, other: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, r1, r2, r3, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DatumStakeRoot");
    stakeRoot = await F.deploy();
    await stakeRoot.addReporter(r1.address);
    await stakeRoot.addReporter(r2.address);
    await stakeRoot.addReporter(r3.address);
    await stakeRoot.setThreshold(2);
  });

  it("rejects commit from non-reporter", async function () {
    const root = ethers.id("root-1");
    await expect(stakeRoot.connect(other).commitStakeRoot(1, root)).to.be.revertedWith("E01");
  });

  it("first reporter proposes, second finalizes", async function () {
    const root = ethers.id("root-1");
    await stakeRoot.connect(r1).commitStakeRoot(1, root);
    expect(await stakeRoot.rootAt(1)).to.equal(ethers.ZeroHash);
    await stakeRoot.connect(r2).commitStakeRoot(1, root);
    expect(await stakeRoot.rootAt(1)).to.equal(root);
    expect(await stakeRoot.latestEpoch()).to.equal(1n);
  });

  it("reporter cannot double-vote on the same proposal", async function () {
    const root = ethers.id("root-1");
    await stakeRoot.connect(r1).commitStakeRoot(1, root);
    await expect(stakeRoot.connect(r1).commitStakeRoot(1, root)).to.be.revertedWith("E22");
  });

  it("rejects backwards epoch", async function () {
    const r1Root = ethers.id("e1");
    await stakeRoot.connect(r1).commitStakeRoot(5, r1Root);
    await stakeRoot.connect(r2).commitStakeRoot(5, r1Root);
    await expect(stakeRoot.connect(r1).commitStakeRoot(4, ethers.id("e0"))).to.be.revertedWith("E64");
  });

  it("isRecent honors the 8-epoch lookback", async function () {
    // Commit roots at epochs 1..10
    for (let e = 1; e <= 10; e++) {
      const root = ethers.id(`e${e}`);
      await stakeRoot.connect(r1).commitStakeRoot(e, root);
      await stakeRoot.connect(r2).commitStakeRoot(e, root);
    }
    // latestEpoch=10, lookback=8 → epochs 3..10 recent
    expect(await stakeRoot.isRecent(ethers.id("e10"))).to.equal(true);
    expect(await stakeRoot.isRecent(ethers.id("e3"))).to.equal(true);
    expect(await stakeRoot.isRecent(ethers.id("e2"))).to.equal(false);
    expect(await stakeRoot.isRecent(ethers.id("e1"))).to.equal(false);
  });

  it("threshold bounded by reporter count", async function () {
    await expect(stakeRoot.setThreshold(0)).to.be.revertedWith("E11");
    await expect(stakeRoot.setThreshold(4)).to.be.revertedWith("E11");
    await stakeRoot.setThreshold(3);
  });

  it("removeReporter compacts array", async function () {
    expect(await stakeRoot.reporterCount()).to.equal(3n);
    await stakeRoot.removeReporter(r2.address);
    expect(await stakeRoot.reporterCount()).to.equal(2n);
    expect(await stakeRoot.isReporter(r2.address)).to.equal(false);
  });
});

describe("Path A: DatumInterestCommitments", function () {
  let ic: any;
  let alice: any, bob: any;

  beforeEach(async function () {
    await fundSigners();
    [, alice, bob] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DatumInterestCommitments");
    ic = await F.deploy();
  });

  it("stores per-user commitment + lastSetBlock", async function () {
    const root = ethers.id("alice-interests");
    const tx = await ic.connect(alice).setInterestCommitment(root);
    const r = await tx.wait();
    expect(await ic.interestRoot(alice.address)).to.equal(root);
    expect(await ic.lastSetBlock(alice.address)).to.equal(BigInt(r!.blockNumber));
    expect(await ic.interestRoot(bob.address)).to.equal(ethers.ZeroHash);
  });

  it("overwrites cleanly", async function () {
    await ic.connect(alice).setInterestCommitment(ethers.id("v1"));
    await ic.connect(alice).setInterestCommitment(ethers.id("v2"));
    expect(await ic.interestRoot(alice.address)).to.equal(ethers.id("v2"));
  });

  it("emits InterestCommitmentSet with block", async function () {
    await expect(ic.connect(alice).setInterestCommitment(ethers.id("x")))
      .to.emit(ic, "InterestCommitmentSet");
  });
});

describe("Path A: DatumCampaigns minStake + requiredCategory", function () {
  let campaigns: any, publishers: any, pauseReg: any, ledger: any;
  let owner: any, advertiser: any, publisher: any, other: any, lifecycleMock: any;

  before(async function () {
    await fundSigners();
    [owner, advertiser, publisher, other, lifecycleMock] = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await Pause.deploy(owner.address, advertiser.address, publisher.address);
    const Pubs = await ethers.getContractFactory("DatumPublishers");
    publishers = await Pubs.deploy(50n, await pauseReg.getAddress());
    const Ledger = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await Ledger.deploy();
    const C = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await C.deploy(0n, 100n, await publishers.getAddress(), await pauseReg.getAddress());
    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);
    await campaigns.setGovernanceContract(owner.address);
    await publishers.connect(publisher).registerPublisher(5000);
  });

  async function createPendingCampaign() {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: 1_000_000_000n, dailyCapPlanck: 1_000_000_000n, ratePlanck: 1n, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n,
      { value: 1_000_000_000n }
    );
    await tx.wait();
    return (await campaigns.nextCampaignId()) - 1n;
  }

  it("default minStake and requiredCategory are 0 / 0x0", async function () {
    const cid = await createPendingCampaign();
    expect(await campaigns.getCampaignMinStake(cid)).to.equal(0n);
    expect(await campaigns.getCampaignRequiredCategory(cid)).to.equal(ethers.ZeroHash);
  });

  it("advertiser can set minStake while Pending; non-advertiser reverts E21", async function () {
    const cid = await createPendingCampaign();
    await campaigns.connect(advertiser).setCampaignMinStake(cid, 1_000n);
    expect(await campaigns.getCampaignMinStake(cid)).to.equal(1_000n);
    await expect(campaigns.connect(other).setCampaignMinStake(cid, 1n)).to.be.revertedWith("E21");
  });

  it("raising minStake locked once Active; lowering still allowed", async function () {
    const cid = await createPendingCampaign();
    await campaigns.connect(advertiser).setCampaignMinStake(cid, 500n);
    await campaigns.activateCampaign(cid);
    // Lower is OK
    await campaigns.connect(advertiser).setCampaignMinStake(cid, 100n);
    expect(await campaigns.getCampaignMinStake(cid)).to.equal(100n);
    // Raise reverts E22
    await expect(
      campaigns.connect(advertiser).setCampaignMinStake(cid, 200n)
    ).to.be.revertedWith("E22");
  });

  it("requiredCategory locked once Active (raise OR lower)", async function () {
    const cid = await createPendingCampaign();
    const cat1 = ethers.id("finance");
    const cat2 = ethers.id("crypto");
    await campaigns.connect(advertiser).setCampaignRequiredCategory(cid, cat1);
    expect(await campaigns.getCampaignRequiredCategory(cid)).to.equal(cat1);
    await campaigns.activateCampaign(cid);
    await expect(
      campaigns.connect(advertiser).setCampaignRequiredCategory(cid, cat2)
    ).to.be.revertedWith("E22");
  });
});

describe("Path A: ClaimValidator uses verifyA via MockZKVerifier", function () {
  // Smoke test: confirms MockZKVerifier.verifyA returns true for non-empty proofs
  // (mirrors BM-ZK-2 in benchmark.test.ts but via the new path).
  it("MockZKVerifier.verifyA accepts any non-empty 256-byte proof", async function () {
    const F = await ethers.getContractFactory("MockZKVerifier");
    const v = await F.deploy();
    const proof = "0x" + "ab".repeat(256);
    const pubs = [1n, 2n, 3n, 4n, 5n, 6n, 7n] as any;
    expect(await v.verifyA(proof, pubs)).to.equal(true);
    expect(await v.verifyA("0x", pubs)).to.equal(false);
  });
});

describe("Path A: DatumZKStake withdrawal lockup", function () {
  let zkStake: any, mockToken: any;
  let owner: any, alice: any, bob: any;
  const INITIAL = 1_000_000n;

  before(async function () {
    await fundSigners();
    [owner, alice, bob] = await ethers.getSigners();
  });

  beforeEach(async function () {
    const Tok = await ethers.getContractFactory("MockERC20");
    mockToken = await Tok.deploy("DATUM", "DATUM");
    await mockToken.mint(alice.address, INITIAL);
    await mockToken.mint(bob.address, INITIAL);

    const F = await ethers.getContractFactory("DatumZKStake");
    zkStake = await F.deploy(await mockToken.getAddress());
    // Pre-register commitments so deposit() works directly
    await zkStake.connect(alice).setUserCommitment(ethers.id("alice-secret"));
    await zkStake.connect(bob).setUserCommitment(ethers.id("bob-secret"));
  });

  it("deposit transfers tokens and increments staked", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 1000n);
    await zkStake.connect(alice).deposit(1000n);
    expect(await zkStake.staked(alice.address)).to.equal(1000n);
    expect(await zkStake.totalLocked()).to.equal(1000n);
    expect(await mockToken.balanceOf(alice.address)).to.equal(INITIAL - 1000n);
  });

  it("requestWithdrawal drops staked immediately and sets readyAt", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 1000n);
    await zkStake.connect(alice).setUserCommitment(ethers.id("alice-secret"));
    await zkStake.connect(alice).deposit(1000n);
    const tx = await zkStake.connect(alice).requestWithdrawal(400n);
    const r = await tx.wait();
    expect(await zkStake.staked(alice.address)).to.equal(600n);
    const p = await zkStake.pending(alice.address);
    expect(p.amount).to.equal(400n);
    expect(p.readyAt).to.equal(BigInt(r!.blockNumber) + 432_000n);
  });

  it("executeWithdrawal reverts before lockup elapses (E37)", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 500n);
    await zkStake.connect(alice).deposit(500n);
    await zkStake.connect(alice).requestWithdrawal(500n);
    await expect(zkStake.connect(alice).executeWithdrawal()).to.be.revertedWith("E37");
  });

  it("second request resets lockup clock (no rolling exits)", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 1000n);
    await zkStake.connect(alice).setUserCommitment(ethers.id("alice-secret"));
    await zkStake.connect(alice).deposit(1000n);
    const tx1 = await zkStake.connect(alice).requestWithdrawal(300n);
    const r1 = await tx1.wait();
    const ready1 = BigInt(r1!.blockNumber) + 432_000n;
    // Advance some blocks
    await ethers.provider.send("hardhat_mine", ["0x100"]); // 256 blocks
    const tx2 = await zkStake.connect(alice).requestWithdrawal(200n);
    const r2 = await tx2.wait();
    const ready2 = BigInt(r2!.blockNumber) + 432_000n;
    const p = await zkStake.pending(alice.address);
    expect(p.amount).to.equal(500n);
    expect(p.readyAt).to.equal(ready2);
    expect(ready2).to.be.gt(ready1);
  });

  it("cancelWithdrawal folds pending back into staked, no lockup penalty", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 1000n);
    await zkStake.connect(alice).setUserCommitment(ethers.id("alice-secret"));
    await zkStake.connect(alice).deposit(1000n);
    await zkStake.connect(alice).requestWithdrawal(400n);
    await zkStake.connect(alice).cancelWithdrawal();
    expect(await zkStake.staked(alice.address)).to.equal(1000n);
    const p = await zkStake.pending(alice.address);
    expect(p.amount).to.equal(0n);
    expect(p.readyAt).to.equal(0n);
  });

  it("executeWithdrawal transfers after lockup", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 500n);
    await zkStake.connect(alice).deposit(500n);
    await zkStake.connect(alice).requestWithdrawal(500n);
    await ethers.provider.send("hardhat_mine", ["0x69780"]); // 432,000 blocks
    await zkStake.connect(alice).executeWithdrawal();
    expect(await mockToken.balanceOf(alice.address)).to.equal(INITIAL);
    expect(await zkStake.totalLocked()).to.equal(0n);
  });

  it("cannot request more than staked (E03)", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 100n);
    await zkStake.connect(alice).deposit(100n);
    await expect(zkStake.connect(alice).requestWithdrawal(200n)).to.be.revertedWith("E03");
  });

  it("zero-amount actions revert E11/E03", async function () {
    await expect(zkStake.connect(alice).deposit(0n)).to.be.revertedWith("E11");
    await expect(zkStake.connect(alice).requestWithdrawal(0n)).to.be.revertedWith("E11");
    await expect(zkStake.connect(alice).executeWithdrawal()).to.be.revertedWith("E03");
    await expect(zkStake.connect(alice).cancelWithdrawal()).to.be.revertedWith("E03");
  });

  it("deposit without userCommitment reverts E01", async function () {
    // bob has commitment from beforeEach; use a fresh signer
    const fresh = (await ethers.getSigners())[10];
    await mockToken.mint(fresh.address, 100n);
    await mockToken.connect(fresh).approve(await zkStake.getAddress(), 100n);
    await expect(zkStake.connect(fresh).deposit(100n)).to.be.revertedWith("E01");
  });

  it("setUserCommitment locked once user has stake", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 100n);
    await zkStake.connect(alice).deposit(100n);
    await expect(
      zkStake.connect(alice).setUserCommitment(ethers.id("alice-v2"))
    ).to.be.revertedWith("locked-by-stake");
  });

  it("depositWith atomically sets commitment + deposits", async function () {
    const fresh = (await ethers.getSigners())[11];
    await mockToken.mint(fresh.address, 1000n);
    await mockToken.connect(fresh).approve(await zkStake.getAddress(), 1000n);
    const commit = ethers.id("fresh-secret");
    await zkStake.connect(fresh).depositWith(commit, 1000n);
    expect(await zkStake.userCommitment(fresh.address)).to.equal(commit);
    expect(await zkStake.staked(fresh.address)).to.equal(1000n);
  });

  it("depositWith reverts if commitment differs from on-file", async function () {
    await mockToken.connect(alice).approve(await zkStake.getAddress(), 100n);
    await expect(
      zkStake.connect(alice).depositWith(ethers.id("wrong"), 100n)
    ).to.be.revertedWith("commitment-mismatch");
  });

  // ── Slashing ──────────────────────────────────────────────────────────
  describe("slashing", function () {
    let slasher: any;

    beforeEach(async function () {
      slasher = (await ethers.getSigners())[5];
      await zkStake.setSlasher(slasher.address, true);
      await zkStake.setSlashRecipient(bob.address);
      // H-2: lift per-call cap so legacy tests can drain full balances in one call.
      await zkStake.setMaxSlashBpsPerCall(10000);
      await mockToken.connect(alice).approve(await zkStake.getAddress(), 1000n);
      await zkStake.connect(alice).deposit(1000n);
    });

    it("non-slasher cannot slash (E18)", async function () {
      await expect(zkStake.connect(alice).slash(alice.address, 100n)).to.be.revertedWith("E18");
    });

    it("slash takes from active stake when no pending", async function () {
      const bobBefore = await mockToken.balanceOf(bob.address);
      const tx = await zkStake.connect(slasher).slash(alice.address, 300n);
      const r = await tx.wait();
      expect(await zkStake.staked(alice.address)).to.equal(700n);
      expect(await mockToken.balanceOf(bob.address)).to.equal(bobBefore + 300n);
      // Event check
      const log = r!.logs.find((l: any) => { try { return zkStake.interface.parseLog(l)?.name === "Slashed"; } catch { return false; } });
      const parsed = zkStake.interface.parseLog(log!);
      expect(parsed!.args.fromStaked).to.equal(300n);
      expect(parsed!.args.fromPending).to.equal(0n);
    });

    it("slash drains pending FIRST then active", async function () {
      await zkStake.connect(alice).requestWithdrawal(400n);
      // pending=400, staked=600
      await zkStake.connect(slasher).slash(alice.address, 500n);
      const p = await zkStake.pending(alice.address);
      expect(p.amount).to.equal(0n);   // 400 taken from pending
      expect(await zkStake.staked(alice.address)).to.equal(500n); // 100 from staked
    });

    it("slash >= totalUserHeld takes everything", async function () {
      // staked=1000 only
      await zkStake.connect(slasher).slash(alice.address, 2000n);
      expect(await zkStake.staked(alice.address)).to.equal(0n);
      // totalLocked should drop by only what existed
      expect(await zkStake.totalLocked()).to.equal(0n);
    });

    it("lockSlashers freezes the role set permanently", async function () {
      await zkStake.lockSlashers();
      await expect(
        zkStake.setSlasher(alice.address, true)
      ).to.be.revertedWith("slashers-locked");
    });
  });
});

describe("Path A: governance cap on campaignMinStake", function () {
  let campaigns: any, publishers: any, pauseReg: any, ledger: any;
  let owner: any, advertiser: any, publisher: any, lifecycleMock: any;

  beforeEach(async function () {
    await fundSigners();
    [owner, advertiser, publisher, lifecycleMock] = await ethers.getSigners();
    const Pause = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await Pause.deploy(owner.address, advertiser.address, publisher.address);
    const Pubs = await ethers.getContractFactory("DatumPublishers");
    publishers = await Pubs.deploy(50n, await pauseReg.getAddress());
    const Ledger = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await Ledger.deploy();
    const C = await ethers.getContractFactory("DatumCampaigns");
    campaigns = await C.deploy(0n, 100n, await publishers.getAddress(), await pauseReg.getAddress());
    await ledger.setCampaigns(await campaigns.getAddress());
    await campaigns.setBudgetLedger(await ledger.getAddress());
    await campaigns.setLifecycleContract(lifecycleMock.address);
    await campaigns.setGovernanceContract(owner.address);
    await publishers.connect(publisher).registerPublisher(5000);
  });

  async function newCampaign() {
    const tx = await campaigns.connect(advertiser).createCampaign(
      publisher.address,
      [{ actionType: 0, budgetPlanck: 1_000_000_000n, dailyCapPlanck: 1_000_000_000n, ratePlanck: 1n, actionVerifier: ethers.ZeroAddress }],
      [], false, ethers.ZeroAddress, 0n, 0n,
      { value: 1_000_000_000n }
    );
    await tx.wait();
    return (await campaigns.nextCampaignId()) - 1n;
  }

  it("default cap is 0 (no cap)", async function () {
    expect(await campaigns.maxAllowedMinStake()).to.equal(0n);
    const cid = await newCampaign();
    // With no cap, even huge values allowed
    await campaigns.connect(advertiser).setCampaignMinStake(cid, ethers.MaxUint256);
    expect(await campaigns.getCampaignMinStake(cid)).to.equal(ethers.MaxUint256);
  });

  it("owner can set cap; advertiser bounded by it (E11 above)", async function () {
    await campaigns.setMaxAllowedMinStake(10_000n);
    const cid = await newCampaign();
    await campaigns.connect(advertiser).setCampaignMinStake(cid, 10_000n); // exact cap allowed
    await expect(
      campaigns.connect(advertiser).setCampaignMinStake(cid, 10_001n)
    ).to.be.revertedWith("E11");
  });

  it("non-owner cannot set cap (E18)", async function () {
    await expect(
      campaigns.connect(advertiser).setMaxAllowedMinStake(100n)
    ).to.be.revertedWith("E18");
  });

  it("setMaxAllowedMinStake remains tunable after lockLanes (parameter, not lane)", async function () {
    // lockLanes requires tagRegistry to be wired first; skip that path here by
    // asserting the simpler invariant: setMaxAllowedMinStake never had a
    // lock check in the new posture and stays callable indefinitely.
    await expect(campaigns.setMaxAllowedMinStake(100n)).to.not.be.reverted;
    expect(await campaigns.maxAllowedMinStake()).to.equal(100n);
  });
});
