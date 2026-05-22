// /identity dashboard — People-Chain bridge + identity ZK overview.
//
// The identity plane has three contracts:
//   - DatumPeopleChainIdentity   (the cache; tracks per-user attestations)
//   - DatumPeopleChainXcmBridge  (trustless XCM-dispatched refresh path)
//   - DatumPeopleChainBondedReporter (fast-path identity cache via bonded reporters)
//   - DatumIdentityVerifier      (Groth16 verifier for identity ZK proofs)
//
// Hero stats:
//   - Identities attested (7d)         (IdentityAttested log count)
//   - Refresh requests (7d)            (IdentityRefreshRequested log count)
//   - XCM refreshes dispatched (7d)    (RefreshDispatched + RefreshFromCampaign)
//   - Default validity blocks          (PeopleChainIdentity.defaultValidityBlocks)
//
// Telemetry stream:
//   - PeopleChainIdentity: IdentityAttested, IdentityForgotten,
//                          IdentityRefreshRequested
//   - PeopleChainXcmBridge: RefreshDispatched, RefreshFromCampaign,
//                           RefreshCallback
//
// Action hooks: People Chain / ZK (per design doc §2.3).

import { useMemo } from "react";
import { id as ethersId, Interface } from "ethers";
import { Dashboard, type ActionHook } from "../../components/Dashboard";
import { type HeroStat } from "../../hooks/useHeroStat";
import { type TelemetryStreamOpts, type StreamRow } from "../../hooks/useTelemetryStream";
import { callContract } from "../../lib/contractRead";
import { pineRpc } from "../../lib/provider";
import { type EthLog } from "../../lib/eventBus";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const TOPIC_ATTESTED = ethersId(
  "IdentityAttested(address,uint8,uint64,uint64,address)"
);
const TOPIC_FORGOTTEN = ethersId("IdentityForgotten(address)");
const TOPIC_REFRESH_REQUESTED = ethersId(
  "IdentityRefreshRequested(address,address)"
);
const TOPIC_REFRESH_DISPATCHED = ethersId(
  "RefreshDispatched(address,address,uint256)"
);
const TOPIC_REFRESH_FROM_CAMPAIGN = ethersId(
  "RefreshFromCampaign(uint256,address,address,uint256)"
);
const TOPIC_REFRESH_CALLBACK = ethersId(
  "RefreshCallback(address,uint8,uint64)"
);

const IDENTITY_IFACE = new Interface([
  "event IdentityAttested(address indexed user, uint8 level, uint64 validUntil, uint64 attestedAt, address indexed reporter)",
  "event IdentityForgotten(address indexed user)",
  "event IdentityRefreshRequested(address indexed user, address indexed requester)",
]);
const BRIDGE_IFACE = new Interface([
  "event RefreshDispatched(address indexed user, address indexed requester, uint256 feePaid)",
  "event RefreshFromCampaign(uint256 indexed campaignId, address indexed user, address indexed requester, uint256 feePaid)",
  "event RefreshCallback(address indexed user, uint8 level, uint64 validityBlocks)",
]);

const IDENTITY_READ_ABI = [
  "function defaultValidityBlocks() view returns (uint64)",
];

type Addrs = (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"];

export function IdentityDashboard() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;

  const heroStats = useMemo<HeroStat[]>(() => buildHeroStats(addrs), [addrs]);
  const stream = useMemo<TelemetryStreamOpts>(() => buildStream(addrs), [addrs]);
  const actions = useMemo<ActionHook[]>(() => buildActions(addrs), [addrs]);

  return (
    <Dashboard
      role="identity"
      title="Identity"
      subtitle="People-Chain attestation cache, XCM refresh bridge, identity ZK."
      heroStats={heroStats}
      stream={stream}
      actions={actions}
    />
  );
}

function buildHeroStats(addrs: Addrs): HeroStat[] {
  return [
    {
      label: "Identities attested (7d)",
      value: async () =>
        addrs.peopleChainIdentity
          ? countLogs(addrs.peopleChainIdentity, TOPIC_ATTESTED)
          : 0,
      formatter: (v) => String(v),
    },
    {
      label: "Refresh requests (7d)",
      value: async () =>
        addrs.peopleChainIdentity
          ? countLogs(addrs.peopleChainIdentity, TOPIC_REFRESH_REQUESTED)
          : 0,
      formatter: (v) => String(v),
      link: "/identity/people-chain",
    },
    {
      label: "XCM refreshes (7d)",
      value: async () => {
        if (!addrs.peopleChainXcmBridge) return 0;
        const [a, b] = await Promise.all([
          countLogs(addrs.peopleChainXcmBridge, TOPIC_REFRESH_DISPATCHED),
          countLogs(addrs.peopleChainXcmBridge, TOPIC_REFRESH_FROM_CAMPAIGN),
        ]);
        return a + b;
      },
      formatter: (v) => String(v),
      link: "/identity/people-chain",
    },
    {
      label: "Default validity",
      value: async () => {
        if (!addrs.peopleChainIdentity) return 0n;
        try {
          return await callContract<bigint>({
            address: addrs.peopleChainIdentity,
            abi: IDENTITY_READ_ABI,
            method: "defaultValidityBlocks",
          });
        } catch {
          return 0n;
        }
      },
      formatter: (v) => {
        const blocks = BigInt(String(v));
        if (blocks === 0n) return "—";
        const days = Number(blocks) / 14_400;
        return days >= 1 ? `${days.toFixed(1)}d` : `${blocks} blocks`;
      },
    },
  ];
}

