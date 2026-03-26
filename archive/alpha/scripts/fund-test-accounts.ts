// fund-test-accounts.ts — Fund multiple test accounts from Alith for browser E2E testing.
// Creates accounts with varying balances including some marginally below the existential deposit.
//
// Usage: npx hardhat run scripts/fund-test-accounts.ts --network substrate

import { ethers } from "hardhat";
import { Wallet } from "ethers";
import { formatDOT } from "../test/helpers/dot";
import * as fs from "fs";

// Pallet-revive gas costs ~5×10^21 planck per contract call.
// Fund "full" accounts with 10^24 planck so they can actually transact.
const FULL_FUND    = 1_000_000_000_000_000_000_000_000n; // 10^24 planck
// "Light" accounts get just enough to exist but not enough to do much
const LIGHT_FUND   = 100_000_000_000_000_000_000n;       // 10^20 planck (~100M DOT at 12 dec)

// Existential deposit edge cases (12 decimal chain).
// ED on substrate devchain is typically 10^6 planck (1 micro-unit).
// We test amounts just below and just above.
const ED_ABOVE     = 2_000_000n;       // 2× ED — should survive
const ED_EXACT     = 1_000_000n;       // exactly ED — should survive
const ED_BELOW_1   = 999_000n;         // just under ED — should fail or be dusted
const ED_BELOW_2   = 500_000n;         // half ED
const ED_TINY      = 1_000n;           // negligible

interface TestAccount {
  name: string;
  address: string;
  privateKey: string;
  targetBalance: bigint;
  purpose: string;
}

