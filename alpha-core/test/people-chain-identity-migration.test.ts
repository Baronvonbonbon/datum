import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Upgrade migration for the per-user identity cache: freeze v1 → v2.migrate(v1)
// copies every cached IdentityRecord + the default-validity config.
describe("DatumPeopleChainIdentity — upgrade migration", function () {
  let v1: any, v2: any, router: any;
  let owner: HardhatEthersSigner, gov: HardhatEthersSigner, reporter: HardhatEthersSigner, u1: HardhatEthersSigner, u2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, gov, reporter, u1, u2] = await ethers.getSigners();
    router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
    await router.setGovernor(gov.address);

    v1 = await (await ethers.getContractFactory("DatumPeopleChainIdentity")).deploy();
    await v1.setRouter(await router.getAddress());
    await v1.setOracleReporter(reporter.address);
    await v1.connect(reporter).submitAttestation(u1.address, 2, 1000);
    await v1.connect(reporter).submitAttestation(u2.address, 1, 5000);

    v2 = await (await ethers.getContractFactory("MockPeopleChainIdentityV2")).deploy();
    await v2.setRouter(await router.getAddress());
  });

  it("copies cached identity records + config", async function () {
    await v1.connect(gov).freeze();
    await v2.connect(gov).migrate(await v1.getAddress());

    const r1 = await v2.getIdentity(u1.address);
    expect(r1.level).to.equal(2);
    expect(r1.expiryBlock).to.be.greaterThan(0n);
    const r2 = await v2.getIdentity(u2.address);
    expect(r2.level).to.equal(1);
    expect(await v2.identityUserCount()).to.equal(2n);
    // an unknown user is empty
    expect((await v2.getIdentity(owner.address)).level).to.equal(0);
  });
});
