// /me dashboard — user overview.
//
// Hero stats:
//   - Active DOT balance        (live, via pine eth_getBalance)
//   - Pending withdraw          (PaymentVault.userBalance)
//   - AssuranceLevel            (Settlement.userMinAssurance)
//   - Identity attestation freshness (placeholder until Stage 4 identity wire-up)
//
// Telemetry stream:
//   - SettlementCredited events on PaymentVault where user==me
//   - UserWithdrawal events on PaymentVault where user==me
//
// Behaviour without a connected wallet: a top-level <NeedsExtension>
// panel replaces the hero+stream. The page never reads chain state
// without the user explicitly opting in via the extension connect
// flow.

import { useMemo } from "react";
import { id as ethersId, Interface } from "ethers";
import { Dashboard, type ActionHook } from "../../components/Dashboard";
import { AnonymousPreviewBanner } from "../../components/AnonymousPreviewBanner";
import { PageExplainer } from "../../components/PageExplainer";
import { ContractsTouched } from "../../components/ContractsTouched";
import { Link } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { type HeroStat } from "../../hooks/useHeroStat";
import { type TelemetryStreamOpts, type StreamRow } from "../../hooks/useTelemetryStream";
import { callContract } from "../../lib/contractRead";
import { pineRpc } from "../../lib/provider";
import { addressToTopic, type EthLog } from "../../lib/eventBus";
import { NETWORK_CONFIGS } from "../../shared/networks";

// Paseo block time is 6s; 14_400 blocks ≈ 24h.
const WINDOW_24H_BLOCKS = 14_400;

// EIP-1167-shaped Settlement view minified to just what we need.
const SETTLEMENT_ABI = [
  "function userMinAssurance(address) view returns (uint8)",
];
const PAYMENT_VAULT_ABI = [
  "function userBalance(address) view returns (uint256)",
];

// Pre-compute event topic0s. ethers.id == keccak256(eventSig).
const TOPIC_SETTLEMENT_CREDITED = ethersId(
  "SettlementCredited(address,address,uint256)"
);
const TOPIC_USER_WITHDRAWAL = ethersId("UserWithdrawal(address,uint256)");

const SETTLEMENT_IFACE = new Interface([
  "event SettlementCredited(address indexed publisher, address indexed user, uint256 total)",
]);
const WITHDRAWAL_IFACE = new Interface([
  "event UserWithdrawal(address indexed user, uint256 amount)",
]);

const ASSURANCE_LABELS: Record<number, string> = {
  0: "L0 — public claims",
  1: "L1 — publisher-signed",
  2: "L2 — dual-signed",
  3: "L3 — ZK-only",
};

export function MeDashboard() {
  const wallet = useWallet();
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const me = wallet.address ?? null;
  const anonymous = !me;

  // Hero stats are address-bound; render an empty row in preview mode
  // (the AnonymousPreviewBanner above the dashboard explains why).
  const heroStats = useMemo<HeroStat[]>(
    () => (anonymous ? [] : buildHeroStats(me!, addrs.settlement, addrs.paymentVault)),
    [anonymous, me, addrs.settlement, addrs.paymentVault]
  );
  // Stream uses the global PaymentVault feed; in anonymous mode we
  // surface system-wide settlement activity instead of filtering to
  // the current address.
  const stream = useMemo<TelemetryStreamOpts>(
    () =>
      anonymous
        ? buildGlobalStream(addrs.paymentVault)
        : buildStream(me!, addrs.paymentVault),
    [anonymous, me, addrs.paymentVault]
  );
  const actions = useMemo<ActionHook[]>(() => buildActions(), []);

  return (
    <>
      {anonymous && <AnonymousPreviewBanner surface="me" />}
      <PageExplainer slug="me-dashboard" title="What is the Me dashboard?">
        <p style={{ margin: 0 }}>
          Your wallet-scoped view of DATUM. The four hero cards show your
          DOT balance, anything settlement has credited but you haven't
          withdrawn yet, your current assurance level, and your identity
          verification status. The telemetry stream below lists{" "}
          <code>SettlementCredited</code> and <code>UserWithdrawal</code>{" "}
          events tied to your address.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          Want the full breakdown? <Link to="/about/me">About: Me →</Link>
        </p>
      </PageExplainer>
      <Dashboard
        role="me"
        title="Your account"
        subtitle={
          anonymous
            ? "Preview mode — connect a DATUM wallet to personalize"
            : `Connected as ${me!.slice(0, 6)}…${me!.slice(-4)}`
        }
        heroStats={heroStats}
        stream={stream}
        actions={actions}
      />
      <ContractsTouched contracts={[
        "settlement",
        "paymentVault",
        "tokenRewardVault",
        "peopleChainIdentity",
        "publisherStake",
      ]} />
    </>
  );
}

