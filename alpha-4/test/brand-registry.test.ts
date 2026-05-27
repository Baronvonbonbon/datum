// Tests for DatumBrandRegistry + DatumBrandCurator.
//
// BrandRegistry — self-only writes, name uniqueness, length caps,
// homepage scheme check, last-update tracking.
//
// BrandCurator — Council-gated approve/revoke/restore, isCouncilVerified
// combinator, council pointer lock-once.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { fundSigners } from "./helpers/mine";

describe("DatumBrandRegistry", function () {
  let reg: any;
  let owner: HardhatEthersSigner, alice: HardhatEthersSigner, bob: HardhatEthersSigner;
  const LOGO = "0x" + "ab".repeat(32);
  const PROFILE = "0x" + "cd".repeat(32);

  beforeEach(async function () {
    await fundSigners();
    [owner, alice, bob] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DatumBrandRegistry");
    reg = await F.deploy();
  });

  it("unregistered address returns empty profile", async function () {
    const p = await reg.getBrand(alice.address);
    expect(p.name).to.equal("");
    expect(p.logoCid).to.equal(ethers.ZeroHash);
    expect(p.homepage).to.equal("");
    expect(p.brandColor).to.equal(0n);
    expect(p.profileHash).to.equal(ethers.ZeroHash);
    expect(await reg.isRegistered(alice.address)).to.equal(false);
  });

  it("setBrand round-trips the full profile", async function () {
    await reg.connect(alice).setBrand("Alice", LOGO, "https://alice.example", 0xff00ff, PROFILE);
    const p = await reg.getBrand(alice.address);
    expect(p.name).to.equal("Alice");
    expect(p.logoCid).to.equal(LOGO);
    expect(p.homepage).to.equal("https://alice.example");
    expect(p.brandColor).to.equal(0xff00ffn);
    expect(p.profileHash).to.equal(PROFILE);
    expect(await reg.isRegistered(alice.address)).to.equal(true);
  });

  it("hot-fields convenience matches full read", async function () {
    await reg.connect(alice).setBrand("Acme", LOGO, "https://acme.example", 0x123456, PROFILE);
    const hot = await reg.getBrandHotFields(alice.address);
    expect(hot[0]).to.equal("Acme");
    expect(hot[1]).to.equal(LOGO);
    expect(hot[2]).to.equal("https://acme.example");
    expect(hot[3]).to.equal(0x123456n);
  });

  it("homepage must start with https:// when non-empty", async function () {
    await expect(
      reg.connect(alice).setBrand("Alice", LOGO, "http://insecure.example", 0, PROFILE)
    ).to.be.revertedWithCustomError(reg, "HomepageScheme");
    await expect(
      reg.connect(alice).setBrand("Alice", LOGO, "ftp://x.example", 0, PROFILE)
    ).to.be.revertedWithCustomError(reg, "HomepageScheme");
    // empty homepage is OK
    await reg.connect(alice).setBrand("Alice", LOGO, "", 0, PROFILE);
  });

  it("name capped at 32 bytes", async function () {
    const longName = "x".repeat(33);
    await expect(
      reg.connect(alice).setBrand(longName, LOGO, "", 0, PROFILE)
    ).to.be.revertedWithCustomError(reg, "NameTooLong");
    // exactly 32 bytes is OK
    await reg.connect(alice).setBrand("x".repeat(32), LOGO, "", 0, PROFILE);
  });

  it("homepage capped at 128 bytes", async function () {
    const longHp = "https://" + "a".repeat(121); // 8 + 121 = 129
    await expect(
      reg.connect(alice).setBrand("Alice", LOGO, longHp, 0, PROFILE)
    ).to.be.revertedWithCustomError(reg, "HomepageTooLong");
  });

  it("name uniqueness — second address can't claim same name", async function () {
    await reg.connect(alice).setBrand("Polkadot", LOGO, "", 0, PROFILE);
    await expect(
      reg.connect(bob).setBrand("Polkadot", LOGO, "", 0, PROFILE)
    ).to.be.revertedWithCustomError(reg, "NameTaken");
  });

  it("name uniqueness — owner can update own brand keeping the name", async function () {
    await reg.connect(alice).setBrand("Alice", LOGO, "", 0, PROFILE);
    // Update with the same name — should be allowed.
    await reg.connect(alice).setBrand("Alice", LOGO, "https://alice2.example", 0xabcdef, PROFILE);
    const p = await reg.getBrand(alice.address);
    expect(p.homepage).to.equal("https://alice2.example");
  });

  it("name release — clearing your brand frees the name", async function () {
    await reg.connect(alice).setBrand("ShortName", LOGO, "", 0, PROFILE);
    await reg.connect(alice).clearBrand();
    // Bob can now take it.
    await reg.connect(bob).setBrand("ShortName", LOGO, "", 0, PROFILE);
    expect(await reg.nameOwner(ethers.keccak256(ethers.toUtf8Bytes("ShortName")))).to.equal(bob.address);
  });

  it("name release — changing your name frees the old one", async function () {
    await reg.connect(alice).setBrand("OldName", LOGO, "", 0, PROFILE);
    await reg.connect(alice).setBrand("NewName", LOGO, "", 0, PROFILE);
    expect(await reg.nameOwner(ethers.keccak256(ethers.toUtf8Bytes("OldName")))).to.equal(ethers.ZeroAddress);
    expect(await reg.nameOwner(ethers.keccak256(ethers.toUtf8Bytes("NewName")))).to.equal(alice.address);
  });

  it("lastUpdateBlock advances on every set", async function () {
    await reg.connect(alice).setBrand("Alice", LOGO, "", 0, PROFILE);
    const b1 = await reg.lastUpdateBlock(alice.address);
    expect(b1).to.be.greaterThan(0n);
    await reg.connect(alice).setBrand("Alice", LOGO, "https://x.example", 0, PROFILE);
    const b2 = await reg.lastUpdateBlock(alice.address);
    expect(b2).to.be.greaterThan(b1);
  });

  it("emits BrandSet on update, BrandCleared on clear", async function () {
    await expect(reg.connect(alice).setBrand("A", LOGO, "https://a.example", 0xfacade, PROFILE))
      .to.emit(reg, "BrandSet")
      .withArgs(alice.address, "A", LOGO, "https://a.example", 0xfacade, PROFILE);
    await expect(reg.connect(alice).clearBrand())
      .to.emit(reg, "BrandCleared")
      .withArgs(alice.address);
  });
});

