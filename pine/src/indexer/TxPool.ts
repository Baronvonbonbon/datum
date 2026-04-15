// ── TxPool: local transaction tracking ──
//
// Tracks submitted transactions so we can look them up by hash later.
// When a transaction is submitted via eth_sendRawTransaction, it is
// registered here. The LogIndexer then scans finalized blocks for
// matching extrinsics and links them.

import type { EthTransaction } from "../types.js";

export interface PendingTx {
  hash: string;
  raw: string;
  from: string;
  to: string | null;
  nonce: number;
  value: string;
  data: string;
  submittedAt: number; // timestamp
}

export interface IncludedTx {
  hash: string;
  blockHash: string;
  blockNumber: number;
  transactionIndex: number;
  from: string;
  to: string | null;
  nonce: number;
  value: string;
  data: string;
  gasUsed: bigint;
  status: boolean; // true = success
}

const MAX_PENDING = 256;
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class TxPool {
  private pending = new Map<string, PendingTx>();
  private included = new Map<string, IncludedTx>();

  /** Register a submitted transaction */
  addPending(tx: PendingTx): void {
    // Evict old entries
    this.pruneStale();
    if (this.pending.size >= MAX_PENDING) {
      // Drop oldest
      const oldest = this.pending.keys().next().value!;
      this.pending.delete(oldest);
    }
    this.pending.set(tx.hash.toLowerCase(), tx);
  }

  /** Mark a transaction as included in a finalized block */
  markIncluded(txHash: string, info: Omit<IncludedTx, "hash">): void {
    const key = txHash.toLowerCase();
    this.pending.delete(key);
    this.included.set(key, { hash: txHash, ...info });
  }

  /** Look up a pending or included transaction by hash */
  get(txHash: string): PendingTx | IncludedTx | undefined {
    const key = txHash.toLowerCase();
    return this.included.get(key) ?? this.pending.get(key);
  }

  /** Check if a tx is included (finalized) */
  getIncluded(txHash: string): IncludedTx | undefined {
    return this.included.get(txHash.toLowerCase());
  }

  /** Check if a tx is still pending */
  getPending(txHash: string): PendingTx | undefined {
    return this.pending.get(txHash.toLowerCase());
  }

  /** Format a tracked tx as an EthTransaction */
  formatTransaction(txHash: string): EthTransaction | null {
    const tx = this.get(txHash);
    if (!tx) return null;

    const isIncluded = "blockHash" in tx;

    return {
      hash: tx.hash,
      nonce: "0x" + tx.nonce.toString(16),
      blockHash: isIncluded ? (tx as IncludedTx).blockHash : null,
      blockNumber: isIncluded ? "0x" + (tx as IncludedTx).blockNumber.toString(16) : null,
      transactionIndex: isIncluded ? "0x" + (tx as IncludedTx).transactionIndex.toString(16) : null,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      gasPrice: "0xe8d4a51000", // 10^12
      gas: "0x0",
      input: tx.data,
      type: "0x0",
      chainId: "0x0",
      v: "0x0",
      r: "0x0",
      s: "0x0",
    };
  }

  /** Whether there are any pending (unconfirmed) transactions */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Get all pending transaction hashes (for block scanning) */
  getPendingHashes(): string[] {
    return Array.from(this.pending.keys());
  }

  get size(): number {
    return this.pending.size + this.included.size;
  }

  private pruneStale(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, tx] of this.pending) {
      if (tx.submittedAt < cutoff) {
        this.pending.delete(key);
      }
    }
  }
}
