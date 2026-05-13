// Shared types mirroring IDatumSettlement.sol and IDatumCampaigns.sol structs

// Per-campaign action pot config (mirrors IDatumCampaigns.ActionPotConfig)
export interface ActionPotConfig {
  actionType: number;         // 0=view/CPM, 1=click/CPC, 2=remote-action/CPA
  budgetPlanck: bigint;
  dailyCapPlanck: bigint;
  ratePlanck: bigint;         // CPM rate (type-0) or flat rate per event (type-1/2)
  actionVerifier: string;     // EOA that signs type-2 claims (address(0) for type-0/1)
}

export interface Claim {
  campaignId: bigint;
  publisher: string;
  eventCount: bigint;         // renamed from impressionCount
  ratePlanck: bigint;         // renamed from clearingCpmPlanck; CPM for type-0, flat for type-1/2
  actionType: number;         // 0=view, 1=click, 2=remote-action
  clickSessionHash: string;   // bytes32: impressionNonce for type-1, ZeroHash otherwise
  nonce: bigint;
  previousClaimHash: string;  // bytes32 hex
  claimHash: string;          // bytes32 hex
  zkProof: string[];          // bytes32[8] — 8 BN254 scalars; all ZeroHash for non-ZK campaigns
  nullifier: string;          // bytes32 hex; ZeroHash for non-ZK campaigns (FP-5)
  actionSig: string[];        // bytes32[3] — [r, s, v_as_bytes32]; all ZeroHash for type-0/1
  powNonce: string;           // #5: bytes32 PoW nonce; ZeroHash when enforcePow=false or solved lazily at submit
}

export interface ClaimBatch {
  user: string;
  campaignId: bigint;
  claims: Claim[];
}

export interface SignedClaimBatch extends ClaimBatch {
  deadline: number;    // block number (relay path) OR unix timestamp (dual-sig path)
  userSig: string;     // 65-byte EIP-712 user signature hex (relay path; "0x" for dual-sig)
  publisherSig: string; // publisher EIP-712 attestation/co-sig hex (empty "0x" if absent)
  advertiserSig: string; // advertiser EIP-712 co-sig hex (dual-sig path; "0x" if absent)
}

export interface SettlementResult {
  settledCount: bigint;
  rejectedCount: bigint;
  totalPaid: bigint;
}

// A1.3: id and budget removed from on-chain struct — tracked externally
export interface Campaign {
  advertiser: string;
  publisher: string;
  remainingBudget: bigint;      // total planck across all pots
  pots?: ActionPotConfig[];     // per-action-type budget pots
  viewBid?: bigint;             // view pot ratePlanck (CPM); undefined if no view pot
  snapshotTakeRateBps: number;
  status: CampaignStatus;
  categoryId: number;           // deprecated — use requiredTags (TX-3)
  pendingExpiryBlock: bigint;
  terminationBlock: bigint;
  requiredTags: string[];       // TX-3: bytes32 tag hashes required for this campaign
}

// IAB-standard ad slot formats supported by the DATUM SDK.
// Publishers declare one of these via data-slot="<format>" on their script tag.
// Advertisers upload per-format images in IPFS creative metadata.
export type AdFormat =
  | "leaderboard"       // 728×90  — horizontal banner
  | "medium-rectangle"  // 300×250 — "the box"
  | "wide-skyscraper"   // 160×600 — sidebar
  | "half-page"         // 300×600 — tall sidebar
  | "mobile-banner"     // 320×50  — mobile horizontal
  | "square"            // 250×250
  | "large-rectangle";  // 336×280

/** Pixel dimensions for each format */
export const AD_FORMAT_SIZES: Record<AdFormat, { w: number; h: number }> = {
  "leaderboard":      { w: 728, h: 90  },
  "medium-rectangle": { w: 300, h: 250 },
  "wide-skyscraper":  { w: 160, h: 600 },
  "half-page":        { w: 300, h: 600 },
  "mobile-banner":    { w: 320, h: 50  },
  "square":           { w: 250, h: 250 },
  "large-rectangle":  { w: 336, h: 280 },
};

/** A single format-specific creative image stored in IPFS metadata */
export interface CreativeAsset {
  /** Target slot format */
  format: AdFormat;
  /** HTTPS URL or bare IPFS CID (e.g. "QmXxx...") */
  url: string;
  /** Optional alt text for accessibility */
  alt?: string;
}

