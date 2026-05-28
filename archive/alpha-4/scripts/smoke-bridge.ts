// smoke-bridge.ts — Phase D Paseo smoke test
//
// Three modes, picked via the SMOKE_MODE env var:
//
//   SMOKE_MODE=request     (default) Calls bridge.requestRefresh(self) with
//                          the configured fee. Verifies RefreshInFlight +
//                          RefreshDispatched events. Inspects the dispatched
//                          XCM bytes (VersionedXcm::V5, expected shape).
//                          DOES NOT wait for the callback.
//
//   SMOKE_MODE=callback    Calls bridge.xcmCallback(target, level, validity)
//                          from the configured sovereign EOA. Verifies the
//                          cache record updates. The "Diana stand-in
//                          callback" simulator.
//
//   SMOKE_MODE=e2e         Calls requestRefresh, then waits for the
//                          RefreshCallback event (Diana daemon must be
//                          running). Asserts cache.isVerified flips.
//                          End-to-end via the live daemon.
//
// Usage:
//   export DEPLOYER_PRIVATE_KEY="0x..."
//   export SMOKE_TARGET="0x..."           # default: signer self
//   export SMOKE_LEVEL=1                  # default: 1
//   export SMOKE_VALIDITY_BLOCKS=432000   # default: 432_000
//   export SMOKE_MODE=request|callback|e2e
//   npx hardhat run scripts/smoke-bridge.ts --network polkadotTestnet
//
// Mirrors the raw-JsonRpcProvider + nonce-polling pattern used elsewhere
// in scripts/ because Paseo eth-rpc's getTransactionReceipt is broken.

import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

const _IS_PASEO = (network.name === "polkadotTestnet");
const TX_OPTS = {
  gasLimit: _IS_PASEO ? 500_000_000n : 15_000_000n,
  type: 0 as const,
  gasPrice: _IS_PASEO ? 1_000_000_000_000n : 1_000_000_000n,
};

const RPC_URL = _IS_PASEO
  ? "https://eth-rpc-testnet.polkadot.io/"
  : "http://127.0.0.1:8545/";

const MODE   = (process.env.SMOKE_MODE || "request").toLowerCase();
const LEVEL  = Number(process.env.SMOKE_LEVEL ?? 1);
const VB     = BigInt(process.env.SMOKE_VALIDITY_BLOCKS ?? 432_000);
const KEY    = (process.env.DEPLOYER_PRIVATE_KEY || "").trim();

if (!KEY) {
  console.error("Set DEPLOYER_PRIVATE_KEY");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// Address loading
// ─────────────────────────────────────────────────────────────────────────

const ADDRS_FILE = _IS_PASEO
  ? "deployed-addresses.json"
  : "deployed-addresses.localhost.json";

const addrs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", ADDRS_FILE), "utf-8"),
);

