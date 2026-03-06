// Chrome extension message types for background ↔ popup ↔ content ↔ offscreen communication

// Messages sent FROM content script TO background
export type ContentToBackground =
  | { type: "IMPRESSION_RECORDED"; campaignId: string; url: string; category: string; publisherAddress: string }
  | { type: "GET_ACTIVE_CAMPAIGNS" }
  | { type: "UPDATE_INTEREST"; category: string }
  | { type: "SELECT_CAMPAIGN"; campaigns: any[]; pageCategory: string };

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
  | { type: "REQUEST_PUBLISHER_ATTESTATION"; publisherAddress: string; campaignId: string; userAddress: string; firstNonce: string; lastNonce: string; claimCount: number };

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
