// Timelock-routed governable setters.
//
// Parallel structure to parameterCatalog.ts but for setters that live on
// Timelock-owned contracts (Campaigns / Settlement / Publishers / Router).
// Calls go through the Timelock multi-proposal flow:
//   timelock.propose(target, calldata, salt) → 48h delay → timelock.execute(id)
//
// The Timelock has no whitelist (it's the ultimate admin), but the UI
// benefits from the same structured propose form + current-value display.

import { Interface } from "ethers";

export type TLContractKey =
  | "campaigns"
  | "settlement"
  | "publishers"
  | "governanceRouter";

export type TLArgKind =
  | "uint256-blocks"
  | "uint256-bps"
  | "uint256-planck"
  | "uint256-count"
  | "uint16-bps"
  | "uint16-count"
  | "uint8-enum"
  | "address"
  | "bool"
  | "bytes32";

export interface TLArg {
  name: string;
  kind: TLArgKind;
  description: string;
  enumLabels?: string[];   // for uint8-enum
}

export interface TLSetter {
  contractKey: TLContractKey;
  contractLabel: string;
  fnName: string;
  signature: string;
  abi: string;
  description: string;
  args: TLArg[];
  /** view function names on the same contract returning current values, aligned by index. */
  currentGetters: (string | null)[];
}

