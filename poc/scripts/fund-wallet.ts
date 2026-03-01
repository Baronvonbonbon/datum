// fund-wallet.ts — Send DOT from Alith (funded dev account) to a target address.
// Usage: TARGET=0x... npx hardhat run scripts/fund-wallet.ts --network substrate
//        AMOUNT_DOT=500 TARGET=0x... npx hardhat run scripts/fund-wallet.ts --network substrate
//
// Defaults: 100 DOT. Amounts are rounded to the nearest 10^6 planck to satisfy
// the pallet-revive eth-rpc denomination rounding requirement.

import { ethers } from "hardhat";

const PLANCK_PER_DOT = 10_000_000_000n; // 10^10
const ROUND_TO      =      1_000_000n;  // eth-rpc rounds wei→planck by /10^6; amounts must be clean multiples

async function main() {
  const target = process.env["TARGET"];
  if (!target || !ethers.isAddress(target)) {
    console.error("Error: set TARGET=0x<address> environment variable.");
    console.error("Example: TARGET=0xAbCd... npx hardhat run scripts/fund-wallet.ts --network substrate");
    process.exitCode = 1;
    return;
  }

  const dotAmount = BigInt(Math.round(parseFloat(process.env["AMOUNT_DOT"] ?? "100")));
  const rawPlanck = dotAmount * PLANCK_PER_DOT;
  // Round down to nearest ROUND_TO boundary (already a multiple for whole DOT amounts, but be safe)
  const planck = (rawPlanck / ROUND_TO) * ROUND_TO;

  const [alith] = await ethers.getSigners();
  console.log(`Sender  : ${alith.address}`);
  console.log(`Target  : ${target}`);
  console.log(`Amount  : ${dotAmount} DOT (${planck.toString()} planck)`);

  const balBefore = await ethers.provider.getBalance(target);
  console.log(`Balance before: ${formatDOT(balBefore)} DOT`);

  const tx = await alith.sendTransaction({ to: target, value: planck });
  const receipt = await tx.wait();
  console.log(`TX hash : ${receipt?.hash}`);

  const balAfter = await ethers.provider.getBalance(target);
  console.log(`Balance after : ${formatDOT(balAfter)} DOT`);
  console.log("Done.");
}

function formatDOT(planck: bigint): string {
  const DOT = planck / 10_000_000_000n;
  const rem = planck % 10_000_000_000n;
  const dec = rem.toString().padStart(10, "0").slice(0, 4);
  return `${DOT}.${dec}`;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
