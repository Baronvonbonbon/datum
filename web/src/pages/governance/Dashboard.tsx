// /governance dashboard — protocol-wide overview for voters,
// council members, and observers. Public route — no wallet required;
// signing-only actions (vote, file appeal, etc.) are gated downstream
// on the per-action pages.
//
// Hero stats:
//   - Phase + governor address (Router.phase + Router.governor)
//   - Active campaigns in vote        (count of Pending campaigns
//     this is tricky without a "list" view — proxied via
//     CommitRevealWindowOpened in the 7d window)
//   - Council blocklist appeals open  (count of BlocklistAppealFiled
//     minus BlocklistAppealResolved)
//   - Parameter retunes (7d)          (RetuneGuarded log count across
//     guarded contracts)
//
// Telemetry stream:
//   - GovernanceV2: VoteCast, CampaignEvaluated, OwnerSweepQueued
//   - Router: PhaseTransitioned, HighTierProposed, HighTierExecuted,
//     HighTierVetoed
//   - CouncilBlocklistCurator: AddrBlocked, BlocklistAppealFiled,
//     BlocklistAppealResolved
//   - ActivationBonds: BondOpened (high-level signal of new
//     campaigns entering the pipeline)

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

const ROUTER_ABI = [
  "function phase() view returns (uint8)",
  "function governor() view returns (address)",
];

const TOPIC_VOTE_CAST = ethersId("VoteCast(uint256,address,bool,uint256,uint8)");
const TOPIC_CAMPAIGN_EVALUATED = ethersId("CampaignEvaluated(uint256,uint8)");
const TOPIC_COMMIT_REVEAL_OPENED = ethersId(
  "CommitRevealWindowOpened(uint256,uint64,uint64)"
);
const TOPIC_PHASE_TRANSITIONED = ethersId(
  "PhaseTransitioned(uint8,address)"
);
const TOPIC_HIGH_TIER_PROPOSED = ethersId(
  "HighTierProposed(uint256,address,uint256)"
);
const TOPIC_HIGH_TIER_EXECUTED = ethersId(
  "HighTierExecuted(uint256,bool,bytes)"
);
const TOPIC_HIGH_TIER_VETOED = ethersId("HighTierVetoed(uint256)");
const TOPIC_BOND_OPENED = ethersId(
  "BondOpened(uint256,address,uint256,uint64)"
);
const TOPIC_ADDR_BLOCKED = ethersId("AddrBlocked(address,bytes32)");
const TOPIC_BLOCKLIST_APPEAL_FILED = ethersId(
  "BlocklistAppealFiled(uint256,address,address,bytes32,uint256)"
);
const TOPIC_BLOCKLIST_APPEAL_RESOLVED = ethersId(
  "BlocklistAppealResolved(uint256,address,bool,uint256)"
);
const TOPIC_RETUNE_GUARDED = ethersId(
  "RetuneGuarded(bytes32,uint256,uint256)"
);
const TOPIC_ADV_FRAUD_PROPOSED = ethersId(
  "AdvertiserFraudProposed(uint256,address,address,bytes32)"
);
const TOPIC_PUB_FRAUD_PROPOSED = ethersId(
  "ProposalCreated(uint256,address,bytes32)"
);

const GOV_IFACE = new Interface([
  "event VoteCast(uint256 indexed campaignId, address indexed voter, bool aye, uint256 amount, uint8 conviction)",
  "event CampaignEvaluated(uint256 indexed campaignId, uint8 result)",
]);
const ROUTER_IFACE = new Interface([
  "event PhaseTransitioned(uint8 indexed newPhase, address indexed newGovernor)",
  "event HighTierProposed(uint256 indexed id, address indexed target, uint256 executableAfterBlock)",
  "event HighTierExecuted(uint256 indexed id, bool success, bytes returndata)",
  "event HighTierVetoed(uint256 indexed id)",
]);
const BOND_IFACE = new Interface([
  "event BondOpened(uint256 indexed campaignId, address indexed creator, uint256 bond, uint64 timelockExpiry)",
]);
const FRAUD_IFACE = new Interface([
  "event AdvertiserFraudProposed(uint256 indexed id, address indexed advertiser, address indexed proposer, bytes32 evidenceHash)",
  "event ProposalCreated(uint256 indexed proposalId, address indexed publisher, bytes32 evidenceHash)",
]);
const BLOCKLIST_IFACE = new Interface([
  "event AddrBlocked(address indexed addr, bytes32 reasonHash)",
  "event BlocklistAppealFiled(uint256 indexed appealId, address indexed appellant, address indexed blockedAddr, bytes32 evidenceHash, uint256 bond)",
  "event BlocklistAppealResolved(uint256 indexed appealId, address indexed blockedAddr, bool upheld, uint256 bondDisposition)",
]);