// Campaign metadata fetched from IPFS
// Field length caps enforced by contentSafety.ts:
//   title ≤ 128, description ≤ 256, category ≤ 64,
//   creative.text ≤ 512, creative.cta ≤ 64, creative.ctaUrl ≤ 2048,
//   creative.imageUrl ≤ 2048, creative.videoUrl ≤ 2048,
//   creative.images[] ≤ 7 entries, each url ≤ 2048
export interface CampaignMetadata {
  title: string;
  description: string;
  category: string;
  creative: {
    type: "text";
    text: string;
    cta: string;
    ctaUrl: string;
    /** Legacy single image — used when no per-format images or no format match */
    imageUrl?: string;
    /** Per-format images (max 7 — one per AdFormat). Stored in IPFS for full transparency. */
    images?: CreativeAsset[];
    /**
     * Optional video creative (HTTPS URL or bare IPFS CID).
     * Rendered as <video autoplay muted loop playsinline> in the ad slot.
     * Advertisers signal video campaigns with the "creative:video" tag.
     */
    videoUrl?: string;
  };
  version: number;
}

export enum CampaignStatus {
  Pending = 0,
  Active = 1,
  Paused = 2,
  Completed = 3,
  Terminated = 4,
  Expired = 5,
}

/** @deprecated Use tag strings from tagDictionary.ts instead. Kept for backward compat. */
// 26 top-level categories for ad classification
// IDs 1-26 are top-level; subcategories use parent*100+sub scheme (e.g., 101=Celebrities under Arts)
export const CATEGORY_NAMES: Record<number, string> = {
  0: "Uncategorized",
  // Top-level categories
  1: "Arts & Entertainment",
  2: "Autos & Vehicles",
  3: "Beauty & Fitness",
  4: "Books & Literature",
  5: "Business & Industrial",
  6: "Computers & Electronics",
  7: "Finance",
  8: "Food & Drink",
  9: "Games",
  10: "Health",
  11: "Hobbies & Leisure",
  12: "Home & Garden",
  13: "Internet & Telecom",
  14: "Jobs & Education",
  15: "Law & Government",
  16: "News",
  17: "Online Communities",
  18: "People & Society",
  19: "Pets & Animals",
  20: "Real Estate",
  21: "Reference",
  22: "Science",
  23: "Shopping",
  24: "Sports",
  25: "Travel",
  26: "Crypto & Web3",
  // Subcategories — Arts & Entertainment (1xx)
  101: "Celebrities & Entertainment News",
  102: "Comics & Animation",
  103: "Movies",
  104: "Music & Audio",
  105: "Performing Arts",
  106: "TV & Video",
  107: "Visual Art & Design",
  // Autos & Vehicles (2xx)
  201: "Motor Vehicles",
  202: "Vehicle Parts & Accessories",
  203: "Vehicle Shopping",
  // Beauty & Fitness (3xx)
  301: "Beauty & Personal Care",
  302: "Fitness & Bodybuilding",
  303: "Fashion & Style",
  // Books & Literature (4xx)
  401: "Book Reviews",
  402: "E-Books & Digital Publishing",
  // Business & Industrial (5xx)
  501: "Advertising & Marketing",
  502: "Agriculture & Forestry",
  503: "Business Finance",
  504: "Construction & Maintenance",
  505: "Manufacturing",
  506: "Small Business",
  // Computers & Electronics (6xx)
  601: "Consumer Electronics",
  602: "Programming & Developer Tools",
  603: "Hardware",
  604: "Networking",
  605: "Software",
  // Finance (7xx)
  701: "Banking",
  702: "Insurance",
  703: "Investing",
  704: "Credit & Lending",
  // Food & Drink (8xx)
  801: "Cooking & Recipes",
  802: "Restaurants & Dining",
  803: "Beverages",
  // Games (9xx)
  901: "Board & Card Games",
  902: "Computer & Video Games",
  903: "Online Games",
  904: "Esports",
  // Health (10xx)
  1001: "Health Conditions",
  1002: "Mental Health",
  1003: "Nutrition & Diet",
  1004: "Pharmacy & Medications",
  // Hobbies & Leisure (11xx)
  1101: "Crafts & DIY",
  1102: "Outdoor Recreation",
  1103: "Photography",
  // Home & Garden (12xx)
  1201: "Gardening",
  1202: "Home Improvement",
  1203: "Interior Design",
  // Internet & Telecom (13xx)
  1301: "Email & Messaging",
  1302: "Search Engines",
  1303: "Web Services & Cloud",
  1304: "Privacy & Security",
  // Jobs & Education (14xx)
  1401: "Education & Training",
  1402: "Job Listings & Careers",
  // Law & Government (15xx)
  1501: "Government",
  1502: "Legal",
  1503: "Military",
  // News (16xx)
  1601: "Business News",
  1602: "Politics",
  1603: "Technology News",
  1604: "World News",
  // Online Communities (17xx)
  1701: "Blogging & Forums",
  1702: "Social Networks",
  // People & Society (18xx)
  1801: "Family & Relationships",
  1802: "Religion & Spirituality",
  1803: "Social Issues & Advocacy",
  // Pets & Animals (19xx)
  1901: "Dogs",
  1902: "Cats",
  1903: "Wildlife",
  // Real Estate (20xx)
  2001: "Rental Properties",
  2002: "Commercial Real Estate",
  // Science (22xx)
  2201: "Biological Sciences",
  2202: "Earth Sciences",
  2203: "Physics",
  2204: "Mathematics",
  2205: "Computer Science",
  // Shopping (23xx)
  2301: "Apparel",
  2302: "Consumer Electronics Shopping",
  2303: "Gifts & Special Events",
  // Sports (24xx)
  2401: "Team Sports",
  2402: "Individual Sports",
  2403: "Combat Sports",
  2404: "Water Sports",
  // Travel (25xx)
  2501: "Air Travel",
  2502: "Hotels & Accommodations",
  2503: "Tourist Destinations",
  // Crypto & Web3 (26xx)
  2601: "Bitcoin & Ethereum",
  2602: "DeFi",
  2603: "NFTs & Digital Collectibles",
  2604: "Polkadot & Parachains",
  2605: "DAOs & Governance",
};