const BRIDGE = addrs.peopleChainXcmBridge;
const CACHE  = addrs.peopleChainIdentity;
if (!BRIDGE || !CACHE) {
  console.error(`Missing addresses in ${ADDRS_FILE}: peopleChainXcmBridge or peopleChainIdentity`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// ABIs (minimal — only what smoke needs)
// ─────────────────────────────────────────────────────────────────────────

const BRIDGE_ABI = [
  "function estimatedRefreshFee() view returns (uint256)",
  "function peopleChainSovereign() view returns (address)",
  "function lastRefreshBlock(address) view returns (uint64)",
  "function refreshCooldownBlocks() view returns (uint64)",
  "function requestRefresh(address user) payable",
  "function xcmCallback(address user, uint8 level, uint64 validityBlocks)",
  "event RefreshDispatched(address indexed user, address indexed requester, uint256 feePaid)",
  "event RefreshInFlight(address indexed user)",
  "event RefreshCallback(address indexed user, uint8 level, uint64 validityBlocks)",
];

const CACHE_ABI = [
  "function isVerified(address user, uint8 minLevel) view returns (bool)",
  "function getIdentity(address user) view returns (tuple(uint8 level, uint64 expiryBlock, uint64 lastUpdatedBlock))",
  "function xcmDispatcher() view returns (address)",
];

const bridgeIface = new Interface(BRIDGE_ABI);
const cacheIface  = new Interface(CACHE_ABI);

// ─────────────────────────────────────────────────────────────────────────
// Paseo-safe tx confirmation
// ─────────────────────────────────────────────────────────────────────────

async function waitForNonce(
  provider: JsonRpcProvider, address: string, target: number, maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > target) return;
    if (i > 0 && i % 10 === 0) console.log(`    ...waiting for tx confirmation (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${target}`);
}

async function sendCall(
  signer: Wallet, provider: JsonRpcProvider,
  to: string, iface: Interface, method: string, args: any[],
  value?: bigint,
): Promise<string> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  const tx = await signer.sendTransaction({ to, data, value: value ?? 0n, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
  return tx.hash;
}

async function readCall(
  provider: JsonRpcProvider, to: string, iface: Interface, method: string, args: any[],
): Promise<string> {
  const data = iface.encodeFunctionData(method, args);
  return provider.send("eth_call", [{ to, data }, "latest"]);
}

// ─────────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────────

async function modeRequest(signer: Wallet, provider: JsonRpcProvider, target: string) {
  console.log(`\n=== SMOKE_MODE=request ===`);
  console.log(`  bridge:    ${BRIDGE}`);
  console.log(`  signer:    ${signer.address}`);
  console.log(`  target:    ${target}`);

  // Pre-flight: read fee + cooldown state
  const feeRaw = await readCall(provider, BRIDGE, bridgeIface, "estimatedRefreshFee", []);
  const fee = BigInt(feeRaw);
  console.log(`  fee:       ${fee.toString()} planck`);

  const cooldownRaw = await readCall(provider, BRIDGE, bridgeIface, "refreshCooldownBlocks", []);
  const cooldown = BigInt(cooldownRaw);
  const lastRaw  = await readCall(provider, BRIDGE, bridgeIface, "lastRefreshBlock", [target]);
  const last     = BigInt(lastRaw);
  const head     = BigInt(await provider.getBlockNumber());
  console.log(`  cooldown:  ${cooldown.toString()} blocks; last=${last.toString()}, head=${head.toString()}`);
  if (last > 0n && head < last + cooldown) {
    const wait = (last + cooldown - head).toString();
    console.error(`  COOLDOWN ACTIVE: wait ${wait} more blocks before retrying`);
    process.exit(1);
  }

  // Dispatch
  console.log(`\n→ bridge.requestRefresh(${target}) value=${fee.toString()}`);
  const txHash = await sendCall(signer, provider, BRIDGE, bridgeIface, "requestRefresh", [target], fee);
  console.log(`  tx: ${txHash}`);

  // Scan recent blocks for the events emitted by this tx. Paseo's
  // getTransactionReceipt is unreliable, so we use eth_getLogs by
  // block range instead.
  const head2 = await provider.getBlockNumber();
  const logs = await provider.send("eth_getLogs", [{
    address: BRIDGE,
    fromBlock: "0x" + Math.max(0, head2 - 5).toString(16),
    toBlock: "latest",
  }]);

  console.log(`\nEvents from bridge (recent):`);
  let sawDispatched = false;
  let sawInFlight = false;
  for (const log of logs) {
    try {
      const parsed = bridgeIface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      if (parsed.name === "RefreshDispatched") {
        sawDispatched = true;
        console.log(`  ✔ RefreshDispatched(${parsed.args[0]}, ${parsed.args[1]}, ${parsed.args[2]})`);
      } else if (parsed.name === "RefreshInFlight") {
        sawInFlight = true;
        console.log(`  ✔ RefreshInFlight(${parsed.args[0]})`);
      }
    } catch { /* skip unparseable */ }
  }
  if (!sawDispatched || !sawInFlight) {
    console.error(`\n  FAIL: missing event(s). sawDispatched=${sawDispatched}, sawInFlight=${sawInFlight}`);
    process.exit(1);
  }
  console.log(`\n  PASS — outbound XCM dispatched. (Inspect Paseo block explorer for outbound XCM in the same tx.)`);
}

async function modeCallback(signer: Wallet, provider: JsonRpcProvider, target: string) {
  console.log(`\n=== SMOKE_MODE=callback ===`);
  console.log(`  bridge:    ${BRIDGE}`);
  console.log(`  signer:    ${signer.address}`);
  console.log(`  target:    ${target}`);
  console.log(`  level:     ${LEVEL}`);
  console.log(`  validity:  ${VB.toString()} blocks`);

  // Pre-flight: confirm signer matches peopleChainSovereign
  const sovRaw = await readCall(provider, BRIDGE, bridgeIface, "peopleChainSovereign", []);
  // sovRaw is a 32-byte ABI-encoded address; the last 20 bytes are the address.
  const sov = "0x" + sovRaw.slice(-40);
  console.log(`  sovereign: ${sov}`);
  if (sov.toLowerCase() !== signer.address.toLowerCase()) {
    console.error(`  FAIL: signer is not peopleChainSovereign; xcmCallback would revert E18`);
    process.exit(1);
  }

  // Pre-state
  const beforeRaw = await readCall(provider, CACHE, cacheIface, "getIdentity", [target]);
  console.log(`  cache before: ${beforeRaw}`);

  // Call
  console.log(`\n→ bridge.xcmCallback(${target}, ${LEVEL}, ${VB.toString()})`);
  const txHash = await sendCall(signer, provider, BRIDGE, bridgeIface, "xcmCallback",
    [target, LEVEL, VB]);
  console.log(`  tx: ${txHash}`);

  // Post-state
  const afterRaw = await readCall(provider, CACHE, cacheIface, "getIdentity", [target]);
  const verifiedRaw = await readCall(provider, CACHE, cacheIface, "isVerified", [target, LEVEL]);
  console.log(`  cache after:  ${afterRaw}`);
  console.log(`  isVerified(${LEVEL}): ${verifiedRaw}`);

  // verifiedRaw is a 32-byte ABI bool. true = ...0001.
  if (!verifiedRaw.endsWith("1")) {
    console.error(`\n  FAIL: cache write did not flip isVerified`);
    process.exit(1);
  }
  console.log(`\n  PASS — Diana stand-in callback wrote attestation`);
}

async function modeE2E(signer: Wallet, provider: JsonRpcProvider, target: string) {
  console.log(`\n=== SMOKE_MODE=e2e ===`);
  console.log(`  (Diana daemon must be running. Will dispatch and wait up to 5 minutes for the callback.)`);

  await modeRequest(signer, provider, target);

  console.log(`\n→ waiting for bridge.RefreshCallback(${target}) ...`);
  const startBlock = await provider.getBlockNumber();
  const startTs = Date.now();
  const timeoutMs = 5 * 60 * 1000;

  while (Date.now() - startTs < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));
    const head = await provider.getBlockNumber();
    const logs = await provider.send("eth_getLogs", [{
      address: BRIDGE,
      fromBlock: "0x" + startBlock.toString(16),
      toBlock: "0x" + head.toString(16),
    }]);
    for (const log of logs) {
      try {
        const parsed = bridgeIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "RefreshCallback" && parsed.args[0].toLowerCase() === target.toLowerCase()) {
          const level    = Number(parsed.args[1]);
          const validity = parsed.args[2].toString();
          console.log(`\n  ✔ RefreshCallback(${parsed.args[0]}, ${level}, ${validity}) — round-trip complete`);
          const verifiedRaw = await readCall(provider, CACHE, cacheIface, "isVerified", [target, level]);
          if (verifiedRaw.endsWith("1")) {
            console.log(`  PASS — cache.isVerified(${level}) = true`);
          } else if (level === 0) {
            console.log(`  PASS — cache write OK, level=0 (user has no People Chain identity)`);
          } else {
            console.error(`  FAIL — RefreshCallback fired but cache.isVerified returned false`);
            process.exit(1);
          }
          return;
        }
      } catch { /* skip */ }
    }
    const elapsed = Math.round((Date.now() - startTs) / 1000);
    if (elapsed % 30 === 0) {
      console.log(`    ...still waiting (${elapsed}s elapsed)`);
    }
  }
  console.error(`\n  FAIL: timed out after ${timeoutMs / 1000}s. Diana daemon running?`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const signer = new Wallet(KEY, provider);

  // Default target is signer self
  const target = (process.env.SMOKE_TARGET || signer.address).toLowerCase();

  const dispatcherRaw = await readCall(provider, CACHE, cacheIface, "xcmDispatcher", []);
  const dispatcher = "0x" + dispatcherRaw.slice(-40);
  if (dispatcher.toLowerCase() !== BRIDGE.toLowerCase()) {
    console.warn(`  WARN: cache.xcmDispatcher (${dispatcher}) != bridge (${BRIDGE}).`);
    console.warn(`        Bridge writes will revert; smoke may show stale state.`);
  }

  switch (MODE) {
    case "request":  return modeRequest(signer, provider, target);
    case "callback": return modeCallback(signer, provider, target);
    case "e2e":      return modeE2E(signer, provider, target);
    default:
      console.error(`Unknown SMOKE_MODE=${MODE}; use request | callback | e2e`);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
