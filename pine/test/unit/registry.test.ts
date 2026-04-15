import { describe, it, expect, beforeEach } from "vitest";

// We test the registry indirectly by importing PineProvider which
// triggers all method registrations, then checking the registry.
// Import the method registration side-effects first.
import "../../src/methods/eth_chainId.js";
import "../../src/methods/eth_blockNumber.js";
import "../../src/methods/eth_getBalance.js";
import "../../src/methods/eth_getCode.js";
import "../../src/methods/eth_getStorageAt.js";
import "../../src/methods/eth_call.js";
import "../../src/methods/eth_estimateGas.js";
import "../../src/methods/eth_gasPrice.js";
import "../../src/methods/eth_getTransactionCount.js";
import "../../src/methods/eth_getBlockByNumber.js";
import "../../src/methods/eth_getBlockByHash.js";
import "../../src/methods/eth_getTransactionByHash.js";
import "../../src/methods/eth_getTransactionReceipt.js";
import "../../src/methods/eth_getLogs.js";
import "../../src/methods/eth_getBlockTransactionCount.js";
import "../../src/methods/eth_sendRawTransaction.js";
import "../../src/methods/net_version.js";
import "../../src/methods/web3_clientVersion.js";

import {
  hasMethod,
  getRegisteredMethods,
} from "../../src/methods/registry.js";

describe("method registry", () => {
  it("registers all expected methods", () => {
    const methods = getRegisteredMethods();
    // 18 files register 19 methods (eth_getBlockTransactionCount registers 2)
    expect(methods.length).toBeGreaterThanOrEqual(19);
  });

  const expectedMethods = [
    "eth_chainId",
    "eth_blockNumber",
    "eth_getBalance",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_call",
    "eth_estimateGas",
    "eth_gasPrice",
    "eth_getTransactionCount",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getLogs",
    "eth_getBlockTransactionCountByHash",
    "eth_getBlockTransactionCountByNumber",
    "eth_sendRawTransaction",
    "net_version",
    "web3_clientVersion",
  ];

  for (const method of expectedMethods) {
    it(`has ${method} registered`, () => {
      expect(hasMethod(method)).toBe(true);
    });
  }

  it("returns false for unknown methods", () => {
    expect(hasMethod("eth_bogusMethod")).toBe(false);
  });
});
