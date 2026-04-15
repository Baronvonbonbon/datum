// ── ChainManager: substrate JSON-RPC interface over smoldot ──
//
// Manages:
//   - chainHead_v1_follow subscription (track finalized blocks)
//   - chainHead_v1_call (runtime API calls — ReviveApi_*)
//   - chainHead_v1_storage (raw storage queries)
//   - transaction_v1_broadcast (submit transactions)
//   - Block hash ↔ number mapping

import type { ChainManagerInterface, TrackedBlock } from "../types.js";
import { SmoldotTransport } from "./SmoldotTransport.js";
import { bytesToHex, hexToBytes } from "../codec/scale.js";

/** Pending JSON-RPC request waiting for a response */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** chainHead operation waiting for an operationId-keyed response */
interface PendingOperation {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class ChainManager implements ChainManagerInterface {
  private transport: SmoldotTransport;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private pendingOperations = new Map<string, PendingOperation>();

  // chainHead_v1_follow state
  private followSubscriptionId: string | null = null;
  private bestFinalizedHash: string = "";
  private bestFinalizedNumber = 0;
  private blocksByHash = new Map<string, TrackedBlock>();
  private hashByNumber = new Map<number, string>();

  // Finalized block listeners
  private finalizedListeners = new Set<(block: TrackedBlock) => void>();
  private readyResolvers: (() => void)[] = [];
  private _isReady = false;
  private reFollowAttempts = 0;
  private static readonly MAX_REFOLLOW_RETRIES = 5;
  private onFatalError: ((error: Error) => void) | null = null;

  constructor(transport: SmoldotTransport) {
    this.transport = transport;
    transport.onResponse((raw) => this.handleResponse(raw));
  }

  /** Register a callback for fatal errors (e.g. re-follow exhausted) */
  setFatalErrorHandler(handler: (error: Error) => void): void {
    this.onFatalError = handler;
  }

  /** Start following the chain head (must call after transport.start()) */
  async startFollowing(): Promise<void> {
    const result = await this.sendRpc<{ result: string }>(
      "chainHead_v1_follow",
      [true], // withRuntime = true
    );
    this.followSubscriptionId = result.result;
  }

  /** Re-follow with exponential backoff after a subscription stop event */
  private async reFollowWithBackoff(): Promise<void> {
    if (this.reFollowAttempts >= ChainManager.MAX_REFOLLOW_RETRIES) {
      const err = new Error(
        `ChainManager: re-follow failed after ${ChainManager.MAX_REFOLLOW_RETRIES} attempts`,
      );
      console.error("[Pine]", err.message);
      this.onFatalError?.(err);
      return;
    }

    this.reFollowAttempts++;
    const delayMs = 1000 * 2 ** (this.reFollowAttempts - 1); // 1s, 2s, 4s, 8s, 16s
    console.warn(
      `[Pine] chainHead follow stopped — retry ${this.reFollowAttempts}/${ChainManager.MAX_REFOLLOW_RETRIES} in ${delayMs}ms`,
    );

    await new Promise((r) => setTimeout(r, delayMs));

    try {
      await this.startFollowing();
      // Success — reset counter
      this.reFollowAttempts = 0;
    } catch (e) {
      console.error("[Pine] re-follow attempt failed:", e);
      this.reFollowWithBackoff();
    }
  }

