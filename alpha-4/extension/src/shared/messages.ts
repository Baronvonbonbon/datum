// Chrome extension message types for background <-> popup <-> content <-> offscreen communication

// Messages sent FROM content script TO background
export type ContentToBackground =
  | { type: "IMPRESSION_RECORDED"; campaignId: string; url: string; category: string; publisherAddress: string; clearingCpmPlanck?: string; campaignTags?: string[] }
  | { type: "AD_CLICK"; campaignId: string; publisherAddress: string; impressionNonce: string }
  | { type: "REMOTE_ACTION"; campaignId: string; publisherAddress: string }
  | { type: "GET_ACTIVE_CAMPAIGNS" }
  | { type: "UPDATE_INTEREST"; tags: string[]; category?: string; delta?: number }
  | { type: "SELECT_CAMPAIGN"; campaigns: any[]; pageCategory: string; pageTags?: string[]; slotFormat?: string; excludedCampaignIds?: string[] }
  | { type: "FETCH_IPFS_METADATA"; campaignId: string; metadataHash: string; bulletinDigest?: string; bulletinCodec?: number }
  | { type: "ENGAGEMENT_RECORDED"; event: import("./types").EngagementEvent }
  | { type: "ENGAGEMENT_QUALITY_RESULT"; campaignId: string; qualityScore: number; passed: boolean }
  | { type: "SET_PUBLISHER_RELAY"; publisher: string; relay: string }
  | { type: "CHECK_PUBLISHER_ALLOWLIST"; publisher: string }
  // window.datum provider bridge (EIP-1193 compatible)
  | { type: "PROVIDER_CONNECT" }
  | { type: "PROVIDER_GET_ADDRESS" }
  | { type: "PROVIDER_GET_CHAIN_ID" }
  | { type: "PROVIDER_SIGN_TYPED_DATA"; domain: any; types: any; value: any; requestId: string }
  | { type: "PROVIDER_PERSONAL_SIGN"; message: string; address: string; requestId: string }
  | { type: "PROVIDER_SEND_TRANSACTION"; tx: any; requestId: string }
  | { type: "PROVIDER_RPC_PROXY"; method: string; params: any[]; requestId: string }
  | { type: "PROVIDER_DISCONNECT" };

// Messages sent FROM popup TO background
export type PopupToBackground =
  | { type: "WALLET_CONNECTED"; address: string }
  | { type: "WALLET_DISCONNECTED" }
  | { type: "SUBMIT_CLAIMS"; userAddress: string }
  | { type: "SUBMIT_CAMPAIGN_CLAIMS"; userAddress: string; campaignId: string }
  | { type: "DISCARD_CAMPAIGN_CLAIMS"; userAddress: string; campaignId: string }
  | { type: "SIGN_FOR_RELAY"; userAddress: string; campaignId: string }
  | { type: "GET_QUEUE_STATE" }
  | { type: "CLEAR_QUEUE" }
  | { type: "SETTINGS_UPDATED"; settings: import("./types").StoredSettings }
  | { type: "RESET_CHAIN_STATE" }
  | { type: "REMOVE_SETTLED_CLAIMS"; userAddress: string; settledNonces: Record<string, string[]> }
  | { type: "PRUNE_SETTLED_UP_TO_NONCE"; userAddress: string; campaignId: string; upToNonce: string }
  | { type: "SYNC_CHAIN_STATE"; userAddress: string; campaignId: string; onChainNonce: number; onChainHash: string }
  | { type: "ACQUIRE_MUTEX" }
  | { type: "RELEASE_MUTEX" }
  | { type: "POLL_CAMPAIGNS" }
  | { type: "GET_INTEREST_PROFILE" }
  | { type: "RESET_INTEREST_PROFILE" }
  | { type: "REQUEST_PUBLISHER_ATTESTATION"; publisherAddress: string; campaignId: string; userAddress: string; claimsHash: string; deadlineBlock: string }
  | { type: "GET_USER_PREFERENCES" }
  | { type: "UPDATE_USER_PREFERENCES"; preferences: Partial<import("./types").UserPreferences> }
  | { type: "BLOCK_CAMPAIGN"; campaignId: string }
  | { type: "UNBLOCK_CAMPAIGN"; campaignId: string }
  | { type: "BLOCK_TAG"; tag: string }
  | { type: "UNBLOCK_TAG"; tag: string }
  | { type: "AUTHORIZE_AUTO_SUBMIT"; password: string }
  | { type: "REVOKE_AUTO_SUBMIT" }
  | { type: "CHECK_AUTO_SUBMIT" }
  | { type: "GET_TIMELOCK_PENDING" }
  | { type: "PROVIDER_APPROVAL_RESPONSE"; requestId: string; approved: boolean }
  | { type: "DISCARD_REJECTED_CLAIMS"; userAddress: string; campaignIds: string[] }
  | { type: "GET_AD_RATE" }
  | { type: "REPORT_PAGE"; campaignId: string; reason: number }
  | { type: "REPORT_AD"; campaignId: string; reason: number }
  | { type: "GET_IMPRESSION_LOG" }
  | { type: "CLEAR_IMPRESSION_LOG" };

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