const PHASE_NAMES: Record<number, string> = {
  0: "Admin",
  1: "Council",
  2: "OpenGov",
};
const VOTE_RESULTS: Record<number, string> = {
  0: "Pending",
  1: "Active",
  2: "Rejected",
  3: "Completed",
  4: "Terminated",
  5: "Expired",
};

type Addrs = (typeof NETWORK_CONFIGS)["polkadotTestnet"]["addresses"];

export function GovernanceDashboard() {
  const addrs = NETWORK_CONFIGS.polkadotTestnet.addresses;

  const heroStats = useMemo<HeroStat[]>(() => buildHeroStats(addrs), [addrs]);
  const stream = useMemo<TelemetryStreamOpts>(() => buildStream(addrs), [addrs]);
  const actions = useMemo<ActionHook[]>(() => buildActions(), []);

  return (
    <>
      <PageExplainer slug="governance-dashboard" title="What is Governance?">
        <p style={{ margin: 0 }}>
          DATUM governance is conviction-weighted, multi-track, and phased.
          The hero cards show the current phase (0 = Admin, 1 = Council,
          2 = OpenGov), open council appeals, and parameter retunes from
          the last 7 days. The stream below records every vote, every
          high-tier router proposal, and every appeal as it's filed and
          resolved.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          Want the full breakdown? <Link to="/about/governance">About: Governance →</Link>{" "}
          ·{" "}
          See the per-contract phase status: <Link to="/governance/phase-ladder">Phase Ladder →</Link>
        </p>
      </PageExplainer>
      <Dashboard
        role="governance"
        title="Governance"
        subtitle="Protocol-wide voting, council appeals, and parameter tuning."
        heroStats={heroStats}
        stream={stream}
        actions={actions}
      />
      <ContractsTouched contracts={[
        "governanceV2",
        "governanceRouter",
        "council",
        "timelock",
        "parameterGovernance",
        "publisherGovernance",
        "advertiserGovernance",
        "activationBonds",
        "blocklistCurator",
      ]} />
    </>
  );
}

// ─── Hero stats ───────────────────────────────────────────────────

