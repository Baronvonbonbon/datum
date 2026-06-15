// hardhat.config.ts — Alpha-5 EVM-only build config
// Usage: npx hardhat compile / npx hardhat test / npx hardhat run scripts/deploy.ts --network polkadotTestnet
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "cancun",
      // Emit storage layouts so test/settlement-layout.test.ts can assert
      // DatumSettlement / LogicA / LogicB all share the exact same slot
      // assignments (phase 8d-5 invariant for the DELEGATECALL pattern).
      outputSelection: {
        "*": {
          "*": ["storageLayout"],
        },
      },
    },
  },
  networks: {
    hardhat: {
      // Local EVM for unit testing.
      // DatumSettlement has grown past 24KB after the audit fixes + dual-sig
      // toggle. pallet-revive on Polkadot Hub doesn't enforce the EIP-170
      // 24KB cap, so we relax it locally; production deploys still measure
      // bytecode size via the gas benchmark in scripts/benchmark-gas.ts.
      allowUnlimitedContractSize: true,
      // deploy.ts hardcodes gasLimit: 500_000_000n for the Paseo workaround;
      // raise the block cap so `npx hardhat node` accepts those txs locally.
      blockGasLimit: 1_000_000_000,
    },
    substrate: {
      // Local pallet-revive dev node + eth-rpc adapter (Docker; see
      // archive/poc/scripts/start-substrate.sh). Used to reproduce Paseo-only
      // (pallet-revive) behaviour that the in-process hardhat EVM doesn't show.
      url: "http://127.0.0.1:8545",
      // This pallet-revive eth-rpc dev image pre-funds the standard hardhat/anvil
      // test accounts (confirmed via eth_accounts + eth_getBalance), so use those keys.
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0xf39F… acct0
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 0x7099… acct1
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 0x3C44… acct2
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 0x90F7… acct3
        "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // 0x15d3… acct4
        "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 0x9965… acct5
      ],
    },
    localhost: {
      // Local hardhat node for end-to-end deploy testing.
      url: "http://127.0.0.1:8545",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [
            process.env.DEPLOYER_PRIVATE_KEY,
            ...(process.env.LOCALHOST_ACCOUNTS ?? "").split(",").filter(Boolean),
          ]
        : [],
    },
    polkadotTestnet: {
      // Paseo testnet — EVM bytecode on pallet-revive
      url: process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [
            process.env.DEPLOYER_PRIVATE_KEY,
            ...(process.env.TESTNET_ACCOUNTS ?? "").split(",").filter(Boolean),
          ]
        : [],
    },
  },
  mocha: {
    timeout: 300000,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
