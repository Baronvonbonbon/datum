// Selection-policy dispatcher for client-side ad selection.
//
// C0 (2026-05-24): the auction is now policy-dispatched. The default
// `interest-weighted` policy is the historic Vickrey-with-interest-weight
// path (P19 + TX-3). Additional policies let users pick how the extension
// resolves the impression — max-price, contextual, lottery, relevance-only —
// while the advertiser's published `CampaignPolicyEnvelope` (read from
// chain in the campaign poller) constrains which of those policies the
// campaign will accept.
//
// C1: result carries `policyId` + `interestWeightBps` so the claim builder
// can bind them under the claim hash. The chain validates them against
// the envelope at settlement.
//
// C2: result carries `auctionRootCommit` — a Merkle root over the
// eligible-bid set sorted deterministically. The claim binds the root so
// the advertiser can later request the transcript off-chain and dispute
// any mismatch.

import { keccak256, AbiCoder, getBytes, hexlify } from "ethers";
import { UserInterestProfile } from "./interestProfile";
import { tagStringFromHash } from "@shared/tagDictionary";

// ─── Types ────────────────────────────────────────────────────────────
export interface CampaignCandidate {
  id: string;
  viewBid: string;          // serialized bigint — view pot ratePlanck (CPM)
  categoryId: number;
  publisher: string;
  requiredTags?: string[];  // TX-3: bytes32 tag hashes
  // C1 envelope hints (poller-provided; absent = no restriction)
  allowedPolicies?: number;       // uint16 bitmask
  priceFloorBps?: number;         // uint16
  minRelevanceBps?: number;       // uint16
  requirePolicyAttest?: boolean;
  [key: string]: any;
}

export interface ScoredBid {
  id: string;
  viewBid: string;          // serialized bigint — view pot ratePlanck
  interestWeight: number;
  effectiveBidMicro: string;
}

/** C0 selection-policy registry. Values match DatumCampaigns.allowedPolicies
 *  bit positions (bit i = policy i). 0 = unspecified (legacy claims). */
export type PolicyId = 0 | 1 | 2 | 3 | 4 | 5;
export const POLICY_NONE: PolicyId = 0;
export const POLICY_MAX_PRICE: PolicyId = 1;
export const POLICY_INTEREST_WEIGHTED: PolicyId = 2;
export const POLICY_CONTEXTUAL: PolicyId = 3;
export const POLICY_LOTTERY: PolicyId = 4;
export const POLICY_RELEVANCE_ONLY: PolicyId = 5;

export interface AuctionResult {
  winner: CampaignCandidate;
  clearingCpmPlanck: bigint;
  participants: number;
  mechanism: "second-price" | "solo" | "floor" | "max-price" | "lottery";
  allScored: ScoredBid[];
  bidEfficiency: number;
  /** C1: policy the auction ran under. */
  policyId: PolicyId;
  /** C1: claimed interest weight for the winner, in basis points (0..10_000). */
  interestWeightBps: number;
  /** C2: Merkle root over the eligible-bid set (sorted by campaign id ascending).
   *  bytes32(0) when transcript commitment is disabled. */
  auctionRootCommit: string;
  /** C2: leaves used to build the root, retained client-side so the user
   *  can answer a future advertiser transcript challenge. */
  auctionLeaves: AuctionLeaf[];
}

export interface AuctionLeaf {
  campaignId: string;
  viewBid: string;          // pot ratePlanck
  interestWeightBps: number;
}

/** Options bundle for `auctionForPage`. Backwards-compatible: omitted
 *  fields restore the historic interest-weighted behavior. */
export interface AuctionOpts {
  policyId?: PolicyId;
  /** If true, emit a Merkle root over the sorted bid set in the result. */
  commitTranscript?: boolean;
  /** Legacy contextual-mode flag retained for backwards compat. Equivalent
   *  to passing policyId = POLICY_CONTEXTUAL. */
  contextualMode?: boolean;
}

// ─── Entry point ──────────────────────────────────────────────────────