// Hierarchical category structure for collapsible UI
export interface CategoryGroup {
  id: number;
  name: string;
  children: { id: number; name: string }[];
}

/** Get parent ID from subcategory ID: e.g. 2601 → 26, 101 → 1 */
export function getCategoryParent(id: number): number {
  if (id <= 26) return 0; // top-level
  if (id < 100) return 0;
  if (id < 200) return 1;
  if (id < 300) return 2;
  if (id < 400) return 3;
  if (id < 500) return 4;
  if (id < 600) return 5;
  if (id < 700) return 6;
  if (id < 800) return 7;
  if (id < 900) return 8;
  if (id < 1000) return 9;
  if (id < 1100) return 10;
  if (id < 1200) return 11;
  if (id < 1300) return 12;
  if (id < 1400) return 13;
  if (id < 1500) return 14;
  if (id < 1600) return 15;
  if (id < 1700) return 16;
  if (id < 1800) return 17;
  if (id < 1900) return 18;
  if (id < 2000) return 19;
  if (id < 2100) return 20;
  if (id < 2200) return 21;
  if (id < 2300) return 22;
  if (id < 2400) return 23;
  if (id < 2500) return 24;
  if (id < 2600) return 25;
  if (id < 2700) return 26;
  return 0;
}

/** Build hierarchical category groups from CATEGORY_NAMES */
export function buildCategoryHierarchy(): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  // Collect top-level categories (1-26)
  for (let id = 1; id <= 26; id++) {
    const name = CATEGORY_NAMES[id];
    if (!name) continue;
    const children: { id: number; name: string }[] = [];
    for (const [subId, subName] of Object.entries(CATEGORY_NAMES)) {
      const sid = Number(subId);
      if (getCategoryParent(sid) === id && sid !== id) {
        children.push({ id: sid, name: subName });
      }
    }
    groups.push({ id, name, children });
  }
  return groups;
}

export interface Impression {
  campaignId: bigint;
  publisherAddress: string;
  userAddress: string;
  timestamp: number;
  url: string;
  category: string;
}

// Per-(userAddress, campaignId, actionType) claim chain state persisted in chrome.storage.local
export interface ClaimChainState {
  userAddress: string;
  campaignId: string;   // bigint as string for JSON serialization
  actionType: number;   // 0=view, 1=click, 2=remote-action
  lastNonce: number;
  lastClaimHash: string; // bytes32 hex
}

// Serialized form of ClaimBatch (bigints as strings) used in chrome message passing
export interface SerializedClaim {
  campaignId: string;
  publisher: string;
  eventCount: string;          // renamed from impressionCount
  ratePlanck: string;          // renamed from clearingCpmPlanck
  actionType: string;          // "0", "1", or "2"
  clickSessionHash: string;    // bytes32 hex; ZeroHash for type-0/2
  nonce: string;
  previousClaimHash: string;
  claimHash: string;
  zkProof: string[];           // bytes32[8] — serialized as JSON array of hex strings
  nullifier: string;           // bytes32 hex; ZeroHash for non-ZK campaigns (FP-5)
  actionSig: string[];         // bytes32[3] — [r, s, v_as_bytes32]
  powNonce: string;            // #5: bytes32 PoW nonce
}

export interface SerializedClaimBatch {
  user: string;
  campaignId: string;
  claims: SerializedClaim[];
}

export interface StoredSettings {
  rpcUrl: string;
  network: NetworkName;
  publisherAddress: string;
  autoSubmit: boolean;
  autoSubmitIntervalMinutes: number;
  contractAddresses: ContractAddresses;
  ipfsGateway: string;
  pinataApiKey: string;
  /** Use Pine light client instead of centralized RPC (default: false) */
  usePine?: boolean;
}

