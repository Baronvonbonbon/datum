import { ethers } from "hardhat";
import {
  DatumSettlement,
  DatumRelay,
  DatumPauseRegistry,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumClaimValidator,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
import { fundSigners } from "./helpers/mine";
import { wireSettlementLogic } from "./helpers/settlementLogic";

// A/B gas harness: measures gasUsed for an N-claim single-campaign view batch
// settled via settleClaims. Deterministic — same setup as settlement.test.ts.
// Run on baseline and on each prototype branch; compare the printed table.

describe("GAS-AB: settleClaims view-batch", function () {
  let settlement: DatumSettlement;
  let relay: DatumRelay;
  let mock: MockCampaigns;
  let pauseReg: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("1000");
  const DAILY_CAP = parseDOT("1000");

  let nextCampaignId = 1n;

  function buildClaimChain(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    count: number,
    baseCpm: bigint,
    impressionsPerClaim: bigint
  ) {
    const claims = [];
    let prevHash = ethers.ZeroHash;
    for (let i = 1; i <= count; i++) {
      const nonce = BigInt(i);
      const hash = ethersKeccakAbi(
        ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
        [campaignId, publisherAddr, userAddr, impressionsPerClaim, baseCpm, 0, ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash]
      );
      claims.push({
        campaignId,
        publisher: publisherAddr,
        eventCount: impressionsPerClaim,
        rateWei: baseCpm,
        actionType: 0,
        proof: [],
      });
      prevHash = hash;
    }
    return claims;
  }

  async function createTestCampaign(): Promise<bigint> {
    const id = nextCampaignId++;
    await mock.setCampaign(id, owner.address, publisher.address, BID_CPM, TAKE_RATE_BPS, 1);
    await mock.initBudget(id, 0, BUDGET, DAILY_CAP, { value: BUDGET });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher] = await ethers.getSigners();

    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy(owner.address, user.address, publisher.address);
    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();
    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();
    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();
    const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
    validator = await ValidatorFactory.deploy(
      await mock.getAddress(), await mock.getAddress(), await pauseReg.getAddress()
    );
    const SettlementFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementFactory.deploy(await pauseReg.getAddress());
    await wireSettlementLogic(settlement as any);
    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(
      await settlement.getAddress(), await mock.getAddress(), await pauseReg.getAddress()
    );
    await settlement.configure(
      await ledger.getAddress(), await vault.getAddress(),
      await mock.getAddress(), await relay.getAddress()
    );
    await settlement.setClaimValidator(await validator.getAddress());
    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());
    await mock.setBudgetLedger(await ledger.getAddress());
    await vault.setSettlement(await settlement.getAddress());
    await settlement.setPublishers(await mock.getAddress());
    await settlement.setCampaigns(await mock.getAddress());
  });

  it("measures gas across batch sizes", async function () {
    // Warmup: settle once so persistent singleton slots (vault balances,
    // userTotalSettled, ledger globals) are already non-zero. Keeps the
    // measured rows free of first-touch cold-SSTORE noise so the A/B table
    // is monotonic and the marginal per-claim is clean.
    {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 2, BID_CPM, 100n);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);
    }

    const sizes = [1, 5, 10, 20];
    const rows: string[] = [];
    for (const n of sizes) {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, n, BID_CPM, 100n);
      const batch = { user: user.address, campaignId: cid, claims };
      // sanity: all settle
      const res = await settlement.connect(user).settleClaims.staticCall([batch]);
      if (res.settledCount !== BigInt(n)) {
        throw new Error(`batch n=${n} settled ${res.settledCount}, expected ${n}`);
      }
      const tx = await settlement.connect(user).settleClaims([batch]);
      const rcpt = await tx.wait();
      const gas = rcpt!.gasUsed;
      const perClaim = gas / BigInt(n);
      rows.push(`  N=${String(n).padStart(2)}  total=${gas.toString().padStart(9)}  per-claim=${perClaim.toString().padStart(8)}`);
    }
    console.log("\n=== settleClaims gas (view, single campaign) ===");
    for (const r of rows) console.log(r);
    console.log("");
  });
});
