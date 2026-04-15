// ── LogIndexer: real-time event tracking from finalized blocks ──
//
// Subscribes to finalized blocks via ChainManager and extracts EVM logs
// from System.Events storage. Maintains a rolling window of indexed logs
// for eth_getLogs queries.
//
// pallet-revive emits these relevant events:
//   - Revive::ContractEmitted { contract: AccountId20, data: Vec<u8> }
//     The `data` field contains the raw EVM log entry (topics + data).
//
// Event storage layout (System.Events):
//   Vec<EventRecord<Event, Hash>> where each EventRecord is:
//     phase: ApplyExtrinsic(u32) | Finalization | Initialization
//     event: enum (pallet_index, event_variant, fields...)
//     topics: Vec<Hash>

import type {
  ChainManagerInterface,
  TrackedBlock,
  EthLog,
  EthLogFilter,
} from "../types.js";
import { systemEventsKey } from "../codec/storageKeys.js";
import { bytesToHex, hexToBytes } from "../codec/scale.js";

/** A block's worth of indexed EVM logs */
interface BlockLogs {
  blockNumber: number;
  blockHash: string;
  logs: EthLog[];
}

const DEFAULT_WINDOW = 10_000; // blocks to keep in rolling window

export class LogIndexer {
  private chainManager: ChainManagerInterface;
  private logWindow = new Map<string, BlockLogs>(); // blockHash → logs
  private logsByNumber = new Map<number, string>(); // blockNumber → blockHash
  private maxWindow: number;
  private unsubscribe: (() => void) | null = null;

  // pallet-revive pallet index — discovered at runtime from first event scan
  private revivePalletIndex: number | null = null;

  constructor(chainManager: ChainManagerInterface, maxWindow = DEFAULT_WINDOW) {
    this.chainManager = chainManager;
    this.maxWindow = maxWindow;
  }

  /** Start indexing finalized blocks */
  start(): void {
    this.unsubscribe = this.chainManager.onFinalizedBlock((block) => {
      this.indexBlock(block).catch((e) => {
        console.error("[Pine] LogIndexer failed to index block:", block.number, e);
      });
    });
  }

  /** Stop indexing */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Query logs matching a filter */
  getLogs(filter: EthLogFilter): EthLog[] {
    const fromBlock = filter.fromBlock
      ? resolveBlockTag(filter.fromBlock, this.latestBlockNumber())
      : this.latestBlockNumber();
    const toBlock = filter.toBlock
      ? resolveBlockTag(filter.toBlock, this.latestBlockNumber())
      : this.latestBlockNumber();

    const results: EthLog[] = [];

    for (let num = fromBlock; num <= toBlock; num++) {
      const hash = this.logsByNumber.get(num);
      if (!hash) continue;
      const blockLogs = this.logWindow.get(hash);
      if (!blockLogs) continue;

      for (const log of blockLogs.logs) {
        if (matchesFilter(log, filter)) {
          results.push(log);
        }
      }
    }

    return results;
  }

  /** Get logs for a specific block hash */
  getBlockLogs(blockHash: string): EthLog[] {
    return this.logWindow.get(blockHash.toLowerCase())?.logs ?? [];
  }

  /** Get all logs emitted by a specific extrinsic index within a block */
  getExtrinsicLogs(blockHash: string, extrinsicIndex: number): EthLog[] {
    const blockLogs = this.logWindow.get(blockHash.toLowerCase());
    if (!blockLogs) return [];
    // Logs store transactionIndex = extrinsic index
    return blockLogs.logs.filter(
      (log) => Number(BigInt(log.transactionIndex)) === extrinsicIndex,
    );
  }

  private latestBlockNumber(): number {
    return this.chainManager.getBlockNumber();
  }

  /** Index a single finalized block's events */
  private async indexBlock(block: TrackedBlock): Promise<void> {
    const eventsKey = systemEventsKey();
    const eventsHex = await this.chainManager.getStorage(eventsKey, block.hash);

    const logs: EthLog[] = [];

    if (eventsHex) {
      const eventsBytes = hexToBytes(eventsHex.startsWith("0x") ? eventsHex.slice(2) : eventsHex);
      const parsed = this.parseSystemEvents(eventsBytes, block);
      logs.push(...parsed);
    }

    // Assign log indices
    for (let i = 0; i < logs.length; i++) {
      logs[i].logIndex = "0x" + i.toString(16);
    }

    const entry: BlockLogs = {
      blockNumber: block.number,
      blockHash: block.hash,
      logs,
    };

    this.logWindow.set(block.hash.toLowerCase(), entry);
    this.logsByNumber.set(block.number, block.hash.toLowerCase());

    // Prune old blocks beyond the rolling window
    const cutoff = block.number - this.maxWindow;
    for (const [hash, bl] of this.logWindow) {
      if (bl.blockNumber < cutoff) {
        this.logWindow.delete(hash);
        this.logsByNumber.delete(bl.blockNumber);
      }
    }
  }

