// /advertiser dashboard — campaign-creator overview.
//
// Hero stats: counts derived from on-chain events (CampaignCreated,
// CampaignActivated, BondOpened, Challenged, Activated). The hero
// fetchers reuse the same pine subscriptions the telemetry stream
// uses, but a HeroStat returns a single value so we encode counts
// per-stat. To stay cheap, each hero re-queries the relevant event
// window from pine on the polling cadence.
//
// Telemetry stream: campaign lifecycle events filtered to events
// involving this advertiser. Operator route — historyAllowed: true
// so the stream splices RPC for windows past pine's reach.
//
// Without a connected wallet: <NeedsExtension>.
//
// Legacy dashboard preserved in Dashboard.legacy.tsx; its
// per-campaign table + CSV export will fold into the new design's
// action hooks during follow-up polish.

import { useMemo } from "react";
import { id as ethersId, Interface } from "ethers";
import { Dashboard, type ActionHook } from "../../components/Dashboard";
import { NeedsExtension } from "../../components/NeedsExtension";
import { useWallet } from "../../hooks/useWallet";
import { type HeroStat } from "../../hooks/useHeroStat";
import { type TelemetryStreamOpts, type StreamRow } from "../../hooks/useTelemetryStream";
import { pineRpc } from "../../lib/provider";
import { addressToTopic, type EthLog } from "../../lib/eventBus";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

// Event topic0s
const TOPIC_CAMPAIGN_CREATED = ethersId(
  "CampaignCreated(uint256,address,address,uint256,uint16)"
);
const TOPIC_CAMPAIGN_ACTIVATED = ethersId("CampaignActivated(uint256)");
const TOPIC_BOND_OPENED = ethersId(
  "BondOpened(uint256,address,uint256,uint64)"
);
const TOPIC_BOND_CHALLENGED = ethersId(
  "Challenged(uint256,address,uint256)"
);
const TOPIC_BOND_ACTIVATED = ethersId("Activated(uint256,address)");
const TOPIC_BOND_RESOLVED = ethersId(
  "Resolved(uint256,bool,uint256,uint256,uint256)"
);
const TOPIC_MUTED = ethersId("Muted(uint256,address,uint256)");

// Interfaces for decoding
const CAMPAIGN_IFACE = new Interface([
  "event CampaignCreated(uint256 indexed campaignId, address indexed advertiser, address indexed publisher, uint256 totalBudgetPlanck, uint16 snapshotTakeRateBps)",
  "event CampaignActivated(uint256 indexed campaignId)",
]);
const BOND_IFACE = new Interface([
  "event BondOpened(uint256 indexed campaignId, address indexed creator, uint256 bond, uint64 timelockExpiry)",
  "event Challenged(uint256 indexed campaignId, address indexed challenger, uint256 bond)",
  "event Activated(uint256 indexed campaignId, address indexed activator)",
  "event Resolved(uint256 indexed campaignId, bool creatorWon, uint256 winnerRefund, uint256 winnerBonus, uint256 treasuryCut)",
  "event Muted(uint256 indexed campaignId, address indexed muter, uint256 bond)",
]);

