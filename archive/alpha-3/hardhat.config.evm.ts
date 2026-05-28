// hardhat.config.evm.ts — Standard EVM build config (no resolc / no PVM target)
// Use with: npx hardhat --config hardhat.config.evm.ts <command> --network paseoEvm
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
    },
  },
  networks: {
    hardhat: {
      // Local EVM for unit testing
    },
    paseoEvm: {
      // Paseo testnet — standard EVM bytecode deployment
      // pallet-revive exposes Ethereum-compatible JSON-RPC at this endpoint.
      // Contracts compiled with solc (keccak256 hashing, no PolkaVM precompiles).
      url: process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [
            process.env.DEPLOYER_PRIVATE_KEY,
            ...(process.env.TESTNET_ACCOUNTS ?? "").split(",").filter(Boolean),
          ]
        : [],
      // No polkadot: { target: "pvm" } — standard EVM bytecode
    },
  },
  mocha: {
    timeout: 300000,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache-evm",
    artifacts: "./artifacts-evm",
  },
};

export default config;