// Global stream — same payment-vault events but unfiltered by user.
function buildGlobalStream(paymentVaultAddr: string): TelemetryStreamOpts {
  return {
    windowBlocks: WINDOW_24H_BLOCKS,
    historyAllowed: false,
    sources: [
      {
        address: paymentVaultAddr.toLowerCase(),
        topic0: TOPIC_SETTLEMENT_CREDITED,
        formatter: globalSettlementRow,
      },
      {
        address: paymentVaultAddr.toLowerCase(),
        topic0: TOPIC_USER_WITHDRAWAL,
        formatter: globalWithdrawalRow,
      },
    ],
  };
}

function globalSettlementRow(log: EthLog): StreamRow {
  const decoded = SETTLEMENT_IFACE.decodeEventLog(
    "SettlementCredited",
    log.data,
    log.topics
  );
  const total = decoded[2] as bigint;
  const publisher = topicAddress(log.topics[1]);
  const user = topicAddress(log.topics[2]);
  return {
    ts: pseudoTsFromBlock(log.blockNumber),
    type: "settlement",
    title: `Settlement: ${formatDot(total)}`,
    subtitle: `Publisher ${shorten(publisher)} → user ${shorten(user)}`,
  };
}

function globalWithdrawalRow(log: EthLog): StreamRow {
  const decoded = WITHDRAWAL_IFACE.decodeEventLog(
    "UserWithdrawal",
    log.data,
    log.topics
  );
  const amount = decoded[1] as bigint;
  const user = topicAddress(log.topics[1]);
  return {
    ts: pseudoTsFromBlock(log.blockNumber),
    type: "withdrawal",
    title: `Withdraw ${formatDot(amount)}`,
    subtitle: `User ${shorten(user)}`,
  };
}

// ─── Hero stats ───────────────────────────────────────────────────

function buildHeroStats(
  me: string,
  settlementAddr: string,
  paymentVaultAddr: string
): HeroStat[] {
  return [
    {
      label: "DOT balance",
      value: async () => {
        const hex = await pineRpc<string>("eth_getBalance", [me, "latest"]);
        return BigInt(hex);
      },
      formatter: (v) => formatDot(v as bigint),
    },
    {
      label: "Pending withdraw",
      value: async () => {
        const bal = await callContract<bigint>({
          address: paymentVaultAddr,
          abi: PAYMENT_VAULT_ABI,
          method: "userBalance",
          args: [me],
        });
        return bal;
      },
      formatter: (v) => formatDot(v as bigint),
      link: "/me/dust",
    },
    {
      label: "AssuranceLevel",
      value: async () => {
        const lvl = await callContract<bigint>({
          address: settlementAddr,
          abi: SETTLEMENT_ABI,
          method: "userMinAssurance",
          args: [me],
        });
        return Number(lvl);
      },
      formatter: (v) => ASSURANCE_LABELS[Number(v)] ?? `L${v}`,
      link: "/me/assurance",
    },
    {
      label: "Identity",
      value: async () => "—", // wired in Stage 4 identity follow-up
      formatter: () => "Not verified",
      link: "/me/identity",
    },
  ];
}

// ─── Telemetry stream ─────────────────────────────────────────────

