// Config loader — env + alpha-5 contract addresses.
//
// Reads from process.env (dotenv is loaded in index.mjs). All
// addresses come from the in-tree deployed-addresses.json so this
// file has no separate source of truth.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ADDRESSES_PATH = join(REPO_ROOT, "alpha-core", "deployed-addresses.json");

const REQUIRED = ["RELAY_PRIVATE_KEY"];

const DEFAULTS = {
  NETWORK: "polkadotTestnet",
  RPC_URL: "https://eth-rpc-testnet.polkadot.io/",
  HTTP_PORT: "3401",
  HTTP_BIND: "127.0.0.1",
  CLICK_BATCH_SIZE: "25",
  CLICK_BATCH_MAX_AGE_MS: "15000",
  SETTLEMENT_BATCH_SIZE: "8",
  STAKE_ROOT_INTERVAL_BLOCKS: "600",
  LOG_LEVEL: "1",
};

export function loadConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].startsWith("0x000"));
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}. Copy .env.example to .env.`);
  }

  const env = Object.fromEntries(
    Object.entries(DEFAULTS).map(([k, v]) => [k, process.env[k] ?? v])
  );
  env.RELAY_PRIVATE_KEY = process.env.RELAY_PRIVATE_KEY;

  let addresses;
  try {
    addresses = JSON.parse(readFileSync(ADDRESSES_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to read ${ADDRESSES_PATH}: ${e.message}`);
  }

  return {
    network: env.NETWORK,
    rpcUrl: env.RPC_URL,
    httpPort: Number(env.HTTP_PORT),
    httpBind: env.HTTP_BIND,
    clickBatchSize: Number(env.CLICK_BATCH_SIZE),
    clickBatchMaxAgeMs: Number(env.CLICK_BATCH_MAX_AGE_MS),
    settlementBatchSize: Number(env.SETTLEMENT_BATCH_SIZE),
    stakeRootIntervalBlocks: Number(env.STAKE_ROOT_INTERVAL_BLOCKS),
    logLevel: Number(env.LOG_LEVEL),
    privateKey: env.RELAY_PRIVATE_KEY,
    addresses,
    // Pine chain preset — keyed off the network identifier.
    pineChain: env.NETWORK === "polkadotHub" ? "polkadot-asset-hub" : "paseo-asset-hub",
  };
}