export const TIMELOCK_CATALOG: TLSetter[] = [
  // ── DatumCampaigns ─────────────────────────────────────────────────────
  {
    contractKey: "campaigns",
    contractLabel: "Campaigns",
    fnName: "setMaxCampaignBudget",
    signature: "setMaxCampaignBudget(uint256)",
    abi: "function setMaxCampaignBudget(uint256 amount)",
    description:
      "Cap on per-campaign DOT budget. 0 disables the cap entirely. Bounds runaway campaigns during early rollout.",
    args: [{ name: "amount", kind: "uint256-planck", description: "Max budget per campaign in planck. 0 = unlimited." }],
    currentGetters: ["maxCampaignBudget"],
  },
  {
    contractKey: "campaigns",
    contractLabel: "Campaigns",
    fnName: "setEnforceTagRegistry",
    signature: "setEnforceTagRegistry(bool)",
    abi: "function setEnforceTagRegistry(bool enforced)",
    description:
      "When enabled, only tags pre-approved via approveTag are valid for createCampaign / setPublisherTags. Disabled = free-form tags.",
    args: [{ name: "enforced", kind: "bool", description: "true = restrict to approved tag set; false = open." }],
    currentGetters: ["enforceTagRegistry"],
  },
  {
    contractKey: "campaigns",
    contractLabel: "Campaigns",
    fnName: "setDefaultTakeRateBps",
    signature: "setDefaultTakeRateBps(uint16)",
    abi: "function setDefaultTakeRateBps(uint16 bps)",
    description:
      "Take rate snapshotted into open campaigns (publisher = 0x0). Bounded 30%-80% (3000-8000 bps).",
    args: [{ name: "bps", kind: "uint16-bps", description: "Take rate in bps (3000-8000 enforced)." }],
    currentGetters: ["defaultTakeRateBps"],
  },
  {
    contractKey: "campaigns",
    contractLabel: "Campaigns",
    fnName: "approveTag",
    signature: "approveTag(bytes32)",
    abi: "function approveTag(bytes32 tag)",
    description: "Add a tag hash to the approved-tag registry. Only effective when enforceTagRegistry is on.",
    args: [{ name: "tag", kind: "bytes32", description: "keccak256 of the canonical tag string (use the tag dictionary helper)." }],
    currentGetters: [null],
  },
  {
    contractKey: "campaigns",
    contractLabel: "Campaigns",
    fnName: "removeApprovedTag",
    signature: "removeApprovedTag(bytes32)",
    abi: "function removeApprovedTag(bytes32 tag)",
    description: "Remove a tag from the approved-tag registry.",
    args: [{ name: "tag", kind: "bytes32", description: "Tag hash to remove." }],
    currentGetters: [null],
  },

  // ── DatumSettlement ────────────────────────────────────────────────────
  {
    contractKey: "settlement",
    contractLabel: "Settlement",
    fnName: "setRateLimits",
    signature: "setRateLimits(uint256,uint256)",
    abi: "function setRateLimits(uint256 windowBlocks, uint256 maxEventsPerWindow)",
    description:
      "Per-publisher event-rate cap. Settlement rejects events from a publisher that exceed maxEventsPerWindow within windowBlocks. Tunes the floor on relay throttling.",
    args: [
      { name: "windowBlocks",       kind: "uint256-blocks", description: "Sliding window size (blocks)." },
      { name: "maxEventsPerWindow", kind: "uint256-count",  description: "Max events a single publisher can settle in one window." },
    ],
    currentGetters: ["rlWindowBlocks", "rlMaxEventsPerWindow"],
  },
  {
    contractKey: "settlement",
    contractLabel: "Settlement",
    fnName: "setMinClaimInterval",
    signature: "setMinClaimInterval(uint16)",
    abi: "function setMinClaimInterval(uint16 interval)",
    description: "Minimum blocks between consecutive claims from the same user-campaign pair. Rate-limits claim spam.",
    args: [{ name: "interval", kind: "uint16-count", description: "Block interval (0 = disabled)." }],
    currentGetters: ["minClaimInterval"],
  },
  {
    contractKey: "settlement",
    contractLabel: "Settlement",
    fnName: "setNullifierWindowBlocks",
    signature: "setNullifierWindowBlocks(uint256)",
    abi: "function setNullifierWindowBlocks(uint256 windowBlocks)",
    description:
      "ZK nullifier replay-prevention window. nullifier = Poseidon(secret, campaignId, windowId) where windowId = block / windowBlocks. Larger windows = stronger replay protection but more storage.",
    args: [{ name: "windowBlocks", kind: "uint256-blocks", description: "Block window for nullifier bucketing." }],
    currentGetters: ["nullifierWindowBlocks"],
  },
  {
    contractKey: "settlement",
    contractLabel: "Settlement",
    fnName: "setMinReputationScore",
    signature: "setMinReputationScore(uint16)",
    abi: "function setMinReputationScore(uint16 score)",
    description: "Reputation floor (bps) below which a publisher's claims are rejected. 0 disables the floor.",
    args: [{ name: "score", kind: "uint16-bps", description: "Min reputation in bps (0-10000)." }],
    currentGetters: ["minReputationScore"],
  },
  {
    contractKey: "settlement",
    contractLabel: "Settlement",
    fnName: "setMaxSettlementPerBlock",
    signature: "setMaxSettlementPerBlock(uint256)",
    abi: "function setMaxSettlementPerBlock(uint256 cap)",
    description: "Per-block global cap on settled events across all publishers. DoS guard.",
    args: [{ name: "cap", kind: "uint256-count", description: "Max events settled in any single block." }],
    currentGetters: ["maxSettlementPerBlock"],
  },

  // ── DatumPublishers ────────────────────────────────────────────────────
  {
    contractKey: "publishers",
    contractLabel: "Publishers",
    fnName: "setWhitelistMode",
    signature: "setWhitelistMode(bool)",
    abi: "function setWhitelistMode(bool enabled)",
    description:
      "When enabled, only addresses approved by setApproved (or staking >= stakeGate) can registerPublisher. Used during early rollout.",
    args: [{ name: "enabled", kind: "bool", description: "true = whitelist mode on; false = open registration." }],
    currentGetters: ["whitelistMode"],
  },
  {
    contractKey: "publishers",
    contractLabel: "Publishers",
    fnName: "setApproved",
    signature: "setApproved(address,bool)",
    abi: "function setApproved(address publisher, bool isApproved)",
    description: "Per-publisher approval flag for whitelist-mode registration.",
    args: [
      { name: "publisher",  kind: "address", description: "Publisher address." },
      { name: "isApproved", kind: "bool",    description: "true = approve; false = revoke." },
    ],
    currentGetters: [null, null],
  },
  {
    contractKey: "publishers",
    contractLabel: "Publishers",
    fnName: "setStakeGate",
    signature: "setStakeGate(address,uint256)",
    abi: "function setStakeGate(address stakeContract, uint256 threshold)",
    description:
      "Stake-gated registration bypass: a publisher with staked() >= threshold can registerPublisher even in whitelist mode. address(0) disables. Locked irreversibly via lockStakeGate().",
    args: [
      { name: "stakeContract", kind: "address",       description: "DatumPublisherStake address (or 0x0 to disable)." },
      { name: "threshold",     kind: "uint256-planck", description: "Minimum staked planck to bypass whitelist." },
    ],
    currentGetters: ["publisherStake", "stakeGate"],
  },
  {
    contractKey: "publishers",
    contractLabel: "Publishers",
    fnName: "lockStakeGate",
    signature: "lockStakeGate()",
    abi: "function lockStakeGate()",
    description:
      "One-way switch — disables further setStakeGate calls. Once locked, the stake-gate target and threshold can no longer be reassigned. Irreversible.",
    args: [],
    currentGetters: [],
  },
  {
    contractKey: "publishers",
    contractLabel: "Publishers",
    fnName: "blockAddress",
    signature: "blockAddress(address)",
    abi: "function blockAddress(address addr)",
    description: "S12 blocklist — block an address from publisher / advertiser activity. 48h timelock.",
    args: [{ name: "addr", kind: "address", description: "Address to block." }],
    currentGetters: [null],
  },

  // ── DatumGovernanceRouter ──────────────────────────────────────────────
  {
    contractKey: "governanceRouter",
    contractLabel: "GovernanceRouter",
    fnName: "setGovernor",
    signature: "setGovernor(uint8,address)",
    abi: "function setGovernor(uint8 newPhase, address newGovernor)",
    description:
      "Phase transition: Admin (0) → Council (1) → OpenGov (2). Only the Timelock can move phases. The new governor takes over campaign activate/terminate/demote routing.",
    args: [
      {
        name: "newPhase", kind: "uint8-enum",
        description: "0=Admin, 1=Council, 2=OpenGov.",
        enumLabels: ["Admin", "Council", "OpenGov"],
      },
      { name: "newGovernor", kind: "address", description: "Address of the new governor (Council or GovernanceV2)." },
    ],
    currentGetters: ["phase", "governor"],
  },
];

