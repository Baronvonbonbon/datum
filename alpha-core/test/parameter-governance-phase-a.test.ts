// Phase-A parameter-governance tests for DatumCampaigns and
// DatumCampaignLifecycle.
//
// Validates:
//   - Constructor still accepts the legacy (initialValue, ...) shape.
//   - Owner can retune each new parameter; PG can retune; everyone else
//     reverts E18.
//   - MIN / MAX bounds revert with "out-of-bounds" on both ends.
//   - setParameterGovernance is lock-once (second call reverts).
//   - lockX() reverts pre-OpenGov and reverts again post-lock.
//   - lockX() works under Phase-2 OpenGov and permanently freezes the
//     parameter (subsequent setX() calls revert "locked").
//
// The lock semantics are the cypherpunk end-state: setters are useful
// during alpha/beta; after OpenGov fires lockX() each parameter
// becomes effectively immutable again.

import { expect } from "chai";
import { ethers } from "hardhat";
import { parseDOT } from "./helpers/dot";
import { wireOpenGovRouter } from "./helpers/openGovRouter";

const PENDING_TIMEOUT_INIT = 1000n;   // inside [100, 5_256_000]
const INACTIVITY_TIMEOUT_INIT = 432_000n; // inside [14_400, 5_256_000]

const CPM_FLOOR_MIN = 1n;
const CPM_FLOOR_MAX = 10n * 10n ** 18n; // 10 PAS/1000 imps (18-dec wei; matches contract)
const PENDING_MIN   = 100n;
const PENDING_MAX   = 5_256_000n;
const INACT_MIN     = 14_400n;
const INACT_MAX     = 5_256_000n;

async function deployCampaigns(initialFloor: bigint = parseDOT("0.001")) {
  const [owner, , , pauseRegSigner] = await ethers.getSigners();
  // Standalone fixture — only needs PauseRegistry + Publishers wired.
  const [, g0, g1, g2] = await ethers.getSigners();
  const pauseReg = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
    g0.address, g1.address, g2.address,
  );
  const publishers = await (await ethers.getContractFactory("DatumPublishers")).deploy(
    20n, await pauseReg.getAddress(),
  );
  const campaigns = await (await ethers.getContractFactory("DatumCampaigns")).deploy(
    initialFloor,
    PENDING_TIMEOUT_INIT,
    await publishers.getAddress(),
    await pauseReg.getAddress(),
  );
  return campaigns;
}

async function deployLifecycle() {
  const [owner] = await ethers.getSigners();
  const [, g0, g1, g2] = await ethers.getSigners();
  const pauseReg = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(
    g0.address, g1.address, g2.address,
  );
  const lifecycle = await (await ethers.getContractFactory("DatumCampaignLifecycle")).deploy(
    await pauseReg.getAddress(),
    INACTIVITY_TIMEOUT_INIT,
  );
  return lifecycle;
}

