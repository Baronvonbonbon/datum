import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumChallengeBonds } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// DatumChallengeBonds tests (FP-2)
// CB1–CB5:   lockBond() — access control, zero value, duplicate, happy path, event
// CB6–CB9:   returnBond() — access control, no-bond no-op, happy path, event
// CB10–CB12: addToPool() — access control, zero value, accumulation
// CB13–CB18: claimBonus() — not bonded, wrong advertiser, no pool, proportional share, burn-bond, already-claimed
// CB19–CB20: ownership transfer

describe("DatumChallengeBonds", function () {
  let bonds: DatumChallengeBonds;

  let owner: HardhatEthersSigner;
  let campaigns: HardhatEthersSigner;   // impersonates DatumCampaigns
  let lifecycle: HardhatEthersSigner;   // impersonates DatumCampaignLifecycle
  let governance: HardhatEthersSigner;  // impersonates DatumPublisherGovernance
  let advertiser: HardhatEthersSigner;
  let advertiser2: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const BOND = 2_000_000_000n; // 0.2 DOT

  before(async function () {
    await fundSigners();
    [owner, campaigns, lifecycle, governance, advertiser, advertiser2, publisher, other] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DatumChallengeBonds");
    bonds = await Factory.deploy();

    await bonds.connect(owner).setCampaignsContract(campaigns.address);
    await bonds.connect(owner).setLifecycleContract(lifecycle.address);
    await bonds.connect(owner).setGovernanceContract(governance.address);
  });

  // ── lockBond() ────────────────────────────────────────────────────────────────

  // CB1: lockBond from non-campaigns reverts E18
  it("CB1: lockBond from non-campaigns reverts E18", async function () {
    await expect(
      bonds.connect(other).lockBond(1, advertiser.address, publisher.address, { value: BOND })
    ).to.be.revertedWith("E18");
  });

  // CB2: lockBond with zero value reverts E11
  it("CB2: lockBond with zero value reverts E11", async function () {
    await expect(
      bonds.connect(campaigns).lockBond(1, advertiser.address, publisher.address, { value: 0n })
    ).to.be.revertedWith("E11");
  });

  // CB3: lockBond records bond, owner, publisher; updates totalBonds
  it("CB3: lockBond stores bond state", async function () {
    await bonds
      .connect(campaigns)
      .lockBond(1, advertiser.address, publisher.address, { value: BOND });

    expect(await bonds.bond(1n)).to.equal(BOND);
    expect(await bonds.bondOwner(1n)).to.equal(advertiser.address);
    expect(await bonds.bondPublisher(1n)).to.equal(publisher.address);
    expect(await bonds.totalBonds(publisher.address)).to.equal(BOND);
  });

  // CB4: lockBond emits BondLocked
  it("CB4: lockBond emits BondLocked", async function () {
    await expect(
      bonds.connect(campaigns).lockBond(2, advertiser2.address, publisher.address, { value: BOND * 2n })
    )
      .to.emit(bonds, "BondLocked")
      .withArgs(2n, advertiser2.address, publisher.address, BOND * 2n);
    expect(await bonds.totalBonds(publisher.address)).to.equal(BOND + BOND * 2n);
  });

  // CB5: duplicate lockBond on same campaignId reverts E71
  it("CB5: duplicate lockBond reverts E71", async function () {
    await expect(
      bonds.connect(campaigns).lockBond(1, advertiser.address, publisher.address, { value: BOND })
    ).to.be.revertedWith("E71");
  });

  // ── returnBond() ──────────────────────────────────────────────────────────────

  // CB6: returnBond from non-lifecycle reverts E18
  it("CB6: returnBond from non-lifecycle reverts E18", async function () {
    await expect(
      bonds.connect(other).returnBond(1n)
    ).to.be.revertedWith("E18");
  });

  // CB7: returnBond on campaign with no bond silently succeeds (no-op)
  it("CB7: returnBond with no bond is a no-op (no revert)", async function () {
    await expect(bonds.connect(lifecycle).returnBond(999n)).to.not.be.reverted;
  });

  // CB8: returnBond queues bond for advertiser pull, clears state (M-1)
  it("CB8: returnBond queues bond for advertiser pull", async function () {
    const pendingBefore = await bonds.pendingBondReturn(advertiser2.address);
    // Return bond for campaign 2 (advertiser2, BOND * 2n)
    await bonds.connect(lifecycle).returnBond(2n);

    // M-1: bond is queued, not pushed
    const pendingAfter = await bonds.pendingBondReturn(advertiser2.address);
    expect(pendingAfter - pendingBefore).to.equal(BOND * 2n);
    expect(await bonds.bond(2n)).to.equal(0n);
    expect(await bonds.totalBonds(publisher.address)).to.equal(BOND); // only campaign 1 remains

    // Advertiser pulls the bond
    const balBefore = await ethers.provider.getBalance(advertiser2.address);
    const tx = await bonds.connect(advertiser2).claimBondReturn();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(advertiser2.address);
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    expect(balAfter - balBefore + gasUsed).to.equal(BOND * 2n);
  });

  // CB9: returnBond emits BondReturned
  it("CB9: returnBond emits BondReturned — re-lock and return new bond", async function () {
    // Lock a fresh bond for campaign 10
    await bonds.connect(campaigns).lockBond(10, advertiser.address, publisher.address, { value: BOND });
    await expect(bonds.connect(lifecycle).returnBond(10n))
      .to.emit(bonds, "BondReturned")
      .withArgs(10n, advertiser.address, BOND);
  });

  // ── addToPool() ───────────────────────────────────────────────────────────────

  // CB10: addToPool from non-governance reverts E18
  it("CB10: addToPool from non-governance reverts E18", async function () {
    await expect(
      bonds.connect(other).addToPool(publisher.address, { value: 1_000_000_000n })
    ).to.be.revertedWith("E18");
  });

  // CB11: addToPool with zero value reverts E11
  it("CB11: addToPool with zero value reverts E11", async function () {
    await expect(
      bonds.connect(governance).addToPool(publisher.address, { value: 0n })
    ).to.be.revertedWith("E11");
  });

  // CB12: addToPool accumulates bonus pool and emits BonusAdded
  it("CB12: addToPool accumulates pool", async function () {
    const poolBefore = await bonds.bonusPool(publisher.address);
    const bonus = 1_000_000_000n;
    await expect(bonds.connect(governance).addToPool(publisher.address, { value: bonus }))
      .to.emit(bonds, "BonusAdded")
      .withArgs(publisher.address, bonus, poolBefore + bonus);
    expect(await bonds.bonusPool(publisher.address)).to.equal(poolBefore + bonus);
  });

  // ── claimBonus() ──────────────────────────────────────────────────────────────

  // CB13: claimBonus on campaign with no bond reverts E01
  it("CB13: claimBonus with no bond reverts E01", async function () {
    await expect(bonds.connect(advertiser2).claimBonus(2n)).to.be.revertedWith("E01");
  });

  // CB14: claimBonus from wrong advertiser reverts E18
  it("CB14: claimBonus from wrong advertiser reverts E18", async function () {
    await expect(bonds.connect(other).claimBonus(1n)).to.be.revertedWith("E18");
  });

  // CB15: claimBonus with empty pool reverts E03
  it("CB15: claimBonus with no pool reverts E03", async function () {
    // Lock a fresh campaign with publisher2 who has no pool
    const [, , , , , , , pub2] = await ethers.getSigners();
    await bonds
      .connect(campaigns)
      .lockBond(20, advertiser.address, pub2.address, { value: BOND });
    await expect(bonds.connect(advertiser).claimBonus(20n)).to.be.revertedWith("E03");
  });

  // CB16: claimBonus distributes proportional share; bond is burned
  it("CB16: claimBonus distributes proportional share", async function () {
    // Campaign 1: advertiser has BOND staked against publisher
    // Pool was added in CB12 (bonus = 1 DOT)
    const total = await bonds.totalBonds(publisher.address);
    const pool  = await bonds.bonusPool(publisher.address);
    const bond1 = await bonds.bond(1n);

    const expectedShare = (bond1 * pool) / total;

    const balBefore = await ethers.provider.getBalance(advertiser.address);
    const tx = await bonds.connect(advertiser).claimBonus(1n);
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
    const balAfter = await ethers.provider.getBalance(advertiser.address);

    expect(balAfter + gasUsed).to.be.closeTo(balBefore + expectedShare, 1_000_000n);

    // Bond must be burned (cleared)
    expect(await bonds.bond(1n)).to.equal(0n);
    expect(await bonds.bonusClaimed(1n)).to.equal(true);
  });

  // CB17: claimBonus emits BonusClaimed
  it("CB17: claimBonus emits BonusClaimed", async function () {
    // Add more pool and lock campaign 30
    await bonds.connect(governance).addToPool(publisher.address, { value: 2_000_000_000n });
    await bonds
      .connect(campaigns)
      .lockBond(30, advertiser2.address, publisher.address, { value: BOND });

    const total = await bonds.totalBonds(publisher.address);
    const pool  = await bonds.bonusPool(publisher.address);
    const bond30 = await bonds.bond(30n);
    const share = (bond30 * pool) / total;

    await expect(bonds.connect(advertiser2).claimBonus(30n))
      .to.emit(bonds, "BonusClaimed")
      .withArgs(30n, advertiser2.address, share);
  });

  // CB18: claimBonus twice reverts E72
  it("CB18: double claimBonus reverts E72", async function () {
    await expect(bonds.connect(advertiser).claimBonus(1n)).to.be.revertedWith("E72");
  });

  // ── ownership ─────────────────────────────────────────────────────────────────

  // CB19: transferOwnership requires acceptance
  it("CB19: two-step ownership transfer", async function () {
    await bonds.connect(owner).transferOwnership(other.address);
    expect(await bonds.pendingOwner()).to.equal(other.address);
    await bonds.connect(other).acceptOwnership();
    expect(await bonds.owner()).to.equal(other.address);
    // Transfer back
    await bonds.connect(other).transferOwnership(owner.address);
    await bonds.connect(owner).acceptOwnership();
  });

  // CB20: setCampaignsContract from non-owner reverts E18
  it("CB20: admin setters gated to owner", async function () {
    await expect(
      bonds.connect(other).setCampaignsContract(campaigns.address)
    ).to.be.revertedWith("E18");
  });
});
