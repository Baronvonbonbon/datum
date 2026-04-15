// ── Smoldot light client lifecycle management ──
//
// Wraps @polkadot-api/smoldot to manage:
//   1. Starting the smoldot WASM worker
//   2. Adding the relay chain
//   3. Adding the parachain (Asset Hub) linked to the relay
//   4. Providing a JSON-RPC send/receive interface for the parachain

import type { PineConfig } from "../types.js";

/** JSON-RPC response callback */
export type JsonRpcCallback = (response: string) => void;

/**
 * SmoldotTransport manages the smoldot light client instance and provides
 * a JSON-RPC interface for the target parachain.
 *
 * Usage:
 *   const transport = new SmoldotTransport();
 *   await transport.start(relaySpec, parachainSpec);
 *   transport.sendJsonRpc('{"jsonrpc":"2.0","id":1,"method":"chainHead_v1_follow","params":[true]}');
 */
export class SmoldotTransport {
  private client: SmoldotClient | null = null;
  private relayChain: SmoldotChain | null = null;
  private parachain: SmoldotChain | null = null;
  private responseListeners = new Set<JsonRpcCallback>();

  /** Start smoldot and connect to relay + parachain. Retries up to maxRetries on failure. */
  async start(
    relayChainSpec: string,
    parachainChainSpec: string,
    maxRetries = 3,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 1s, 2s, 4s
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }

        // Dynamic import — smoldot is heavy and may not be available at parse time.
        // In service worker contexts (MV3 extensions), use startWithBytecode
        // since Web Workers are not available.
        this.client = await this.createClient();

        // Add relay chain
        this.relayChain = await this.client.addChain({
          chainSpec: relayChainSpec,
          disableJsonRpc: true, // We only talk to the parachain
        });

        // Add parachain, linked to relay
        this.parachain = await this.client.addChain({
          chainSpec: parachainChainSpec,
          potentialRelayChains: [this.relayChain],
        });

        // Start pumping responses
        this.pumpResponses();
        return; // success
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Clean up partial state before retry
        await this.stop().catch(() => {});
      }
    }

    throw new Error(
      `SmoldotTransport failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
    );
  }

  /** Send a JSON-RPC request string to the parachain */
  sendJsonRpc(request: string): void {
    if (!this.parachain) {
      throw new Error("SmoldotTransport not started — call start() first");
    }
    this.parachain.sendJsonRpc(request);
  }

  /** Register a listener for JSON-RPC responses */
  onResponse(callback: JsonRpcCallback): () => void {
    this.responseListeners.add(callback);
    return () => this.responseListeners.delete(callback);
  }

  /** Stop smoldot and release resources */
  async stop(): Promise<void> {
    if (this.parachain) {
      this.parachain.remove();
      this.parachain = null;
    }
    if (this.relayChain) {
      this.relayChain.remove();
      this.relayChain = null;
    }
    if (this.client) {
      await this.client.terminate();
      this.client = null;
    }
    this.responseListeners.clear();
  }

  /** Whether the transport has been started */
  get isStarted(): boolean {
    return this.parachain !== null;
  }

  /** Continuously read responses from the parachain JSON-RPC channel */
  private async pumpResponses(): Promise<void> {
    if (!this.parachain) return;

    try {
      while (this.parachain) {
        const response = await this.parachain.nextJsonRpcResponse();
        for (const listener of this.responseListeners) {
          try {
            listener(response);
          } catch {
            // Don't let one bad listener break the pump
          }
        }
      }
    } catch (e) {
      // Chain was removed — this is expected during shutdown
      if (this.parachain) {
        console.error("[Pine] SmoldotTransport response pump error:", e);
      }
    }
  }

  /** Detect whether we're in a service worker and create the appropriate smoldot client */
  private async createClient(): Promise<SmoldotClient> {
    // Service workers (MV3 extensions) can't spawn Web Workers.
    // Detect via globalThis — ServiceWorkerGlobalScope exists only in SW contexts.
    const isServiceWorker =
      typeof (globalThis as Record<string, unknown>).ServiceWorkerGlobalScope !== "undefined";

    if (isServiceWorker) {
      // Use startWithBytecode which runs WASM on the same thread.
      const { startWithBytecode } = await import(/* @vite-ignore */ "smoldot/no-auto-bytecode");
      const { compileBytecode } = await import(/* @vite-ignore */ "smoldot/bytecode");
      const bytecode = await compileBytecode();
      return startWithBytecode({
        bytecode,
        maxLogLevel: 3, // warn
      });
    }

    // Standard browser/Node — smoldot spawns its own worker
    const { start } = await import("smoldot");
    return start({
      maxLogLevel: 3, // warn
    });
  }
}

// ── Smoldot type stubs (actual types come from the smoldot package) ──

interface SmoldotClient {
  addChain(options: {
    chainSpec: string;
    disableJsonRpc?: boolean;
    potentialRelayChains?: SmoldotChain[];
  }): Promise<SmoldotChain>;
  terminate(): Promise<void>;
}

interface SmoldotChain {
  sendJsonRpc(rpc: string): void;
  nextJsonRpcResponse(): Promise<string>;
  remove(): void;
}