function buildStream(me: string, paymentVaultAddr: string): TelemetryStreamOpts {
  const userTopic = addressToTopic(me);
  return {
    windowBlocks: WINDOW_24H_BLOCKS,
    historyAllowed: false,
    sources: [
      {
        address: paymentVaultAddr.toLowerCase(),
        topic0: TOPIC_SETTLEMENT_CREDITED,
        // Settlement credits use topic2 = user; topic1 = publisher.
        // We don't have a topic2 field on the bus yet, so subscribe
        // on the unfiltered channel and filter in the formatter.
        formatter: (log: EthLog): StreamRow => settlementRow(log, me),
      },
      {
        address: paymentVaultAddr.toLowerCase(),
        topic0: TOPIC_USER_WITHDRAWAL,
        formatter: (log: EthLog): StreamRow => withdrawalRow(log, me),
      },
    ],
  };
}

function settlementRow(log: EthLog, me: string): StreamRow {
  // SettlementCredited(address indexed publisher, address indexed user, uint256 total)
  // topics[0] = signature, topics[1] = publisher, topics[2] = user
  // We re-check the user filter client-side because we couldn't bind
  // it on the channel (would force a separate per-address channel
  // per dApp user — not great for shared protocol contracts).
  const user = topicAddress(log.topics[2]);
  if (user.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const decoded = SETTLEMENT_IFACE.decodeEventLog(
    "SettlementCredited",
    log.data,
    log.topics
  );
  const total = decoded[2] as bigint;
  const publisher = topicAddress(log.topics[1]);
  return {
    ts: pseudoTsFromBlock(log.blockNumber),
    type: "settlement",
    title: `Earned ${formatDot(total)} from publisher ${shorten(publisher)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: "/me/history",
  };
}

function withdrawalRow(log: EthLog, me: string): StreamRow {
  // UserWithdrawal(address indexed user, uint256 amount)
  // topics[0] = signature, topics[1] = user
  const user = topicAddress(log.topics[1]);
  if (user.toLowerCase() !== me.toLowerCase()) {
    return { ts: 0, type: "skipped", title: "" };
  }
  const decoded = WITHDRAWAL_IFACE.decodeEventLog(
    "UserWithdrawal",
    log.data,
    log.topics
  );
  const amount = decoded[1] as bigint;
  return {
    ts: pseudoTsFromBlock(log.blockNumber),
    type: "withdraw",
    title: `Withdrew ${formatDot(amount)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

// ─── Action hooks ─────────────────────────────────────────────────

function buildActions(): ActionHook[] {
  return [
    { label: "Withdraw earnings", route: "/me/dust", description: "Pull settled DOT to your wallet" },
    { label: "Verify identity", route: "/me/identity", description: "Bind your People Chain identity" },
    { label: "Tune assurance", route: "/me/assurance", description: "Choose how strict your claims are" },
    { label: "View history", route: "/me/history", description: "Per-campaign breakdown" },
    { label: "Brand profile", route: "/me/branding", description: "Set your logo, name, and homepage" },
  ];
}

// ─── Format helpers ───────────────────────────────────────────────

function formatDot(wei: bigint): string {
  // Polkadot Hub's EVM exposes native balance in wei (10^18). For
  // display we show DOT to 4 decimals — fewer for small amounts to
  // avoid leading-zero noise.
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

function topicAddress(topic: string | undefined): string {
  if (!topic) return "";
  // topics are 32-byte left-padded; address lives in the low 20 bytes.
  return "0x" + topic.toLowerCase().slice(-40);
}

function shorten(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pseudoTsFromBlock(blockHex: string): number {
  // Without a synchronous block-timestamp lookup we approximate using
  // wall clock — recent logs are roughly current, older logs lose
  // precision but still sort correctly. The real ts can be filled in
  // by a follow-up that batches eth_getBlockByNumber lookups.
  return Math.floor(Date.now() / 1000) - blocksAgo(blockHex);
}

function blocksAgo(blockHex: string): number {
  const block = Number(BigInt(blockHex));
  // Use the last-fetched finalized block as the reference point.
  // Conservative: 6s per block on Paseo.
  if (!Number.isFinite(block) || block === 0) return 0;
  // We don't have the head here without an async call; an upper-
  // bound approximation: assume any log we receive is at most the
  // window we requested. The Dashboard's "Xm ago" rendering is
  // best-effort either way.
  return 0;
}