/** Backwards-compatible signature kept for existing callers — extension code
 *  that hasn't migrated to the policy-aware path keeps working. */
export function auctionForPage(
  campaigns: CampaignCandidate[],
  pageCategories: Record<string, number>,
  profile: UserInterestProfile,
  pageTags?: string[],
  contextualModeOrOpts?: boolean | AuctionOpts,
): AuctionResult | null {
  const opts: AuctionOpts =
    typeof contextualModeOrOpts === "boolean"
      ? { contextualMode: contextualModeOrOpts }
      : contextualModeOrOpts ?? {};

  let policyId: PolicyId =
    opts.policyId ?? (opts.contextualMode ? POLICY_CONTEXTUAL : POLICY_INTEREST_WEIGHTED);

  if (campaigns.length === 0) return null;

  // C1: enforce per-campaign envelope on the client side so we don't
  // submit claims we know will reject. Drop ineligible candidates first.
  const eligible = campaigns.filter((c) => isPolicyAllowed(c, policyId));
  if (eligible.length === 0) return null;

  // Score every eligible candidate (used by all policies + transcript leaves).
  const scored = eligible.map((c) => {
    const interestWeight = Math.max(
      getTagWeight(profile, c, pageTags, policyId === POLICY_CONTEXTUAL),
      0.1
    );
    const bidCpm = BigInt(c.viewBid);
    const effectiveBid = bidCpm * BigInt(Math.round(interestWeight * 1000));
    return { campaign: c, bidCpm, interestWeight, effectiveBid };
  });

  // Apply relevance-only floor.
  let pool = scored;
  if (policyId === POLICY_RELEVANCE_ONLY) {
    pool = scored.filter((s) => s.interestWeight >= 0.6);
    if (pool.length === 0) return null;
  }

  // Sort by effective bid descending; deterministic tie-break by id.
  pool.sort((a, b) => {
    if (b.effectiveBid > a.effectiveBid) return 1;
    if (b.effectiveBid < a.effectiveBid) return -1;
    return compareIds(a.campaign.id, b.campaign.id);
  });

  // Build the transcript leaves from the full scored set (regardless of
  // pool — leaves represent eligible candidates the auction saw).
  const leaves: AuctionLeaf[] = scored
    .map((s) => ({
      campaignId: s.campaign.id,
      viewBid: s.bidCpm.toString(),
      interestWeightBps: Math.round(s.interestWeight * 10_000),
    }))
    .sort((a, b) => compareIds(a.campaignId, b.campaignId));

  const auctionRootCommit = opts.commitTranscript
    ? buildTranscriptRoot(leaves)
    : "0x" + "0".repeat(64);

  const allScored: ScoredBid[] = pool.map((s) => ({
    id: String(s.campaign.id ?? "?"),
    viewBid: s.bidCpm.toString(),
    interestWeight: s.interestWeight,
    effectiveBidMicro: s.effectiveBid.toString(),
  }));

  // Dispatch by policy. Returns { winner, clearingCpm, mechanism, winnerWeight }.
  const picked = dispatchPolicy(policyId, pool);

  // Enforce per-campaign envelope priceFloorBps on the chosen result.
  const winnerEnv = priceFloorFor(picked.winner.campaign);
  let clearingCpm = picked.clearingCpm;
  if (winnerEnv > 0n) {
    const floor = (picked.bidCpm * winnerEnv) / 10_000n;
    if (clearingCpm < floor) clearingCpm = floor;
  }

  const interestWeightBps = Math.min(10_000, Math.max(0, Math.round(picked.winnerWeight * 10_000)));

  return {
    winner: picked.winner.campaign,
    clearingCpmPlanck: clearingCpm,
    participants: pool.length,
    mechanism: picked.mechanism,
    allScored,
    bidEfficiency: picked.bidCpm > 0n ? Number(clearingCpm) / Number(picked.bidCpm) : 0,
    policyId,
    interestWeightBps,
    auctionRootCommit,
    auctionLeaves: leaves,
  };
}