describe("Phase A — DatumCampaigns parameter governance", () => {
  describe("setMinimumCpmFloor", () => {
    it("owner can retune within bounds", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      const newFloor = parseDOT("0.05");
      await expect(c.connect(owner).setMinimumCpmFloor(newFloor))
        .to.emit(c, "MinimumCpmFloorSet")
        .withArgs(parseDOT("0.001"), newFloor);
      expect(await c.minimumCpmFloor()).to.equal(newFloor);
    });

    it("ParameterGovernance can retune", async () => {
      const c = await deployCampaigns();
      const [owner, , pgSigner] = await ethers.getSigners();
      await c.connect(owner).setParameterGovernance(pgSigner.address);
      const v = parseDOT("0.02");
      await c.connect(pgSigner).setMinimumCpmFloor(v);
      expect(await c.minimumCpmFloor()).to.equal(v);
    });

    it("non-owner / non-PG reverts E18", async () => {
      const c = await deployCampaigns();
      const [, attacker] = await ethers.getSigners();
      await expect(c.connect(attacker).setMinimumCpmFloor(parseDOT("0.01")))
        .to.be.revertedWithCustomError(c, "E18");
    });

    it("reverts when below MIN bound", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await expect(c.connect(owner).setMinimumCpmFloor(0))
        .to.be.revertedWith("out-of-bounds");
    });

    it("reverts when above MAX bound", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await expect(c.connect(owner).setMinimumCpmFloor(CPM_FLOOR_MAX + 1n))
        .to.be.revertedWith("out-of-bounds");
    });

    it("accepts exact MIN and MAX values", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await c.connect(owner).setMinimumCpmFloor(CPM_FLOOR_MIN);
      expect(await c.minimumCpmFloor()).to.equal(CPM_FLOOR_MIN);
      await c.connect(owner).setMinimumCpmFloor(CPM_FLOOR_MAX);
      expect(await c.minimumCpmFloor()).to.equal(CPM_FLOOR_MAX);
    });

    it("reverts after lock", async () => {
      const c = await deployCampaigns(parseDOT("0.01"));
      const [owner] = await ethers.getSigners();
      await wireOpenGovRouter(c);
      await c.lockMinimumCpmFloor();
      await expect(c.connect(owner).setMinimumCpmFloor(parseDOT("0.02")))
        .to.be.revertedWith("locked");
    });
  });

  describe("setPendingTimeoutBlocks", () => {
    it("owner can retune within bounds", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await c.connect(owner).setPendingTimeoutBlocks(2000n);
      expect(await c.pendingTimeoutBlocks()).to.equal(2000n);
    });

    it("reverts below MIN", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await expect(c.connect(owner).setPendingTimeoutBlocks(PENDING_MIN - 1n))
        .to.be.revertedWith("out-of-bounds");
    });

    it("reverts above MAX", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await expect(c.connect(owner).setPendingTimeoutBlocks(PENDING_MAX + 1n))
        .to.be.revertedWith("out-of-bounds");
    });

    it("accepts MIN and MAX", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await c.connect(owner).setPendingTimeoutBlocks(PENDING_MIN);
      expect(await c.pendingTimeoutBlocks()).to.equal(PENDING_MIN);
      await c.connect(owner).setPendingTimeoutBlocks(PENDING_MAX);
      expect(await c.pendingTimeoutBlocks()).to.equal(PENDING_MAX);
    });

    it("non-owner / non-PG reverts E18", async () => {
      const c = await deployCampaigns();
      const [, attacker] = await ethers.getSigners();
      await expect(c.connect(attacker).setPendingTimeoutBlocks(2000n))
        .to.be.revertedWithCustomError(c, "E18");
    });
  });

  describe("setParameterGovernance", () => {
    it("is re-pointable until lockPlumbing@OpenGov (phase-conditional)", async () => {
      const c = await deployCampaigns();
      const [owner, , pgA, pgB] = await ethers.getSigners();
      await c.connect(owner).setParameterGovernance(pgA.address);
      await c.connect(owner).setParameterGovernance(pgB.address); // re-pointable while unlocked
      expect(await c.parameterGovernance()).to.equal(pgB.address);
    });

    it("rejects zero address", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await expect(c.connect(owner).setParameterGovernance(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(c, "E00");
    });

    it("only owner may set", async () => {
      const c = await deployCampaigns();
      const [, attacker] = await ethers.getSigners();
      await expect(c.connect(attacker).setParameterGovernance(attacker.address))
        .to.be.reverted;
    });
  });

  describe("lock-once semantics", () => {
    it("lockMinimumCpmFloor reverts pre-OpenGov (no router)", async () => {
      const c = await deployCampaigns(parseDOT("0.01"));
      await expect(c.lockMinimumCpmFloor()).to.be.revertedWith("router-unset");
    });

    it("lockMinimumCpmFloor reverts under Phase 0/1", async () => {
      const c = await deployCampaigns(parseDOT("0.01"));
      const router = await wireOpenGovRouter(c);
      await router.setPhase(0);
      await expect(c.lockMinimumCpmFloor()).to.be.revertedWith("not-opengov");
      await router.setPhase(1);
      await expect(c.lockMinimumCpmFloor()).to.be.revertedWith("not-opengov");
    });

    it("refuses to lock CPM floor at zero", async () => {
      const c = await deployCampaigns(0n);
      await wireOpenGovRouter(c);
      await expect(c.lockMinimumCpmFloor()).to.be.revertedWith("refuse-lock-zero");
    });

    it("locks under Phase 2 + double-lock reverts", async () => {
      const c = await deployCampaigns(parseDOT("0.05"));
      await wireOpenGovRouter(c);
      await expect(c.lockMinimumCpmFloor())
        .to.emit(c, "MinimumCpmFloorLocked")
        .withArgs(parseDOT("0.05"));
      await expect(c.lockMinimumCpmFloor()).to.be.revertedWith("already locked");
    });

    it("lockPendingTimeoutBlocks freezes the value", async () => {
      const c = await deployCampaigns();
      const [owner] = await ethers.getSigners();
      await wireOpenGovRouter(c);
      await c.lockPendingTimeoutBlocks();
      await expect(c.connect(owner).setPendingTimeoutBlocks(2000n))
        .to.be.revertedWith("locked");
    });
  });
});

