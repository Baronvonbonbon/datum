// /publisher dashboard — publisher-operator overview.
//
// Hero stats:
//   - Pending DOT             (PaymentVault.publisherBalance)
//   - Stake / required        (PublisherStake.staked / requiredStake)
//   - Reputation              (PublisherReputation.getReputationScore, bps)
//   - Blocklist status        (Publishers.isBlocked)
//
// Telemetry stream (operator route — historyAllowed: true so we can
// splice in settlements past pine's rolling window via the operator's
// configured RPC endpoint per design §1):
//   - SettlementCredited where publisher == me
//   - PublisherWithdrawal where publisher == me
//   - PageReported where publisher == me  (when DatumReports is wired)
//
// Without a connected wallet: <NeedsExtension>. Same gate as /me.
//
// The legacy dashboard (withdraw flow, tag editing, IPFS profile
// fetch) lives in Dashboard.legacy.tsx; its concerns will fold into
// the new action-hook column during follow-up polish.

import { useMemo } from "react";
import { id as ethersId, Interface } from "ethers";
import { Dashboard, type ActionHook } from "../../components/Dashboard";
import { NeedsExtension } from "../../components/NeedsExtension";
import { useWallet } from "../../hooks/useWallet";
import { type HeroStat } from "../../hooks/useHeroStat";
import { type TelemetryStreamOpts, type StreamRow } from "../../hooks/useTelemetryStream";
import { callContract } from "../../lib/contractRead";
import { type EthLog } from "../../lib/eventBus";
import { NETWORK_CONFIGS } from "../../shared/networks";

const WINDOW_7D_BLOCKS = 14_400 * 7;

const PAYMENT_VAULT_ABI = [
  "function publisherBalance(address) view returns (uint256)",
];
const PUBLISHER_STAKE_ABI = [
  "function staked(address) view returns (uint256)",
  "function requiredStake(address) view returns (uint256)",
];
const PUBLISHER_REPUTATION_ABI = [
  "function getReputationScore(address) view returns (uint16)",
];
const PUBLISHERS_ABI = [
  "function isBlocked(address) view returns (bool)",
];

const TOPIC_SETTLEMENT_CREDITED = ethersId(
  "SettlementCredited(address,address,uint256)"
);
const TOPIC_PUBLISHER_WITHDRAWAL = ethersId(
  "PublisherWithdrawal(address,uint256)"
);
const TOPIC_PAGE_REPORTED = ethersId(
  "PageReported(uint256,address,address,uint8)"
);

const SETTLEMENT_IFACE = new Interface([
  "event SettlementCredited(address indexed publisher, address indexed user, uint256 total)",
]);
const WITHDRAWAL_IFACE = new Interface([
  "event PublisherWithdrawal(address indexed publisher, uint256 amount)",
]);
const REPORT_IFACE = new Interface([
  "event PageReported(uint256 indexed campaignId, address indexed publisher, address indexed reporter, uint8 reason)",
]);

const REPORT_REASONS: Record<number, string> = {
  1: "spam",
  2: "misleading",
  3: "inappropriate",
  4: "illegal",
  5: "other",
};

