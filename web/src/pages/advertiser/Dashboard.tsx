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

import { useMemo } from "react";
import { id as ethersId, Interface } from "ethers";
import { Link } from "react-router-dom";
import { Dashboard, type ActionHook } from "../../components/Dashboard";
import { AnonymousPreviewBanner } from "../../components/AnonymousPreviewBanner";
import { PageExplainer } from "../../components/PageExplainer";
import { ContractsTouched } from "../../components/ContractsTouched";
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
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;
  const me = wallet.address ?? null;
  const anonymous = !me;

  const heroStats = useMemo<HeroStat[]>(
    () => (anonymous ? [] : buildHeroStats(me!, addrs)),
    [anonymous, me, addrs]
  );
  const stream = useMemo<TelemetryStreamOpts>(
    () => (anonymous ? buildGlobalStream(addrs) : buildStream(me!, addrs)),
    [anonymous, me, addrs]
  );
  const actions = useMemo<ActionHook[]>(() => buildActions(), []);

  return (
    <>
      {anonymous && <AnonymousPreviewBanner surface="advertiser" />}
      <PageExplainer slug="advertiser-dashboard" title="What is the Advertiser dashboard?">
        <p style={{ margin: 0 }}>
          Where you create, fund, and operate ad campaigns. The hero cards
          show your activity over the last 7 days — campaigns created,
          activated, challenged, and muted. The stream below tracks campaign
          lifecycle and bond events; click any row to jump to the campaign
          page.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          Want the full breakdown? <Link to="/about/advertiser">About: Advertiser →</Link>
        </p>
      </PageExplainer>

      {/* Setup walkthrough — distinct from the Publisher path, advertisers
          have no separate registration step on the current Paseo deploy. */}
      {!anonymous && (
        <div className="nano-card" style={{ padding: 14, margin: "12px 0 16px", borderColor: "var(--accent)" }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Setup walkthrough</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
            There is no separate "register advertiser" step on this deploy — a connected wallet
            with PAS can create a campaign directly. The advertiser-stake contract
            (<code>DatumAdvertiserStake</code>) is deployed but not yet wired into Campaigns on
            Paseo, so the on-chain gate is disabled here. Mainnet will require staking.
          </div>
          <ol style={{ paddingLeft: 18, margin: 0, color: "var(--text)", fontSize: 12, lineHeight: 1.9 }}>
            <li><span style={{ display: "inline-block", width: 14 }}>✓</span>Wallet connected <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>required</span></li>
            <li><span style={{ display: "inline-block", width: 14 }}>—</span>Brand metadata via <Link to="/me/branding" style={{ color: "inherit" }}>/me/branding</Link> <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>recommended</span></li>
            <li><span style={{ display: "inline-block", width: 14 }}>○</span><Link to="/advertiser/create" style={{ color: "inherit" }}>Create your first campaign</Link> — set budget, CPM, optional bond, optional ERC-20 reward sidecar <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>required</span></li>
            <li><span style={{ display: "inline-block", width: 14 }}>○</span>Pin creative metadata to IPFS via <Link to="/advertiser/create" style={{ color: "inherit" }}>Set Metadata</Link> after creation <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>required</span></li>
            <li><span style={{ display: "inline-block", width: 14 }}>○</span>Optional: register a Bulletin Chain creative via <Link to="/advertiser" style={{ color: "inherit" }}>Bulletin Manager</Link> <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>optional</span></li>
          </ol>
        </div>
      )}
      <Dashboard
        role="advertiser"
        title="Advertiser dashboard"
        subtitle={
          anonymous
            ? "Preview mode — connect a DATUM wallet to personalize"
            : `Campaigns owned by ${me!.slice(0, 6)}…${me!.slice(-4)}`
        }
        heroStats={heroStats}
        stream={stream}
        actions={actions}
      />
      <ContractsTouched contracts={[
        "campaigns",
        "budgetLedger",
        "challengeBonds",
        "activationBonds",
        "campaignAllowlist",
        "tokenRewardVault",
        "lifecycle",
      ]} />
    </>
  );
}

// Global stream — system-wide campaign + bond events, unfiltered.
function buildGlobalStream(addrs: Addrs): TelemetryStreamOpts {
  const sources: TelemetryStreamOpts["sources"] = [
    {
      address: addrs.campaigns.toLowerCase(),
      topic0: TOPIC_CAMPAIGN_CREATED,
      formatter: globalCampaignCreatedRow,
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
      { address: bond, topic0: TOPIC_BOND_OPENED, formatter: globalBondOpenedRow },
      { address: bond, topic0: TOPIC_BOND_CHALLENGED, formatter: bondChallengedRow },
      { address: bond, topic0: TOPIC_BOND_RESOLVED, formatter: bondResolvedRow },
      { address: bond, topic0: TOPIC_MUTED, formatter: bondMutedRow }
    );
  }
  return {
    windowBlocks: WINDOW_7D_BLOCKS,
    historyAllowed: true,
    sources,
  };
}

function globalCampaignCreatedRow(log: EthLog): StreamRow {
  const id = BigInt(log.topics[1] ?? "0x0");
  const advertiser = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "campaign-created",
    title: `Campaign #${id} created`,
    subtitle: `Advertiser ${shorten(advertiser)}`,
    route: `/campaigns/${id}`,
  };
}

function globalBondOpenedRow(log: EthLog): StreamRow {
  const id = BigInt(log.topics[1] ?? "0x0");
  const creator = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "bond-open",
    title: `Bond opened for campaign #${id}`,
    subtitle: `Creator ${shorten(creator)}`,
    route: "/governance/activation-bonds",
  };
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
    { label: "View campaigns", route: "/campaigns", description: "Browse every active campaign on-chain" },
    { label: "Analytics", route: "/advertiser/analytics", description: "Per-campaign breakdown" },
    { label: "Cosign batch", route: "/advertiser/cosign", description: "EIP-712 cosign a publisher-signed batch (dual-sig path)" },
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