  /** Wait until the chain manager has received at least one finalized block */
  async waitReady(timeoutMs = 30_000): Promise<void> {
    if (this._isReady) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ChainManager not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── ChainManagerInterface implementation ──

  getBlockNumber(): number {
    return this.bestFinalizedNumber;
  }

  getBlockHash(): string {
    return this.bestFinalizedHash;
  }

  async runtimeCall(fn: string, args: Uint8Array, atHash?: string): Promise<Uint8Array> {
    const hash = atHash ?? this.bestFinalizedHash;
    if (!this.followSubscriptionId) throw new Error("Not following chain");

    const operationResult = await this.sendRpc<{ result: { operationId: string } }>(
      "chainHead_v1_call",
      [this.followSubscriptionId, hash, fn, "0x" + bytesToHex(args)],
    );

    const operationId = operationResult.result.operationId;

    // Wait for the operation result via subscription notification
    const resultHex = await this.waitForOperation<string>(operationId);
    return hexToBytes(resultHex.startsWith("0x") ? resultHex.slice(2) : resultHex);
  }

  async getStorage(key: string, atHash?: string): Promise<string | null> {
    const hash = atHash ?? this.bestFinalizedHash;
    if (!this.followSubscriptionId) throw new Error("Not following chain");

    const operationResult = await this.sendRpc<{ result: { operationId: string } }>(
      "chainHead_v1_storage",
      [
        this.followSubscriptionId,
        hash,
        [{ key, type: "value" }],
        null, // no child trie
      ],
    );

    const operationId = operationResult.result.operationId;
    const items = await this.waitForOperation<StorageItem[]>(operationId);
    return items.length > 0 ? items[0].value ?? null : null;
  }

  async getHeader(hash: string): Promise<Uint8Array | null> {
    if (!this.followSubscriptionId) throw new Error("Not following chain");
    try {
      const result = await this.sendRpc<{ result: string | null }>(
        "chainHead_v1_header",
        [this.followSubscriptionId, hash],
      );
      if (!result.result) return null;
      return hexToBytes(result.result.startsWith("0x") ? result.result.slice(2) : result.result);
    } catch {
      return null;
    }
  }

  async getBody(hash: string): Promise<Uint8Array[]> {
    if (!this.followSubscriptionId) throw new Error("Not following chain");

    const operationResult = await this.sendRpc<{ result: { operationId: string } }>(
      "chainHead_v1_body",
      [this.followSubscriptionId, hash],
    );

    const operationId = operationResult.result.operationId;
    const extrinsics = await this.waitForOperation<string[]>(operationId);
    return extrinsics.map((hex) =>
      hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex),
    );
  }

  async getBlockHashByNumber(num: number): Promise<string | null> {
    // Check local cache first
    const cached = this.hashByNumber.get(num);
    if (cached) return cached;

    // For finalized blocks, we can use archive_unstable_hashByHeight
    // or look it up via header chain walking. For now, return null
    // if not in our tracked window.
    return null;
  }

  async submitTransaction(tx: string): Promise<void> {
    await this.sendRpc("transaction_v1_broadcast", [tx]);
  }

  onFinalizedBlock(cb: (block: TrackedBlock) => void): () => void {
    this.finalizedListeners.add(cb);
    return () => this.finalizedListeners.delete(cb);
  }

  isReady(): boolean {
    return this._isReady;
  }

  // ── Internal JSON-RPC plumbing ──

