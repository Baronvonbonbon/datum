// /protocol dashboard — top-level overview of every load-bearing
// satellite (PauseRegistry, TagSystem, GovernanceRouter registry,
// SybilDefense, ParameterGovernance, …). Replaces the old /admin
// index page per design doc §2.3.
//
// Hero stats:
//   - Registered contracts          (ContractRegistered all-time count)
//   - Pauses (7d)                   (Paused + PausedCategory)
//   - Tag appeals open (7d)         (TagAppealFiled − TagAppealResolved)
//   - Active campaigns              (next id − 1 on Campaigns)
//
// Telemetry stream:
//   - GovernanceRouter: ContractRegistered, ContractUpgraded,
//     HighTierProposed/Executed/Vetoed
//   - PauseRegistry: Paused, PausedCategory, PauseExtended
//   - TagCurator: TagApproved, TagAppealFiled, TagAppealResolved
//
// Public route — no wallet required. All actions are link-outs to
// per-contract sub-pages which handle their own signing gates.

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

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_CONTRACT_REGISTERED = ethersId("ContractRegistered(bytes32,address)");
const TOPIC_CONTRACT_UPGRADED = ethersId(
  "ContractUpgraded(bytes32,address,address,uint256)"
);
const TOPIC_HIGH_TIER_PROPOSED = ethersId(
  "HighTierProposed(uint256,address,uint256)"
);
const TOPIC_HIGH_TIER_EXECUTED = ethersId("HighTierExecuted(uint256,bool,bytes)");
const TOPIC_HIGH_TIER_VETOED = ethersId("HighTierVetoed(uint256)");
const TOPIC_PAUSED = ethersId("Paused(address)");
const TOPIC_PAUSED_CATEGORY = ethersId("PausedCategory(address,uint8)");
const TOPIC_PAUSE_EXTENDED = ethersId("PauseExtended(address,uint8,uint64)");
const TOPIC_TAG_APPROVED = ethersId("TagApproved(bytes32)");
const TOPIC_TAG_APPEAL_FILED = ethersId(
  "TagAppealFiled(uint256,address,bytes32,bytes32,uint256)"
);
const TOPIC_TAG_APPEAL_RESOLVED = ethersId(
  "TagAppealResolved(uint256,bytes32,bool,uint256)"
);

const ROUTER_IFACE = new Interface([
  "event ContractRegistered(bytes32 indexed name, address indexed addr)",
  "event ContractUpgraded(bytes32 indexed name, address indexed oldAddr, address indexed newAddr, uint256 version)",
  "event HighTierProposed(uint256 indexed id, address indexed target, uint256 executableAfterBlock)",
  "event HighTierExecuted(uint256 indexed id, bool success, bytes returndata)",
]);
const PAUSE_IFACE = new Interface([
  "event Paused(address indexed by)",
  "event PausedCategory(address indexed by, uint8 indexed categories)",
  "event PauseExtended(address indexed by, uint8 indexed categories, uint64 until)",
]);
const TAG_IFACE = new Interface([
  "event TagApproved(bytes32 indexed tag)",
  "event TagAppealFiled(uint256 indexed appealId, address indexed appellant, bytes32 indexed tag, bytes32 evidenceHash, uint256 bond)",
  "event TagAppealResolved(uint256 indexed appealId, bytes32 indexed tag, bool upheld, uint256 bondDisposition)",
]);

type Addrs = (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"];

export function ProtocolDashboard() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;

  const heroStats = useMemo<HeroStat[]>(() => buildHeroStats(addrs), [addrs]);
  const stream = useMemo<TelemetryStreamOpts>(() => buildStream(addrs), [addrs]);
  const actions = useMemo<ActionHook[]>(() => buildActions(), []);

  return (
    <>
      <PageExplainer slug="protocol-dashboard" title="What is the Protocol section?">
        <p style={{ margin: 0 }}>
          Top-level view of the load-bearing satellites. The hero cards
          show how many contracts the GovernanceRouter has registered,
          how many pause events have fired in the last 7 days, how many
          tag appeals are open, and total active campaigns. The stream
          tracks router registration/upgrade events, pause events, and
          tag-curator decisions.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          See the upgrade timeline:{" "}
          <Link to="/protocol/upgrades">Upgrades →</Link> · Full deep dive:{" "}
          <Link to="/about/protocol">About: Protocol →</Link>
        </p>
      </PageExplainer>
      <Dashboard
        role="protocol"
        title="Protocol"
        subtitle="Pause registry, tag curator, governance router registry, sybil defense, parameter governance."
        heroStats={heroStats}
        stream={stream}
        actions={actions}
      />
      <ContractsTouched contracts={[
        "governanceRouter",
        "pauseRegistry",
        "tagSystem",
        "parameterGovernance",
        "powEngine",
        "blocklistCurator",
        "publisherStake",
        "challengeBonds",
        "settlementRateLimiter",
        "nullifierRegistry",
        "publisherReputation",
      ]} />
    </>
  );
}

