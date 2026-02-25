import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@parity/hardhat-polkadot-resolc";
// Note: @parity/hardhat-polkadot-node crashes on Node <20 due to WebSocket polyfill.
// Start the local substrate node manually with Docker (see scripts/start-substrate.sh)
// then use the substrate network entry below.

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
  // resolc compiler config for PolkaVM target
  resolc: {
    compilerSource: "npm",
    settings: {
      optimizer: {
        enabled: true,
        parameters: "z",   // LLVM opt level (0–3, s, z) — 'z' optimizes for size
      },
    },
  },
  networks: {
    hardhat: {
      // Local EVM for PoC testing (standard Hardhat network)
    },
    substrate: {
      // Local PolkaVM node via Docker (pallet-revive + eth-rpc adapter)
      // Start with: ./scripts/start-substrate.sh
      // Stop:  docker rm -f substrate eth-rpc
      url: "http://127.0.0.1:8545",
      // Moonbeam/Frontier standard dev accounts — pre-funded on pallet-revive dev chain
      accounts: [
        "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133", // Alith
        "0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b", // Baltathar
        "0x0b6e18cafb6ed99687ec547bd28139cafdd2bffe70e6b688025de6b445aa5c5b", // Charleth
        "0x39539ab1876910bbf3a223d84a29e28f1cb4e2e456503e7e91ed39b2e7223d68", // Dorothy
        "0x7dce9bc8babb68fec1409be38c8e1a52650206a7ed90ff956ae8a6d15eeaaef4", // Ethan
        "0xb9d2ea9a615f3165812e8d44de0d24da9bbd164b65c4f0573e1572827c55c3a4", // Faith
        "0x96b8a38e12e1a31dee1eab2fffdf9d9990045f5b37e44d8cc27766ef294d74e2", // Goliath
        "0x0d6dcaaef49272a5411896be8ad16c01c35d6f8c18873387b71fbc734759b0ab", // Heath
      ],
      polkadot: {
        target: "pvm",
      },
    },
    polkadotHub: {
      // Polkadot Hub (PolkaVM native path)
      // RPC URL supplied via POLKADOT_HUB_RPC env var or override here
      url: process.env.POLKADOT_HUB_RPC ?? "http://127.0.0.1:8545",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      polkadot: {
        target: "pvm",   // Compile to PolkaVM bytecode via resolc
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