  private sendRpc<T>(method: string, params: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
      this.transport.sendJsonRpc(request);
    });
  }

  private waitForOperation<T>(operationId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pendingOperations.set(operationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
  }

  private handleResponse(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Direct RPC response (has "id")
    if (msg.id != null) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    // Subscription notification (has "method" + "params")
    if (msg.method && msg.params) {
      this.handleNotification(msg.method, msg.params);
    }
  }

  private handleNotification(method: string, params: any): void {
    // Verify it's for our subscription
    if (params.subscription !== this.followSubscriptionId) return;

    const event = params.result;
    if (!event) return;

    switch (event.event) {
      case "initialized": {
        // First finalized block after follow
        const hash = event.finalizedBlockHashes?.[event.finalizedBlockHashes.length - 1]
          ?? event.finalizedBlockHash; // older smoldot versions
        if (hash) {
          this.bestFinalizedHash = hash;
          // We don't know the number yet — fetch the header
          this.fetchAndTrackBlock(hash).then(() => {
            this._isReady = true;
            for (const r of this.readyResolvers) r();
            this.readyResolvers = [];
          });
        }
        break;
      }
      case "newBlock": {
        // A new non-finalized block appeared — track it
        const hash = event.blockHash;
        const parentHash = event.parentBlockHash;
        if (hash && parentHash) {
          // We'll fetch full details when it's finalized
        }
        break;
      }
      case "bestBlockChanged": {
        // Best block changed — just informational
        break;
      }
      case "finalized": {
        // New finalized blocks
        const hashes: string[] = event.finalizedBlockHashes ?? [];
        for (const hash of hashes) {
          this.bestFinalizedHash = hash;
          this.fetchAndTrackBlock(hash);
        }
        break;
      }
      case "operationCallDone": {
        const pending = this.pendingOperations.get(event.operationId);
        if (pending) {
          this.pendingOperations.delete(event.operationId);
          pending.resolve(event.output);
        }
        break;
      }
      case "operationStorageItems": {
        // Accumulate storage items — for simplicity, resolve immediately
        const pending = this.pendingOperations.get(event.operationId);
        if (pending) {
          // Don't resolve yet — wait for operationStorageDone
          // Store items on the pending object
          (pending as any)._items = [
            ...((pending as any)._items ?? []),
            ...event.items,
          ];
        }
        break;
      }
      case "operationStorageDone": {
        const pending = this.pendingOperations.get(event.operationId);
        if (pending) {
          this.pendingOperations.delete(event.operationId);
          pending.resolve((pending as any)._items ?? []);
        }
        break;
      }
      case "operationBodyDone": {
        const pending = this.pendingOperations.get(event.operationId);
        if (pending) {
          this.pendingOperations.delete(event.operationId);
          pending.resolve(event.value);
        }
        break;
      }
      case "operationError": {
        const pending = this.pendingOperations.get(event.operationId);
        if (pending) {
          this.pendingOperations.delete(event.operationId);
          pending.reject(new Error(`Operation error: ${event.error}`));
        }
        break;
      }
      case "stop": {
        // Subscription terminated by the node — need to re-follow with backoff
        this.followSubscriptionId = null;
        this.reFollowWithBackoff();
        break;
      }
    }
  }

  private async fetchAndTrackBlock(hash: string): Promise<void> {
    try {
      const headerBytes = await this.getHeader(hash);
      if (!headerBytes) return;

      const block = this.parseSubstrateHeader(hash, headerBytes);
      this.blocksByHash.set(hash, block);
      this.hashByNumber.set(block.number, hash);
      this.bestFinalizedNumber = block.number;

      // Notify listeners
      for (const listener of this.finalizedListeners) {
        try {
          listener(block);
        } catch {
          // Don't let one bad listener break the chain
        }
      }

      // Prune old blocks (keep last 256)
      if (this.blocksByHash.size > 256) {
        const oldest = block.number - 256;
        for (const [h, b] of this.blocksByHash) {
          if (b.number < oldest) {
            this.blocksByHash.delete(h);
            this.hashByNumber.delete(b.number);
          }
        }
      }
    } catch (e) {
      console.error("[Pine] Failed to track block:", hash, e);
    }
  }

  /**
   * Parse a minimal substrate header.
   * Header layout (SCALE): parentHash(32) | number(compact) | stateRoot(32) | extrinsicsRoot(32) | digest(...)
   */
  private parseSubstrateHeader(hash: string, data: Uint8Array): TrackedBlock {
    let offset = 0;

    // parentHash: 32 bytes
    const parentHash = "0x" + bytesToHex(data.slice(offset, offset + 32));
    offset += 32;

    // number: compact u32
    const [number, compactLen] = decodeCompactFromBytes(data, offset);
    offset += compactLen;

    // stateRoot: 32 bytes
    const stateRoot = "0x" + bytesToHex(data.slice(offset, offset + 32));
    offset += 32;

    // extrinsicsRoot: 32 bytes
    const extrinsicsRoot = "0x" + bytesToHex(data.slice(offset, offset + 32));

    return {
      number,
      hash,
      parentHash,
      stateRoot,
      extrinsicsRoot,
      timestamp: Math.floor(Date.now() / 1000), // approximate — real timestamp in inherent
    };
  }

  /** Look up a tracked block by hash */
  getTrackedBlock(hash: string): TrackedBlock | undefined {
    return this.blocksByHash.get(hash);
  }

  /** Look up a tracked block by number */
  getTrackedBlockByNumber(num: number): TrackedBlock | undefined {
    const hash = this.hashByNumber.get(num);
    return hash ? this.blocksByHash.get(hash) : undefined;
  }
}

// Inline compact decoder to avoid circular import
function decodeCompactFromBytes(data: Uint8Array, offset: number): [number, number] {
  const mode = data[offset] & 0x03;
  if (mode === 0) return [data[offset] >> 2, 1];
  if (mode === 1) {
    const v = (data[offset] | (data[offset + 1] << 8)) >> 2;
    return [v, 2];
  }
  if (mode === 2) {
    const v =
      (data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)) >>> 2;
    return [v, 4];
  }
  const numBytes = (data[offset] >> 2) + 4;
  let value = 0;
  for (let i = numBytes - 1; i >= 0; i--) {
    value = value * 256 + data[offset + 1 + i];
  }
  return [value, 1 + numBytes];
}

interface StorageItem {
  key: string;
  value?: string;
  hash?: string;
}