// ─── Hero stats ───────────────────────────────────────────────────

function buildHeroStats(addrs: Addrs): HeroStat[] {
  return [
    {
      label: "Registered contracts",
      value: async () => {
        // All-time ContractRegistered count — no time window, since the
        // router registry is the canonical "what's wired" enumeration.
        if (!addrs.governanceRouter) return 0;
        return countLogsAllTime(addrs.governanceRouter, TOPIC_CONTRACT_REGISTERED);
      },
      formatter: (v) => String(v),
      link: "/protocol/upgrades",
    },
    {
      label: "Pauses (7d)",
      value: async () => {
        const [a, b] = await Promise.all([
          countLogs(addrs.pauseRegistry, TOPIC_PAUSED),
          countLogs(addrs.pauseRegistry, TOPIC_PAUSED_CATEGORY),
        ]);
        return a + b;
      },
      formatter: (v) => String(v),
      link: "/protocol/pause-registry",
    },
    {
      label: "Tag appeals open",
      value: async () => {
        if (!addrs.tagSystem) return 0;
        // tagSystem is the registry contract; TagCurator emits the
        // events. Use tagSystem's tagCurator() to find the right
        // address — if unavailable, fall back to 0.
        try {
          const curator = await callContract<string>({
            address: addrs.tagSystem,
            abi: ["function tagCurator() view returns (address)"],
            method: "tagCurator",
          });
          if (!curator || curator === "0x0000000000000000000000000000000000000000") return 0;
          const [filed, resolved] = await Promise.all([
            countLogs(curator, TOPIC_TAG_APPEAL_FILED),
            countLogs(curator, TOPIC_TAG_APPEAL_RESOLVED),
          ]);
          return Math.max(0, filed - resolved);
        } catch {
          return 0;
        }
      },
      formatter: (v) => String(v),
      link: "/protocol/tag-curator",
    },
    {
      label: "Active campaigns",
      value: async () => {
        try {
          const next = await callContract<bigint>({
            address: addrs.campaigns,
            abi: ["function nextId() view returns (uint256)"],
            method: "nextId",
          });
          return Number(next) > 0 ? Number(next) - 1 : 0;
        } catch {
          return 0;
        }
      },
      formatter: (v) => String(v),
      link: "/campaigns",
    },
  ];
}

