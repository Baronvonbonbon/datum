// People Chain identity gate (2026-05-16).
//
// Covers:
//   ID1 — DatumPeopleChainIdentity unit: writer auth, expiry, batch, forgetMe.
//   ID2 — Settlement gate: campaign-side flag rejects unverified user (code 30).
//   ID3 — Settlement gate: user-side floor rejects when campaign is permissive.
//   ID4 — Settlement gate: verified user at >= effective level settles cleanly.
//   ID5 — Settlement gate: expired attestation rejects.
//   ID6 — Settlement gate: gate disabled (both floors 0) is a no-op.
//   ID7 — Settlement gate: registry unwired but gate active fails CLOSED.
//   ID8 — Campaign-side raise locks at Pending (lower allowed any time).

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumBudgetLedger,
  DatumPaymentVault,
  DatumSettlement,
  DatumClaimValidator,
  DatumPauseRegistry,
  DatumPeopleChainIdentity,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, mineBlocks } from "./helpers/mine";
import { ethersKeccakAbi } from "./helpers/hash";

describe("People Chain identity gate", function () {
  // ── ID1: registry unit tests ─────────────────────────────────────────────
  describe("DatumPeopleChainIdentity (ID1)", function () {
    let reg: DatumPeopleChainIdentity;
    let owner: HardhatEthersSigner;
    let oracle: HardhatEthersSigner;
    let user: HardhatEthersSigner;
    let other: HardhatEthersSigner;

    beforeEach(async function () {
      await fundSigners();
      [owner, oracle, user, other] = await ethers.getSigners();
      const F = await ethers.getContractFactory("DatumPeopleChainIdentity");
      reg = await F.deploy();
      await reg.connect(owner).setOracleReporter(oracle.address);
    });

    it("non-writer cannot submit attestation (E18)", async function () {
      await expect(reg.connect(other).submitAttestation(user.address, 2, 0))
        .to.be.revertedWith("E18");
    });

    it("oracle reporter writes & isVerified honors minLevel", async function () {
      await expect(reg.connect(oracle).submitAttestation(user.address, 1, 1000))
        .to.emit(reg, "IdentityAttested")
        .withArgs(user.address, 1, anyValue(), oracle.address);
      expect(await reg.isVerified(user.address, 0)).to.equal(true);  // 0 always passes
      expect(await reg.isVerified(user.address, 1)).to.equal(true);
      expect(await reg.isVerified(user.address, 2)).to.equal(false); // higher tier
    });

    it("attestation expires after validityBlocks", async function () {
      await reg.connect(oracle).submitAttestation(user.address, 2, 600);
      expect(await reg.isVerified(user.address, 2)).to.equal(true);
      await mineBlocks(601);
      expect(await reg.isVerified(user.address, 2)).to.equal(false);
      const rec = await reg.getIdentity(user.address);
      expect(rec.level).to.equal(0); // getter zeros stale records
    });

    it("forgetMe purges self record", async function () {
      await reg.connect(oracle).submitAttestation(user.address, 2, 1000);
      expect(await reg.isVerified(user.address, 1)).to.equal(true);
      await expect(reg.connect(user).forgetMe())
        .to.emit(reg, "IdentityForgotten").withArgs(user.address);
      expect(await reg.isVerified(user.address, 1)).to.equal(false);
    });

    it("validityBlocks out of bounds reverts", async function () {
      await expect(reg.connect(oracle).submitAttestation(user.address, 1, 1))
        .to.be.revertedWith("E11");
      await expect(reg.connect(oracle).submitAttestation(user.address, 1, 2_000_000))
        .to.be.revertedWith("E11");
    });

    it("submitAttestationBatch updates multiple users", async function () {
      const users = [user.address, other.address];
      const levels = [1, 2];
      const vbs = [1000n, 1000n];
      await reg.connect(oracle).submitAttestationBatch(users, levels, vbs);
      expect(await reg.isVerified(user.address, 1)).to.equal(true);
      expect(await reg.isVerified(other.address, 2)).to.equal(true);
    });

    it("lockOracleReporter is one-way and clears the writer", async function () {
      const { wireOpenGovRouter } = await import("./helpers/openGovRouter");
      await wireOpenGovRouter(reg);
      await reg.connect(owner).lockOracleReporter();
      expect(await reg.oracleReporterLocked()).to.equal(true);
      expect(await reg.oracleReporter()).to.equal(ethers.ZeroAddress);
      await expect(reg.connect(owner).setOracleReporter(oracle.address))
        .to.be.revertedWith("locked");
      // Oracle can no longer write.
      await expect(reg.connect(oracle).submitAttestation(user.address, 1, 1000))
        .to.be.revertedWith("E18");
    });

    it("requestIdentityRefresh is permissionless and emits", async function () {
      await expect(reg.connect(other).requestIdentityRefresh(user.address))
        .to.emit(reg, "IdentityRefreshRequested")
        .withArgs(user.address, other.address);
    });
  });

  // ── Settlement gate fixture (mirrors audit-fixes.test.ts patterns) ───────
  describe("Settlement gate (ID2–ID7)", function () {
    let validator: DatumClaimValidator;
    let settlement: DatumSettlement;
    let pauseReg: DatumPauseRegistry;
    let ledger: DatumBudgetLedger;
    let vault: DatumPaymentVault;
    let mock: MockCampaigns;
    let reg: DatumPeopleChainIdentity;
    let owner: HardhatEthersSigner;
    let user: HardhatEthersSigner;
    let publisher: HardhatEthersSigner;
    let oracle: HardhatEthersSigner;
    let other: HardhatEthersSigner;

    const TAKE = 5000;
    const CPM = parseDOT("0.016");
    const BUDGET = parseDOT("4");
    const DAILY_CAP = parseDOT("2");

    function buildClaim(
      campaignId: bigint,
      pubAddr: string,
      userAddr: string,
      nonce: bigint,
      prevHash: string
    ) {
      const eventCount = 1000n;
      const hash = ethersKeccakAbi(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
        [campaignId, pubAddr, userAddr, eventCount, CPM, 0, ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash]
      );
      return {
        campaignId,
        publisher: pubAddr,
        eventCount,
        ratePlanck: CPM,
        actionType: 0,
        clickSessionHash: ethers.ZeroHash,
        nonce,
        previousClaimHash: prevHash,
        claimHash: hash,
        zkProof: new Array(8).fill(ethers.ZeroHash),
        nullifier: ethers.ZeroHash,
        stakeRootUsed: ethers.ZeroHash,
        actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        powNonce: ethers.ZeroHash,
      };
    }

    let nextCid = 1n;

    async function createCampaign(): Promise<bigint> {
      const id = nextCid++;
      await mock.setCampaign(id, owner.address, publisher.address, CPM, TAKE, 1);
      await mock.initBudget(id, 0, BUDGET, DAILY_CAP, { value: BUDGET });
      return id;
    }

    async function rejectedReasons(tx: Awaited<ReturnType<typeof settlement.settleClaims>>) {
      const receipt = await tx.wait();
      const iface = settlement.interface;
      const out: number[] = [];
      for (const l of receipt!.logs) {
        try {
          const p = iface.parseLog(l);
          if (p?.name === "ClaimRejected") out.push(Number(p.args.reasonCode));
        } catch {}
      }
      return out;
    }

    before(async function () {
      await fundSigners();
      [owner, user, publisher, oracle, other] = await ethers.getSigners();

      const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
      pauseReg = await PauseFactory.deploy(owner.address, user.address, publisher.address);

      mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();
      ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
      vault = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
      validator = await (await ethers.getContractFactory("DatumClaimValidator")).deploy(
        await mock.getAddress(),
        await mock.getAddress(),
        await pauseReg.getAddress()
      );
      settlement = await (await ethers.getContractFactory("DatumSettlement"))
        .deploy(await pauseReg.getAddress());
        await wireSettlementLogic(settlement as any);

      const RelayFactory = await ethers.getContractFactory("DatumRelay");
      const relay = await RelayFactory.deploy(
        await settlement.getAddress(),
        await mock.getAddress(),
        await pauseReg.getAddress()
      );

      await settlement.configure(
        await ledger.getAddress(),
        await vault.getAddress(),
        await mock.getAddress(),
        await relay.getAddress()
      );
      await settlement.setClaimValidator(await validator.getAddress());
      await ledger.setCampaigns(await mock.getAddress());
      await ledger.setSettlement(await settlement.getAddress());
      await ledger.setLifecycle(await mock.getAddress());
      await mock.setBudgetLedger(await ledger.getAddress());
      await vault.setSettlement(await settlement.getAddress());
      await settlement.setPublishers(await mock.getAddress());
      await settlement.setCampaigns(await mock.getAddress());

      // Identity registry, wired into Settlement.
      reg = await (await ethers.getContractFactory("DatumPeopleChainIdentity")).deploy();
      await reg.connect(owner).setOracleReporter(oracle.address);
      await settlement.connect(owner).setIdentityRegistry(await reg.getAddress());
    });

    it("ID2: campaign-side flag rejects unverified user (reason 30)", async function () {
      const cid = await createCampaign();
      await mock.setCampaignMinIdentityLevel(cid, 1);

      const c = buildClaim(cid, publisher.address, user.address, 1n, ethers.ZeroHash);
      const tx = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c] },
      ]);
      expect(await rejectedReasons(tx)).to.deep.equal([30]);
    });

    it("ID3: user-side floor rejects on a permissive campaign", async function () {
      const cid = await createCampaign();
      // campaignMinIdentityLevel left at 0; user demands level 2.
      await settlement.connect(user).setUserMinIdentityLevel(2);

      const c = buildClaim(cid, publisher.address, user.address, 1n, ethers.ZeroHash);
      const tx = await settlement.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c] },
      ]);
      expect(await rejectedReasons(tx)).to.deep.equal([30]);

      // Cleanup user-side floor for subsequent tests.
      await settlement.connect(user).setUserMinIdentityLevel(0);
    });

    it("ID4: verified user at >= effective level settles cleanly", async function () {
      const cid = await createCampaign();
      await mock.setCampaignMinIdentityLevel(cid, 1);
      await reg.connect(oracle).submitAttestation(user.address, 2, 100000); // KnownGood

      const c = buildClaim(cid, publisher.address, user.address, 1n, ethers.ZeroHash);
      const r = await settlement.connect(user).settleClaims.staticCall([
        { user: user.address, campaignId: cid, claims: [c] },
      ]);
      expect(r.settledCount).to.equal(1n);
    });

    it("ID5: expired attestation rejects", async function () {
      const cid = await createCampaign();
      await mock.setCampaignMinIdentityLevel(cid, 1);
      // Fresh user (other) — short-lived attestation.
      await reg.connect(oracle).submitAttestation(other.address, 2, 600);
      // Advance past expiry.
      await mineBlocks(601);

      const c = buildClaim(cid, publisher.address, other.address, 1n, ethers.ZeroHash);
      const tx = await settlement.connect(other).settleClaims([
        { user: other.address, campaignId: cid, claims: [c] },
      ]);
      expect(await rejectedReasons(tx)).to.deep.equal([30]);
    });

    it("ID6: gate disabled is a no-op (no reason 30 emitted)", async function () {
      const signers = await ethers.getSigners();
      const freshUser = signers[7]; // unused by other tests in this block
      const cid = await createCampaign();
      // campaign and user both at level 0 — no gate.
      const c = buildClaim(cid, publisher.address, freshUser.address, 1n, ethers.ZeroHash);
      const r = await settlement.connect(freshUser).settleClaims.staticCall([
        { user: freshUser.address, campaignId: cid, claims: [c] },
      ]);
      expect(r.settledCount).to.equal(1n);
    });

    it("ID7: identity registry unwired but gate active fails CLOSED", async function () {
      // Fresh settlement without identityRegistry set, but gate requested.
      const settle2 = await (await ethers.getContractFactory("DatumSettlement"))
        .deploy(await pauseReg.getAddress());
        await wireSettlementLogic(settle2 as any);

      const RelayFactory = await ethers.getContractFactory("DatumRelay");
      const relay2 = await RelayFactory.deploy(
        await settle2.getAddress(),
        await mock.getAddress(),
        await pauseReg.getAddress()
      );

      const ledger2 = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();
      const vault2 = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
      await settle2.configure(
        await ledger2.getAddress(),
        await vault2.getAddress(),
        await mock.getAddress(),
        await relay2.getAddress()
      );
      await settle2.setClaimValidator(await validator.getAddress());
      await settle2.setCampaigns(await mock.getAddress());
      await ledger2.setCampaigns(await mock.getAddress());
      await ledger2.setSettlement(await settle2.getAddress());
      await ledger2.setLifecycle(await mock.getAddress());
      await vault2.setSettlement(await settle2.getAddress());

      const cid = await createCampaign();
      await mock.setCampaignMinIdentityLevel(cid, 1);

      // Need a fresh ledger budget on the second settlement; budget escrow is on the
      // first ledger. Easier: assert the rejection without budget consumption.
      const c = buildClaim(cid, publisher.address, user.address, 1n, ethers.ZeroHash);
      const tx = await settle2.connect(user).settleClaims([
        { user: user.address, campaignId: cid, claims: [c] },
      ]);
      expect(await rejectedReasons(tx)).to.deep.equal([30]);
    });

    it("ID8: setIdentityRegistry is phase-conditional lock-once (re-pointable until lockPlumbing)", async function () {
      // Cypherpunk posture: the structural identity ref stays governance-
      // re-pointable through Admin/Council, then freezes at OpenGov.
      // 1. Re-pointable while unlocked.
      await expect(settlement.connect(owner).setIdentityRegistry(other.address)).to.not.be.reverted;
      expect(await settlement.identityRegistry()).to.equal(other.address);
      // 2. Wire an OpenGov router and fire the umbrella lock.
      const { wireOpenGovRouter } = await import("./helpers/openGovRouter");
      await wireOpenGovRouter(settlement as any);
      await settlement.connect(owner).lockPlumbing();
      expect(await settlement.plumbingLocked()).to.equal(true);
      // 3. Frozen: any further structural re-point reverts AlreadySet.
      await expect(settlement.connect(owner).setIdentityRegistry(oracle.address))
        .to.be.revertedWithCustomError(settlement, "AlreadySet");
    });
  });
});

// Tiny shim so withArgs can match dynamic expiryBlock.
import { anyValue as anyValueExp } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { wireSettlementLogic } from "./helpers/settlementLogic";
function anyValue() { return anyValueExp; }
