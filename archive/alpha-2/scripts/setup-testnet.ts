// setup-testnet.ts — Automated post-deploy testnet setup for Alpha-2
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
//   export DEPLOYER_PRIVATE_KEY="0x..."
//   npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet

import { ethers } from "hardhat";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";

// ── Test accounts ────────────────────────────────────────────────────────────
// Keys stored in gitignored DEPLOY-TESTNET.md.
// Testnet only — NEVER use these on mainnet.
const ACCOUNTS = {
  alice:   { key: "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8", role: "Deployer" },
  bob:     { key: "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52", role: "Advertiser 1" },
  charlie: { key: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1", role: "Advertiser 2" },
  diana:   { key: "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0", role: "Publisher 1" },
  eve:     { key: "0x22adcf911646ca05279aa42b03dcabae2610417af459be43c2ba37f869c15914", role: "Publisher 2" },
  frank:   { key: "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c", role: "Voter (Aye)" },
  grace:   { key: "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235", role: "Voter (Nay)" },
};

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
    console.error("No deployed-addresses.json found. Run deploy script first:");
    console.error("  npx hardhat run scripts/deploy.ts --network polkadotTestnet");
    process.exitCode = 1;
    return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  log("INIT", "Loaded addresses from " + addrFile);

  // Verify alpha-2 contracts are present (13 keys)
  const alpha2Keys = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "budgetLedger", "paymentVault", "campaignLifecycle",
    "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier",
  ];
  const missing = alpha2Keys.filter(k => !addrs[k]);
  if (missing.length > 0) {
    console.error("Missing contract addresses:", missing.join(", "));
    console.error("This looks like an alpha (9-contract) deploy. Re-run deploy.ts for alpha-2.");
    process.exitCode = 1;
    return;
  }

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
    console.error("Use the faucet: https://faucet.polkadot.io/ (Paseo)");
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
      log("1", `  ${name} already has ${formatDOT(bal)} PAS -- skipping`);
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

  // Diana: 50% take rate, all 26 categories (bitmask: bits 1-26)
  const ALL_26_CATEGORIES = (1n << 27n) - 2n; // bits 1..26 set

  for (const [name, wallet, takeBps, categories] of [
    ["diana", diana, 5000, ALL_26_CATEGORIES] as const,
    ["eve",   eve,   4000, 1n << 26n] as const, // category 26 (other)
  ]) {
    const info = await publishers.getPublisher(wallet.address);
    if (info.registered) {
      log("2", `  ${name} already registered -- skipping`);
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
      log("2", `  ${name} categories: ${String(err).slice(0, 80)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CREATE TEST CAMPAIGN (Bob as advertiser, Diana as publisher)
  // ═══════════════════════════════════════════════════════════════════════════
  log("3", "--- Creating test campaign ---");

  const BUDGET    = parseDOT("10");    // 10 PAS
  const DAILY_CAP = parseDOT("10");    // daily cap = budget
  const BID_CPM   = parseDOT("0.016"); // 0.016 PAS per 1000 impressions
  const CATEGORY  = 1;                  // crypto

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
      } catch { /* different contract event */ }
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

  const quorum = await v2.quorumWeighted();
  log("4", `  Governance quorum: ${formatDOT(quorum)} PAS (conviction-weighted)`);

  // Conviction 0 = 1x weight. Stake >= quorum to pass with single voter.
  const VOTE_STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");

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
    log("4", "  Campaign stays Pending -- may need more aye votes to meet quorum.");
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
    log("5", `  setMetadata failed: ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== Alpha-2 Testnet Setup Complete ===");
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
  console.log("Alpha-2 contract addresses (13):");
  const alpha2ContractKeys = [
    "pauseRegistry", "timelock", "publishers", "campaigns",
    "budgetLedger", "paymentVault", "campaignLifecycle",
    "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier",
  ];
  for (const key of alpha2ContractKeys) {
    console.log(`  ${key.padEnd(24)} ${addrs[key]}`);
  }
  console.log("");
  console.log("User accounts (fund via faucet for testing):");
  console.log("  hank     0x615BcbE62B43bB033e65533bB6FcCC8b6FcB5BbD");
  console.log("  iris     0xC59101dab8d0899F74d19a4f13bb2D9A030065af");
  console.log("  jack     0x705f35BC60EE574FA5d1D38Ef2CD4784dE9371d3");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