async function countLogs(address: string, topic0: string): Promise<number> {
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

function buildStream(addrs: Addrs): TelemetryStreamOpts {
  const sources: TelemetryStreamOpts["sources"] = [];
  if (addrs.peopleChainIdentity) {
    const id = addrs.peopleChainIdentity.toLowerCase();
    sources.push(
      { address: id, topic0: TOPIC_ATTESTED, formatter: attestedRow },
      { address: id, topic0: TOPIC_FORGOTTEN, formatter: forgottenRow },
      { address: id, topic0: TOPIC_REFRESH_REQUESTED, formatter: refreshRequestedRow }
    );
  }
  if (addrs.peopleChainXcmBridge) {
    const br = addrs.peopleChainXcmBridge.toLowerCase();
    sources.push(
      { address: br, topic0: TOPIC_REFRESH_DISPATCHED, formatter: refreshDispatchedRow },
      { address: br, topic0: TOPIC_REFRESH_FROM_CAMPAIGN, formatter: refreshFromCampaignRow },
      { address: br, topic0: TOPIC_REFRESH_CALLBACK, formatter: refreshCallbackRow }
    );
  }
  return { windowBlocks: WINDOW_7D_BLOCKS, historyAllowed: true, sources };
}

function attestedRow(log: EthLog): StreamRow {
  const d = IDENTITY_IFACE.decodeEventLog("IdentityAttested", log.data, log.topics);
  const user = topicAddress(log.topics[1]);
  const reporter = topicAddress(log.topics[2]);
  const level = d[1] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "attested",
    title: `Identity attested for ${shorten(user)} · tier ${level}`,
    subtitle: `Reporter ${shorten(reporter)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/identity/people-chain",
  };
}

function forgottenRow(log: EthLog): StreamRow {
  const user = topicAddress(log.topics[1]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "forgotten",
    title: `Identity forgotten — ${shorten(user)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function refreshRequestedRow(log: EthLog): StreamRow {
  const user = topicAddress(log.topics[1]);
  const requester = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "refresh-req",
    title: `Refresh requested for ${shorten(user)}`,
    subtitle: `By ${shorten(requester)} · block ${Number(BigInt(log.blockNumber))}`,
    route: "/identity/people-chain",
  };
}

function refreshDispatchedRow(log: EthLog): StreamRow {
  const user = topicAddress(log.topics[1]);
  const d = BRIDGE_IFACE.decodeEventLog("RefreshDispatched", log.data, log.topics);
  const fee = d[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "xcm-dispatch",
    title: `XCM refresh dispatched for ${shorten(user)}`,
    subtitle: `Fee ${formatDot(fee)} · block ${Number(BigInt(log.blockNumber))}`,
  };
}

function refreshFromCampaignRow(log: EthLog): StreamRow {
  const cid = BigInt(log.topics[1] ?? "0x0");
  const user = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "xcm-camp",
    title: `Campaign ${cid} pulled XCM refresh for ${shorten(user)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function refreshCallbackRow(log: EthLog): StreamRow {
  const user = topicAddress(log.topics[1]);
  const d = BRIDGE_IFACE.decodeEventLog("RefreshCallback", log.data, log.topics);
  const level = d[1] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "xcm-callback",
    title: `Refresh callback — ${shorten(user)} → tier ${level}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function buildActions(addrs: Addrs): ActionHook[] {
  const out: ActionHook[] = [];
  if (addrs.peopleChainIdentity) {
    out.push({ label: "People Chain", route: "/identity/people-chain", description: "Refresh + XCM status" });
  }
  if (addrs.identityVerifier) {
    out.push({ label: "Identity ZK", route: "/identity/zk", description: "ZK proof tooling" });
  }
  out.push({ label: "My identity", route: "/me/identity", description: "Your attestation record" });
  return out;
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