function buildHeroStats(addrs: Addrs): HeroStat[] {
  return [
    {
      label: "Phase",
      value: async () => {
        const phase = await callContract<bigint>({
          address: addrs.governanceRouter,
          abi: ROUTER_ABI,
          method: "phase",
        });
        const gov = await callContract<string>({
          address: addrs.governanceRouter,
          abi: ROUTER_ABI,
          method: "governor",
        });
        return `${Number(phase)}|${gov.toLowerCase()}`;
      },
      formatter: (v) => {
        const [phaseStr, gov] = String(v).split("|");
        const name = PHASE_NAMES[Number(phaseStr)] ?? `Phase ${phaseStr}`;
        return `${name} (${shorten(gov)})`;
      },
      link: "/governance/phase-ladder",
    },
    {
      label: "Vote windows (7d)",
      value: async () =>
        countLogs(addrs.governanceV2, TOPIC_COMMIT_REVEAL_OPENED),
      formatter: (v) => String(v),
    },
    {
      label: "Council appeals (7d)",
      value: async () => {
        if (!addrs.blocklistCurator) return 0;
        const [filed, resolved] = await Promise.all([
          countLogs(addrs.blocklistCurator, TOPIC_BLOCKLIST_APPEAL_FILED),
          countLogs(addrs.blocklistCurator, TOPIC_BLOCKLIST_APPEAL_RESOLVED),
        ]);
        // Open ≈ filed − resolved in the same window. Negative
        // values clamp to zero (we'd miss earlier "filed" events
        // that resolved within the window).
        return Math.max(0, filed - resolved);
      },
      formatter: (v) => String(v),
      link: "/governance/council",
    },
    {
      label: "Param retunes (7d)",
      value: async () => {
        // RetuneGuarded fires on every guarded setter call across
        // ~7 contracts (GovernanceV2, PublisherGov, AdvertiserGov,
        // RelayGov, MintCoordinator). We sum across the ones whose
        // addresses are known.
        const contracts: (string | undefined)[] = [
          addrs.governanceV2,
          addrs.publisherGovernance,
          addrs.relayGovernance,
          addrs.mintCoordinator,
        ];
        const counts = await Promise.all(
          contracts.map((addr) =>
            addr ? countLogs(addr, TOPIC_RETUNE_GUARDED) : Promise.resolve(0)
          )
        );
        return counts.reduce((a, b) => a + b, 0);
      },
      formatter: (v) => String(v),
      link: "/governance/parameters",
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

// ─── Telemetry stream ─────────────────────────────────────────────

function buildStream(addrs: Addrs): TelemetryStreamOpts {
  const sources: TelemetryStreamOpts["sources"] = [
    {
      address: addrs.governanceV2.toLowerCase(),
      topic0: TOPIC_VOTE_CAST,
      formatter: voteCastRow,
    },
    {
      address: addrs.governanceV2.toLowerCase(),
      topic0: TOPIC_CAMPAIGN_EVALUATED,
      formatter: campaignEvaluatedRow,
    },
    {
      address: addrs.governanceRouter.toLowerCase(),
      topic0: TOPIC_PHASE_TRANSITIONED,
      formatter: phaseTransitionedRow,
    },
    {
      address: addrs.governanceRouter.toLowerCase(),
      topic0: TOPIC_HIGH_TIER_PROPOSED,
      formatter: highTierProposedRow,
    },
    {
      address: addrs.governanceRouter.toLowerCase(),
      topic0: TOPIC_HIGH_TIER_EXECUTED,
      formatter: highTierExecutedRow,
    },
  ];
  if (addrs.activationBonds) {
    sources.push({
      address: addrs.activationBonds.toLowerCase(),
      topic0: TOPIC_BOND_OPENED,
      formatter: bondOpenedRow,
    });
  }
  if (addrs.advertiserGovernance) {
    sources.push({
      address: addrs.advertiserGovernance.toLowerCase(),
      topic0: TOPIC_ADV_FRAUD_PROPOSED,
      formatter: advertiserFraudProposedRow,
    });
  }
  if (addrs.publisherGovernance) {
    sources.push({
      address: addrs.publisherGovernance.toLowerCase(),
      topic0: TOPIC_PUB_FRAUD_PROPOSED,
      formatter: publisherFraudProposedRow,
    });
  }
  if (addrs.blocklistCurator) {
    sources.push(
      {
        address: addrs.blocklistCurator.toLowerCase(),
        topic0: TOPIC_ADDR_BLOCKED,
        formatter: addrBlockedRow,
      },
      {
        address: addrs.blocklistCurator.toLowerCase(),
        topic0: TOPIC_BLOCKLIST_APPEAL_FILED,
        formatter: blocklistAppealRow,
      }
    );
  }
  return {
    windowBlocks: WINDOW_7D_BLOCKS,
    historyAllowed: true,
    sources,
  };
}

function voteCastRow(log: EthLog): StreamRow {
  const decoded = GOV_IFACE.decodeEventLog("VoteCast", log.data, log.topics);
  const campaignId = decoded[0] as bigint;
  const voter = topicAddress(log.topics[2]);
  const aye = decoded[2] as boolean;
  const conviction = decoded[4] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "vote",
    title: `${aye ? "Aye" : "Nay"} on campaign ${campaignId} (conviction ${conviction})`,
    subtitle: `Voter ${shorten(voter)} · block ${Number(BigInt(log.blockNumber))}`,
    route: `/governance/vote/${campaignId}`,
  };
}

function campaignEvaluatedRow(log: EthLog): StreamRow {
  const decoded = GOV_IFACE.decodeEventLog(
    "CampaignEvaluated",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  const result = decoded[1] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "evaluate",
    title: `Campaign ${id} evaluated → ${VOTE_RESULTS[Number(result)] ?? `status ${result}`}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: `/explorer/campaigns/${id}`,
  };
}

function phaseTransitionedRow(log: EthLog): StreamRow {
  const decoded = ROUTER_IFACE.decodeEventLog(
    "PhaseTransitioned",
    log.data,
    log.topics
  );
  const phase = decoded[0] as bigint;
  const gov = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "phase",
    title: `Phase transitioned → ${PHASE_NAMES[Number(phase)] ?? phase}`,
    subtitle: `New governor ${shorten(gov)}`,
    route: "/governance/phase-ladder",
  };
}

function highTierProposedRow(log: EthLog): StreamRow {
  const decoded = ROUTER_IFACE.decodeEventLog(
    "HighTierProposed",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  const target = topicAddress(log.topics[2]);
  const after = decoded[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "high-tier-proposed",
    title: `High-tier #${id} proposed → ${shorten(target)}`,
    subtitle: `Executable at block ${after.toString()}`,
    route: "/governance/council",
  };
}

function highTierExecutedRow(log: EthLog): StreamRow {
  const decoded = ROUTER_IFACE.decodeEventLog(
    "HighTierExecuted",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  const success = decoded[1] as boolean;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "high-tier-exec",
    title: `High-tier #${id} ${success ? "executed" : "execution failed"}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
  };
}

function advertiserFraudProposedRow(log: EthLog): StreamRow {
  const decoded = FRAUD_IFACE.decodeEventLog(
    "AdvertiserFraudProposed",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  const advertiser = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "fraud-adv-proposed",
    title: `Advertiser fraud proposal #${id} → ${shorten(advertiser)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: "/governance/advertiser-fraud",
  };
}

function publisherFraudProposedRow(log: EthLog): StreamRow {
  const decoded = FRAUD_IFACE.decodeEventLog(
    "ProposalCreated",
    log.data,
    log.topics
  );
  const id = decoded[0] as bigint;
  const publisher = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "fraud-pub-proposed",
    title: `Publisher fraud proposal #${id} → ${shorten(publisher)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: "/governance/publisher-fraud",
  };
}

function bondOpenedRow(log: EthLog): StreamRow {
  const decoded = BOND_IFACE.decodeEventLog("BondOpened", log.data, log.topics);
  const id = decoded[0] as bigint;
  const creator = topicAddress(log.topics[2]);
  const bond = decoded[2] as bigint;
  return {
    ts: tsForBlock(log.blockNumber),
    type: "bond-open",
    title: `Campaign ${id} bond opened`,
    subtitle: `Creator ${shorten(creator)} · ${formatDot(bond)} · open for challenge`,
    route: "/governance/activation-bonds",
  };
}

function addrBlockedRow(log: EthLog): StreamRow {
  const blocked = topicAddress(log.topics[1]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "blocked",
    title: `Council blocked ${shorten(blocked)}`,
    subtitle: `Block ${Number(BigInt(log.blockNumber))}`,
    route: "/governance/council",
  };
}

function blocklistAppealRow(log: EthLog): StreamRow {
  const decoded = BLOCKLIST_IFACE.decodeEventLog(
    "BlocklistAppealFiled",
    log.data,
    log.topics
  );
  const appealId = decoded[0] as bigint;
  const appellant = topicAddress(log.topics[2]);
  return {
    ts: tsForBlock(log.blockNumber),
    type: "appeal",
    title: `Blocklist appeal #${appealId} filed`,
    subtitle: `Appellant ${shorten(appellant)}`,
    route: "/governance/council",
  };
}

// ─── Action hooks ─────────────────────────────────────────────────

function buildActions(): ActionHook[] {
  return [
    { label: "Active campaigns", route: "/campaigns", description: "Browse campaigns currently in vote" },
    { label: "My votes", route: "/governance/my-votes", description: "Locked DOT + withdraw" },
    { label: "Activation bonds", route: "/governance/activation-bonds", description: "Contest / activate pending campaigns" },
    { label: "Advertiser fraud", route: "/governance/advertiser-fraud", description: "Slash fraudulent advertisers" },
    { label: "Publisher fraud", route: "/governance/publisher-fraud", description: "Slash fraudulent publishers" },
    { label: "Council", route: "/governance/council", description: "Blocklist + tag appeals" },
    { label: "Parameters", route: "/governance/parameters", description: "Per-contract tuning" },
    { label: "Phase ladder", route: "/governance/phase-ladder", description: "Admin → Council → OpenGov" },
  ];
}

// ─── Format helpers ───────────────────────────────────────────────

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
