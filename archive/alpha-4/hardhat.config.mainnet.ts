// hardhat.config.mainnet.ts — production build with optimizer runs=1 (size-prioritized).
//
// Mainnet enforces EIP-170's 24,576 B runtime cap; the default config at
// hardhat.config.ts uses runs=200 (gas-prioritized) which trips the cap on
// DatumSettlement and DatumCampaigns. This config is used for:
//   - `npm run compile:mainnet`
//   - `npm run size:mainnet`
//   - mainnet deploy (via `npx hardhat --config hardhat.config.mainnet.ts run scripts/deploy.ts`)
//
// The test config (hardhat.config.ts) stays at runs=200 so unit-test gas
// figures keep matching what a heavily-used production deploy would see.
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
        runs: 1,
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      blockGasLimit: 1_000_000_000,
    },
    polkadotTestnet: {
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
    cache: "./cache-mainnet",
    artifacts: "./artifacts-mainnet",
  },
};

export default config;