// ─── Policy dispatch ──────────────────────────────────────────────────

type ScoredEntry = {
  campaign: CampaignCandidate;
  bidCpm: bigint;
  interestWeight: number;
  effectiveBid: bigint;
};

type PickResult = {
  winner: ScoredEntry;
  clearingCpm: bigint;
  bidCpm: bigint;
  winnerWeight: number;
  mechanism: AuctionResult["mechanism"];
};

function dispatchPolicy(policyId: PolicyId, pool: ScoredEntry[]): PickResult {
  const winner = pool[0];

  if (policyId === POLICY_MAX_PRICE) {
    // Pick highest pot ceiling, pay the ceiling. The advertiser opted in
    // by including bit 1 in allowedPolicies — they accept first-price.
    pool.sort((a, b) => {
      if (b.bidCpm > a.bidCpm) return 1;
      if (b.bidCpm < a.bidCpm) return -1;
      return compareIds(a.campaign.id, b.campaign.id);
    });
    const w = pool[0];
    return {
      winner: w, clearingCpm: w.bidCpm, bidCpm: w.bidCpm,
      winnerWeight: w.interestWeight, mechanism: "max-price",
    };
  }

  if (policyId === POLICY_LOTTERY) {
    // Sample proportional to effectiveBid. Deterministic across the
    // session window so the user can't grind for higher-paying ads by
    // refreshing — `nonce` (block height) seeds the RNG upstream when
    // we move to a verifiable randomness source. For C0 we use Math.random;
    // the lottery policy is best-effort fairness, not adversarial.
    const total = pool.reduce((acc, s) => acc + s.effectiveBid, 0n);
    if (total === 0n) {
      return solo(winner);
    }
    const draw = randomBigint(total);
    let cur = 0n;
    let picked = winner;
    for (const s of pool) {
      cur += s.effectiveBid;
      if (draw < cur) { picked = s; break; }
    }
    return {
      winner: picked, clearingCpm: picked.bidCpm, bidCpm: picked.bidCpm,
      winnerWeight: picked.interestWeight, mechanism: "lottery",
    };
  }

  // Default Vickrey path: POLICY_INTEREST_WEIGHTED, POLICY_CONTEXTUAL,
  // POLICY_RELEVANCE_ONLY all use the same clearing math; they differ
  // only in pool composition + weight derivation upstream.
  if (pool.length === 1) {
    return solo(winner);
  }

  const second = pool[1];
  const clearingRaw =
    second.effectiveBid / BigInt(Math.round(winner.interestWeight * 1000));
  const floor = (winner.bidCpm * 65n) / 100n;
  let clearingCpm: bigint;
  let mechanism: AuctionResult["mechanism"];
  if (clearingRaw < floor) {
    clearingCpm = floor > 0n ? floor : 1n;
    mechanism = "floor";
  } else if (clearingRaw > winner.bidCpm) {
    clearingCpm = winner.bidCpm;
    mechanism = "second-price";
  } else {
    clearingCpm = clearingRaw > 0n ? clearingRaw : 1n;
    mechanism = "second-price";
  }
  return {
    winner, clearingCpm, bidCpm: winner.bidCpm,
    winnerWeight: winner.interestWeight, mechanism,
  };
}

function solo(winner: ScoredEntry): PickResult {
  const clearingCpm = (winner.bidCpm * 85n) / 100n;
  return {
    winner,
    clearingCpm: clearingCpm > 0n ? clearingCpm : 1n,
    bidCpm: winner.bidCpm,
    winnerWeight: winner.interestWeight,
    mechanism: "solo",
  };
}

function randomBigint(max: bigint): bigint {
  if (max <= 0n) return 0n;
  const bits = max.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let val = 0n;
  for (const b of arr) val = (val << 8n) | BigInt(b);
  return val % max;
}

// ─── Envelope filtering ───────────────────────────────────────────────

