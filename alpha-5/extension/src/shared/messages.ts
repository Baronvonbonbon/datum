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
  | { type: "CLEAR_IMPRESSION_LOG" }
  | { type: "EARNINGS_REFRESH_ONESHOT" }
  // Self-contained wallet (Stage 1c). All popup ↔ background wallet
  // calls flow through this single envelope so we don't bloat the
  // PopupToBackground union with one type per op. The `op` field
  // selects the dispatch path inside background/index.ts; `args` is
  // shaped to whatever that op expects. Replies arrive on the
  // WalletRpcResponse channel below, correlated by `requestId`.
  | {
      type: "WALLET_RPC_REQUEST";
      requestId: string;
      op: WalletRpcOp;
      args?: unknown;
    }
  // Content script ↔ background: EIP-1193 provider RPC. Sent by the
  // walletBridge (ISOLATED world) after the walletInjector (MAIN world)
  // proxied a window.datum.request call. Reply is WALLET_PROVIDER_RESPONSE.
  | {
      type: "WALLET_PROVIDER_REQUEST";
      requestId: string;
      method: string;
      params: unknown[];
    };

/// Discriminator for WALLET_RPC_REQUEST. Each op maps to a handler in
/// background/index.ts → background/wallet/{unlock,signing}.ts.
export type WalletRpcOp =
  | "getStatus"
  | "createWallet"
  | "importWallet"
  | "unlock"
  | "lock"
  | "resetWallet"
  | "addHdAccount"
  | "addImportedAccount"
  | "setActiveAccount"
  | "setIdleTimeoutMinutes"
  | "getNativeBalance"
  | "sendNative"
  | "sendContract"
  | "ethCall"
  | "signTransaction"
  | "signTypedData"
  | "personalSign"
  // Permission ops — surfaced by the popup's PermissionRequest overlay
  // and Settings → Permissions section.
  | "listPermissions"
  | "revokePermission"
  | "getPendingPermission"
  | "approvePendingPermission"
  | "denyPendingPermission";

/// Reply envelope for WALLET_RPC_REQUEST. Background pushes this back
/// via `sendResponse`; popupClient resolves the matching Promise.
export type WalletRpcResponse = {
  type: "WALLET_RPC_RESPONSE";
  requestId: string;
  ok: boolean;
  /// Free-form payload — shape depends on the op. See the table in
  /// popup/wallet/walletClient.ts for the per-op return types.
  payload?: unknown;
  error?: string;
};

