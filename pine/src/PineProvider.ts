// ── PineProvider: EIP-1193 + ethers v6 compatible provider ──
//
// The main entry point for consumers. Translates eth-rpc calls into
// substrate JSON-RPC via smoldot light client.
//
// Usage:
//   const provider = new PineProvider({ chain: "paseo-asset-hub" });
//   await provider.connect();
//   const balance = await provider.request({ method: "eth_getBalance", params: ["0x...", "latest"] });

import type {
  PineConfig,
  EIP1193Provider,
  EIP1193RequestArgs,
  MethodHandler,
  MethodContext,
  TrackedBlock,
} from "./types.js";
import { SmoldotTransport } from "./transport/SmoldotTransport.js";
import { ChainManager } from "./transport/ChainManager.js";
import { Cache } from "./cache/Cache.js";
import { LogIndexer } from "./indexer/LogIndexer.js";
import { ReceiptBuilder } from "./indexer/ReceiptBuilder.js";
import { TxPool } from "./indexer/TxPool.js";
import { createHandlers } from "./methods/registry.js";
import { initXxhash } from "./codec/storageKeys.js";

// Side-effect imports — register all method handlers
import "./methods/eth_chainId.js";
import "./methods/eth_blockNumber.js";
import "./methods/eth_getBalance.js";
import "./methods/eth_getCode.js";
import "./methods/eth_getStorageAt.js";
import "./methods/eth_call.js";
import "./methods/eth_estimateGas.js";
import "./methods/eth_gasPrice.js";
import "./methods/eth_getTransactionCount.js";
import "./methods/eth_getBlockByNumber.js";
import "./methods/eth_getBlockByHash.js";
import "./methods/eth_getTransactionByHash.js";
import "./methods/eth_getTransactionReceipt.js";
import "./methods/eth_getLogs.js";
import "./methods/eth_getBlockTransactionCount.js";
import "./methods/eth_sendRawTransaction.js";
import "./methods/net_version.js";
import "./methods/web3_clientVersion.js";

type EventListener = (...args: unknown[]) => void;

export class PineProvider implements EIP1193Provider {
  readonly config: PineConfig;

  private transport: SmoldotTransport | null = null;
  private chainManager: ChainManager | null = null;
  private cache: Cache | null = null;
  private logIndexer: LogIndexer | null = null;
  private receiptBuilder: ReceiptBuilder | null = null;
  private txPool: TxPool | null = null;
  private handlers: Map<string, MethodHandler> | null = null;
  private eventListeners = new Map<string, Set<EventListener>>();
  private _connected = false;

  constructor(config: PineConfig) {
    this.config = {
      paraId: 1000,
      timeoutMs: 30_000,
      quirkMitigation: true,
      ...config,
    };
  }

  /** Connect to the network via smoldot. Resolves when the first finalized block is received. */
  async connect(): Promise<void> {
    if (this._connected) return;

    // Initialize xxhash WASM (needed for storage key derivation)
    await initXxhash();

    const { relayChainSpec, parachainChainSpec } = await this.resolveChainSpecs();

    // Boot smoldot
    this.transport = new SmoldotTransport();
    await this.transport.start(relayChainSpec, parachainChainSpec);

    // Start chain manager
    this.chainManager = new ChainManager(this.transport);
    this.chainManager.setFatalErrorHandler((error) => {
      this._connected = false;
      this.emit("disconnect", { code: 1013, reason: error.message });
    });
    await this.chainManager.startFollowing();

    // Create cache
    this.cache = new Cache(
      this.config.cache?.maxBlocks ?? 1024,
      this.config.cache?.stateTtlMs ?? 6_000,
    );

    // Invalidate state cache + check pending txs on new finalized block
    this.chainManager.onFinalizedBlock((block: TrackedBlock) => {
      this.cache!.invalidateByPrefix("state:");
      this.cache!.invalidateByPrefix("call:");
      this.emit("chainChanged", "0x" + this.getChainIdHex());

      // Scan for pending transactions in this finalized block
      if (this.txPool?.hasPending()) {
        this.scanBlockForPendingTxs(block).catch(() => {});
      }
    });

    // Create indexer components
    this.txPool = new TxPool();
    this.logIndexer = new LogIndexer(
      this.chainManager,
      this.config.cache?.logWindowBlocks ?? 10_000,
    );
    this.receiptBuilder = new ReceiptBuilder(
      this.chainManager,
      this.logIndexer,
      this.txPool,
    );
    this.logIndexer.start();

    // Build method handlers
    const ctx: MethodContext = {
      chainManager: this.chainManager,
      cache: this.cache,
      config: this.config,
      logIndexer: this.logIndexer,
      receiptBuilder: this.receiptBuilder,
      txPool: this.txPool,
    };
    this.handlers = createHandlers(ctx);

    // Wait for first finalized block
    await this.chainManager.waitReady(this.config.timeoutMs);
    this._connected = true;

    this.emit("connect", { chainId: "0x" + this.getChainIdHex() });
  }