  /**
   * Parse System.Events SCALE blob and extract EVM logs.
   *
   * System.Events is Vec<EventRecord> where each EventRecord:
   *   phase: enum { ApplyExtrinsic(u32), Finalization, Initialization }
   *   event: enum Event (pallet_index: u8, variant: u8, fields...)
   *   topics: Vec<H256>
   *
   * We're looking for Revive::ContractEmitted events which contain
   * the raw EVM log data (Ethereum-style topics + data).
   *
   * The EVM log is encoded in ContractEmitted.data as:
   *   num_topics: u8 (0-4)
   *   topic[0..n]: H256 each
   *   remaining: log data bytes
   */
  private parseSystemEvents(data: Uint8Array, block: TrackedBlock): EthLog[] {
    const logs: EthLog[] = [];
    let offset = 0;

    // Vec length (compact)
    const [numEvents, compactLen] = decodeCompactAt(data, offset);
    offset += compactLen;

    for (let i = 0; i < numEvents && offset < data.length; i++) {
      try {
        // Phase: enum
        const phaseVariant = data[offset];
        offset += 1;

        let extrinsicIndex = -1;
        if (phaseVariant === 0) {
          // ApplyExtrinsic(u32)
          extrinsicIndex =
            data[offset] |
            (data[offset + 1] << 8) |
            (data[offset + 2] << 16) |
            (data[offset + 3] << 24);
          offset += 4;
        }
        // phaseVariant 1 = Finalization, 2 = Initialization — no extra data

        // Event: pallet_index(u8) + variant(u8)
        const palletIndex = data[offset];
        offset += 1;
        const eventVariant = data[offset];
        offset += 1;

        // We need to identify Revive::ContractEmitted.
        // The pallet index varies by runtime. ContractEmitted is typically
        // variant index 1 in pallet-revive's event enum.
        //
        // ContractEmitted { contract: AccountId20, data: Vec<u8> }
        //
        // We detect this by checking if the pallet index matches our cached
        // revive pallet index (or discover it heuristically).
        //
        // For robustness, we attempt to parse any event from the revive pallet
        // and skip events from other pallets by reading their SCALE-encoded
        // size. However, without full runtime metadata, we can't know the exact
        // size of arbitrary events.
        //
        // Strategy: Use runtime metadata call to discover pallet index on first
        // block, then only parse events from that pallet. For events from other
        // pallets, skip using the topics Vec at the end of EventRecord.
        //
        // SIMPLIFIED APPROACH: Since we can't reliably skip unknown events
        // without metadata, we'll attempt to parse ContractEmitted events
        // and bail gracefully on parse errors. A more robust implementation
        // would use the Metadata_metadata runtime call to build a full decoder.

        if (this.revivePalletIndex !== null && palletIndex !== this.revivePalletIndex) {
          // Skip this event — try to find the next EventRecord by scanning
          // for the topics Vec. This is fragile without metadata, so we'll
          // try to skip the rest of this event + topics.
          offset = this.skipUnknownEventFields(data, offset);
          continue;
        }

        // Try to parse as ContractEmitted (variant typically 1)
        // ContractEmitted { contract: H160, data: Vec<u8> }
        if (eventVariant === 1 || this.revivePalletIndex === null) {
          const parseStart = offset;
          try {
            // contract: H160 (20 bytes)
            if (offset + 20 > data.length) { offset = parseStart; break; }
            const contract = "0x" + bytesToHex(data.slice(offset, offset + 20));
            offset += 20;

            // data: Vec<u8>
            const [dataLen, dataCompactLen] = decodeCompactAt(data, offset);
            offset += dataCompactLen;

            if (offset + dataLen > data.length) { offset = parseStart; break; }
            const evmLogData = data.slice(offset, offset + dataLen);
            offset += dataLen;

            // Parse the EVM log from the ContractEmitted data field
            const evmLog = parseEvmLogFromContractEmitted(evmLogData, contract, block, extrinsicIndex);
            if (evmLog) {
              logs.push(evmLog);
              // We found a valid Revive event — cache the pallet index
              if (this.revivePalletIndex === null) {
                this.revivePalletIndex = palletIndex;
              }
            }

            // Skip topics Vec at end of EventRecord
            offset = this.skipTopicsVec(data, offset);
          } catch {
            // Parse failed — this wasn't a ContractEmitted event.
            // Reset and skip.
            offset = parseStart;
            offset = this.skipUnknownEventFields(data, offset);
          }
        } else {
          offset = this.skipUnknownEventFields(data, offset);
        }
      } catch {
        // Can't parse further — stop
        break;
      }
    }

    return logs;
  }