/// Reply envelope for WALLET_PROVIDER_REQUEST. Background pushes this
/// back to the content-script bridge, which forwards to the page via
/// CustomEvent.
export type WalletProviderResponse = {
  type: "WALLET_PROVIDER_RESPONSE";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// Messages sent FROM background TO offscreen document
export type BackgroundToOffscreen =
  | {
      type: "OFFSCREEN_SUBMIT";
      userAddress: string;
      batches: import("./types").SerializedClaimBatch[];
      contractAddresses: import("./types").ContractAddresses;
      rpcUrl: string;
    }
  | {
      // Pine RPC bridge — background asks the offscreen-hosted PineProvider
      // to handle a JSON-RPC call. Reply is PINE_RPC_RESULT.
      type: "PINE_RPC_REQUEST";
      requestId: string;
      method: string;
      params: unknown[];
    }
  | {
      // Initialize the offscreen pine instance (chainspec + connect).
      // Idempotent — repeated calls report current status without reconnecting.
      type: "PINE_INIT";
      chain: string; // chain preset key, e.g. "paseo-asset-hub"
    }
  | {
      // Subscribe / unsubscribe to status updates (sync step, peer count,
      // finalized head). Background re-broadcasts these to interested
      // popup/UI listeners.
      type: "PINE_STATUS_SUBSCRIBE";
    }
  // ── Wallet ops ────────────────────────────────────────────────────
  // All wallet messages route to the offscreen-hosted wallet host
  // (`offscreen/wallet.ts`). The popup calls them via background's
  // unlock/signing modules, which forward here. Replies follow the
  // matching WALLET_*_RESULT shape on OffscreenToBackground.
  | {
      type: "WALLET_CREATE";
      requestId: string;
      password: string;
      strength?: 128 | 256;
      bip39Passphrase?: string;
    }
  | {
      type: "WALLET_IMPORT";
      requestId: string;
      password: string;
      phrase: string;
      bip39Passphrase?: string;
    }
  | {
      type: "WALLET_UNLOCK";
      requestId: string;
      // Background reads the persisted vault and forwards it here; the
      // offscreen host doesn't touch chrome.storage directly so testing
      // stays self-contained.
      vault: import("../background/wallet/keystore").Vault;
      password: string;
    }
  | { type: "WALLET_LOCK"; requestId: string }
  | { type: "WALLET_IS_UNLOCKED"; requestId: string }
  | { type: "WALLET_ADD_HD_ACCOUNT"; requestId: string; label?: string }
  | {
      type: "WALLET_ADD_IMPORTED";
      requestId: string;
      privateKey: string;
      label?: string;
    }
  | { type: "WALLET_SET_ACTIVE"; requestId: string; index: number }
  | {
      type: "WALLET_REENCRYPT";
      requestId: string;
      password: string;
    }
  | {
      type: "WALLET_SIGN_TRANSACTION";
      requestId: string;
      // ethers' TransactionRequest is intentionally untyped here so the
      // message channel stays JSON-friendly (BigInts must be stringified).
      tx: Record<string, unknown>;
    }
  | {
      type: "WALLET_SIGN_TYPED_DATA";
      requestId: string;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      value: Record<string, unknown>;
    }
  | { type: "WALLET_PERSONAL_SIGN"; requestId: string; message: string };

// Messages sent FROM offscreen document TO background
export type OffscreenToBackground =
  | {
      type: "OFFSCREEN_SUBMIT_RESULT";
      settledCount: number;
      rejectedCount: number;
      error?: string;
    }
  | {
      type: "PINE_RPC_RESULT";
      requestId: string;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    }
  | {
      type: "PINE_STATUS";
      status: PineStatus;
    }
  // ── Wallet replies ───────────────────────────────────────────────
  // Single-shape envelope: { type, requestId, ok, error?, ...payload }.
  // The popup correlates by requestId; background's wallet orchestrator
  // unwraps and returns Promise<payload> to its callers.
  | {
      type: "WALLET_RESULT";
      requestId: string;
      ok: boolean;
      error?: string;
      /// Free-form payload, shape depends on the originating WALLET_* op.
      /// See offscreen/wallet.ts for the shapes returned by each handler.
      payload?: unknown;
    };

/// Snapshot of the offscreen pine instance's lifecycle, broadcast to
/// background → popup → any tile that listens. Stage-1 surface is small;
/// every consumer keeps a single `useState<PineStatus>` and renders accordingly.
export type PineStatus = {
  /// "idle" before PINE_INIT. "connecting" while smoldot warms up.
  /// "ready" once the first finalized block is observed and the LogIndexer
  /// has at least started. "error" if connect rejected; the error string is
  /// populated.
  state: "idle" | "connecting" | "ready" | "error";
  /// Most recent SyncStep label from pine (e.g. "fetching-chainspec",
  /// "waiting-for-peers", "syncing-from-checkpoint"). Empty before connect.
  step: string;
  /// Smoldot's peer count, reported by chainHead. 0 until smoldot dials out.
  peers: number;
  /// Latest finalized block number seen, or 0 if none yet.
  finalizedHead: number;
  /// Block at which pine considers its LogIndexer warm. UI uses this as the
  /// lower-bound when computing "history begins at block N" footers.
  indexedFromBlock: number;
  /// Populated only when state === "error".
  error?: string;
};
