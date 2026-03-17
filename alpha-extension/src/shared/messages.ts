// Chrome extension message types for background <-> popup <-> content <-> offscreen communication

// Messages sent FROM content script TO background
export type ContentToBackground =
  | { type: "IMPRESSION_RECORDED"; campaignId: string; url: string; category: string; publisherAddress: string; clearingCpmPlanck?: string }
  | { type: "GET_ACTIVE_CAMPAIGNS" }
  | { type: "UPDATE_INTEREST"; category: string }
  | { type: "SELECT_CAMPAIGN"; campaigns: any[]; pageCategory: string }
  | { type: "FETCH_IPFS_METADATA"; campaignId: string; metadataHash: string }
  | { type: "ENGAGEMENT_RECORDED"; event: import("./types").EngagementEvent }
  | { type: "ENGAGEMENT_QUALITY_RESULT"; campaignId: string; qualityScore: number; passed: boolean };

// Messages sent FROM popup TO background
export type PopupToBackground =
  | { type: "WALLET_CONNECTED"; address: string }
  | { type: "WALLET_DISCONNECTED" }
  | { type: "SUBMIT_CLAIMS"; userAddress: string }
  | { type: "SIGN_FOR_RELAY"; userAddress: string; campaignId: string }
  | { type: "GET_QUEUE_STATE" }
  | { type: "CLEAR_QUEUE" }
  | { type: "SETTINGS_UPDATED"; settings: import("./types").StoredSettings }
  | { type: "RESET_CHAIN_STATE" }
  | { type: "REMOVE_SETTLED_CLAIMS"; userAddress: string; settledNonces: Record<string, string[]> }
  | { type: "SYNC_CHAIN_STATE"; userAddress: string; campaignId: string; onChainNonce: number; onChainHash: string }
  | { type: "ACQUIRE_MUTEX" }
  | { type: "RELEASE_MUTEX" }
  | { type: "POLL_CAMPAIGNS" }
  | { type: "GET_INTEREST_PROFILE" }
  | { type: "RESET_INTEREST_PROFILE" }
  | { type: "REQUEST_PUBLISHER_ATTESTATION"; publisherAddress: string; campaignId: string; userAddress: string; firstNonce: string; lastNonce: string; claimCount: number }
  | { type: "EVALUATE_CAMPAIGN"; campaignId: string }
  | { type: "FINALIZE_SLASH"; campaignId: string }
  | { type: "CLAIM_SLASH_REWARD"; campaignId: string }
  | { type: "GET_USER_PREFERENCES" }
  | { type: "UPDATE_USER_PREFERENCES"; preferences: Partial<import("./types").UserPreferences> }
  | { type: "BLOCK_CAMPAIGN"; campaignId: string }
  | { type: "UNBLOCK_CAMPAIGN"; campaignId: string }
  | { type: "AUTHORIZE_AUTO_SUBMIT"; privateKey: string }
  | { type: "REVOKE_AUTO_SUBMIT" }
  | { type: "CHECK_AUTO_SUBMIT" }
  | { type: "GET_TIMELOCK_PENDING" };

// Messages sent FROM background TO offscreen document (sign + submit)
export type BackgroundToOffscreen = {
  type: "OFFSCREEN_SUBMIT";
  userAddress: string;
  batches: import("./types").SerializedClaimBatch[];
  contractAddresses: import("./types").ContractAddresses;
  rpcUrl: string;
};

// Messages sent FROM offscreen document TO background
export type OffscreenToBackground = {
  type: "OFFSCREEN_SUBMIT_RESULT";
  settledCount: number;
  rejectedCount: number;
  error?: string;
};
