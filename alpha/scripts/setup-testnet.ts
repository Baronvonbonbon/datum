// setup-testnet.ts — Automated post-deploy testnet setup
//
// Prerequisite: Alice funded via faucet + contracts deployed (npm run deploy:testnet)
//
// This script:
//   1. Funds all non-user accounts from Alice (Bob, Charlie, Diana, Eve, Frank, Grace)
//   2. Registers Diana + Eve as publishers with categories
//   3. Creates a test campaign (Bob as advertiser, Diana as publisher)
//   4. Votes aye (Frank) to activate the campaign
//   5. Sets metadata hash
//   6. Verifies everything
//
// Usage:
//   export DEPLOYER_PRIVATE_KEY="0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8"
//   npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet

import { ethers } from "hardhat";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";

// ── Test accounts (from DEPLOY-TESTNET.md) ──────────────────────────────────
const ACCOUNTS = {
  alice:   { key: "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8", role: "Deployer" },
  bob:     { key: "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52", role: "Advertiser 1" },
  charlie: { key: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1", role: "Advertiser 2" },
  diana:   { key: "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0", role: "Publisher 1" },
  eve:     { key: "0x22adcf911646ca05279aa42b03dcabae2610417af459be43c2ba37f869c15914", role: "Publisher 2" },
  frank:   { key: "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c", role: "Voter (Aye)" },
  grace:   { key: "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235", role: "Voter (Nay)" },
  // Users NOT funded by this script — they fund themselves via faucet
  // hank:  0x615BcbE62B43bB033e65533bB6FcCC8b6FcB5BbD
  // iris:  0xC59101dab8d0899F74d19a4f13bb2D9A030065af
  // jack:  0x705f35BC60EE574FA5d1D38Ef2CD4784dE9371d3
};

// Accounts to fund from Alice (everyone except Alice + users)
const TO_FUND = ["bob", "charlie", "diana", "eve", "frank", "grace"] as const;
const FUND_AMOUNT = parseDOT("50"); // 50 PAS each

const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

function log(section: string, msg: string) {
  console.log(`[${section}] ${msg}`);
}

async function main() {
  const provider = ethers.provider;

  // Build signers from private keys
  const alice   = new Wallet(ACCOUNTS.alice.key, provider);
  const bob     = new Wallet(ACCOUNTS.bob.key, provider);
  const charlie = new Wallet(ACCOUNTS.charlie.key, provider);
  const diana   = new Wallet(ACCOUNTS.diana.key, provider);
  const eve     = new Wallet(ACCOUNTS.eve.key, provider);
  const frank   = new Wallet(ACCOUNTS.frank.key, provider);
  const grace   = new Wallet(ACCOUNTS.grace.key, provider);

  const wallets: Record<string, Wallet> = { alice, bob, charlie, diana, eve, frank, grace };

  log("INIT", `Alice (deployer): ${alice.address}`);

  // Load deployed addresses
  const addrFile = __dirname + "/../deployed-addresses.json";
  if (!fs.existsSync(addrFile)) {
    console.error("No deployed-addresses.json — run deploy:testnet first");
    process.exitCode = 1;
    return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  log("INIT", "Loaded addresses from " + addrFile);

  // Connect to contracts
  const publishers = await ethers.getContractAt("DatumPublishers", addrs.publishers);
  const campaigns  = await ethers.getContractAt("DatumCampaigns",  addrs.campaigns);
  const v2         = await ethers.getContractAt("DatumGovernanceV2", addrs.governanceV2);

  // ─── Check Alice's balance ───────────────────────────────────────────────
  const aliceBal = await provider.getBalance(alice.address);
  log("INIT", `Alice balance: ${formatDOT(aliceBal)} PAS`);
  const needed = FUND_AMOUNT * BigInt(TO_FUND.length);
  if (aliceBal < needed + parseDOT("50")) {
    console.error(`Alice needs at least ${formatDOT(needed + parseDOT("50"))} PAS to fund accounts + pay gas.`);
    console.error("Use the faucet: https://faucet.polkadot.io/ (Polkadot Hub TestNet)");
    process.exitCode = 1;
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. FUND NON-USER ACCOUNTS
  // ═══════════════════════════════════════════════════════════════════════════
  log("1", "--- Funding non-user accounts (50 PAS each) ---");

  for (const name of TO_FUND) {
    const w = wallets[name];
    const bal = await provider.getBalance(w.address);
    if (bal >= parseDOT("10")) {
      log("1", `  ${name} already has ${formatDOT(bal)} PAS — skipping`);
      continue;
    }
    try {
      const tx = await alice.sendTransaction({ to: w.address, value: FUND_AMOUNT });
      await tx.wait();
      const newBal = await provider.getBalance(w.address);
      log("1", `  ${name} funded: ${formatDOT(newBal)} PAS`);
    } catch (err) {
      console.error(`  FAILED to fund ${name}: ${String(err).slice(0, 150)}`);
      process.exitCode = 1;
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. REGISTER PUBLISHERS (Diana + Eve)
  // ═══════════════════════════════════════════════════════════════════════════
  log("2", "--- Registering publishers ---");

  for (const [name, wallet, takeBps, categories] of [
    ["diana", diana, 5000, 0b110] as const,  // categories 1+2 (crypto + tech)
    ["eve",   eve,   4000, 0b10000000000000000000000000] as const, // category 26 (other)
  ]) {
    const info = await publishers.getPublisher(wallet.address);
    if (info.registered) {
      log("2", `  ${name} already registered — skipping`);
    } else {
      try {
        await (await publishers.connect(wallet).registerPublisher(takeBps)).wait();
        log("2", `  ${name} registered (${takeBps} bps take rate)`);
      } catch (err) {
        console.error(`  FAILED to register ${name}: ${String(err).slice(0, 150)}`);
        process.exitCode = 1;
        return;
      }
    }
    // Set categories
    try {
      await (await publishers.connect(wallet).setCategories(categories)).wait();
      log("2", `  ${name} categories set: 0x${categories.toString(16)}`);
    } catch (err) {
      // May fail if categories already set and there's no setter — that's fine
      log("2", `  ${name} categories: ${String(err).slice(0, 80)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CREATE TEST CAMPAIGN (Bob as advertiser, Diana as publisher)
  // ═══════════════════════════════════════════════════════════════════════════
  log("3", "--- Creating test campaign ---");

  const BUDGET    = parseDOT("10");   // 10 PAS
  const DAILY_CAP = parseDOT("10");   // daily cap = budget
  const BID_CPM   = parseDOT("0.016"); // 0.016 PAS per 1000 impressions
  const CATEGORY  = 1;                 // crypto

  let campaignId: bigint | undefined;

  try {
    const tx = await campaigns.connect(bob).createCampaign(
      diana.address, DAILY_CAP, BID_CPM, CATEGORY,
      { value: BUDGET }
    );
    const receipt = await tx.wait();

    for (const logEntry of receipt!.logs) {
      try {
        const parsed = campaigns.interface.parseLog(logEntry);
        if (parsed?.name === "CampaignCreated") campaignId = parsed.args.campaignId;
      } catch { /* different contract */ }
    }
  } catch (err) {
    console.error(`FAILED to create campaign: ${String(err).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  if (campaignId === undefined) {
    console.error("CampaignCreated event not found in receipt");
    process.exitCode = 1;
    return;
  }
  log("3", `Campaign created: ID ${campaignId.toString()}`);
  log("3", `  Advertiser: Bob (${bob.address})`);
  log("3", `  Publisher: Diana (${diana.address})`);
  log("3", `  Budget: 10 PAS, CPM: 0.016 PAS, Category: ${CATEGORY}`);

  // Verify Pending
  const statusBefore = Number(await campaigns.getCampaignStatus(campaignId));
  log("3", `  Status: ${STATUS_NAMES[statusBefore]}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. VOTE AYE (Frank) + EVALUATE TO ACTIVATE
  // ═══════════════════════════════════════════════════════════════════════════
  log("4", "--- Voting + activating campaign ---");

  // Frank votes aye. Need ≥ quorum (100 PAS for production, or 1 PAS if lowered).
  // Check current quorum
  const quorum = await v2.quorumWeighted();
  log("4", `  Governance quorum: ${formatDOT(quorum)} PAS`);

  // Stake needs to be ≥ quorum (conviction 0 = 0.1x weight, so stake must be 10x quorum)
  // With conviction 0: weight = stake * 0.1, so stake ≥ quorum * 10
  // Actually conviction 0 = 1x weight (no multiplier, no lockup) in DatumGovernanceV2
  // Let's check: if quorum=100 DOT and conviction=0, stake=100 DOT → weight=100 DOT
  // If quorum was lowered to 1 DOT, stake=1 DOT is enough
  const VOTE_STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");

  // Check Frank has enough
  const frankBal = await provider.getBalance(frank.address);
  if (frankBal < VOTE_STAKE + parseDOT("1")) {
    console.error(`Frank needs ${formatDOT(VOTE_STAKE + parseDOT("1"))} PAS but has ${formatDOT(frankBal)}`);
    process.exitCode = 1;
    return;
  }

  try {
    await (await v2.connect(frank).vote(campaignId, true, 0, { value: VOTE_STAKE })).wait();
    log("4", `  Frank voted aye (${formatDOT(VOTE_STAKE)} PAS, conviction 0)`);
  } catch (err) {
    console.error(`FAILED to vote: ${String(err).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  // Evaluate
  try {
    await (await v2.evaluateCampaign(campaignId)).wait();
    const statusAfter = Number(await campaigns.getCampaignStatus(campaignId));
    log("4", `  Status after evaluate: ${STATUS_NAMES[statusAfter]}`);
    if (statusAfter !== 1) {
      log("4", "  WARNING: Campaign did not activate. May need more stake or different quorum.");
    }
  } catch (err) {
    log("4", `  evaluateCampaign reverted: ${String(err).slice(0, 150)}`);
    log("4", "  Campaign stays Pending — may need more aye votes to meet quorum.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. SET METADATA
  // ═══════════════════════════════════════════════════════════════════════════
  log("5", "--- Setting metadata ---");

  const metaHash = keccak256(toUtf8Bytes("testnet-campaign-" + campaignId.toString()));
  try {
    await (await campaigns.connect(bob).setMetadata(campaignId, metaHash)).wait();
    log("5", `  Metadata hash: ${metaHash.slice(0, 18)}...`);
  } catch (err) {
    log("5", `  setMetadata failed (may need advertiser): ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Testnet Setup Complete ===");
  console.log("Campaign ID :", campaignId.toString());
  console.log("Advertiser  : Bob", bob.address);
  console.log("Publisher   : Diana", diana.address);
  console.log("Aye voter   : Frank", frank.address);
  console.log("");
  console.log("Funded accounts:");
  for (const name of TO_FUND) {
    const bal = await provider.getBalance(wallets[name].address);
    console.log(`  ${name.padEnd(8)} ${wallets[name].address}  ${formatDOT(bal)} PAS`);
  }
  console.log("");
  console.log("User accounts (fund via faucet for testing):");
  console.log("  hank     0x615BcbE62B43bB033e65533bB6FcCC8b6FcB5BbD");
  console.log("  iris     0xC59101dab8d0899F74d19a4f13bb2D9A030065af");
  console.log("  jack     0x705f35BC60EE574FA5d1D38Ef2CD4784dE9371d3");

  // Write findings to deploy doc appendix
  const findings = `
---

## Deployment Log (auto-generated)

**Date:** ${new Date().toISOString()}
**Script:** setup-testnet.ts

### Accounts Funded
| Name | Address | Balance |
|------|---------|---------|
${await Promise.all(TO_FUND.map(async (name) => {
    const bal = await provider.getBalance(wallets[name].address);
    return `| ${name} | \`${wallets[name].address}\` | ${formatDOT(bal)} PAS |`;
  })).then(rows => rows.join("\n"))}

### Publishers Registered
- Diana: ${diana.address} (50% take rate, categories: crypto+tech)
- Eve: ${eve.address} (40% take rate, categories: other)

### Test Campaign
- **Campaign ID:** ${campaignId.toString()}
- **Status:** ${STATUS_NAMES[Number(await campaigns.getCampaignStatus(campaignId))]}
- **Advertiser:** Bob (${bob.address})
- **Publisher:** Diana (${diana.address})
- **Budget:** 10 PAS
- **Bid CPM:** 0.016 PAS
- **Category:** 1 (crypto)
- **Metadata hash:** ${metaHash}
- **Aye voter:** Frank (${frank.address}), stake: ${formatDOT(VOTE_STAKE)} PAS

### Contract Addresses
${Object.entries(addrs).filter(([k]) => k !== "network").map(([k, v]) => `- **${k}:** \`${v}\``).join("\n")}
`;

  // Append to DEPLOY-TESTNET.md if it exists
  const deployDoc = __dirname + "/../DEPLOY-TESTNET.md";
  if (fs.existsSync(deployDoc)) {
    const existing = fs.readFileSync(deployDoc, "utf-8");
    // Replace previous deployment log if present, or append
    const marker = "## Deployment Log (auto-generated)";
    const idx = existing.indexOf(marker);
    if (idx > 0) {
      // Find the preceding --- separator
      const sepIdx = existing.lastIndexOf("---", idx);
      const updated = existing.slice(0, sepIdx > 0 ? sepIdx : idx) + findings;
      fs.writeFileSync(deployDoc, updated);
    } else {
      fs.writeFileSync(deployDoc, existing + findings);
    }
    log("6", "Deployment log appended to DEPLOY-TESTNET.md");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