function isPolicyAllowed(c: CampaignCandidate, policyId: PolicyId): boolean {
  const mask = c.allowedPolicies ?? 0;
  if (mask === 0) return true; // no restriction
  if (policyId === 0) return !c.requirePolicyAttest; // unspecified only OK if not required
  return (mask & (1 << policyId)) !== 0;
}

function priceFloorFor(c: CampaignCandidate): bigint {
  const bps = c.priceFloorBps ?? 0;
  return BigInt(bps);
}

// ─── C2: transcript Merkle root ───────────────────────────────────────

/** Build a sorted-leaf Merkle root over the eligible-bid set. Sorting by
 *  campaignId guarantees the root is deterministic regardless of poll order.
 *  Single leaf = root = leaf. Odd-leaf levels pair the last leaf with
 *  itself (standard OZ MerkleProof convention). */
export function buildTranscriptRoot(leaves: AuctionLeaf[]): string {
  if (leaves.length === 0) return "0x" + "0".repeat(64);
  const abi = AbiCoder.defaultAbiCoder();
  let layer: Uint8Array[] = leaves.map((l) =>
    getBytes(keccak256(
      abi.encode(
        ["uint256", "uint256", "uint16"],
        [idToBigInt(l.campaignId), BigInt(l.viewBid), l.interestWeightBps]
      )
    ))
  );
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = i + 1 < layer.length ? layer[i + 1] : a;
      // Sorted-pair hashing (matches OZ MerkleProof).
      const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
      const buf = new Uint8Array(64);
      buf.set(lo, 0);
      buf.set(hi, 32);
      next.push(getBytes(keccak256(hexlify(buf))));
    }
    layer = next;
  }
  return hexlify(layer[0]);
}

/** Deterministic compare for campaign ids. Handles numeric ids via BigInt
 *  and falls back to lexicographic comparison for non-numeric strings. */
function compareIds(a: string, b: string): number {
  // Numeric ids fast path
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const da = BigInt(a) - BigInt(b);
    if (da > 0n) return 1;
    if (da < 0n) return -1;
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Hash a numeric id to bigint for transcript leaf encoding. Non-numeric
 *  ids are first keccak-hashed and the low 31 bytes are used as the id —
 *  rare path (test fixtures only); ensures the encoder doesn't throw. */
function idToBigInt(id: string): bigint {
  if (/^\d+$/.test(id)) return BigInt(id);
  const hex = keccak256(new TextEncoder().encode(id));
  return BigInt("0x" + hex.slice(-62));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// ─── Interest weight (unchanged from pre-C0) ──────────────────────────

function getTagWeight(
  profile: UserInterestProfile,
  c: CampaignCandidate,
  pageTags?: string[],
  contextualMode?: boolean,
): number {
  if (contextualMode) {
    if (c.requiredTags && c.requiredTags.length > 0) {
      if (!pageTags || pageTags.length === 0) return 0.1;
      const pageTagSet = new Set(pageTags);
      let matches = 0;
      for (const hash of c.requiredTags) {
        const tagStr = tagStringFromHash(hash);
        if (tagStr && pageTagSet.has(tagStr)) matches++;
      }
      return matches > 0 ? matches / c.requiredTags.length : 0.1;
    }
    return 0.5;
  }

  if (c.requiredTags && c.requiredTags.length > 0) {
    let totalWeight = 0;
    let matchCount = 0;
    for (const hash of c.requiredTags) {
      const tagStr = tagStringFromHash(hash);
      if (tagStr) {
        totalWeight += profile.weights[tagStr] ?? 0;
        matchCount++;
      }
    }
    return matchCount > 0 ? totalWeight / matchCount : 0;
  }

  if (pageTags && pageTags.length > 0) {
    let totalWeight = 0;
    let matchCount = 0;
    for (const tag of pageTags) {
      if (!tag.startsWith("topic:")) continue;
      const w = profile.weights[tag] ?? 0;
      totalWeight += w;
      matchCount++;
    }
    return matchCount > 0 ? totalWeight / matchCount : 0;
  }

  return 0;
}
