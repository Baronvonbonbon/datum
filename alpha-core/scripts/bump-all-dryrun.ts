// Full-system "bump everything" dry-run: deploy each upgradable contract, load
// it with real state + funds, then run the redeploy-migrate-rewire upgrade
// (freeze -> deploy v2 -> migrate -> migrateFundsTo) and assert NOTHING IS LOST
// — native DOT + ERC-20 balances conserved to the wei, and state carried over.
//
//   npx hardhat run scripts/bump-all-dryrun.ts          (hardhat in-process)
//
// Each entry is independent and failures are caught so the run prints a full
// tally even if one contract regresses.
import { ethers } from "hardhat";

type Ctx = { signers: any[]; gov: any; router: any; token: any; pause: any };
type Snapshot = { isFund?: boolean; isToken?: boolean; verify: (v2: any) => Promise<void> };
type Entry = {
  name: string; factory: string; v2: string; args: (c: Ctx) => any[];
  load: (v1: any, c: Ctx) => Promise<Snapshot>;
};

const results: { name: string; ok: boolean; native: string; token: string; note: string }[] = [];

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, gov, a, b, cc] = signers;
  const router = await (await ethers.getContractFactory("MockOpenGovRouter")).deploy();
  await router.setGovernor(gov.address);
  const token = await (await ethers.getContractFactory("MockERC20")).deploy("DATUM", "DATUM");
  const pause = await (await ethers.getContractFactory("DatumPauseRegistry")).deploy(deployer.address, a.address, b.address);
  const ctx: Ctx = { signers, gov, router, token, pause };

  const D = (n: string) => ethers.parseEther(n);

  const entries: Entry[] = [
    // ───────────────── native-DOT fund contracts ─────────────────
    {
      name: "DatumPublisherStake", factory: "DatumPublisherStake", v2: "MockPublisherStakeV2",
      args: () => [1_000_000n, 1_000n, 10n],
      load: async (v1) => {
        await v1.connect(a).stake({ value: D("0.5") });
        await v1.connect(b).stake({ value: D("0.3") });
        return { isFund: true, verify: async (v2) => {
          if ((await v2.staked(a.address)) !== D("0.5")) throw new Error("staked A lost");
          if ((await v2.staked(b.address)) !== D("0.3")) throw new Error("staked B lost");
        }};
      },
    },
    {
      name: "DatumAdvertiserStake", factory: "DatumAdvertiserStake", v2: "MockAdvertiserStakeV2",
      args: () => [1_000_000n, 1_000n, 10n],
      load: async (v1) => {
        await v1.connect(a).stake({ value: D("0.7") });
        return { isFund: true, verify: async (v2) => {
          if ((await v2.staked(a.address)) !== D("0.7")) throw new Error("staked lost");
        }};
      },
    },
    {
      name: "DatumChallengeBonds", factory: "DatumChallengeBonds", v2: "MockChallengeBondsV2",
      args: () => [],
      load: async (v1) => {
        await v1.setCampaignsContract(cc.address);            // EOA shim as the authorized caller
        await v1.connect(cc).lockBond(1, a.address, b.address, { value: D("0.4") });
        return { isFund: true, verify: async (v2) => {
          if ((await v2.bondForPublisher(1, b.address)) !== D("0.4")) throw new Error("bond lost");
        }};
      },
    },
    {
      name: "DatumActivationBonds", factory: "DatumActivationBonds", v2: "MockActivationBondsV2",
      args: () => [D("0.01"), 10n, 500, 200, deployer.address],
      load: async (v1) => {
        await v1.setCampaignsContract(cc.address);
        await v1.connect(cc).openBond(1, a.address, { value: D("0.25") });
        return { isFund: true, verify: async () => {} }; // balance conservation is the guarantee
      },
    },
    {
      name: "DatumBudgetLedger", factory: "DatumBudgetLedger", v2: "MockBudgetLedgerV2",
      args: () => [],
      load: async (v1) => {
        await v1.setCampaigns(cc.address);
        await v1.connect(cc).initializeBudget(1, 0, D("0.6"), D("0.3"), { value: D("0.6") });
        return { isFund: true, verify: async (v2) => {
          if ((await v2.getRemainingBudget(1, 0)) !== D("0.6")) throw new Error("budget lost");
        }};
      },
    },
    // ───────────────── ERC-20 custody contracts ─────────────────
    {
      name: "DatumZKStake", factory: "DatumZKStake", v2: "MockZKStakeV2",
      args: (c) => [c.token.target],
      load: async (v1) => {
        await token.mint(a.address, D("100"));
        await token.connect(a).approve(v1.target, D("40"));
        await v1.connect(a).depositWith(ethers.encodeBytes32String("commit-a"), D("40"));
        return { isToken: true, verify: async (v2) => {
          if ((await v2.staked(a.address)) !== D("40")) throw new Error("zk stake lost");
        }};
      },
    },
    {
      name: "DatumTagRegistry", factory: "DatumTagRegistry", v2: "MockTagRegistryNext",
      args: (c) => [c.token.target],
      load: async (v1) => {
        const tag = ethers.encodeBytes32String("sports");
        await token.mint(a.address, D("100"));
        await token.connect(a).approve(v1.target, D("50"));
        await v1.connect(a).registerTag(tag, D("50"));
        return { isToken: true, verify: async (v2) => {
          if ((await v2.tagBond(tag)) !== D("50")) throw new Error("tag bond lost");
          if ((await v2.tagOwner(tag)).toLowerCase() !== a.address.toLowerCase()) throw new Error("tag owner lost");
        }};
      },
    },
    {
      name: "DatumRelayStake", factory: "DatumRelayStake", v2: "MockRelayStakeV2",
      args: () => [1_000_000n, 10n],
      load: async (v1) => {
        await v1.connect(a).stake({ value: D("0.9") });
        return { isFund: true, verify: async (v2) => {
          if ((await v2.totalStaked()) !== D("0.9")) throw new Error("relay stake lost");
        }};
      },
    },
    // ─────────── governances: vote-state + locked DOT ───────────
    {
      name: "DatumRelayGovernance", factory: "DatumRelayGovernance", v2: "MockRelayGovernanceNext",
      args: () => [10, 100, 0, 5000, 2000, 1000],
      load: async (v1) => {
        await v1.setConvictionLockups([100n, 1n, 3n, 7n, 21n, 90n, 180n, 270n, 365n]);
        await v1.connect(a).propose(cc.address, 1, "0x" + "ee".repeat(32));
        await v1.connect(b).vote(1, true, 1, { value: D("2") });
        return { isFund: true, verify: async (v2) => {
          if ((await v2.getProposal(1)).relay.toLowerCase() !== cc.address.toLowerCase()) throw new Error("proposal lost");
          if ((await v2.getVote(1, b.address)).lockAmount !== D("2")) throw new Error("vote/lock lost");
        }};
      },
    },
    {
      name: "DatumPublisherGovernance", factory: "DatumPublisherGovernance", v2: "MockPublisherGovernanceNext",
      args: (c) => [c.pause.target, c.pause.target, c.pause.target, 20, 4000, 500, 200, D("2")],
      load: async (v1) => {
        await v1.setConvictionLockups([100n, 1n, 3n, 7n, 21n, 90n, 180n, 270n, 365n]);
        await a.sendTransaction({ to: v1.target, value: D("0.5") }); // pre-fund pool
        return { isFund: true, verify: async (v2) => {
          if ((await v2.quorum()) !== 20n) throw new Error("config lost");
        }};
      },
    },
    {
      name: "DatumAdvertiserGovernance", factory: "DatumAdvertiserGovernance", v2: "MockAdvertiserGovernanceNext",
      args: (c) => [15, 3000, 150, D("1"), c.pause.target],
      load: async (v1) => {
        await v1.setConvictionLockups([100n, 1n, 3n, 7n, 21n, 90n, 180n, 270n, 365n]);
        return { verify: async (v2) => {
          if ((await v2.quorum()) !== 15n) throw new Error("config lost");
        }};
      },
    },
    // ───────────── predecessor-chain replay stores ─────────────
    {
      name: "DatumNullifierRegistry", factory: "DatumNullifierRegistry", v2: "MockNullifierRegistryV2",
      args: () => [],
      load: async (v1) => {
        await v1.setSettlement(cc.address);
        const nul = ethers.encodeBytes32String("nul-1");
        await v1.connect(cc).tryConsume(1, nul); // mark used
        return { verify: async (v2) => {
          await v2.setSettlement(cc.address);
          const stillUsed = !(await v2.connect(cc).tryConsume.staticCall(1, nul));
          if (!stillUsed) throw new Error("nullifier used-set lost (replay possible!)");
        }};
      },
    },
    {
      name: "DatumPublisherReputation", factory: "DatumPublisherReputation", v2: "MockPublisherReputationV2",
      args: () => [],
      load: async (v1) => {
        await v1.setSettlement(cc.address);
        await v1.connect(cc).recordSettlement(a.address, 1, 10, 2);
        return { verify: async (v2) => {
          if ((await v2.repTotalSettled(a.address)) !== 10n) throw new Error("reputation counters lost");
        }};
      },
    },
    // ───────────────── state-only registries ─────────────────
    {
      name: "DatumPublishers", factory: "DatumPublishers", v2: "MockPublishersV2",
      args: (c) => [50n, c.pause.target],
      load: async (v1) => {
        await v1.connect(a).registerPublisher(5000);
        return { verify: async (v2) => {
          if (!(await v2.getPublisher(a.address)).registered) throw new Error("registration lost");
        }};
      },
    },
    {
      name: "DatumCampaignAllowlist", factory: "DatumCampaignAllowlist", v2: "MockCampaignAllowlistV2",
      args: () => [],
      load: async (v1) => {
        await v1.setCampaigns(cc.address);
        await v1.connect(cc).initializeFor(1, a.address, 5000);
        return { verify: async (v2) => {
          if (!(await v2.isAllowedPublisher(1, a.address))) throw new Error("allowlist entry lost");
        }};
      },
    },
  ];

  for (const e of entries) {
    let note = "";
    try {
      const v1: any = await (await ethers.getContractFactory(e.factory)).deploy(...e.args(ctx));
      await v1.setRouter(router.target);
      const snap = await e.load(v1, ctx);

      const nativeBefore = await ethers.provider.getBalance(v1.target);
      const tokenBefore = snap.isToken ? await token.balanceOf(v1.target) : 0n;

      await v1.connect(gov).freeze();
      const v2: any = await (await ethers.getContractFactory(e.v2)).deploy(...e.args(ctx));
      await v2.setRouter(router.target);
      await v2.connect(gov).migrate(v1.target);
      if (snap.isFund || snap.isToken) await v1.connect(gov).migrateFundsTo(v2.target);

      const nativeAfter = await ethers.provider.getBalance(v2.target);
      const v1NativeAfter = await ethers.provider.getBalance(v1.target);
      const tokenAfter = snap.isToken ? await token.balanceOf(v2.target) : 0n;
      const v1TokenAfter = snap.isToken ? await token.balanceOf(v1.target) : 0n;

      // conservation
      if (snap.isFund && (nativeAfter !== nativeBefore || v1NativeAfter !== 0n))
        throw new Error(`native not conserved: before=${nativeBefore} v2=${nativeAfter} v1left=${v1NativeAfter}`);
      if (snap.isToken && (tokenAfter !== tokenBefore || v1TokenAfter !== 0n))
        throw new Error(`token not conserved: before=${tokenBefore} v2=${tokenAfter} v1left=${v1TokenAfter}`);
      if ((await v2.version()) <= (await v1.version())) throw new Error("version not bumped");

      await snap.verify(v2);
      note = snap.isFund ? `native ${ethers.formatEther(nativeBefore)} conserved`
           : snap.isToken ? `token ${ethers.formatEther(tokenBefore)} conserved`
           : `state carried`;
      results.push({ name: e.name, ok: true, native: snap.isFund ? ethers.formatEther(nativeBefore) : "-", token: snap.isToken ? ethers.formatEther(tokenBefore) : "-", note });
    } catch (err: any) {
      results.push({ name: e.name, ok: false, native: "-", token: "-", note: err.message.slice(0, 120) });
    }
  }

  // ── report ──
  console.log("\n==================== BUMP-ALL REPORT ====================");
  let pass = 0, totalNative = 0n, totalToken = 0n;
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.name.padEnd(26)} ${r.note}`);
    if (r.ok) pass++;
    if (r.native !== "-") totalNative += ethers.parseEther(r.native);
    if (r.token !== "-") totalToken += ethers.parseEther(r.token);
  }
  console.log("---------------------------------------------------------");
  console.log(`  ${pass}/${results.length} contracts bumped with no loss`);
  console.log(`  native conserved across bumps: ${ethers.formatEther(totalNative)} DOT`);
  console.log(`  ERC-20 conserved across bumps: ${ethers.formatEther(totalToken)} DATUM`);
  console.log("=========================================================");
  if (pass !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
