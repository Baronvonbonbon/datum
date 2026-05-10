// Parameter governance catalog.
//
// Typed metadata for every governable parameter setter: which contract owns
// the function, the human-readable description, the named arguments and their
// units, and a getter pointer so the UI can show the current on-chain value
// next to a proposed change.
//
// The on-chain whitelist (DatumParameterGovernance.permittedSelectors) must
// stay in sync with this list — see alpha-4/scripts/deploy.ts Phase 3b.

import { Interface } from "ethers";

export type ContractKey =
  | "publisherStake"
  | "publisherGovernance"
  | "parameterGovernance";

export type ArgKind = "uint256-blocks" | "uint256-bps" | "uint256-planck" | "uint256-count";

export interface ParamArg {
  name: string;
  kind: ArgKind;
  description: string;
  // Optional sane bounds for quick validation in the UI
  min?: string;     // string for bigint comparison
  max?: string;
}

export interface ParamSetter {
  contractKey: ContractKey;
  contractLabel: string;
  fnName: string;          // bare name, no signature
  signature: string;       // canonical signature for selector calc
  abi: string;             // human-readable function ABI for ethers Interface
  description: string;
  args: ParamArg[];
  // Each arg maps to a current-value getter (function on the same contract)
  // returning the same type. Aligned by index with `args`.
  currentGetters: string[];
}

export const PARAM_CATALOG: ParamSetter[] = [
  // ── DatumPublisherStake ────────────────────────────────────────────────
  {
    contractKey: "publisherStake",
    contractLabel: "PublisherStake",
    fnName: "setParams",
    signature: "setParams(uint256,uint256,uint256)",
    abi: "function setParams(uint256 base, uint256 perImpression, uint256 unstakeDelay)",
    description:
      "Stake curve and unstake delay. Required stake = base + cumulativeImpressions × perImpression. Unstake delay defers withdrawals.",
    args: [
      { name: "base",          kind: "uint256-planck", description: "Floor stake required even at 0 impressions (planck)." },
      { name: "perImpression", kind: "uint256-planck", description: "Marginal stake added per cumulative impression (planck)." },
      { name: "unstakeDelay",  kind: "uint256-blocks", description: "Blocks between requestUnstake and unstake claim." },
    ],
    currentGetters: ["baseStakePlanck", "planckPerImpression", "unstakeDelayBlocks"],
  },
  {
    contractKey: "publisherStake",
    contractLabel: "PublisherStake",
    fnName: "setMaxRequiredStake",
    signature: "setMaxRequiredStake(uint256)",
    abi: "function setMaxRequiredStake(uint256 cap)",
    description: "Hard cap on requiredStake regardless of impression volume. Prevents runaway requirements on long-tail publishers.",
    args: [
      { name: "cap", kind: "uint256-planck", description: "Maximum required stake in planck. 0 disables the cap." },
    ],
    currentGetters: ["maxRequiredStake"],
  },

  // ── DatumPublisherGovernance ───────────────────────────────────────────
  {
    contractKey: "publisherGovernance",
    contractLabel: "PublisherGovernance",
    fnName: "setParams",
    signature: "setParams(uint256,uint256,uint256,uint256)",
    abi: "function setParams(uint256 quorum, uint256 slashBps, uint256 bondBonusBps, uint256 minGrace)",
    description:
      "Fraud governance tunables. quorum = min weighted aye stake; slashBps = % of publisher stake slashed on upheld; bondBonusBps = % forwarded to ChallengeBonds bonus pool; minGrace = blocks before resolve permitted.",
    args: [
      { name: "quorum",       kind: "uint256-planck", description: "Minimum weighted aye stake to pass (planck)." },
      { name: "slashBps",     kind: "uint256-bps",    description: "% of publisher stake slashed on upheld fraud (bps; 10000 = 100%).", min: "0", max: "10000" },
      { name: "bondBonusBps", kind: "uint256-bps",    description: "% of slashed amount forwarded to ChallengeBonds (bps).", min: "0", max: "10000" },
      { name: "minGrace",     kind: "uint256-blocks", description: "Min blocks between proposal creation and resolve()." },
    ],
    currentGetters: ["quorum", "slashBps", "bondBonusBps", "minGraceBlocks"],
  },
  {
    contractKey: "publisherGovernance",
    contractLabel: "PublisherGovernance",
    fnName: "setProposeBond",
    signature: "setProposeBond(uint256)",
    abi: "function setProposeBond(uint256 bond)",
    description: "Anti-spam bond required to file a fraud proposal. Returned on win, slashed on lose.",
    args: [
      { name: "bond", kind: "uint256-planck", description: "Required bond per proposal (planck)." },
    ],
    currentGetters: ["proposeBond"],
  },

  // ── DatumParameterGovernance (self-governance) ─────────────────────────
  {
    contractKey: "parameterGovernance",
    contractLabel: "ParameterGovernance",
    fnName: "setParams",
    signature: "setParams(uint256,uint256,uint256,uint256)",
    abi: "function setParams(uint256 votingPeriodBlocks, uint256 timelockBlocks, uint256 quorum, uint256 proposeBond)",
    description:
      "Self-governance — change ParameterGovernance's own voting period, post-pass timelock, weighted quorum, and proposal bond.",
    args: [
      { name: "votingPeriodBlocks", kind: "uint256-blocks", description: "Voting window after propose() (blocks)." },
      { name: "timelockBlocks",     kind: "uint256-blocks", description: "Delay between resolve()=Passed and execute() (blocks)." },
      { name: "quorum",             kind: "uint256-planck", description: "Minimum weighted aye stake to pass (planck)." },
      { name: "proposeBond",        kind: "uint256-planck", description: "Bond required to file a proposal (planck)." },
    ],
    currentGetters: ["votingPeriodBlocks", "timelockBlocks", "quorum", "proposeBond"],
  },
];

/**
 * Encode a parameter-change proposal payload for ParameterGovernance.execute.
 * Returns the calldata bytes that PG will replay against the target contract.
 */
export function encodeParamCall(setter: ParamSetter, args: (string | bigint)[]): string {
  const iface = new Interface([setter.abi]);
  return iface.encodeFunctionData(setter.fnName, args);
}

/** keccak256(signature)[0..4] — selector that the PG whitelist must permit. */
export function selectorOf(setter: ParamSetter): string {
  // Cheaper than spinning up an Interface just for the selector.
  // Same value as Interface(...).getFunction(name).selector, but no allocation.
  // Caller is expected to already hold the canonical signature string.
  // Falls through to Interface for safety.
  const iface = new Interface([setter.abi]);
  const f = iface.getFunction(setter.fnName);
  return f ? f.selector : "0x00000000";
}

/** Render an arg value for display next to its proposed value. */
export function formatArg(kind: ArgKind, raw: bigint): string {
  switch (kind) {
    case "uint256-bps":     return `${raw.toString()} (${(Number(raw) / 100).toFixed(2)}%)`;
    case "uint256-blocks":  return `${raw.toString()} blocks`;
    case "uint256-planck":  return `${raw.toString()} planck`;
    case "uint256-count":   return raw.toString();
  }
}

/** Parse a free-form input string into a bigint of the appropriate kind. */
export function parseArg(_kind: ArgKind, input: string): bigint {
  const t = input.trim();
  if (!t) return 0n;
  // Accept plain integers in all kinds for now — UI shows the unit hint.
  if (!/^\d+$/.test(t)) throw new Error(`expected integer, got "${t}"`);
  return BigInt(t);
}