export type NetworkName = "local" | "polkadotTestnet" | "westend" | "kusama" | "polkadotHub";

export interface ContractAddresses {
  campaigns: string;
  publishers: string;
  governanceV2: string;
  settlement: string;
  relay: string;
  pauseRegistry: string;
  timelock: string;
  zkVerifier: string;
  paymentVault: string;
  budgetLedger: string;
  lifecycle: string;
  attestationVerifier: string;
  claimValidator: string;       // SE-1: claim validation satellite
  tokenRewardVault: string;     // multi-token reward vault for per-campaign rewards
  publisherStake: string;       // FP-1+FP-4: publisher staking + bonding curve
  challengeBonds: string;       // FP-2: advertiser challenge bonds
  publisherGovernance: string;  // FP-3: conviction-weighted publisher fraud governance
  parameterGovernance: string;  // T1-B: conviction-vote governance for FP system parameters
  clickRegistry: string;        // FP-CPC: impression→click session registry for CPC fraud prevention
  governanceRouter: string;     // Stable-address proxy + inline admin (Phase 0)
  council: string;              // Phase 1: N-of-M trusted council voting
  // Optional (post-token-deploy) — extension treats empty / undefined as "feature off".
  councilBlocklistCurator?: string;
  wrapper?: string;             // DatumWrapper (WDATUM ERC-20)
  mintAuthority?: string;       // DatumMintAuthority (canonical DATUM bridge)
  bootstrapPool?: string;       // DatumBootstrapPool (house-ad bonus)
  vesting?: string;             // DatumVesting (founder + ops vesting)
  feeShare?: string;            // DatumFeeShare (stake WDATUM, earn DOT)
}

// User ad preferences — persisted in chrome.storage.local
export interface UserPreferences {
  blockedCampaigns: string[];     // campaign IDs blocked by user
  /** @deprecated Use blockedTags. Migrated on read. */
  silencedCategories: string[];   // category names user doesn't want
  blockedTags: string[];          // tag strings user doesn't want (e.g., "topic:gambling")
  maxAdsPerHour: number;          // rate limit (default 12)
  minBidCpm: string;              // minimum CPM in planck (default "0")
  filterMode: "all" | "selected"; // "all" = opt-out (default), "selected" = opt-in
  allowedTopics: string[];        // used when filterMode === "selected"
  sweepAddress: string;           // cold wallet address to sweep earnings to (empty = disabled)
  sweepThresholdPlanck: string;   // auto-sweep when balance exceeds this (in planck, as string; "0" = manual only)
  /** Contextual mode: ads matched to current page only. No profile data collected, no rewards earned. */
  contextualMode?: boolean;
}

// Engagement tracking (Phase 6 / P16)
export interface EngagementEvent {
  campaignId: string;
  dwellMs: number;         // time ad visible in viewport
  scrollDepthPct: number;  // max scroll % after ad render
  tabFocusMs: number;      // foreground time during impression
  viewableMs: number;      // continuous visibility time
  iabViewable: boolean;    // >=50% visible for >=1s
  timestamp: number;
}

// Behavior hash chain state (Phase 6 / P16)
export interface BehaviorChainState {
  userAddress: string;
  campaignId: string;
  headHash: string;        // bytes32
  eventCount: number;
  cumulativeDwellMs: number;
  cumulativeViewableMs: number;
  iabViewableCount: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Earnings index (History tab) — populated from ClaimSettled events.
// Storage keys are scoped per-(chainId, userAddress) so account / network
// switches don't mix data. The index is a pure local cache; on-chain truth
// is the events themselves.
// ─────────────────────────────────────────────────────────────────────────

export interface EarningsCampaignTotals {
  totalUserPlanck: string;     // bigint serialised to decimal string
  totalEvents: string;         // bigint serialised
  claimCount: number;
  lastBlock: number;
  lastPaymentPlanck: string;   // most recent userPayment, bigint string
  firstSeenBlock: number;
}

export interface EarningsRecentEntry {
  campaignId: string;          // bigint as string
  blockNumber: number;
  blockTimestamp: number;      // unix seconds; 0 if unknown
  userPaymentPlanck: string;   // bigint as string
  publisher: string;
  actionType: 0 | 1 | 2;
  txHash: string;
  logIndex: number;
}

export interface CampaignMetaCacheEntry {
  campaignId: string;
  advertiser: string;
  metadataHash: string;        // bytes32 (IPFS CID-as-hash)
  title?: string;              // resolved off-chain (IPFS); optional
  description?: string;
  imageUrl?: string;
  fetchedAt: number;           // unix seconds
}