export function tlEncodeCall(setter: TLSetter, args: (string | bigint | boolean)[]): string {
  const iface = new Interface([setter.abi]);
  return iface.encodeFunctionData(setter.fnName, args);
}

export function tlSelector(setter: TLSetter): string {
  const iface = new Interface([setter.abi]);
  const f = iface.getFunction(setter.fnName);
  return f ? f.selector : "0x00000000";
}

export function tlFormatArg(kind: TLArgKind, raw: bigint | boolean | string): string {
  if (kind === "bool") return raw ? "true" : "false";
  if (kind === "address" || kind === "bytes32") return String(raw);
  const n = typeof raw === "bigint" ? raw : BigInt(String(raw));
  switch (kind) {
    case "uint256-blocks":  return `${n.toString()} blocks`;
    case "uint256-bps":
    case "uint16-bps":      return `${n.toString()} (${(Number(n) / 100).toFixed(2)}%)`;
    case "uint256-planck":  return `${n.toString()} planck`;
    case "uint256-count":
    case "uint16-count":    return n.toString();
    case "uint8-enum":      return n.toString();
    default: return n.toString();
  }
}

/**
 * Parse a free-form input into the appropriate type for ABI encoding.
 */
export function tlParseArg(kind: TLArgKind, input: string): string | bigint | boolean {
  const t = input.trim();
  switch (kind) {
    case "bool": {
      const lower = t.toLowerCase();
      if (lower === "true" || lower === "1") return true;
      if (lower === "false" || lower === "0" || lower === "") return false;
      throw new Error(`expected bool, got "${t}"`);
    }
    case "address":
      if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`expected 0x address, got "${t}"`);
      return t;
    case "bytes32":
      if (!/^0x[0-9a-fA-F]{64}$/.test(t)) throw new Error(`expected 0x bytes32, got "${t}"`);
      return t;
    default: {
      if (!t) return 0n;
      if (!/^\d+$/.test(t)) throw new Error(`expected integer, got "${t}"`);
      return BigInt(t);
    }
  }
}

/** keccak256-shaped salt — a wallet-side value to differentiate proposals. */
export function defaultSalt(): string {
  // Random 32-byte salt; harmless if reused but Timelock rejects duplicates.
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return "0x" + Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