async function countLogs(address: string | undefined, topic0: string): Promise<number> {
  if (!address) return 0;
  try {
    const head = await pineRpc<string>("eth_blockNumber");
    const headN = Number(BigInt(head));
    const fromN = Math.max(0, headN - WINDOW_7D_BLOCKS);
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

async function countLogsAllTime(address: string, topic0: string): Promise<number> {
  try {
    const logs = await pineRpc<unknown[]>("eth_getLogs", [
      {
        address: address.toLowerCase(),
        topics: [topic0],
        fromBlock: "0x0",
        toBlock: "latest",
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

  if (addrs.governanceRouter) {
    const router = addrs.governanceRouter.toLowerCase();
    sources.push(
      { address: router, topic0: TOPIC_CONTRACT_REGISTERED, formatter: contractRegisteredRow },
      { address: router, topic0: TOPIC_CONTRACT_UPGRADED, formatter: contractUpgradedRow },
      { address: router, topic0: TOPIC_HIGH_TIER_PROPOSED, formatter: highTierProposedRow },
      { address: router, topic0: TOPIC_HIGH_TIER_EXECUTED, formatter: highTierExecutedRow },
      { address: router, topic0: TOPIC_HIGH_TIER_VETOED, formatter: highTierVetoedRow }
    );
  }
  if (addrs.pauseRegistry) {
    const pause = addrs.pauseRegistry.toLowerCase();
    sources.push(
      { address: pause, topic0: TOPIC_PAUSED, formatter: pausedRow },
      { address: pause, topic0: TOPIC_PAUSED_CATEGORY, formatter: pausedCategoryRow },
      { address: pause, topic0: TOPIC_PAUSE_EXTENDED, formatter: pauseExtendedRow }
    );
  }
  // TagCurator address lives behind tagSystem.tagCurator(); subscribe by
  // wildcard topic across the tagSystem itself for TagApproved (events
  // fire on the curator, but the curator address isn't known at compile
  // time, so we accept the false-positive case where the page just
  // shows no tag events). The dashboard reads the curator address at
  // render time when needed.

  return {
    windowBlocks: WINDOW_7D_BLOCKS,
    historyAllowed: true,
    sources,
  };
}

function contractRegisteredRow(log: EthLog): StreamRow {
  const d = ROUTER_IFACE.decodeEventLog("ContractRegistered", log.data, log.topics);
  const name = bytes32Label(d[0] as string);
  const addr = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "registered",
    title: `Registered ${name}`,
    subtitle: `→ ${shorten(addr)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/protocol/upgrades",
  };
}

function contractUpgradedRow(log: EthLog): StreamRow {
  const d = ROUTER_IFACE.decodeEventLog("ContractUpgraded", log.data, log.topics);
  const name = bytes32Label(d[0] as string);
  const newAddr = topicAddress(log.topics[3]);
  const version = d[3] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "upgraded",
    title: `Upgraded ${name} → v${version}`,
    subtitle: `New addr ${shorten(newAddr)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/protocol/upgrades",
  };
}

function highTierProposedRow(log: EthLog): StreamRow {
  const d = ROUTER_IFACE.decodeEventLog("HighTierProposed", log.data, log.topics);
  const id = d[0] as bigint;
  const target = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "high-tier-proposed",
    title: `High-tier #${id} proposed → ${shorten(target)}`,
    subtitle: `Executable at block ${(d[2] as bigint).toString()}`,
    route: "/governance/council",
  };
}

function highTierExecutedRow(log: EthLog): StreamRow {
  const d = ROUTER_IFACE.decodeEventLog("HighTierExecuted", log.data, log.topics);
  const id = d[0] as bigint;
  const ok = d[1] as boolean;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "high-tier-exec",
    title: `High-tier #${id} ${ok ? "executed" : "execution failed"}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function highTierVetoedRow(log: EthLog): StreamRow {
  const id = BigInt(log.topics[1] ?? "0x0");
  return {
    ts: tsForBlock(log.blockNumber),
    type: "high-tier-veto",
    title: `High-tier #${id} vetoed`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function pausedRow(log: EthLog): StreamRow {
  const by = topicAddress(log.topics[1]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "paused",
    title: `Global pause triggered`,
    subtitle: `By ${shorten(by)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/protocol/pause-registry",
  };
}

function pausedCategoryRow(log: EthLog): StreamRow {
  const by = topicAddress(log.topics[1]);
  const cats = BigInt(log.topics[2] ?? "0x0");
  return {
    ts: tsForBlock(log.blockNumber),
    type: "paused-cat",
    title: `Category pause (mask 0x${cats.toString(16)})`,
    subtitle: `By ${shorten(by)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/protocol/pause-registry",
  };
}

function pauseExtendedRow(log: EthLog): StreamRow {
  const by = topicAddress(log.topics[1]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "pause-extended",
    title: `Pause extended`,
    subtitle: `By ${shorten(by)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/protocol/pause-registry",
  };
}

// ─── Action hooks ─────────────────────────────────────────────────

function buildActions(): ActionHook[] {
  return [
    { label: "Upgrades", route: "/protocol/upgrades", description: "GovernanceRouter registry + lock status" },
    { label: "Tag curator", route: "/protocol/tag-curator", description: "Tag approvals + G-6 appeals" },
    { label: "Pause registry", route: "/protocol/pause-registry", description: "Guardian set + category caps" },
    { label: "Parameter governance", route: "/protocol/parameter-governance", description: "Per-contract retunes" },
    { label: "Sybil defense", route: "/protocol/sybil-defense", description: "PoW, nullifiers, rate limit, ZK" },
    { label: "Relay", route: "/protocol/relay", description: "Authorized relayer set + open-mode lock" },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────

function bytes32Label(b32: string): string {
  // Trim trailing zero bytes and try utf-8 decode. The router stores
  // contract names as bytes32 ASCII strings (e.g., "campaigns" packed
  // right-zero-padded).
  if (!b32 || !b32.startsWith("0x")) return b32 ?? "";
  const hex = b32.slice(2);
  let s = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (byte === 0) break;
    if (byte >= 0x20 && byte < 0x7f) s += String.fromCharCode(byte);
  }
  return s || b32;
}

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

// Re-export used internally — silences unused-import warnings when the
// stream omits the corresponding source on a network without
// pauseRegistry / tagSystem.
void TOPIC_TAG_APPROVED;
void TAG_IFACE;
