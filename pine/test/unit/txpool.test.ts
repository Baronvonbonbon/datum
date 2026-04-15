import { describe, it, expect } from "vitest";
import { TxPool } from "../../src/indexer/TxPool.js";

describe("TxPool", () => {
  it("tracks pending transactions", () => {
    const pool = new TxPool();
    pool.addPending({
      hash: "0xabc",
      raw: "0x1234",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      nonce: 5,
      value: "0x0",
      data: "0x",
      submittedAt: Date.now(),
    });

    expect(pool.getPending("0xabc")).toBeDefined();
    expect(pool.getIncluded("0xabc")).toBeUndefined();
    expect(pool.get("0xabc")).toBeDefined();
  });

  it("marks transactions as included", () => {
    const pool = new TxPool();
    pool.addPending({
      hash: "0xabc",
      raw: "0x1234",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      nonce: 5,
      value: "0x0",
      data: "0x",
      submittedAt: Date.now(),
    });

    pool.markIncluded("0xabc", {
      blockHash: "0xblock1",
      blockNumber: 100,
      transactionIndex: 0,
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      nonce: 5,
      value: "0x0",
      data: "0x",
      gasUsed: 21000n,
      status: true,
    });

    expect(pool.getPending("0xabc")).toBeUndefined();
    expect(pool.getIncluded("0xabc")).toBeDefined();
  });

  it("formats transactions for eth_getTransactionByHash", () => {
    const pool = new TxPool();
    pool.addPending({
      hash: "0xabc",
      raw: "0x1234",
      from: "0x1111111111111111111111111111111111111111",
      to: null,
      nonce: 0,
      value: "0x0",
      data: "0xdeadbeef",
      submittedAt: Date.now(),
    });

    const tx = pool.formatTransaction("0xabc");
    expect(tx).not.toBeNull();
    expect(tx!.hash).toBe("0xabc");
    expect(tx!.from).toBe("0x1111111111111111111111111111111111111111");
    expect(tx!.to).toBeNull();
    expect(tx!.blockHash).toBeNull(); // pending
  });

  it("is case-insensitive on hash lookup", () => {
    const pool = new TxPool();
    pool.addPending({
      hash: "0xABC",
      raw: "0x",
      from: "0x" + "0".repeat(40),
      to: null,
      nonce: 0,
      value: "0x0",
      data: "0x",
      submittedAt: Date.now(),
    });

    expect(pool.get("0xabc")).toBeDefined();
    expect(pool.get("0xABC")).toBeDefined();
  });

  it("returns null for unknown hashes", () => {
    const pool = new TxPool();
    expect(pool.formatTransaction("0xunknown")).toBeNull();
  });
});
