// Full-system "bump everything" dry-run on LIVE PASEO.
//
// Paseo-native port of scripts/bump-all-dryrun.ts: deploys each upgradable
// contract on-chain, loads it with real state + funds, runs the full
// redeploy-migrate-rewire upgrade, and asserts NOTHING IS LOST (native PAS +
// ERC-20 balances conserved to the wei, state carried over) — all against
// pallet-revive's quirks (null receipts -> nonce polling + getCreateAddress,
// weight-unit gas, clean 1e6 denomination).
//
// Single actor: the deployer plays every role (governor / staker / shim);
// param-only roles (advertiser/publisher/relay addresses) use throwaway
// addresses that never need a key. Each contract is isolated in try/catch so a
// single failure doesn't abort the run.
//
//   npx hardhat run scripts/bump-all-paseo.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet, Contract, formatEther } from "ethers";

const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 as const };
const D = (n: string) => ethers.parseEther(n);
const rnd = () => Wallet.createRandom().address;

const UPG = [
  "function setRouter(address)", "function freeze()", "function migrate(address)",
  "function migrateFundsTo(address)", "function version() view returns(uint256)",
  "function frozen() view returns(bool)", "function fundsMigratedOut() view returns(bool)",
];
const TOKEN_ABI = ["function mint(address,uint256)", "function approve(address,uint256)", "function balanceOf(address) view returns(uint256)"];

let p: JsonRpcProvider, gov: Wallet;

async function waitNonce(prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(gov.address)) > prev) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce stuck");
}
async function deploy(name: string, args: any[] = []): Promise<string> {
  const f = await ethers.getContractFactory(name);
  const data = (await f.getDeployTransaction(...args)).data;
  const nonce = await p.getTransactionCount(gov.address);
  const addr = ethers.getCreateAddress({ from: gov.address, nonce });
  await gov.sendTransaction({ data, ...GAS });
  await waitNonce(nonce);
  if ((await p.getCode(addr)).length <= 2) throw new Error(`${name}: no code`);
  return addr;
}
async function tx(to: string, abi: string[], method: string, args: any[] = [], value = 0n) {
  const data = new ethers.Interface(abi).encodeFunctionData(method, args);
  const nonce = await p.getTransactionCount(gov.address);
  await gov.sendTransaction({ to, data, value, ...GAS, nonce });
  await waitNonce(nonce);
}
const ro = (addr: string, abi: string[]) => new Contract(addr, abi, p);

type Entry = {
  name: string; factory: string; v2: string; args: () => any[]; abi: string[];
  fund?: boolean; token?: boolean;
  load: (v1: string, ctx: any) => Promise<void>;
  verify: (v2: string) => Promise<void>;
};

const results: { name: string; ok: boolean; note: string }[] = [];

