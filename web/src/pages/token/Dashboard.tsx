// /token dashboard — DATUM token-plane overview.
//
// Surfaces the four plane components (Wrapper, BootstrapPool,
// Vesting, FeeShare) plus the new alpha-5 emission machinery
// (EmissionEngine + MintCoordinator). Gracefully degrades when
// any contract is absent from the network — most of the token
// plane isn't deployed on Paseo as of 2026-05-22, so the page is
// designed to ship hero-only / stream-only sections that hide
// when their data source is missing.
//
// Hero stats:
//   - Mint rate (currentRate from EmissionEngine, or fallback
//     mintRatePerDot from MintCoordinator).
//   - Daily cap (EmissionEngine.dailyCap()).
//   - Epoch (currentEpoch).
//   - Mint events (24h) — DatumMintFailed + MintComputed log
//     count, treating the union as "something passed through the
//     mint plane today."
//
// Telemetry stream:
//   - MintCoordinator: MintRateUpdated, DatumRewardSplitSet,
//     DatumMintFailed.
//   - EmissionEngine: EpochRolled, DayRolled, RateAdjusted,
//     MintComputed.
//
// Actions: Wrapper / Bootstrap / Vesting / FeeShare / Mint
// coordinator (per design doc §2.3).

import { useMemo } from "react";
import { id as ethersId, Interface } from "ethers";
import { Link } from "react-router-dom";
import { Dashboard, type ActionHook } from "../../components/Dashboard";
import { PageExplainer } from "../../components/PageExplainer";
import { ContractsTouched } from "../../components/ContractsTouched";
import { type HeroStat } from "../../hooks/useHeroStat";
import { type TelemetryStreamOpts, type StreamRow } from "../../hooks/useTelemetryStream";
import { callContract } from "../../lib/contractRead";
import { pineRpc } from "../../lib/provider";
import { type EthLog } from "../../lib/eventBus";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_24H_BLOCKS = 14_400;
const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_MINT_RATE_UPDATED = ethersId("MintRateUpdated(uint256,uint256)");
const TOPIC_REWARD_SPLIT_SET = ethersId(
  "DatumRewardSplitSet(uint16,uint16,uint16)"
);
const TOPIC_MINT_FAILED = ethersId(
  "DatumMintFailed(address,address,address,uint256)"
);
const TOPIC_EPOCH_ROLLED = ethersId(
  "EpochRolled(uint8,uint256,uint256)"
);
const TOPIC_DAY_ROLLED = ethersId("DayRolled(uint256,uint256)");
const TOPIC_RATE_ADJUSTED = ethersId(
  "RateAdjusted(uint256,uint256,uint256)"
);
const TOPIC_MINT_COMPUTED = ethersId(
  "MintComputed(uint256,uint256,uint256)"
);

const MINT_IFACE = new Interface([
  "event MintRateUpdated(uint256 oldRate, uint256 newRate)",
  "event DatumRewardSplitSet(uint16 userBps, uint16 publisherBps, uint16 advertiserBps)",
  "event DatumMintFailed(address indexed user, address indexed publisher, address indexed advertiser, uint256 totalMint)",
]);
const ENGINE_IFACE = new Interface([
  "event EpochRolled(uint8 indexed newEpoch, uint256 scheduledBudget, uint256 carriedForward)",
  "event DayRolled(uint256 newDayStart, uint256 dailyCap)",
  "event RateAdjusted(uint256 newRate, uint256 observedVolume, uint256 previousRate)",
  "event MintComputed(uint256 dotPaid, uint256 rawMint, uint256 effectiveMint)",
]);

const ENGINE_READ_ABI = [
  "function currentRate() view returns (uint256)",
  "function currentEpoch() view returns (uint8)",
  "function dailyCap() view returns (uint256)",
  "function remainingEpochBudget() view returns (uint256)",
];
const COORD_READ_ABI = [
  "function mintRatePerDot() view returns (uint256)",
];

type Addrs = (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"];

export function TokenDashboard() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;

  const heroStats = useMemo<HeroStat[]>(() => buildHeroStats(addrs), [addrs]);
  const stream = useMemo<TelemetryStreamOpts>(() => buildStream(addrs), [addrs]);
  const actions = useMemo<ActionHook[]>(() => buildActions(addrs), [addrs]);

  return (
    <>
      <PageExplainer slug="token-dashboard" title="What is the Token plane?">
        <p style={{ margin: 0 }}>
          DATUM ships a parallel ERC-20 token plane on top of DOT
          settlement. The hero cards show the current mint rate, daily
          emission cap, current epoch, and 24-hour mint activity. The
          stream below tracks every mint, rate adjustment, and epoch roll.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          Note: parts of the token plane may not yet be deployed on this
          network — sections degrade gracefully when their contract is
          absent. Full deep dive:{" "}
          <Link to="/about/token">About: Token →</Link>
        </p>
      </PageExplainer>
      <Dashboard
        role="token"
        title="Token"
        subtitle="DATUM mint engine + wrapper / bootstrap / vesting / fee-share."
        heroStats={heroStats}
        stream={stream}
        actions={actions}
      />
      <ContractsTouched contracts={[
        "mintCoordinator",
        "emissionEngine",
        "wrapper",
        "mintAuthority",
        "bootstrapPool",
        "vesting",
        "feeShare",
        "tokenRewardVault",
      ]} />
    </>
  );
}

