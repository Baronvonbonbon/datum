import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumCouncilBlocklistCurator, DatumPublishers, DatumPauseRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

// B2: Council-driven IDatumBlocklistCurator implementation.
// Verifies the curator can be wired into DatumPublishers and supersedes/augments
// the legacy `blocked[]` map per the OR-merge logic in publishers.isBlocked.

describe("DatumCouncilBlocklistCurator (B2)", function () {
  let curator: DatumCouncilBlocklistCurator;
  let publishers: DatumPublishers;
  let pauseReg: DatumPauseRegistry;

  let owner: HardhatEthersSigner;
  let councilEOA: HardhatEthersSigner;  // stand-in for DatumCouncil contract
  let target: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const REASON = ethers.keccak256(ethers.toUtf8Bytes("ipfs://QmEvidence"));

  before(async function () {
    await fundSigners();
    [owner, councilEOA, target, other] = await ethers.getSigners();

    pauseReg = await (await ethers.getContractFactory("DatumPauseRegistry"))
      .deploy(owner.address, councilEOA.address, target.address);
    publishers = await (await ethers.getContractFactory("DatumPublishers"))
      .deploy(50n, await pauseReg.getAddress());
    curator = await (await ethers.getContractFactory("DatumCouncilBlocklistCurator")).deploy();

    // Wire: curator's council = the EOA standing in for DatumCouncil
    await curator.connect(owner).setCouncil(councilEOA.address);
    // Wire: publishers' blocklistCurator = curator
    await publishers.connect(owner).setBlocklistCurator(await curator.getAddress());
  });

  it("BC1: only council can block; non-council reverts E18", async function () {
    await expect(curator.connect(other).blockAddr(target.address, REASON)).to.be.revertedWith("E18");
  });

  it("BC2: council blocks → publishers.isBlocked returns true via curator OR-merge", async function () {
    await expect(curator.connect(councilEOA).blockAddr(target.address, REASON))
      .to.emit(curator, "AddrBlocked").withArgs(target.address, REASON);
    expect(await curator.isBlocked(target.address)).to.equal(true);
    expect(await publishers.isBlocked(target.address)).to.equal(true);
    expect(await curator.blockReason(target.address)).to.equal(REASON);
  });

  it("BC3: council unblocks → no longer blocked", async function () {
    await expect(curator.connect(councilEOA).unblockAddr(target.address))
      .to.emit(curator, "AddrUnblocked").withArgs(target.address);
    expect(await curator.isBlocked(target.address)).to.equal(false);
    expect(await publishers.isBlocked(target.address)).to.equal(false);
    expect(await curator.blockReason(target.address)).to.equal(ethers.ZeroHash);
  });

  it("BC4: legacy blocked[] still OR-merges with curator (back-compat)", async function () {
    // Owner-block via legacy map (curator is unrelated)
    await publishers.connect(owner).blockAddress(other.address);
    expect(await publishers.isBlocked(other.address)).to.equal(true);
    // Curator says no — but legacy says yes, so OR-merge still true.
    expect(await curator.isBlocked(other.address)).to.equal(false);
  });

  it("BC5: lockCouncil freezes council pointer permanently", async function () {
    await expect(curator.connect(owner).lockCouncil()).to.emit(curator, "CouncilLocked");
    expect(await curator.councilLocked()).to.equal(true);
    await expect(curator.connect(owner).setCouncil(other.address)).to.be.revertedWith("council-locked");
  });

  it("BC6: lockCouncil twice reverts", async function () {
    await expect(curator.connect(owner).lockCouncil()).to.be.revertedWith("already locked");
  });

  it("BC7: lockCouncil with unset council reverts", async function () {
    const fresh = await (await ethers.getContractFactory("DatumCouncilBlocklistCurator")).deploy();
    await expect(fresh.connect(owner).lockCouncil()).to.be.revertedWith("council unset");
  });
});
