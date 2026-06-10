import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Predecessor-chain migration for the unbounded append-only replay set:
// the successor does NOT copy nullifiers; it consults the frozen predecessor
// on a local miss, so replay protection survives the upgrade at O(1) cost.
describe("DatumNullifierRegistry — predecessor-chain migration", function () {
  let v1: any, v2: any, router: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, settle: HardhatEthersSigner;
  const CID = 7n;
  const NULL_A = "0x" + "aa".repeat(32);
  const NULL_B = "0x" + "bb".repeat(32);

  beforeEach(async function () {
    [owner, gov, settle] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);

    v1 = await (await ethers.getContractFactory("DatumNullifierRegistry")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setSettlement(settle.address);
    await v1.setNullifierWindowBlocks(100);
    // burn nullifier A on v1
    expect(await v1.connect(settle).tryConsume.staticCall(CID, NULL_A)).to.equal(true);
    await v1.connect(settle).tryConsume(CID, NULL_A);

    v2 = await (await ethers.getContractFactory("MockNullifierRegistryV2")).deploy();
    await v2.setRouter(await router.getAddress());
    await v2.setSettlement(settle.address);
  });

  it("migrate chains to the frozen predecessor; replay survives the upgrade", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());

    // config scalar copied
    expect(await v2.nullifierWindowBlocks()).to.equal(100n);
    // A is seen as used on v2 via the predecessor (NOT copied)
    expect(await v2.isNullifierUsed(CID, NULL_A)).to.equal(true);
    // a replay of A through v2 is rejected (tryConsume returns false)
    expect(await v2.connect(settle).tryConsume.staticCall(CID, NULL_A)).to.equal(false);
    // a fresh nullifier B still consumes on v2
    expect(await v2.connect(settle).tryConsume.staticCall(CID, NULL_B)).to.equal(true);
    await v2.connect(settle).tryConsume(CID, NULL_B);
    expect(await v2.isNullifierUsed(CID, NULL_B)).to.equal(true);
  });

  it("a nullifier unused anywhere is reported unused", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());
    expect(await v2.isNullifierUsed(CID, NULL_B)).to.equal(false);
    expect(await v2.isNullifierUsed(99n, NULL_A)).to.equal(false); // different campaign
  });
});
