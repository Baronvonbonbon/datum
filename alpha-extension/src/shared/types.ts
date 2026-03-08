// Shared types mirroring IDatumSettlement.sol and IDatumCampaigns.sol structs

export interface Claim {
  campaignId: bigint;
  publisher: string;
  impressionCount: bigint;
  clearingCpmPlanck: bigint;
  nonce: bigint;
  previousClaimHash: string; // bytes32 hex
  claimHash: string;         // bytes32 hex
  zkProof: string;           // bytes hex, "0x" in MVP
}

export interface ClaimBatch {
  user: string;
  campaignId: bigint;
  claims: Claim[];
}

export interface SignedClaimBatch extends ClaimBatch {
  deadline: number;    // block number
  signature: string;   // 65-byte EIP-712 signature hex
  publisherSig: string; // publisher EIP-712 attestation hex (empty "0x" = degraded trust)
}

export interface SettlementResult {
  settledCount: bigint;
  rejectedCount: bigint;
  totalPaid: bigint;
}

export interface Campaign {
  id: bigint;
  advertiser: string;
  publisher: string;
  budget: bigint;           // planck
  remainingBudget: bigint;  // planck
  dailyCap: bigint;         // planck
  bidCpmPlanck: bigint;
  snapshotTakeRateBps: number;
  status: CampaignStatus;
  categoryId: number;       // 0=uncategorized, 1-10 per taxonomy
  pendingExpiryBlock: bigint;
  terminationBlock: bigint;
}

// Campaign metadata fetched from IPFS
export interface CampaignMetadata {
  title: string;
  description: string;
  category: string;
  creative: {
    type: "text";
    text: string;
    cta: string;
    ctaUrl: string;
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

export const CATEGORY_NAMES: Record<number, string> = {
  0: "Uncategorized",
  1: "Crypto",
  2: "Finance",
  3: "Technology",
  4: "Gaming",
  5: "News",
  6: "Privacy",
  7: "Open Source",
  8: "Science",
  9: "Environment",
  10: "Health",
};

export interface Impression {
  campaignId: bigint;
  publisherAddress: string;
  userAddress: string;
  timestamp: number;
  url: string;
  category: string;
}

// Per-(userAddress, campaignId) claim chain state persisted in chrome.storage.local
export interface ClaimChainState {
  userAddress: string;
  campaignId: string;  // bigint as string for JSON serialization
  lastNonce: number;
  lastClaimHash: string; // bytes32 hex
}

// Serialized form of ClaimBatch (bigints as strings) used in chrome message passing
export interface SerializedClaim {
  campaignId: string;
  publisher: string;
  impressionCount: string;
  clearingCpmPlanck: string;
  nonce: string;
  previousClaimHash: string;
  claimHash: string;
  zkProof: string;
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
}

export type NetworkName = "local" | "westend" | "kusama" | "polkadotHub";

export interface ContractAddresses {
  campaigns: string;
  publishers: string;
  governanceVoting: string;
  governanceRewards: string;
  settlement: string;
  relay: string;
}