// ─── Hero stats ───────────────────────────────────────────────────

function buildHeroStats(addrs: Addrs): HeroStat[] {
  return [
    {
      label: "Mint rate (DATUM/DOT)",
      value: async () => {
        // Prefer dynamic EmissionEngine.currentRate; fall back to the
        // flat MintCoordinator.mintRatePerDot when engine isn't
        // deployed.
        if (addrs.emissionEngine) {
          try {
            return await callContract<bigint>({
              address: addrs.emissionEngine,
              abi: ENGINE_READ_ABI,
              method: "currentRate",
            });
          } catch { /* fall through */ }
        }
        if (addrs.mintCoordinator) {
          try {
            return await callContract<bigint>({
              address: addrs.mintCoordinator,
              abi: COORD_READ_ABI,
              method: "mintRatePerDot",
            });
          } catch { /* fall through */ }
        }
        return 0n;
      },
      formatter: (v) => {
        const planck = BigInt(String(v));
        // Rate is DATUM-planck per DOT-planck — i.e. dimensionless
        // when both legs are 10^10. Render whole DATUM-per-DOT.
        const whole = planck / 10n ** 10n;
        return `${whole.toString()}`;
      },
      link: "/token/mint-coordinator",
    },
    {
      label: "Daily cap (DATUM)",
      value: async () => {
        if (!addrs.emissionEngine) return 0n;
        try {
          return await callContract<bigint>({
            address: addrs.emissionEngine,
            abi: ENGINE_READ_ABI,
            method: "dailyCap",
          });
        } catch {
          return 0n;
        }
      },
      formatter: (v) => formatDatum(BigInt(String(v))),
    },
    {
      label: "Epoch",
      value: async () => {
        if (!addrs.emissionEngine) return 0;
        try {
          const e = await callContract<bigint>({
            address: addrs.emissionEngine,
            abi: ENGINE_READ_ABI,
            method: "currentEpoch",
          });
          return Number(e);
        } catch {
          return 0;
        }
      },
      formatter: (v) => `#${v}`,
    },
    {
      label: "Mint events (24h)",
      value: async () => {
        const counts = await Promise.all([
          addrs.mintCoordinator
            ? countLogs(addrs.mintCoordinator, TOPIC_MINT_FAILED, WINDOW_24H_BLOCKS)
            : Promise.resolve(0),
          addrs.emissionEngine
            ? countLogs(addrs.emissionEngine, TOPIC_MINT_COMPUTED, WINDOW_24H_BLOCKS)
            : Promise.resolve(0),
        ]);
        return counts.reduce((a, b) => a + b, 0);
      },
      formatter: (v) => String(v),
      link: "/token/mint-coordinator",
    },
  ];
}

async function countLogs(address: string, topic0: string, windowBlocks: number): Promise<number> {
  try {
    const head = await pineRpc<string>("eth_blockNumber");
    const headN = Number(BigInt(head));
    const fromN = Math.max(0, headN - windowBlocks);
    const logs = await pineRpc<unknown[]>("eth_getLogs", [
      {
        address: address.toLowerCase(),
        topics: [topic0],
        fromBlock: "0x" + fromN.toString(16),
        toBlock: "0x" + headN.toString(16),
      },
    ]);
    return Array.isArray(logs) ? logs.length : 0;
  } catch {
    return 0;
  }
}

// ─── Telemetry stream ─────────────────────────────────────────────

function buildStream(addrs: Addrs): TelemetryStreamOpts {
  const sources: TelemetryStreamOpts["sources"] = [];
  if (addrs.mintCoordinator) {
    const coord = addrs.mintCoordinator.toLowerCase();
    sources.push(
      { address: coord, topic0: TOPIC_MINT_RATE_UPDATED, formatter: mintRateUpdatedRow },
      { address: coord, topic0: TOPIC_REWARD_SPLIT_SET, formatter: rewardSplitSetRow },
      { address: coord, topic0: TOPIC_MINT_FAILED, formatter: mintFailedRow }
    );
  }
  if (addrs.emissionEngine) {
    const eng = addrs.emissionEngine.toLowerCase();
    sources.push(
      { address: eng, topic0: TOPIC_EPOCH_ROLLED, formatter: epochRolledRow },
      { address: eng, topic0: TOPIC_DAY_ROLLED, formatter: dayRolledRow },
      { address: eng, topic0: TOPIC_RATE_ADJUSTED, formatter: rateAdjustedRow },
      { address: eng, topic0: TOPIC_MINT_COMPUTED, formatter: mintComputedRow }
    );
  }
  return { windowBlocks: WINDOW_7D_BLOCKS, historyAllowed: true, sources };
}