  /** Disconnect from the network and release resources */
  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;

    if (this.logIndexer) {
      this.logIndexer.stop();
      this.logIndexer = null;
    }

    this.receiptBuilder = null;
    this.txPool = null;

    if (this.cache) {
      this.cache.clear();
      this.cache = null;
    }

    this.handlers = null;
    this.chainManager = null;

    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }

    this.emit("disconnect", { code: 1000, reason: "User initiated disconnect" });
  }

  /** Whether the provider is connected */
  get connected(): boolean {
    return this._connected;
  }

  // ── EIP-1193 interface ──

  async request(args: EIP1193RequestArgs): Promise<unknown> {
    const { method, params = [] } = args;

    if (!this._connected || !this.handlers) {
      throw providerError(4900, "Provider is not connected — call connect() first");
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      throw providerError(4200, `Unsupported method: ${method}`);
    }

    try {
      return await handler.execute(params);
    } catch (err) {
      // Wrap internal errors as JSON-RPC errors
      if (err instanceof Error && "code" in err) throw err;
      throw providerError(
        -32603,
        err instanceof Error ? err.message : `Internal error in ${method}`,
      );
    }
  }

  // ── ethers v6 JsonRpcApiProvider compatibility ──

  /** ethers.js v6 calls send(method, params) — delegates to request() */
  async send(method: string, params: unknown[]): Promise<unknown> {
    return this.request({ method, params });
  }

  // ── EIP-1193 events ──

  on(event: string, listener: EventListener): void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  removeListener(event: string, listener: EventListener): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(event);
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch {
          // Don't let a bad listener break the provider
        }
      }
    }
  }

  // ── Pending tx scanner ──

  /**
   * Scan a finalized block's body for transactions matching our pending pool.
   * Uses keccak256 of the raw tx bytes to match.
   */
  private async scanBlockForPendingTxs(block: TrackedBlock): Promise<void> {
    if (!this.chainManager || !this.txPool) return;

    const body = await this.chainManager.getBody(block.hash);
    if (body.length === 0) return;

    const { keccak256 } = await import("ethers");
    const pendingHashes = new Set(this.txPool.getPendingHashes());

    for (let i = 0; i < body.length; i++) {
      // Each extrinsic in the body — compute hash to see if it matches
      const extrinsicHex = "0x" + Array.from(body[i]).map(b => b.toString(16).padStart(2, "0")).join("");
      const extrinsicHash = keccak256(extrinsicHex);

      if (pendingHashes.has(extrinsicHash.toLowerCase())) {
        // Found our transaction! Mark it as included.
        const pending = this.txPool.getPending(extrinsicHash);
        if (pending) {
          this.txPool.markIncluded(extrinsicHash, {
            blockHash: block.hash,
            blockNumber: block.number,
            transactionIndex: i,
            from: pending.from,
            to: pending.to,
            nonce: pending.nonce,
            value: pending.value,
            data: pending.data,
            gasUsed: 0n, // Will be refined when receipt is queried
            status: true, // Assume success — receipt builder refines this
          });
        }
      }
    }
  }

  // ── Chain spec resolution ──

  private async resolveChainSpecs(): Promise<{
    relayChainSpec: string;
    parachainChainSpec: string;
  }> {
    if (this.config.chain === "custom") {
      if (!this.config.relayChainSpec || !this.config.parachainChainSpec) {
        throw new Error(
          'PineProvider: chain="custom" requires relayChainSpec and parachainChainSpec',
        );
      }
      return {
        relayChainSpec: this.config.relayChainSpec,
        parachainChainSpec: this.config.parachainChainSpec,
      };
    }

    const { resolveChainSpec } = await import("./chainspecs/index.js");
    return resolveChainSpec(this.config.chain);
  }

  private getChainIdHex(): string {
    const CHAIN_IDS: Record<string, number> = {
      "paseo-asset-hub": 420420417,
      "polkadot-asset-hub": 420420416,
      "kusama-asset-hub": 420420418,
      "westend-asset-hub": 420420419,
    };
    const id = CHAIN_IDS[this.config.chain] ?? 420420417;
    return id.toString(16);
  }
}

/** Create a JSON-RPC error with an EIP-1193 code */
function providerError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}