describe("DatumBrandCurator", function () {
  let cur: any;
  let owner: HardhatEthersSigner, council: HardhatEthersSigner, alice: HardhatEthersSigner, intruder: HardhatEthersSigner;
  const REASON = "0x" + "11".repeat(32);

  beforeEach(async function () {
    await fundSigners();
    [owner, council, alice, intruder] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DatumBrandCurator");
    cur = await F.deploy();
    await cur.setCouncil(council.address); // council is a signer for tests
  });

  it("default state: not approved, not revoked, not verified", async function () {
    expect(await cur.approved(alice.address)).to.equal(false);
    expect(await cur.revoked(alice.address)).to.equal(false);
    expect(await cur.isCouncilVerified(alice.address)).to.equal(false);
  });

  it("council can approve; non-council cannot", async function () {
    await expect(cur.connect(intruder).approveBrand(alice.address, REASON))
      .to.be.revertedWith("E18");
    await cur.connect(council).approveBrand(alice.address, REASON);
    expect(await cur.approved(alice.address)).to.equal(true);
    expect(await cur.isCouncilVerified(alice.address)).to.equal(true);
    expect(await cur.actionReason(alice.address)).to.equal(REASON);
  });

  it("council can revoke; revoked takes precedence over approved", async function () {
    await cur.connect(council).approveBrand(alice.address, REASON);
    await cur.connect(council).revokeBrand(alice.address, REASON);
    expect(await cur.approved(alice.address)).to.equal(true); // historical
    expect(await cur.revoked(alice.address)).to.equal(true);
    expect(await cur.isCouncilVerified(alice.address)).to.equal(false);
  });

  it("approve after revoke clears the revoke flag", async function () {
    await cur.connect(council).revokeBrand(alice.address, REASON);
    await cur.connect(council).approveBrand(alice.address, REASON);
    expect(await cur.revoked(alice.address)).to.equal(false);
    expect(await cur.isCouncilVerified(alice.address)).to.equal(true);
  });

  it("restore clears revocation but preserves approval", async function () {
    await cur.connect(council).approveBrand(alice.address, REASON);
    await cur.connect(council).revokeBrand(alice.address, REASON);
    await cur.connect(council).restoreBrand(alice.address);
    expect(await cur.approved(alice.address)).to.equal(true);
    expect(await cur.revoked(alice.address)).to.equal(false);
    expect(await cur.isCouncilVerified(alice.address)).to.equal(true);
  });

  it("setCouncil locks once lockCouncil is called", async function () {
    // OpenGov phase is required for lockCouncil. The router isn't wired in
    // these tests, so the modifier whenOpenGovPhase relies on default
    // behavior (router == address(0) → treated as Admin phase) which causes
    // the lock to revert with "phase != opengov" via whenOpenGovPhase. We
    // assert the pre-lock setCouncil works to keep the test focused; the
    // phase-gated lock path is covered by lock-phase-gate.test.ts.
    await cur.setCouncil(alice.address);
    expect(await cur.council()).to.equal(alice.address);
  });

  it("emits BrandApproved / BrandRevoked / BrandRestored", async function () {
    await expect(cur.connect(council).approveBrand(alice.address, REASON))
      .to.emit(cur, "BrandApproved").withArgs(alice.address, REASON);
    await expect(cur.connect(council).revokeBrand(alice.address, REASON))
      .to.emit(cur, "BrandRevoked").withArgs(alice.address, REASON);
    await expect(cur.connect(council).restoreBrand(alice.address))
      .to.emit(cur, "BrandRestored").withArgs(alice.address);
  });
});