function mintRateUpdatedRow(log: EthLog): StreamRow {
  const d = MINT_IFACE.decodeEventLog("MintRateUpdated", log.data, log.topics);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "rate-updated",
    title: `Mint rate updated`,
    subtitle: `${(d[0] as bigint) / 10n ** 10n} → ${(d[1] as bigint) / 10n ** 10n} DATUM/DOT · block ${Number(BigInt(log.blockNumber))}`,
    route: "/token/mint-coordinator",
  };
}

function rewardSplitSetRow(log: EthLog): StreamRow {
  const d = MINT_IFACE.decodeEventLog("DatumRewardSplitSet", log.data, log.topics);
  const u = d[0] as bigint;
  const p = d[1] as bigint;
  const a = d[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "split-set",
    title: `Reward split: user ${u}bps / pub ${p}bps / adv ${a}bps`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: "/token/mint-coordinator",
  };
}

function mintFailedRow(log: EthLog): StreamRow {
  const user = topicAddress(log.topics[1]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "mint-failed",
    title: `Mint failed for ${shorten(user)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: "/token/mint-coordinator",
  };
}

function epochRolledRow(log: EthLog): StreamRow {
  const d = ENGINE_IFACE.decodeEventLog("EpochRolled", log.data, log.topics);
  const epoch = BigInt(log.topics[1] ?? "0x0");
  return {
    ts: tsForBlock(log.blockNumber),
    type: "epoch",
    title: `Epoch ${epoch} rolled`,
    subtitle: `Scheduled ${formatDatum(d[1] as bigint)} · carry ${formatDatum(d[2] as bigint)}`,
  };
}

function dayRolledRow(log: EthLog): StreamRow {
  const d = ENGINE_IFACE.decodeEventLog("DayRolled", log.data, log.topics);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "day",
    title: `Day rolled`,
    subtitle: `Daily cap ${formatDatum(d[1] as bigint)} · block ${Number(BigInt(log.blockNumber))}`,
  };
}

function rateAdjustedRow(log: EthLog): StreamRow {
  const d = ENGINE_IFACE.decodeEventLog("RateAdjusted", log.data, log.topics);
  const newRate = d[0] as bigint;
  const prev = d[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "rate-adj",
    title: `Rate adjusted ${(prev / 10n ** 10n).toString()} → ${(newRate / 10n ** 10n).toString()} DATUM/DOT`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function mintComputedRow(log: EthLog): StreamRow {
  const d = ENGINE_IFACE.decodeEventLog("MintComputed", log.data, log.topics);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "minted",
    title: `Minted ${formatDatum(d[2] as bigint)}`,
    subtitle: `For ${formatDot(d[0] as bigint)} · raw ${formatDatum(d[1] as bigint)}`,
  };
}

// ─── Action hooks ─────────────────────────────────────────────────

function buildActions(addrs: Addrs): ActionHook[] {
  const out: ActionHook[] = [
    { label: "Mint coordinator", route: "/token/mint-coordinator", description: "Per-batch emissions log" },
  ];
  if (addrs.wrapper) out.push({ label: "Wrapper", route: "/token/wrapper", description: "DOT ↔ DATUM wrapper" });
  if (addrs.bootstrapPool) out.push({ label: "Bootstrap", route: "/token/bootstrap", description: "Bootstrap liquidity" });
  if (addrs.vesting) out.push({ label: "Vesting", route: "/token/vesting", description: "Vesting schedules" });
  if (addrs.feeShare) out.push({ label: "Fee share", route: "/token/fee-share", description: "Protocol fee distribution" });
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────

function topicAddress(topic: string | undefined): string {
  if (!topic) return "";
  return "0x" + topic.toLowerCase().slice(-40);
}

function shorten(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function tsForBlock(blockHex: string): number {
  void blockHex;
  return Math.floor(Date.now() / 1000);
}

function formatDatum(planck: bigint): string {
  if (planck === 0n) return "0 DATUM";
  const whole = planck / 10n ** 10n;
  const frac = planck % 10n ** 10n;
  if (whole === 0n) {
    const padded = frac.toString().padStart(10, "0");
    const trimmed = padded.slice(0, 4).replace(/0+$/, "") || "0";
    return `0.${trimmed} DATUM`;
  }
  const fracStr = frac.toString().padStart(10, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} DATUM` : `${whole} DATUM`;
}

function formatDot(planck: bigint): string {
  if (planck === 0n) return "0 DOT";
  const whole = planck / 10n ** 10n;
  const frac = planck % 10n ** 10n;
  if (whole === 0n) {
    const padded = frac.toString().padStart(10, "0");
    const trimmed = padded.slice(0, 4).replace(/0+$/, "") || "0";
    return `0.${trimmed} DOT`;
  }
  const fracStr = frac.toString().padStart(10, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} DOT` : `${whole} DOT`;
}