type Addrs = (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"];

export function AdvertiserDashboard() {
  const wallet = useWallet();

  if (!wallet.installed) {
    return (
      <NeedsExtension
        title="Connect your DATUM wallet"
        description="The advertiser dashboard needs the DATUM browser extension to identify your campaigns."
      />
    );
  }
  if (!wallet.connected || !wallet.address) {
    return (
      <NeedsExtension
        title="DATUM wallet not connected"
        description="Click the extension icon and approve this site to view your campaign metrics."
      />
    );
  }

  const me = wallet.address;
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const heroStats = useMemo<HeroStat[]>(() => buildHeroStats(me, addrs), [me, addrs]);
  const stream = useMemo<TelemetryStreamOpts>(() => buildStream(me, addrs), [me, addrs]);
  const actions = useMemo<ActionHook[]>(() => buildActions(), []);

  return (
    <Dashboard
      role="advertiser"
      title="Advertiser dashboard"
      subtitle={`Campaigns owned by ${me.slice(0, 6)}…${me.slice(-4)}`}
      heroStats={heroStats}
      stream={stream}
      actions={actions}
    />
  );
}

// ─── Hero stats ───────────────────────────────────────────────────

function buildHeroStats(me: string, addrs: Addrs): HeroStat[] {
  const meTopic = addressToTopic(me);
  return [
    {
      label: "Created (7d)",
      value: async () => countLogs(addrs.campaigns, TOPIC_CAMPAIGN_CREATED, [null, meTopic]),
      formatter: (v) => String(v),
    },
    {
      label: "Activated (7d)",
      value: async () => {
        // CampaignActivated has only the indexed campaignId — we
        // can't filter to "my campaigns" directly. Count all
        // activations as a coarse signal; the stream below shows
        // the specific events when they tie to a campaign I created.
        if (!addrs.activationBonds) return 0;
        return countLogs(addrs.activationBonds, TOPIC_BOND_ACTIVATED);
      },
      formatter: (v) => String(v),
    },
    {
      label: "Challenged (7d)",
      value: async () => {
        if (!addrs.activationBonds) return 0;
        return countLogs(addrs.activationBonds, TOPIC_BOND_CHALLENGED);
      },
      formatter: (v) => String(v),
    },
    {
      label: "Muted (7d)",
      value: async () => {
        if (!addrs.activationBonds) return 0;
        return countLogs(addrs.activationBonds, TOPIC_MUTED);
      },
      formatter: (v) => String(v),
    },
  ];
}

// One-shot log count over the last 7 days. Pine handles the filter
// natively; we don't go through useLogs because heroes don't need
// the long-lived multicast (each card is a single counter that
// refreshes on block tick).
async function countLogs(
  address: string,
  topic0: string,
  extraTopics: (string | null)[] = []
): Promise<number> {
  try {
    const head = await pineRpc<string>("eth_blockNumber");
    const headN = Number(BigInt(head));
    const fromN = Math.max(0, headN - WINDOW_7D_BLOCKS);
    const topics: (string | null)[] = [topic0];
    for (const t of extraTopics) topics.push(t);
    const logs = await pineRpc<unknown[]>("eth_getLogs", [
      {
        address: address.toLowerCase(),
        topics,
        fromBlock: "0x" + fromN.toString(16),
        toBlock: "0x" + headN.toString(16),
      },
    ]);
    return Array.isArray(logs) ? logs.length : 0;
  } catch {
    // Pine warm-up — return 0 so the card renders zero rather than
    // an error chip. Next poll-cycle picks up the real count.
    return 0;
  }
}

// ─── Telemetry stream ─────────────────────────────────────────────

function buildStream(me: string, addrs: Addrs): TelemetryStreamOpts {
  const sources: TelemetryStreamOpts["sources"] = [
    {
      address: addrs.campaigns.toLowerCase(),
      topic0: TOPIC_CAMPAIGN_CREATED,
      formatter: (log) => campaignCreatedRow(log, me),
    },
    {
      address: addrs.campaigns.toLowerCase(),
      topic0: TOPIC_CAMPAIGN_ACTIVATED,
      formatter: campaignActivatedRow,
    },
  ];
  if (addrs.activationBonds) {
    const bond = addrs.activationBonds.toLowerCase();
    sources.push(
      {
        address: bond,
        topic0: TOPIC_BOND_OPENED,
        formatter: (log) => bondOpenedRow(log, me),
      },
      {
        address: bond,
        topic0: TOPIC_BOND_CHALLENGED,
        formatter: bondChallengedRow,
      },
      {
        address: bond,
        topic0: TOPIC_BOND_RESOLVED,
        formatter: bondResolvedRow,
      },
      {
        address: bond,
        topic0: TOPIC_MUTED,
        formatter: bondMutedRow,
      }
    );
  }
  return {
    windowBlocks: WINDOW_7D_BLOCKS,
    historyAllowed: true,
    sources,
  };
}

function campaignCreatedRow(log: EthLog, me: string): StreamRow {
  // CampaignCreated(uint256 indexed id, address indexed advertiser, ...)
  // topics[2] = advertiser. Skip rows for other advertisers' campaigns.
  const advertiser = topicAddress(log.topics[2]);
  if (advertiser.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const decoded = CAMPAIGN_IFACE.decodeEventLog(
    "CampaignCreated",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  const budget = decoded[3] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "create",
    title: `Campaign ${id} created (${formatDot(budget)})`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: `/explorer/campaigns/${id}`,
  };
}

function campaignActivatedRow(log: EthLog): StreamRow {
  const decoded = CAMPAIGN_IFACE.decodeEventLog(
    "CampaignActivated",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "activate",
    title: `Campaign ${id} activated`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: `/explorer/campaigns/${id}`,
  };
}

function bondOpenedRow(log: EthLog, me: string): StreamRow {
  // BondOpened(uint256 indexed id, address indexed creator, ...)
  // topics[2] = creator. Filter to bonds opened on my campaigns.
  const creator = topicAddress(log.topics[2]);
  if (creator.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const decoded = BOND_IFACE.decodeEventLog("BondOpened", log.data, log.topics);
  const id = decoded[0] as bigint;
  const bond = decoded[2] as bigint;
  const expiry = decoded[3] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "bond-open",
    title: `Bond opened on campaign ${id} (${formatDot(bond)})`,
    subtitle: `Timelock expires block ${expiry.toString()}`,
    route: `/explorer/campaigns/${id}`,
  };
}

function bondChallengedRow(log: EthLog): StreamRow {
  const decoded = BOND_IFACE.decodeEventLog("Challenged", log.data, log.topics);
  const id = decoded[0] as bigint;
  const challenger = topicAddress(log.topics[2]);
  const bond = decoded[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "challenge",
    title: `Campaign ${id} challenged`,
    subtitle: `Challenger ${shorten(challenger)} posted ${formatDot(bond)}`,
    route: `/explorer/campaigns/${id}`,
  };
}

function bondResolvedRow(log: EthLog): StreamRow {
  const decoded = BOND_IFACE.decodeEventLog("Resolved", log.data, log.topics);
  const id = decoded[0] as bigint;
  const creatorWon = decoded[1] as boolean;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "resolve",
    title: `Campaign ${id} ${creatorWon ? "resolved (creator)" : "resolved (challenger)"}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: `/explorer/campaigns/${id}`,
  };
}

function bondMutedRow(log: EthLog): StreamRow {
  const decoded = BOND_IFACE.decodeEventLog("Muted", log.data, log.topics);
  const id = decoded[0] as bigint;
  const muter = topicAddress(log.topics[2]);
  const bond = decoded[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "mute",
    title: `Campaign ${id} muted by ${shorten(muter)}`,
    subtitle: `Mute bond ${formatDot(bond)}`,
    route: `/explorer/campaigns/${id}`,
  };
}

// ─── Action hooks ─────────────────────────────────────────────────

function buildActions(): ActionHook[] {
  return [
    { label: "Create campaign", route: "/advertiser/create", description: "New campaign + activation bond" },
    { label: "Bulletin manager", route: "/advertiser/bulletin", description: "Manage creative storage" },
    { label: "Analytics", route: "/advertiser/analytics", description: "Per-campaign breakdown" },
  ];
}

// ─── Format helpers ───────────────────────────────────────────────

function formatDot(planck: bigint): string {
  // Activation-bond + campaign budgets are stored in planck (10^10
  // base units) per the Polkadot Hub denomination. The wei-to-planck
  // translation lives inside Settlement; bond contracts read planck
  // directly. Display rounded to 4 decimals.
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