describe("Phase A — DatumCampaignLifecycle parameter governance", () => {
  describe("setInactivityTimeoutBlocks", () => {
    it("owner can retune within bounds", async () => {
      const lc = await deployLifecycle();
      const [owner] = await ethers.getSigners();
      await expect(lc.connect(owner).setInactivityTimeoutBlocks(INACT_MIN * 2n))
        .to.emit(lc, "InactivityTimeoutBlocksSet")
        .withArgs(INACTIVITY_TIMEOUT_INIT, INACT_MIN * 2n);
    });

    it("PG can retune", async () => {
      const lc = await deployLifecycle();
      const [owner, , pgSigner] = await ethers.getSigners();
      await lc.connect(owner).setParameterGovernance(pgSigner.address);
      await lc.connect(pgSigner).setInactivityTimeoutBlocks(INACT_MIN * 3n);
      expect(await lc.inactivityTimeoutBlocks()).to.equal(INACT_MIN * 3n);
    });

    it("non-owner / non-PG reverts E18", async () => {
      const lc = await deployLifecycle();
      const [, attacker] = await ethers.getSigners();
      await expect(lc.connect(attacker).setInactivityTimeoutBlocks(INACT_MIN * 2n))
        .to.be.revertedWith("E18");
    });

    it("reverts below MIN (1 day floor — anti-abuse)", async () => {
      const lc = await deployLifecycle();
      const [owner] = await ethers.getSigners();
      await expect(lc.connect(owner).setInactivityTimeoutBlocks(INACT_MIN - 1n))
        .to.be.revertedWith("out-of-bounds");
    });

    it("reverts above MAX (1 year ceiling)", async () => {
      const lc = await deployLifecycle();
      const [owner] = await ethers.getSigners();
      await expect(lc.connect(owner).setInactivityTimeoutBlocks(INACT_MAX + 1n))
        .to.be.revertedWith("out-of-bounds");
    });

    it("accepts exact MIN and MAX", async () => {
      const lc = await deployLifecycle();
      const [owner] = await ethers.getSigners();
      await lc.connect(owner).setInactivityTimeoutBlocks(INACT_MIN);
      expect(await lc.inactivityTimeoutBlocks()).to.equal(INACT_MIN);
      await lc.connect(owner).setInactivityTimeoutBlocks(INACT_MAX);
      expect(await lc.inactivityTimeoutBlocks()).to.equal(INACT_MAX);
    });
  });

  describe("lock-once semantics", () => {
    it("locks under Phase 2 + double-lock reverts", async () => {
      const lc = await deployLifecycle();
      await wireOpenGovRouter(lc);
      await expect(lc.lockInactivityTimeoutBlocks())
        .to.emit(lc, "InactivityTimeoutBlocksLocked")
        .withArgs(INACTIVITY_TIMEOUT_INIT);
      await expect(lc.lockInactivityTimeoutBlocks()).to.be.revertedWith("already locked");
    });

    it("post-lock setter reverts", async () => {
      const lc = await deployLifecycle();
      const [owner] = await ethers.getSigners();
      await wireOpenGovRouter(lc);
      await lc.lockInactivityTimeoutBlocks();
      await expect(lc.connect(owner).setInactivityTimeoutBlocks(INACT_MIN * 2n))
        .to.be.revertedWith("locked");
    });

    it("lock pre-OpenGov reverts", async () => {
      const lc = await deployLifecycle();
      await expect(lc.lockInactivityTimeoutBlocks()).to.be.revertedWith("router-unset");
    });
  });
});
