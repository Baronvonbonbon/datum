// hardhat.config.ts — Alpha-4 EVM-only build config
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