async function main() {
  const rpc = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  p = new JsonRpcProvider(rpc);
  gov = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, p);
  console.log(`Paseo bump-all | deployer ${gov.address}`);
  const startBal = await p.getBalance(gov.address);
  console.log(`start balance: ${formatEther(startBal)} PAS\n`);

  // shared infra
  console.log("deploying shared infra (router, token, pause)...");
  const router = await deploy("MockOpenGovRouter");
  await tx(router, ["function setGovernor(address)"], "setGovernor", [gov.address]);
  const token = await deploy("MockERC20", ["DATUM", "DATUM"]);
  const pause = await deploy("DatumPauseRegistry", [gov.address, rnd(), rnd()]);
  console.log(`  router=${router}\n  token=${token}\n  pause=${pause}\n`);

  const me = gov.address;
  const entries: Entry[] = [
    { name: "DatumPublisherStake", factory: "DatumPublisherStake", v2: "MockPublisherStakeV2", args: () => [1_000_000n, 1_000n, 10n],
      abi: [...UPG, "function stake() payable", "function staked(address) view returns(uint256)"], fund: true,
      load: async (v1) => { await tx(v1, ["function stake() payable"], "stake", [], D("0.05")); },
      verify: async (v2) => { if ((await ro(v2, ["function staked(address) view returns(uint256)"]).staked(me)) !== D("0.05")) throw new Error("stake lost"); } },

    { name: "DatumAdvertiserStake", factory: "DatumAdvertiserStake", v2: "MockAdvertiserStakeV2", args: () => [1_000_000n, 1_000n, 10n],
      abi: [...UPG, "function stake() payable", "function staked(address) view returns(uint256)"], fund: true,
      load: async (v1) => { await tx(v1, ["function stake() payable"], "stake", [], D("0.05")); },
      verify: async (v2) => { if ((await ro(v2, ["function staked(address) view returns(uint256)"]).staked(me)) !== D("0.05")) throw new Error("stake lost"); } },

    { name: "DatumChallengeBonds", factory: "DatumChallengeBonds", v2: "MockChallengeBondsV2", args: () => [],
      abi: [...UPG, "function setCampaignsContract(address)", "function lockBond(uint256,address,address) payable", "function bondForPublisher(uint256,address) view returns(uint256)"], fund: true,
      load: async (v1) => { await tx(v1, ["function setCampaignsContract(address)"], "setCampaignsContract", [me]);
        await tx(v1, ["function lockBond(uint256,address,address) payable"], "lockBond", [1, rnd(), PUB], D("0.04")); },
      verify: async (v2) => { if ((await ro(v2, ["function bondForPublisher(uint256,address) view returns(uint256)"]).bondForPublisher(1, PUB)) !== D("0.04")) throw new Error("bond lost"); } },

    { name: "DatumActivationBonds", factory: "DatumActivationBonds", v2: "MockActivationBondsV2", args: () => [D("0.01"), 10n, 500, 200, me],
      abi: [...UPG, "function setCampaignsContract(address)", "function openBond(uint256,address) payable"], fund: true,
      load: async (v1) => { await tx(v1, ["function setCampaignsContract(address)"], "setCampaignsContract", [me]);
        await tx(v1, ["function openBond(uint256,address) payable"], "openBond", [1, rnd()], D("0.03")); },
      verify: async () => {} },

    { name: "DatumBudgetLedger", factory: "DatumBudgetLedger", v2: "MockBudgetLedgerV2", args: () => [],
      abi: [...UPG, "function setCampaigns(address)", "function initializeBudget(uint256,uint8,uint256,uint256) payable", "function getRemainingBudget(uint256,uint8) view returns(uint256)"], fund: true,
      load: async (v1) => { await tx(v1, ["function setCampaigns(address)"], "setCampaigns", [me]);
        await tx(v1, ["function initializeBudget(uint256,uint8,uint256,uint256) payable"], "initializeBudget", [1, 0, D("0.06"), D("0.03")], D("0.06")); },
      verify: async (v2) => { if ((await ro(v2, ["function getRemainingBudget(uint256,uint8) view returns(uint256)"]).getRemainingBudget(1, 0)) !== D("0.06")) throw new Error("budget lost"); } },

    { name: "DatumZKStake", factory: "DatumZKStake", v2: "MockZKStakeV2", args: () => [token],
      abi: [...UPG, "function depositWith(bytes32,uint256)", "function staked(address) view returns(uint256)"], token: true,
      load: async (v1) => { await tx(token, TOKEN_ABI, "mint", [me, D("10")]); await tx(token, TOKEN_ABI, "approve", [v1, D("4")]);
        await tx(v1, ["function depositWith(bytes32,uint256)"], "depositWith", [ethers.encodeBytes32String("c"), D("4")]); },
      verify: async (v2) => { if ((await ro(v2, ["function staked(address) view returns(uint256)"]).staked(me)) !== D("4")) throw new Error("zk lost"); } },

    { name: "DatumTagRegistry", factory: "DatumTagRegistry", v2: "MockTagRegistryNext", args: () => [token],
      abi: [...UPG, "function registerTag(bytes32,uint256)", "function tagBond(bytes32) view returns(uint256)"], token: true,
      load: async (v1) => { await tx(token, TOKEN_ABI, "mint", [me, D("50")]); await tx(token, TOKEN_ABI, "approve", [v1, D("20")]);
        await tx(v1, ["function registerTag(bytes32,uint256)"], "registerTag", [TAG, D("20")]); }, // >= minTagBond (10e18)
      verify: async (v2) => { if ((await ro(v2, ["function tagBond(bytes32) view returns(uint256)"]).tagBond(TAG)) !== D("20")) throw new Error("tag lost"); } },

    { name: "DatumRelayStake", factory: "DatumRelayStake", v2: "MockRelayStakeV2", args: () => [1_000_000n, 10n],
      abi: [...UPG, "function stake() payable", "function totalStaked() view returns(uint256)"], fund: true,
      load: async (v1) => { await tx(v1, ["function stake() payable"], "stake", [], D("0.05")); },
      verify: async (v2) => { if ((await ro(v2, ["function totalStaked() view returns(uint256)"]).totalStaked()) !== D("0.05")) throw new Error("relay stake lost"); } },

    { name: "DatumRelayGovernance", factory: "DatumRelayGovernance", v2: "MockRelayGovernanceNext", args: () => [10, 100, 0, 5000, 2000, 1000],
      abi: [...UPG, "function setConvictionLockups(uint256[])", "function propose(address,uint8,bytes32)", "function vote(uint256,bool,uint8) payable", "function getVote(uint256,address) view returns(tuple(uint8 direction,uint8 conviction,uint256 lockAmount,uint256 lockedUntilBlock))"], fund: true,
      load: async (v1) => { await tx(v1, ["function setConvictionLockups(uint256[])"], "setConvictionLockups", [[100n,1n,3n,7n,21n,90n,180n,270n,365n]]);
        await tx(v1, ["function propose(address,uint8,bytes32)"], "propose", [rnd(), 1, "0x" + "ee".repeat(32)]);
        await tx(v1, ["function vote(uint256,bool,uint8) payable"], "vote", [1, true, 1], D("0.1")); },
      verify: async (v2) => { if ((await ro(v2, ["function getVote(uint256,address) view returns(tuple(uint8 direction,uint8 conviction,uint256 lockAmount,uint256 lockedUntilBlock))"]).getVote(1, me)).lockAmount !== D("0.1")) throw new Error("vote/lock lost"); } },

    { name: "DatumPublisherGovernance", factory: "DatumPublisherGovernance", v2: "MockPublisherGovernanceNext", args: () => [pause, pause, pause, 20, 4000, 500, 200, D("2")],
      abi: [...UPG, "function setConvictionLockups(uint256[])", "function quorum() view returns(uint256)"], fund: true,
      load: async (v1) => { await tx(v1, ["function setConvictionLockups(uint256[])"], "setConvictionLockups", [[100n,1n,3n,7n,21n,90n,180n,270n,365n]]);
        const n = await p.getTransactionCount(gov.address); await gov.sendTransaction({ to: v1, value: D("0.05"), ...GAS, nonce: n }); await waitNonce(n); },
      verify: async (v2) => { if ((await ro(v2, ["function quorum() view returns(uint256)"]).quorum()) !== 20n) throw new Error("config lost"); } },

    { name: "DatumAdvertiserGovernance", factory: "DatumAdvertiserGovernance", v2: "MockAdvertiserGovernanceNext", args: () => [15, 3000, 150, D("1"), pause],
      abi: [...UPG, "function setConvictionLockups(uint256[])", "function quorum() view returns(uint256)"],
      load: async (v1) => { await tx(v1, ["function setConvictionLockups(uint256[])"], "setConvictionLockups", [[100n,1n,3n,7n,21n,90n,180n,270n,365n]]); },
      verify: async (v2) => { if ((await ro(v2, ["function quorum() view returns(uint256)"]).quorum()) !== 15n) throw new Error("config lost"); } },

    { name: "DatumNullifierRegistry", factory: "DatumNullifierRegistry", v2: "MockNullifierRegistryV2", args: () => [],
      abi: [...UPG, "function setSettlement(address)", "function tryConsume(uint256,bytes32) returns(bool)"],
      load: async (v1) => { await tx(v1, ["function setSettlement(address)"], "setSettlement", [me]);
        await tx(v1, ["function tryConsume(uint256,bytes32)"], "tryConsume", [1, NUL]); },
      verify: async (v2) => { await tx(v2, ["function setSettlement(address)"], "setSettlement", [me]);
        const used = !(await ro(v2, ["function tryConsume(uint256,bytes32) returns(bool)"]).tryConsume.staticCall(1, NUL, { from: me }));
        if (!used) throw new Error("nullifier replay possible!"); } },

    { name: "DatumPublisherReputation", factory: "DatumPublisherReputation", v2: "MockPublisherReputationV2", args: () => [],
      abi: [...UPG, "function setSettlement(address)", "function recordSettlement(address,uint256,uint256,uint256)", "function repTotalSettled(address) view returns(uint256)"],
      load: async (v1) => { await tx(v1, ["function setSettlement(address)"], "setSettlement", [me]);
        await tx(v1, ["function recordSettlement(address,uint256,uint256,uint256)"], "recordSettlement", [PUB, 1, 10, 2]); },
      verify: async (v2) => { if ((await ro(v2, ["function repTotalSettled(address) view returns(uint256)"]).repTotalSettled(PUB)) !== 10n) throw new Error("reputation lost"); } },

    { name: "DatumPublishers", factory: "DatumPublishers", v2: "MockPublishersV2", args: () => [50n, pause],
      abi: [...UPG, "function registerPublisher(uint16)", "function getPublisher(address) view returns(tuple(bool registered,uint16 takeRateBps,bool allowlistEnabled))"],
      load: async (v1) => { await tx(v1, ["function registerPublisher(uint16)"], "registerPublisher", [5000]); },
      verify: async (v2) => { if (!(await ro(v2, ["function getPublisher(address) view returns(tuple(bool registered,uint16 takeRateBps,bool allowlistEnabled))"]).getPublisher(me)).registered) throw new Error("registration lost"); } },

    { name: "DatumCampaignAllowlist", factory: "DatumCampaignAllowlist", v2: "MockCampaignAllowlistV2", args: () => [],
      abi: [...UPG, "function setCampaigns(address)", "function initializeFor(uint256,address,uint16)", "function isAllowedPublisher(uint256,address) view returns(bool)"],
      load: async (v1) => { await tx(v1, ["function setCampaigns(address)"], "setCampaigns", [me]);
        await tx(v1, ["function initializeFor(uint256,address,uint16)"], "initializeFor", [1, PUB, 5000]); },
      verify: async (v2) => { if (!(await ro(v2, ["function isAllowedPublisher(uint256,address) view returns(bool)"]).isAllowedPublisher(1, PUB))) throw new Error("allowlist lost"); } },
  ];

  let pass = 0;
  for (const e of entries) {
    const t0 = Date.now();
    process.stdout.write(`[bump] ${e.name.padEnd(28)} `);
    try {
      const v1 = await deploy(e.factory, e.args());
      await tx(v1, UPG, "setRouter", [router]);
      await e.load(v1, {});
      const natBefore = await p.getBalance(v1);
      const tokBefore = e.token ? await ro(token, TOKEN_ABI).balanceOf(v1) : 0n;

      await tx(v1, UPG, "freeze", []);
      const v2 = await deploy(e.v2, e.args());
      await tx(v2, UPG, "setRouter", [router]);
      await tx(v2, UPG, "migrate", [v1]);
      if (e.fund || e.token) await tx(v1, UPG, "migrateFundsTo", [v2]);

      const natAfter = await p.getBalance(v2), v1Left = await p.getBalance(v1);
      const tokAfter = e.token ? await ro(token, TOKEN_ABI).balanceOf(v2) : 0n;
      const v1Tok = e.token ? await ro(token, TOKEN_ABI).balanceOf(v1) : 0n;
      if (e.fund && (natAfter !== natBefore || v1Left !== 0n)) throw new Error(`native not conserved (v2=${natAfter} v1left=${v1Left})`);
      if (e.token && (tokAfter !== tokBefore || v1Tok !== 0n)) throw new Error(`token not conserved`);
      if ((await ro(v2, UPG).version()) <= (await ro(v1, UPG).version())) throw new Error("version not bumped");
      await e.verify(v2);

      const note = e.fund ? `${formatEther(natBefore)} PAS conserved` : e.token ? `${formatEther(tokBefore)} DATUM conserved` : "state carried";
      console.log(`✅ ${note}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      results.push({ name: e.name, ok: true, note }); pass++;
    } catch (err: any) {
      console.log(`❌ ${err.message.slice(0, 90)}`);
      results.push({ name: e.name, ok: false, note: err.message.slice(0, 90) });
    }
  }

  const endBal = await p.getBalance(gov.address);
  console.log(`\n==================== PASEO BUMP-ALL ====================`);
  console.log(`  ${pass}/${entries.length} contracts bumped with no loss on live Paseo`);
  console.log(`  spent: ${formatEther(startBal - endBal)} PAS`);
  console.log(`========================================================`);
  if (pass !== entries.length) process.exit(1);
}

// throwaway param-only addresses (never need a key)
const PUB = rnd(), TAG = ethers.encodeBytes32String("sports"), NUL = ethers.encodeBytes32String("nul-1");
main().catch((e) => { console.error(e); process.exit(1); });