  /** Skip the topics Vec<H256> at the end of an EventRecord */
  private skipTopicsVec(data: Uint8Array, offset: number): number {
    if (offset >= data.length) return offset;
    const [numTopics, compactLen] = decodeCompactAt(data, offset);
    offset += compactLen;
    offset += numTopics * 32; // each topic is H256 = 32 bytes
    return offset;
  }

  /**
   * Skip unknown event fields. Without runtime metadata we can't know
   * the exact size, so we look for the topics Vec pattern and skip to
   * the end of the EventRecord. This is a best-effort heuristic.
   */
  private skipUnknownEventFields(data: Uint8Array, offset: number): number {
    // Scan forward for a plausible topics Vec header (compact 0 = 0x00 is most common)
    // This is fragile but better than nothing. A production implementation
    // should fetch runtime metadata once and build a proper event decoder.
    //
    // Most events have 0 runtime topics, so we look for 0x00 followed by
    // a valid phase byte for the next event.
    const maxScan = Math.min(offset + 512, data.length);
    for (let i = offset; i < maxScan; i++) {
      if (data[i] === 0x00) {
        // Could be topics Vec of length 0 — check if next byte looks like a valid phase
        const next = i + 1;
        if (next < data.length && data[next] <= 2) {
          return next;
        }
      }
    }
    // Give up — return end of data
    return data.length;
  }
}

/**
 * Parse an EVM log from a ContractEmitted data field.
 *
 * pallet-revive encodes EVM logs in the ContractEmitted event's data
 * as raw bytes. The encoding depends on the runtime version but
 * commonly follows:
 *   topics_count: compact<u32>
 *   topics: [H256; topics_count]
 *   data: remaining bytes
 */
function parseEvmLogFromContractEmitted(
  rawData: Uint8Array,
  contractAddress: string,
  block: TrackedBlock,
  extrinsicIndex: number,
): EthLog | null {
  if (rawData.length === 0) return null;

  let offset = 0;

  // Topics count (compact encoded)
  const [numTopics, compactLen] = decodeCompactAt(rawData, offset);
  offset += compactLen;

  if (numTopics > 4) return null; // EVM max 4 topics

  const topics: string[] = [];
  for (let t = 0; t < numTopics; t++) {
    if (offset + 32 > rawData.length) return null;
    topics.push("0x" + bytesToHex(rawData.slice(offset, offset + 32)));
    offset += 32;
  }

  const logData = rawData.slice(offset);

  return {
    address: contractAddress.toLowerCase(),
    topics,
    data: logData.length > 0 ? "0x" + bytesToHex(logData) : "0x",
    blockNumber: "0x" + block.number.toString(16),
    blockHash: block.hash,
    transactionHash: "0x" + "0".repeat(64), // filled in by caller if known
    transactionIndex: "0x" + Math.max(0, extrinsicIndex).toString(16),
    logIndex: "0x0", // filled in by caller
    removed: false,
  };
}

/** Match an EthLog against an EthLogFilter */
function matchesFilter(log: EthLog, filter: EthLogFilter): boolean {
  // Address filter
  if (filter.address) {
    const filterAddrs = Array.isArray(filter.address)
      ? filter.address.map((a) => a.toLowerCase())
      : [filter.address.toLowerCase()];
    if (!filterAddrs.includes(log.address.toLowerCase())) return false;
  }

  // Topics filter
  if (filter.topics) {
    for (let i = 0; i < filter.topics.length; i++) {
      const criterion = filter.topics[i];
      if (criterion === null || criterion === undefined) continue;
      const logTopic = log.topics[i];
      if (!logTopic) return false;

      if (Array.isArray(criterion)) {
        // OR match — log topic must match any in the array
        if (!criterion.some((t) => t.toLowerCase() === logTopic.toLowerCase())) {
          return false;
        }
      } else {
        if (criterion.toLowerCase() !== logTopic.toLowerCase()) return false;
      }
    }
  }

  return true;
}

function resolveBlockTag(tag: string, latest: number): number {
  if (tag === "latest" || tag === "finalized" || tag === "safe") return latest;
  if (tag === "earliest") return 0;
  if (tag === "pending") return latest;
  return Number(BigInt(tag));
}

// Inline compact decoder (avoid circular deps)
function decodeCompactAt(data: Uint8Array, offset: number): [number, number] {
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