type Addrs = (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"];

export function PublisherDashboard() {
  const wallet = useWallet();

  if (!wallet.installed) {
    return (
      <NeedsExtension
        title="Connect your DATUM wallet"
        description="The publisher dashboard requires the DATUM browser extension to identify your publisher address."
      />
    );
  }
  if (!wallet.connected || !wallet.address) {
    return (
      <NeedsExtension
        title="DATUM wallet not connected"
        description="Click the extension icon and approve this site to view your publisher metrics."
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
      role="publisher"
      title="Publisher dashboard"
      subtitle={`Publisher address: ${me.slice(0, 6)}…${me.slice(-4)}`}
      heroStats={heroStats}
      stream={stream}
      actions={actions}
    />
  );
}

// ─── Hero stats ───────────────────────────────────────────────────

function buildHeroStats(me: string, addrs: Addrs): HeroStat[] {
  return [
    {
      label: "Pending DOT",
      value: async () =>
        callContract<bigint>({
          address: addrs.paymentVault,
          abi: PAYMENT_VAULT_ABI,
          method: "publisherBalance",
          args: [me],
        }),
      formatter: (v) => formatDot(v as bigint),
      link: "/publisher/earnings",
    },
    {
      label: "Stake",
      value: async () => {
        const [staked, required] = await Promise.all([
          callContract<bigint>({
            address: addrs.publisherStake,
            abi: PUBLISHER_STAKE_ABI,
            method: "staked",
            args: [me],
          }),
          callContract<bigint>({
            address: addrs.publisherStake,
            abi: PUBLISHER_STAKE_ABI,
            method: "requiredStake",
            args: [me],
          }),
        ]);
        // Encode both into one string so the formatter can render
        // "current / required" without a second hook.
        return `${staked.toString()}|${required.toString()}`;
      },
      formatter: (v) => formatStakeRatio(String(v)),
      link: "/publisher/stake",
    },
    {
      label: "Reputation",
      value: async () => {
        if (!addrs.publisherReputation) return 0;
        const score = await callContract<bigint>({
          address: addrs.publisherReputation,
          abi: PUBLISHER_REPUTATION_ABI,
          method: "getReputationScore",
          args: [me],
        });
        return Number(score);
      },
      formatter: (v) => {
        const bps = Number(v);
        if (bps === 0 && !addrs.publisherReputation) return "—";
        return `${(bps / 100).toFixed(1)}%`;
      },
    },
    {
      label: "Status",
      value: async () => {
        const blocked = await callContract<boolean>({
          address: addrs.publishers,
          abi: PUBLISHERS_ABI,
          method: "isBlocked",
          args: [me],
        });
        return blocked ? "blocked" : "active";
      },
      formatter: (v) => (v === "blocked" ? "🚫 Blocked" : "✓ Active"),
    },
  ];
}

// ─── Telemetry stream ─────────────────────────────────────────────

function buildStream(me: string, addrs: Addrs): TelemetryStreamOpts {
  const sources: TelemetryStreamOpts["sources"] = [
    {
      address: addrs.paymentVault.toLowerCase(),
      topic0: TOPIC_SETTLEMENT_CREDITED,
      formatter: (log) => settlementRow(log, me),
    },
    {
      address: addrs.paymentVault.toLowerCase(),
      topic0: TOPIC_PUBLISHER_WITHDRAWAL,
      formatter: (log) => withdrawalRow(log, me),
    },
  ];
  if (addrs.reports) {
    sources.push({
      address: addrs.reports.toLowerCase(),
      topic0: TOPIC_PAGE_REPORTED,
      formatter: (log) => reportRow(log, me),
    });
  }
  // Note on filtering: the per-source object passed into
  // useTelemetryStream doesn't currently forward topic1/topic2
  // through to the eventBus channel — it only carries
  // (address, topic0, formatter). For Stage 4b we filter by indexed
  // publisher in the formatter (returns ts=0 + empty title for
  // non-matching rows, which the Dashboard sorts to the bottom and
  // the 50-row slice drops). A follow-up pass will plumb
  // topic1/topic2 through the slot wrapper for the more efficient
  // server-side filter.
  return {
    windowBlocks: WINDOW_7D_BLOCKS,
    historyAllowed: true,
    sources,
  };
}

function settlementRow(log: EthLog, me: string): StreamRow {
  const publisher = topicAddress(log.topics[1]);
  if (publisher.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const user = topicAddress(log.topics[2]);
  const decoded = SETTLEMENT_IFACE.decodeEventLog(
    "SettlementCredited",
    log.data,
    log.topics
  );
  const total = decoded[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "settlement",
    title: `Earned ${formatDot(total)} from ${shorten(user)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function withdrawalRow(log: EthLog, me: string): StreamRow {
  const publisher = topicAddress(log.topics[1]);
  if (publisher.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const decoded = WITHDRAWAL_IFACE.decodeEventLog(
    "PublisherWithdrawal",
    log.data,
    log.topics
  );
  const amount = decoded[1] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "withdraw",
    title: `Withdrew ${formatDot(amount)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function reportRow(log: EthLog, me: string): StreamRow {
  const publisher = topicAddress(log.topics[2]);
  if (publisher.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const decoded = REPORT_IFACE.decodeEventLog(
    "PageReported",
    log.data,
    log.topics
  );
  const reason = decoded[3] as bigint;
  const reasonLabel = REPORT_REASONS[Number(reason)] ?? `reason ${reason}`;
  const campaignId = decoded[0] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "report",
    title: `Reported (${reasonLabel})`,
    subtitle: `Campaign ${campaignId} · block ${Number(BigInt(log.blockNumber))}`,
  };
}

// ─── Action hooks ─────────────────────────────────────────────────

function buildActions(): ActionHook[] {
  return [
    { label: "Withdraw", route: "/publisher/earnings", description: "Pull settled DOT" },
    { label: "Manage stake", route: "/publisher/stake", description: "Top up or reduce stake" },
    { label: "SDK setup", route: "/publisher/sdk-setup", description: "Embed the snippet" },
    { label: "Tags", route: "/publisher/categories", description: "Set targeting tags" },
  ];
}

// ─── Format helpers ───────────────────────────────────────────────

function formatDot(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  if (wei === 0n) return "0 DOT";
  if (whole === 0n) {
    const padded = frac.toString().padStart(18, "0");
    const trimmed = padded.slice(0, 6).replace(/0+$/, "") || "0";
    return `0.${trimmed} DOT`;
  }
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} DOT` : `${whole} DOT`;
}

function formatStakeRatio(encoded: string): string {
  const [stakedStr, requiredStr] = encoded.split("|");
  const staked = BigInt(stakedStr || "0");
  const required = BigInt(requiredStr || "0");
  if (required === 0n) return formatDot(staked);
  const ratio = Number((staked * 100n) / required);
  return `${formatDot(staked)} (${ratio}% of req)`;
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
  // Approximation — see /me Dashboard.tsx for context. Relative
  // ordering by block number is preserved (which is what the stream
  // sort actually uses). Per-block timestamp batching can land in a
  // follow-up.
  void blockHex;
  return Math.floor(Date.now() / 1000);
}