async function main() {
  const [alith] = await ethers.getSigners();
  console.log("Funder (Alith):", alith.address);

  const alithBal = await ethers.provider.getBalance(alith.address);
  console.log("Alith balance:", formatDOT(alithBal), "DOT\n");

  // Generate fresh test accounts (deterministic from seed for reproducibility)
  const accounts: TestAccount[] = [];

  // --- Hardhat config accounts (signers 2-7, skip Alith/Baltathar) ---
  const configKeys = [
    { name: "Charleth",  key: "0x0b6e18cafb6ed99687ec547bd28139cafdd2bffe70e6b688025de6b445aa5c5b" },
    { name: "Dorothy",   key: "0x39539ab1876910bbf3a223d84a29e28f1cb4e2e456503e7e91ed39b2e7223d68" },
    { name: "Ethan",     key: "0x7dce9bc8babb68fec1409be38c8e1a52650206a7ed90ff956ae8a6d15eeaaef4" },
    { name: "Faith",     key: "0xb9d2ea9a615f3165812e8d44de0d24da9bbd164b65c4f0573e1572827c55c3a4" },
    { name: "Goliath",   key: "0x96b8a38e12e1a31dee1eab2fffdf9d9990045f5b37e44d8cc27766ef294d74e2" },
    { name: "Heath",     key: "0x0d6dcaaef49272a5411896be8ad16c01c35d6f8c18873387b71fbc734759b0ab" },
  ];

  for (const { name, key } of configKeys) {
    const w = new Wallet(key);
    accounts.push({
      name: `${name} (config)`,
      address: w.address,
      privateKey: key,
      targetBalance: FULL_FUND,
      purpose: "Full test account — can deploy, vote, settle",
    });
  }

  // --- Fresh random accounts for specific test scenarios ---

  // Advertiser accounts (create campaigns)
  for (let i = 0; i < 3; i++) {
    const w = Wallet.createRandom();
    accounts.push({
      name: `Advertiser-${i + 1}`,
      address: w.address,
      privateKey: w.privateKey,
      targetBalance: FULL_FUND,
      purpose: "Create and fund campaigns",
    });
  }

  // User/viewer accounts (browse ads, submit claims)
  for (let i = 0; i < 3; i++) {
    const w = Wallet.createRandom();
    accounts.push({
      name: `Viewer-${i + 1}`,
      address: w.address,
      privateKey: w.privateKey,
      targetBalance: FULL_FUND,
      purpose: "Browse ads, submit claims, withdraw earnings",
    });
  }

  // Publisher accounts (register, receive settlement payments)
  for (let i = 0; i < 2; i++) {
    const w = Wallet.createRandom();
    accounts.push({
      name: `Publisher-${i + 1}`,
      address: w.address,
      privateKey: w.privateKey,
      targetBalance: FULL_FUND,
      purpose: "Register as publisher, receive settlement",
    });
  }

  // Governance voters (stake and vote)
  for (let i = 0; i < 3; i++) {
    const w = Wallet.createRandom();
    accounts.push({
      name: `Voter-${i + 1}`,
      address: w.address,
      privateKey: w.privateKey,
      targetBalance: FULL_FUND,
      purpose: "Vote on campaigns, test conviction/slash",
    });
  }

  // Light-funded accounts (exist but can't do much)
  for (let i = 0; i < 2; i++) {
    const w = Wallet.createRandom();
    accounts.push({
      name: `LightFund-${i + 1}`,
      address: w.address,
      privateKey: w.privateKey,
      targetBalance: LIGHT_FUND,
      purpose: "Lightly funded — test insufficient-gas scenarios",
    });
  }

  // --- ED edge case accounts ---
  const edCases = [
    { label: "ED-above",   amount: ED_ABOVE,   desc: "2× ED — should survive as account" },
    { label: "ED-exact",   amount: ED_EXACT,    desc: "Exactly ED — boundary case" },
    { label: "ED-below-1", amount: ED_BELOW_1,  desc: "Just under ED (999k) — expect dust/revert" },
    { label: "ED-below-2", amount: ED_BELOW_2,  desc: "Half ED (500k) — expect dust/revert" },
    { label: "ED-tiny",    amount: ED_TINY,      desc: "Negligible (1k) — expect revert" },
  ];

  for (const { label, amount, desc } of edCases) {
    const w = Wallet.createRandom();
    accounts.push({
      name: label,
      address: w.address,
      privateKey: w.privateKey,
      targetBalance: amount,
      purpose: desc,
    });
  }

  // --- Fund all accounts ---
  console.log(`Funding ${accounts.length} accounts...\n`);
  console.log("%-20s %-44s %20s  %s".replace(/%/g, ""), "Name", "Address", "Target", "Purpose");
  console.log("-".repeat(110));

  const results: Array<{
    name: string;
    address: string;
    privateKey: string;
    targetBalance: string;
    actualBalance: string;
    purpose: string;
    funded: boolean;
    error?: string;
  }> = [];

  for (const acct of accounts) {
    const existing = await ethers.provider.getBalance(acct.address);

    let funded = false;
    let error: string | undefined;

    if (existing >= acct.targetBalance) {
      console.log(`  ${acct.name}: already funded (${formatDOT(existing)} DOT)`);
      funded = true;
    } else {
      try {
        const tx = await alith.sendTransaction({
          to: acct.address,
          value: acct.targetBalance,
        });
        await tx.wait();
        funded = true;
        console.log(`  ${acct.name}: funded ${formatDOT(acct.targetBalance)} DOT → ${acct.address.slice(0, 10)}...`);
      } catch (err: any) {
        error = err.message?.slice(0, 120) || String(err).slice(0, 120);
        console.log(`  ${acct.name}: FAILED (${error})`);
      }
    }

    const actualBalance = await ethers.provider.getBalance(acct.address);
    results.push({
      name: acct.name,
      address: acct.address,
      privateKey: acct.privateKey,
      targetBalance: acct.targetBalance.toString(),
      actualBalance: actualBalance.toString(),
      purpose: acct.purpose,
      funded,
      error,
    });
  }

  // --- Summary ---
  console.log("\n=== Funding Summary ===\n");

  const ok = results.filter((r) => r.funded);
  const failed = results.filter((r) => !r.funded);

  console.log(`Funded: ${ok.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`\nFailed (${failed.length}):`);
    for (const f of failed) {
      console.log(`  ${f.name} (${f.address}): ${f.error}`);
    }
  }

  // --- ED edge case results ---
  console.log("\n=== ED Edge Cases ===\n");
  for (const r of results.filter((r) => r.name.startsWith("ED-"))) {
    const bal = BigInt(r.actualBalance);
    const target = BigInt(r.targetBalance);
    const status = r.funded
      ? bal > 0n ? `balance: ${bal.toString()} planck` : "balance: 0 (dusted!)"
      : "transfer rejected";
    console.log(`  ${r.name}: target=${target.toString()} → ${status}`);
  }

  // --- Write results to local file ---
  const outPath = __dirname + "/../test-accounts.json";
  const output = {
    _comment: "Test accounts for browser E2E — DO NOT COMMIT",
    generatedAt: new Date().toISOString(),
    funder: alith.address,
    accounts: results,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nAccounts written to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
