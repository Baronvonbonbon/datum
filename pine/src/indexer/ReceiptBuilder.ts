// ── ReceiptBuilder: construct TransactionReceipt from block data ──
//
// This is Pine's fix for the Paseo eth_getTransactionReceipt null bug.
// Instead of relying on the eth-rpc proxy to return receipts, we build
// them from block events directly.
//
// Flow:
//   1. Find the block containing the tx (via TxPool tracking)
//   2. Get the extrinsic index within the block body
//   3. Read System.Events for that block
//   4. Extract logs emitted by that extrinsic
//   5. Build a proper EthTransactionReceipt

import type {
  EthTransactionReceipt,
  EthLog,
  ChainManagerInterface,
} from "../types.js";
import type { LogIndexer } from "./LogIndexer.js";
import type { TxPool, IncludedTx } from "./TxPool.js";
import { toHex } from "../codec/denomination.js";

export class ReceiptBuilder {
  private chainManager: ChainManagerInterface;
  private logIndexer: LogIndexer;
  private txPool: TxPool;

  constructor(
    chainManager: ChainManagerInterface,
    logIndexer: LogIndexer,
    txPool: TxPool,
  ) {
    this.chainManager = chainManager;
    this.logIndexer = logIndexer;
    this.txPool = txPool;
  }

  /**
   * Build a receipt for a transaction hash.
   * Returns null if the tx is not yet included or not tracked.
   */
  async getReceipt(txHash: string): Promise<EthTransactionReceipt | null> {
    const included = this.txPool.getIncluded(txHash);
    if (!included) {
      // Not yet included — try to discover it from recent blocks
      // (for txs submitted before Pine started tracking)
      return null;
    }

    return this.buildReceipt(included);
  }

  private buildReceipt(tx: IncludedTx): EthTransactionReceipt {
    // Get logs for this extrinsic from the LogIndexer
    const rawLogs = this.logIndexer.getExtrinsicLogs(
      tx.blockHash,
      tx.transactionIndex,
    );

    // Stamp each log with the correct transaction hash
    const logs: EthLog[] = rawLogs.map((log, idx) => ({
      ...log,
      transactionHash: tx.hash,
      logIndex: "0x" + idx.toString(16),
    }));

    // Build a 256-byte zero logsBloom (EIP-1193 compat)
    const logsBloom = "0x" + "0".repeat(512);

    // Compute cumulative gas (approximate — we don't have access to
    // other tx gas usage in the same block, so use gasUsed)
    const gasUsed = toHex(tx.gasUsed);

    return {
      transactionHash: tx.hash,
      transactionIndex: "0x" + tx.transactionIndex.toString(16),
      blockHash: tx.blockHash,
      blockNumber: "0x" + tx.blockNumber.toString(16),
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: gasUsed,
      gasUsed,
      contractAddress: deriveContractAddress(tx),
      logs,
      logsBloom,
      status: tx.status ? "0x1" : "0x0",
      type: "0x0",
    };
  }
}

/**
 * Derive the created contract address for a contract-creation tx.
 * If `to` is null, the tx was a deployment — compute the address
 * from (sender, nonce) using CREATE semantics.
 * Returns null for regular calls.
 */
function deriveContractAddress(tx: IncludedTx): string | null {
  if (tx.to !== null) return null;

  // EVM CREATE address: keccak256(rlp([sender, nonce]))[12:]
  // For pallet-revive on Asset Hub, contract addresses may be computed
  // differently. For now, return null — the exact derivation depends
  // on whether the runtime uses CREATE or CREATE2 semantics.
  //
  // TODO: Use ethers.getCreateAddress({ from: tx.from, nonce: tx.nonce })
  // once we verify pallet-revive uses standard CREATE derivation.
  return null;
}
