// ── Pine core types ──

/** Supported chain presets */
export type ChainPreset =
  | "paseo-asset-hub"
  | "polkadot-asset-hub"
  | "kusama-asset-hub"
  | "westend-asset-hub";

/** Pine provider configuration */
export interface PineConfig {
  /** Named chain preset, or "custom" for manual specs */
  chain: ChainPreset | "custom";
  /** Override relay chain spec JSON (required if chain="custom") */
  relayChainSpec?: string;
  /** Override parachain spec JSON (required if chain="custom") */
  parachainChainSpec?: string;
  /** Parachain ID (default: 1000 = Asset Hub) */
  paraId?: number;
  /** Cache configuration */
  cache?: CacheConfig;
  /** Connection timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Enable Paseo-specific quirk mitigation (default: true) */
  quirkMitigation?: boolean;
  /** Extrinsic encoding config (pallet/call indices) */
  extrinsic?: {
    revivePalletIndex?: number;
    ethTransactCallIndex?: number;
  };
}

export interface CacheConfig {
  /** State TTL in ms (default: 6000 — one block) */
  stateTtlMs?: number;
  /** Contract code TTL in ms (default: 300000 — 5 min) */
  codeTtlMs?: number;
  /** Max cached blocks (default: 256) */
  maxBlocks?: number;
  /** Max log rolling window in blocks (default: 10000) */
  logWindowBlocks?: number;
}

// ── EIP-1193 ──

export interface EIP1193RequestArgs {
  method: string;
  params?: unknown[];
}

export interface EIP1193Provider {
  request(args: EIP1193RequestArgs): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

// ── JSON-RPC ──

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown[];
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── Ethereum types (returned by Pine) ──

export interface EthBlock {
  number: string; // hex
  hash: string;
  parentHash: string;
  timestamp: string; // hex
  miner: string;
  difficulty: string;
  totalDifficulty: string;
  gasLimit: string;
  gasUsed: string;
  baseFeePerGas: string | null;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot: string;
  size: string;
  extraData: string;
  mixHash: string;
  uncles: string[];
  transactions: (string | EthTransaction)[];
}

export interface EthTransaction {
  hash: string;
  nonce: string;
  blockHash: string | null;
  blockNumber: string | null;
  transactionIndex: string | null;
  from: string;
  to: string | null;
  value: string;
  gasPrice: string;
  gas: string;
  input: string;
  type: string;
  chainId: string;
  v: string;
  r: string;
  s: string;
}

export interface EthTransactionReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string | null;
  cumulativeGasUsed: string;
  gasUsed: string;
  contractAddress: string | null;
  logs: EthLog[];
  logsBloom: string;
  status: string; // "0x1" success, "0x0" failure
  type: string;
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
}

export interface EthLogFilter {
  address?: string | string[];
  topics?: (string | string[] | null)[];
  fromBlock?: string;
  toBlock?: string;
}

// ── Internal block tracking ──

export interface TrackedBlock {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  timestamp: number;
}

// ── Method handler interface ──

export interface MethodHandler {
  execute(params: unknown[]): Promise<unknown>;
}

export type MethodFactory = (ctx: MethodContext) => MethodHandler;

export interface MethodContext {
  chainManager: ChainManagerInterface;
  cache: CacheInterface;
  config: PineConfig;
  /** Log indexer — available after connect (Phase 3) */
  logIndexer?: LogIndexerInterface;
  /** Receipt builder — available after connect (Phase 3) */
  receiptBuilder?: ReceiptBuilderInterface;
  /** Transaction pool — available after connect (Phase 3) */
  txPool?: TxPoolInterface;
}

// ── Internal interfaces (for testability) ──

export interface ChainManagerInterface {
  /** Get the current best finalized block number */
  getBlockNumber(): number;
  /** Get the current best finalized block hash */
  getBlockHash(): string;
  /** Execute a runtime API call */
  runtimeCall(fn: string, args: Uint8Array, atHash?: string): Promise<Uint8Array>;
  /** Query storage by key */
  getStorage(key: string, atHash?: string): Promise<string | null>;
  /** Get block header by hash */
  getHeader(hash: string): Promise<Uint8Array | null>;
  /** Get block body (extrinsics) by hash */
  getBody(hash: string): Promise<Uint8Array[]>;
  /** Get block hash by number */
  getBlockHashByNumber(num: number): Promise<string | null>;
  /** Submit a transaction */
  submitTransaction(tx: string): Promise<void>;
  /** Register callback for new finalized blocks */
  onFinalizedBlock(cb: (block: TrackedBlock) => void): () => void;
  /** Whether the chain manager is connected and synced */
  isReady(): boolean;
}

export interface CacheInterface {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
  invalidateByPrefix(prefix: string): void;
}

export interface LogIndexerInterface {
  getLogs(filter: EthLogFilter): EthLog[];
  getBlockLogs(blockHash: string): EthLog[];
  getExtrinsicLogs(blockHash: string, extrinsicIndex: number): EthLog[];
}

export interface ReceiptBuilderInterface {
  getReceipt(txHash: string): Promise<EthTransactionReceipt | null>;
}

export interface TxPoolInterface {
  addPending(tx: {
    hash: string;
    raw: string;
    from: string;
    to: string | null;
    nonce: number;
    value: string;
    data: string;
    submittedAt: number;
  }): void;
  get(txHash: string): unknown | undefined;
  getIncluded(txHash: string): unknown | undefined;
  getPending(txHash: string): unknown | undefined;
  formatTransaction(txHash: string): EthTransaction | null;
  hasPending(): boolean;
  getPendingHashes(): string[];
}
