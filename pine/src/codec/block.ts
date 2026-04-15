// ── Substrate block → Ethereum block format conversion ──

import type { EthBlock, EthTransaction, TrackedBlock } from "../types.js";
import { toHex } from "./denomination.js";

const ZERO_HASH = "0x" + "0".repeat(64);
const EMPTY_BLOOM = "0x" + "0".repeat(512);

/**
 * Convert a substrate block header into an eth-rpc compatible block object.
 * Many fields are placeholder/zero since substrate blocks don't have
 * direct equivalents for things like mixHash, difficulty, etc.
 */
export function formatEthBlock(
  block: TrackedBlock,
  transactions: (string | EthTransaction)[] = [],
  gasUsed = 0n,
  gasLimit = 30_000_000n,
): EthBlock {
  return {
    number: toHex(BigInt(block.number)),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: toHex(BigInt(block.timestamp)),
    miner: "0x" + "0".repeat(40), // no miner concept in substrate
    difficulty: "0x0",
    totalDifficulty: "0x0",
    gasLimit: toHex(gasLimit),
    gasUsed: toHex(gasUsed),
    baseFeePerGas: null,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO_HASH,
    logsBloom: EMPTY_BLOOM,
    transactionsRoot: block.extrinsicsRoot,
    stateRoot: block.stateRoot,
    receiptsRoot: ZERO_HASH,
    size: "0x0",
    extraData: "0x",
    mixHash: ZERO_HASH,
    uncles: [],
    transactions,
  };
}

/** Create a "pending" block placeholder */
export function pendingBlock(): EthBlock {
  return formatEthBlock(
    {
      number: 0,
      hash: ZERO_HASH,
      parentHash: ZERO_HASH,
      stateRoot: ZERO_HASH,
      extrinsicsRoot: ZERO_HASH,
      timestamp: Math.floor(Date.now() / 1000),
    },
    [],
  );
}
