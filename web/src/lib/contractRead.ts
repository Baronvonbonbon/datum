// contractRead — lightweight ethers-backed contract reads over pine.
//
// Most dashboard HeroStat fetchers need to call a single read
// function on a contract; ethers v6's Interface + the existing
// pineRpc helper is enough. This module wraps the two so the
// dashboard pages don't reach for the lower-level primitives.
//
// We accept inline ABI fragments (function signatures or full
// fragments) instead of importing JSON ABI files — keeps the
// dashboards' dependency graph shallow. Heavy users that need full
// contract surfaces should construct their own ethers.Contract
// against `await getPineProvider()`.

import { Interface, type InterfaceAbi } from "ethers";
import { pineRpc } from "./provider";
import { NETWORK_CONFIGS } from "@shared/networks";

// Direct centralized-RPC fallback for when pine returns an empty / undecodable
// payload (most commonly a half-synced smoldot LogIndexer returning "0x" for
// eth_call on a contract that exists). Lets dashboard reads degrade
// gracefully instead of throwing BAD_DATA and breaking the page.
async function rpcCall(to: string, data: string): Promise<string> {
  const url = NETWORK_CONFIGS.polkadotTestnet.rpcUrl;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message ?? "rpc error");
  return json.result as string;
}

function isEmpty(result: string | null | undefined): boolean {
  return !result || result === "0x";
}

/// Call a read-only contract function via pine.
///
/// Example:
///   const balance = await callContract<bigint>({
///     address: addrs.paymentVault,
///     abi: ["function userBalance(address user) view returns (uint256)"],
///     method: "userBalance",
///     args: [userAddress],
///   });
export async function callContract<T = unknown>(args: {
  address: string;
  abi: InterfaceAbi;
  method: string;
  args?: unknown[];
}): Promise<T> {
  const iface = new Interface(args.abi);
  const data = iface.encodeFunctionData(args.method, args.args ?? []);
  let result: string;
  try {
    result = await pineRpc<string>("eth_call", [{ to: args.address, data }, "latest"]);
    if (isEmpty(result)) throw new Error("empty response");
  } catch {
    result = await rpcCall(args.address, data);
  }
  const decoded = iface.decodeFunctionResult(args.method, result);
  // ethers returns a Result tuple. Most reads return a single value;
  // when the function has one output we unwrap. Multi-output reads
  // get the Result returned verbatim — caller casts.
  if (decoded.length === 1) return decoded[0] as T;
  return decoded as unknown as T;
}

/// Read a block's timestamp via pine. Used by telemetry-stream
/// formatters that need to convert block numbers to wall time.
export async function getBlockTs(blockNumber: number | string): Promise<number> {
  const tag = typeof blockNumber === "number" ? "0x" + blockNumber.toString(16) : blockNumber;
  const block = await pineRpc<{ timestamp: string }>("eth_getBlockByNumber", [tag, false]);
  if (!block || !block.timestamp) return 0;
  return Number(BigInt(block.timestamp));
}
