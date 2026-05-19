/**
 * Block-mining and network helpers for both Hardhat EVM and pallet-revive substrate.
 *
 * On Hardhat: uses hardhat_mine (instant, any number of blocks).
 * On substrate: polls for N new blocks (real block time ~3-4s each).
 *
 * SUBSTRATE NOTE: Keep block counts small (≤ 10) in substrate tests to avoid
 * long waits. Hardhat tests can use higher counts (100+).
 *
 * SUBSTRATE ACCOUNTS: Only signers 0 (Alith) and 1 (Baltathar) are pre-funded.
 * Call fundSigners() in a `before` hook to transfer DOT from Alith to all other
 * signers used by the test suite.
 */
import { ethers } from "hardhat";

/** Returns true when connected to a pallet-revive substrate node. */
let _isSubstrate: boolean | undefined;
export async function isSubstrate(): Promise<boolean> {
  if (_isSubstrate === undefined) {
    const net = await ethers.provider.getNetwork();
    _isSubstrate = net.chainId === 420420420n;
  }
  return _isSubstrate;
}

/**
 * Mine (or wait for) `count` new blocks.
 * On Hardhat: instant via hardhat_mine.
 * On substrate: polls eth_blockNumber until `count` new blocks appear.
 */
export async function mineBlocks(count: bigint | number): Promise<void> {
  const n = BigInt(count);
  if (n <= 0n) return;

  if (await isSubstrate()) {
    const start = await ethers.provider.getBlockNumber();
    const target = start + Number(n);
    // Poll at 500ms intervals until we reach the target block
    while (true) {
      const current = await ethers.provider.getBlockNumber();
      if (current >= target) break;
      await sleep(500);
    }
  } else {
    await ethers.provider.send("hardhat_mine", [`0x${n.toString(16)}`]);
  }
}

/**
 * Advance time by `seconds` and mine a block.
 * On Hardhat: uses evm_increaseTime + evm_mine.
 * On substrate: not directly controllable; waits for enough blocks to pass
 * (substrate block time ~3s, so 1 day ≈ 28,800 blocks — too slow for tests).
 * For daily-cap tests on substrate, use timestamp-based approach or skip.
 */
export async function advanceTime(seconds: number): Promise<void> {
  if (await isSubstrate()) {
    // On substrate we can't manipulate timestamps; wait for 1 real block instead.
    // Tests that depend on exact timestamp advancement should be skipped on substrate.
    await mineBlocks(1);
  } else {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }
}

/**
 * Fund all signers from the first pre-funded account (Alith).
 * On Hardhat: no-op (all signers have 10,000 ETH by default).
 * On substrate: only Alith (0) and Baltathar (1) are pre-funded; transfers
 * 10B DOT (10^22 planck at 12 decimals) to each signer.
 * Extreme amount needed because pallet-revive dev chain gas costs are ~1M DOT per
 * value-transfer tx (gasPrice=1000 × weight ~10^15 = 10^18 planck per transfer).
 */
export async function fundSigners(count: number = 10): Promise<void> {
  if (!(await isSubstrate())) return;

  const signers = await ethers.getSigners();
  const funder = signers[0]; // Alith — always funded
  const FUND_AMOUNT = 1_000_000_000_000_000_000_000_000n; // 10^24 planck — ~1 trillion DOT at 12 decimals; needed because pallet-revive dev chain charges ~5×10^21 per contract call

  for (let i = 2; i < Math.min(count, signers.length); i++) {
    const bal = await ethers.provider.getBalance(signers[i].address);
    if (bal < FUND_AMOUNT / 2n) {
      const tx = await funder.sendTransaction({
        to: signers[i].address,
        value: FUND_AMOUNT,
      });
      await tx.wait();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
