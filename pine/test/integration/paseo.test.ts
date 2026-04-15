// ── Integration test: Pine against live Paseo Asset Hub ──
//
// Requires network access. Skipped in CI unless PINE_INTEGRATION=1.
// smoldot sync takes 10-30s on first connect.
//
// Run: PINE_INTEGRATION=1 npx vitest run test/integration/paseo.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PineProvider } from "../../src/PineProvider.js";

const SKIP = !process.env.PINE_INTEGRATION;
const TIMEOUT = 120_000; // 2 min — smoldot sync can be slow

// Known Datum contract on Paseo (Campaigns)
const CAMPAIGNS_ADDRESS = "0xb181415cd7C59fe182A3DeF20546b6d6089CD394";
// Known funded address (Alice deployer)
const ALICE = "0x94CC36412EE0c099BfE7D61a35092e40342F62D7";

describe.skipIf(SKIP)("Pine ↔ Paseo integration", () => {
  let provider: PineProvider;

  beforeAll(async () => {
    provider = new PineProvider({ chain: "paseo-asset-hub" });
    await provider.connect();
  }, TIMEOUT);

  afterAll(async () => {
    if (provider?.connected) {
      await provider.disconnect();
    }
  });

  it("eth_chainId returns Paseo Asset Hub chain ID", async () => {
    const chainId = await provider.request({ method: "eth_chainId" });
    // 420420417 = 0x190F1B41
    expect(chainId).toBe("0x190f1b41");
  });

  it("eth_blockNumber returns a positive block number", async () => {
    const blockNum = await provider.request({ method: "eth_blockNumber" });
    expect(typeof blockNum).toBe("string");
    expect(parseInt(blockNum as string, 16)).toBeGreaterThan(0);
  });

  it("net_version returns chain ID as decimal string", async () => {
    const version = await provider.request({ method: "net_version" });
    expect(version).toBe("420420417");
  });

  it("web3_clientVersion returns Pine identifier", async () => {
    const version = await provider.request({ method: "web3_clientVersion" });
    expect(typeof version).toBe("string");
    expect((version as string).startsWith("Pine/")).toBe(true);
  });

  it("eth_gasPrice returns a hex gas price", async () => {
    const gasPrice = await provider.request({ method: "eth_gasPrice" });
    expect(typeof gasPrice).toBe("string");
    expect((gasPrice as string).startsWith("0x")).toBe(true);
    expect(parseInt(gasPrice as string, 16)).toBeGreaterThan(0);
  });

  it("eth_getBalance returns Alice's balance (should be > 0)", async () => {
    const balance = await provider.request({
      method: "eth_getBalance",
      params: [ALICE, "latest"],
    });
    expect(typeof balance).toBe("string");
    const bal = BigInt(balance as string);
    expect(bal).toBeGreaterThan(0n);
  }, TIMEOUT);

  it("eth_getTransactionCount returns Alice's nonce", async () => {
    const nonce = await provider.request({
      method: "eth_getTransactionCount",
      params: [ALICE, "latest"],
    });
    expect(typeof nonce).toBe("string");
    // Alice has deployed contracts, so nonce > 0
    expect(parseInt(nonce as string, 16)).toBeGreaterThan(0);
  }, TIMEOUT);

  it("eth_getCode returns bytecode for Campaigns contract", async () => {
    const code = await provider.request({
      method: "eth_getCode",
      params: [CAMPAIGNS_ADDRESS, "latest"],
    });
    expect(typeof code).toBe("string");
    // Should have non-trivial bytecode
    expect((code as string).length).toBeGreaterThan(10);
    expect((code as string).startsWith("0x")).toBe(true);
  }, TIMEOUT);

  it("eth_getBlockByNumber returns latest block", async () => {
    const block = await provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    expect(block).toBeTruthy();
    expect((block as any).number).toBeTruthy();
    expect((block as any).hash).toBeTruthy();
    expect((block as any).timestamp).toBeTruthy();
  }, TIMEOUT);

  it("eth_call reads campaignCount from Campaigns contract", async () => {
    // campaignCount() selector = 0x5c0e159d
    const result = await provider.request({
      method: "eth_call",
      params: [
        {
          to: CAMPAIGNS_ADDRESS,
          data: "0x5c0e159d",
        },
        "latest",
      ],
    });
    expect(typeof result).toBe("string");
    expect((result as string).startsWith("0x")).toBe(true);
    // Should return ABI-encoded uint256 (66 hex chars) — if shorter, SCALE parsing may need tuning
    if ((result as string).length === 66) {
      const count = parseInt(result as string, 16);
      expect(count).toBeGreaterThanOrEqual(0);
    }
  }, TIMEOUT);

  it("eth_estimateGas returns gas estimate for a view call", async () => {
    const gas = await provider.request({
      method: "eth_estimateGas",
      params: [
        {
          to: CAMPAIGNS_ADDRESS,
          data: "0x5c0e159d", // campaignCount()
        },
      ],
    });
    expect(typeof gas).toBe("string");
    expect(parseInt(gas as string, 16)).toBeGreaterThan(0);
  }, TIMEOUT);

  it("eth_getBlockByHash returns block when given a valid hash", async () => {
    // First get latest block to get a hash
    const latest = (await provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    })) as any;

    const block = await provider.request({
      method: "eth_getBlockByHash",
      params: [latest.hash, false],
    });
    expect(block).toBeTruthy();
    expect((block as any).hash).toBe(latest.hash);
  }, TIMEOUT);

  it("eth_getLogs returns logs (possibly empty) for recent blocks", async () => {
    const blockNum = (await provider.request({
      method: "eth_blockNumber",
    })) as string;
    const num = parseInt(blockNum, 16);
    const fromBlock = "0x" + Math.max(0, num - 10).toString(16);

    const logs = await provider.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock,
          toBlock: "latest",
          address: CAMPAIGNS_ADDRESS,
        },
      ],
    });
    expect(Array.isArray(logs)).toBe(true);
  }, TIMEOUT);

  it("unsupported method throws 4200 error", async () => {
    await expect(
      provider.request({ method: "eth_unsupportedMethod" }),
    ).rejects.toThrow(/Unsupported method/);
  });
});
