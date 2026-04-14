// setup-demo.ts — Multi-publisher demo seeding for Alpha-3
//
// Seeds 5 publishers, 3 MockERC20 tokens, and 8 campaigns with diverse tag
// targeting, ERC-20 rewards, and an allowlist showcase.
//
// Run AFTER deploy.ts (requires deployed-addresses.json).
// Re-run safe: skips already-registered publishers, reuses token addresses.
//
// Usage:
//   npx hardhat run scripts/setup-demo.ts --network polkadotTestnet

import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface, keccak256, toUtf8Bytes } from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";
import * as path from "path";

// ── Accounts ──────────────────────────────────────────────────────────────────
// Keys stored in gitignored TESTNET-KEYS.md. NEVER use on mainnet.
const ACCOUNTS = {
  alice:   { key: "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8", role: "Deployer / funder" },
  bob:     { key: "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52", role: "Advertiser 1" },
  charlie: { key: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1", role: "Advertiser 2" },
  diana:   { key: "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0", role: "Publisher 1 — CryptoHub" },
  eve:     { key: "0x22adcf911646ca05279aa42b03dcabae2610417af459be43c2ba37f869c15914", role: "Publisher 2 — FinanceDaily" },
  frank:   { key: "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c", role: "Publisher 3 — TechBlog / Voter" },
  grace:   { key: "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235", role: "Publisher 4 — SportZone" },
  heidi:   { key: "0x2222222222222222222222222222222222222222222222222222222222222222", role: "Publisher 5 — GamingWorld" },
};

// ── Publisher profiles ────────────────────────────────────────────────────────
// Tags use the canonical slugs from tagDictionary.ts (not legacy "topic:crypto")
const PUBLISHER_CONFIGS: Record<string, { name: string; tags: string[]; takeBps: bigint; allowlist?: true }> = {
  diana: {
    name: "CryptoHub",
    tags: ["topic:crypto-web3", "topic:defi", "topic:computers-electronics", "locale:en"],
    takeBps: 5000n,
  },
  eve: {
    name: "FinanceDaily",
    tags: ["topic:finance", "topic:news", "topic:people-society", "locale:en"],
    takeBps: 4000n,
  },
  frank: {
    name: "TechBlog",
    tags: ["topic:computers-electronics", "topic:science", "topic:internet-telecom", "locale:en"],
    takeBps: 4500n,
  },
  grace: {
    name: "SportZone",
    tags: ["topic:sports", "topic:health", "topic:beauty-fitness", "locale:en"],
    takeBps: 4000n,
    allowlist: true, // advertiser allowlist: Bob only
  },
  heidi: {
    name: "GamingWorld",
    tags: ["topic:gaming", "topic:arts-entertainment", "topic:anime-manga", "locale:en"],
    takeBps: 3500n,
  },
};

// ── Campaign configs ──────────────────────────────────────────────────────────
interface CampaignConfig {
  label: string;
  advertiser: string; // key in ACCOUNTS
  publisher: string;  // key in ACCOUNTS | "open"
  requiredTagSlugs: string[];
  bidCpm: bigint;
  budget: bigint;
  tokenReward?: { token: string; rewardPerImpression: bigint; deposit: bigint };
  metaSuffix: string;
}

// tokenReward is filled in dynamically after tokens are deployed.
// We declare placeholders here and patch in main().
const CAMPAIGN_CONFIGS: Omit<CampaignConfig, "tokenReward">[] = [
  // C1: Bob → Diana  |  crypto+defi page  |  SWAP token rewards
  {
    label: "C1 LiquidityDAO (Bob→Diana, crypto+defi)",
    advertiser: "bob", publisher: "diana",
    requiredTagSlugs: ["topic:crypto-web3", "topic:defi"],
    bidCpm: parseDOT("0.020"), budget: parseDOT("10"),
    metaSuffix: "liquiditydao",
  },
  // C2: Charlie → Eve  |  finance page  |  DEV token rewards
  {
    label: "C2 YieldFarm Pro (Charlie→Eve, finance)",
    advertiser: "charlie", publisher: "eve",
    requiredTagSlugs: ["topic:finance"],
    bidCpm: parseDOT("0.018"), budget: parseDOT("10"),
    metaSuffix: "yieldfarm-pro",
  },
  // C3: Bob → Frank  |  tech page
  {
    label: "C3 DevChain IDE (Bob→Frank, tech)",
    advertiser: "bob", publisher: "frank",
    requiredTagSlugs: ["topic:computers-electronics"],
    bidCpm: parseDOT("0.015"), budget: parseDOT("10"),
    metaSuffix: "devchain-ide",
  },
  // C4: Bob → Grace  |  sports page  |  FIT token rewards  |  Grace has allowlist (Bob only)
  {
    label: "C4 FitToken Gym (Bob→Grace, sports, allowlist)",
    advertiser: "bob", publisher: "grace",
    requiredTagSlugs: ["topic:sports"],
    bidCpm: parseDOT("0.014"), budget: parseDOT("10"),
    metaSuffix: "fittoken-gym",
  },
  // C5: Charlie → Heidi  |  gaming page  |  SWAP token rewards
  {
    label: "C5 ArcadeChain NFTs (Charlie→Heidi, gaming)",
    advertiser: "charlie", publisher: "heidi",
    requiredTagSlugs: ["topic:gaming"],
    bidCpm: parseDOT("0.022"), budget: parseDOT("10"),
    metaSuffix: "arcadechain",
  },
  // C6: Bob → open  |  gaming+arts page  |  competes with C5 on Heidi
  {
    label: "C6 PixelVerse (Bob→open, gaming+arts)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:gaming", "topic:arts-entertainment"],
    bidCpm: parseDOT("0.012"), budget: parseDOT("8"),
    metaSuffix: "pixelverse",
  },
  // C7: Charlie → open  |  crypto page  |  competes with C1 on Diana
  {
    label: "C7 PolkaHub Bridge (Charlie→open, crypto)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: ["topic:crypto-web3"],
    bidCpm: parseDOT("0.016"), budget: parseDOT("8"),
    metaSuffix: "polkahub-bridge",
  },
  // C8: Bob → open  |  no tags  |  broad fallback for all publishers
  {
    label: "C8 Polkadot Ecosystem (Bob→open, no tags)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: [],
    bidCpm: parseDOT("0.010"), budget: parseDOT("15"),
    metaSuffix: "polkadot-ecosystem",
  },
];

const TX_OPTS = { gasLimit: 500000000n, type: 0, gasPrice: 1000000000000n };
const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];
const DEMO_FILE = path.join(__dirname, "../deployed-demo.json");

function log(section: string, msg: string) {
  console.log(`[${section}] ${msg}`);
}

function tagHash(tag: string): string {
  return keccak256(toUtf8Bytes(tag));
}

// ── Paseo workaround: nonce-based tx confirmation ────────────────────────────

async function waitForNonce(provider: JsonRpcProvider, address: string, targetNonce: number, maxWait = 120): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    if (await provider.getTransactionCount(address) > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for tx (${i}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function sendCall(
  signer: Wallet, provider: JsonRpcProvider,
  to: string, iface: Interface, method: string, args: any[], value?: bigint,
): Promise<void> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, data, value: value ?? 0n, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
}

async function sendTransfer(signer: Wallet, provider: JsonRpcProvider, to: string, value: bigint): Promise<void> {
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, value, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
}

async function readCall(provider: JsonRpcProvider, to: string, iface: Interface, method: string, args: any[]): Promise<string> {
  return provider.call({ to, data: iface.encodeFunctionData(method, args) });
}

// ── Contract ABIs (minimal) ───────────────────────────────────────────────────

const publishersAbi = [
  "function getPublisher(address) view returns (bool registered, uint16 takeRateBps)",
  "function registerPublisher(uint16 takeBps)",
  "function setRelaySigner(address signer)",
  "function relaySigner(address) view returns (address)",
  "function setAllowlistEnabled(bool enabled)",
  "function setAllowedAdvertiser(address advertiser, bool allowed)",
];

const targetingAbi = ["function setTags(bytes32[] tags)"];

const campaignsAbi = [
  "function createCampaign(address publisher, uint256 dailyCap, uint256 bidCpm, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression) payable returns (uint256)",
  "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
];

const govAbi = [
  "function quorumWeighted() view returns (uint256)",
  "function vote(uint256 campaignId, bool aye, uint8 conviction) payable",
  "function evaluateCampaign(uint256 campaignId)",
];

const reputationAbi = [
  "function addReporter(address reporter)",
  "function reporters(address) view returns (bool)",
];

const erc20Abi = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const vaultAbi = [
  "function depositCampaignBudget(uint256 campaignId, address token, uint256 amount)",
];

// ── MockERC20 deployment helper ───────────────────────────────────────────────

async function deployToken(
  deployer: Wallet, provider: JsonRpcProvider, name: string, symbol: string,
): Promise<string> {
  const factory = await ethers.getContractFactory("MockERC20");
  const deployTx = await factory.getDeployTransaction(name, symbol);
  const nonce = await provider.getTransactionCount(deployer.address);
  const expectedAddr = ethers.getCreateAddress({ from: deployer.address, nonce });

  const existing = await provider.getCode(expectedAddr);
  if (existing && existing !== "0x" && existing.length > 2) {
    log("TOKENS", `  ${symbol}: code at derived address ${expectedAddr} — reusing`);
    return expectedAddr;
  }

  await deployer.sendTransaction({ data: deployTx.data!, ...TX_OPTS });
  await waitForNonce(provider, deployer.address, nonce);

  const code = await provider.getCode(expectedAddr);
  if (!code || code === "0x" || code.length <= 2) {
    throw new Error(`${symbol}: no code at ${expectedAddr} after deploy`);
  }
  log("TOKENS", `  ${symbol}: ${expectedAddr}`);
  return expectedAddr;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const rawProvider = new JsonRpcProvider(rpcUrl);

  const wallets: Record<string, Wallet> = Object.fromEntries(
    Object.entries(ACCOUNTS).map(([name, { key }]) => [name, new Wallet(key, rawProvider)]),
  );
  const { alice, bob, charlie, diana, eve, frank, grace, heidi } = wallets as Record<string, Wallet>;

  log("INIT", `Alice: ${alice.address}`);
  log("INIT", `Diana: ${diana.address}`);
  log("INIT", `Heidi: ${heidi.address}`);

  // Load deployed contracts
  const addrFile = path.join(__dirname, "/../deployed-addresses.json");
  if (!fs.existsSync(addrFile)) {
    console.error("deployed-addresses.json not found — run deploy.ts first");
    process.exitCode = 1; return;
  }
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

  const required21 = [
    "pauseRegistry", "timelock", "publishers", "campaigns", "budgetLedger", "paymentVault",
    "campaignLifecycle", "attestationVerifier", "governanceV2", "governanceSlash",
    "settlement", "relay", "zkVerifier", "targetingRegistry", "campaignValidator",
    "claimValidator", "governanceHelper", "reports", "rateLimiter", "reputation", "tokenRewardVault",
  ];
  const missing = required21.filter(k => !addrs[k]);
  if (missing.length > 0) {
    console.error("Missing contract addresses:", missing.join(", "));
    process.exitCode = 1; return;
  }

  // Build interfaces
  const pubIface = new Interface(publishersAbi);
  const targetIface = new Interface(targetingAbi);
  const campIface = new Interface(campaignsAbi);
  const govIface = new Interface(govAbi);
  const repIface = new Interface(reputationAbi);
  const erc20Iface = new Interface(erc20Abi);
  const vaultIface = new Interface(vaultAbi);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. FUND ACCOUNTS
  // ═══════════════════════════════════════════════════════════════════════════
  log("1", "--- Funding accounts ---");
  const aliceBal = await rawProvider.getBalance(alice.address);
  log("1", `Alice balance: ${formatDOT(aliceBal)} PAS`);

  const toFund: [string, Wallet, bigint][] = [
    ["bob",     bob,     parseDOT("50")],
    ["charlie", charlie, parseDOT("50")],
    ["diana",   diana,   parseDOT("50")],
    ["eve",     eve,     parseDOT("50")],
    ["frank",   frank,   parseDOT("1000")], // needs lots for 8 votes
    ["grace",   grace,   parseDOT("50")],
    ["heidi",   heidi,   parseDOT("50")],
  ];
  for (const [name, wallet, amount] of toFund) {
    const bal = await rawProvider.getBalance(wallet.address);
    const threshold = name === "frank" ? parseDOT("500") : parseDOT("10");
    if (bal >= threshold) {
      log("1", `  ${name}: ${formatDOT(bal)} PAS — skipping`);
      continue;
    }
    try {
      await sendTransfer(alice, rawProvider, wallet.address, amount);
      log("1", `  ${name}: funded ${formatDOT(amount)} PAS`);
    } catch (err) {
      console.error(`  FAILED to fund ${name}: ${String(err).slice(0, 150)}`);
      process.exitCode = 1; return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. DEPLOY MOCK ERC-20 TOKENS
  // ═══════════════════════════════════════════════════════════════════════════
  log("2", "--- Deploying MockERC20 tokens ---");

  // Load or initialise cache
  const demoData: Record<string, any> = fs.existsSync(DEMO_FILE)
    ? JSON.parse(fs.readFileSync(DEMO_FILE, "utf-8"))
    : {};

  async function getOrDeployToken(cacheKey: string, name: string, symbol: string): Promise<string> {
    if (demoData[cacheKey]) {
      const code = await rawProvider.getCode(demoData[cacheKey]);
      if (code && code !== "0x" && code.length > 2) {
        log("2", `  ${symbol}: reusing ${demoData[cacheKey]}`);
        return demoData[cacheKey] as string;
      }
    }
    const addr = await deployToken(alice, rawProvider, name, symbol);
    demoData[cacheKey] = addr;
    fs.writeFileSync(DEMO_FILE, JSON.stringify(demoData, null, 2) + "\n");
    return addr;
  }

  const swapToken = await getOrDeployToken("swapToken", "DatumSwap Token", "SWAP");
  const devToken  = await getOrDeployToken("devToken",  "DevChain Token",  "DEV");
  const fitToken  = await getOrDeployToken("fitToken",  "FitToken",        "FIT");

  log("2", `  SWAP: ${swapToken}`);
  log("2", `  DEV:  ${devToken}`);
  log("2", `  FIT:  ${fitToken}`);

  // Assign token rewards to campaign configs (patching in-place)
  const tokenRewards: Record<number, { token: string; rewardPerImpression: bigint; deposit: bigint }> = {
    0: { token: swapToken, rewardPerImpression: BigInt("1000000000000000"), deposit: BigInt("100") * BigInt("10") ** 18n }, // C1 SWAP
    1: { token: devToken,  rewardPerImpression: BigInt("1000000000000000"), deposit: BigInt("100") * BigInt("10") ** 18n }, // C2 DEV
    3: { token: fitToken,  rewardPerImpression: BigInt("1000000000000000"), deposit: BigInt("100") * BigInt("10") ** 18n }, // C4 FIT
    4: { token: swapToken, rewardPerImpression: BigInt("1000000000000000"), deposit: BigInt("100") * BigInt("10") ** 18n }, // C5 SWAP
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. REGISTER PUBLISHERS
  // ═══════════════════════════════════════════════════════════════════════════
  log("3", "--- Registering publishers ---");
  const publisherWallets: Record<string, Wallet> = { diana, eve, frank, grace, heidi };

  for (const [name, cfg] of Object.entries(PUBLISHER_CONFIGS)) {
    const wallet = publisherWallets[name];
    const result = await readCall(rawProvider, addrs.publishers, pubIface, "getPublisher", [wallet.address]);
    const decoded = pubIface.decodeFunctionResult("getPublisher", result);
    if (decoded[0]) {
      log("3", `  ${name} (${cfg.name}): already registered`);
      continue;
    }
    try {
      await sendCall(wallet, rawProvider, addrs.publishers, pubIface, "registerPublisher", [cfg.takeBps]);
      log("3", `  ${name} (${cfg.name}): registered (${cfg.takeBps} bps)`);
    } catch (err) {
      console.error(`  FAILED to register ${name}: ${String(err).slice(0, 150)}`);
      process.exitCode = 1; return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. SET PUBLISHER TAGS (correct slugs — not legacy "topic:crypto")
  // ═══════════════════════════════════════════════════════════════════════════
  log("4", "--- Setting publisher tags (TargetingRegistry) ---");

  for (const [name, cfg] of Object.entries(PUBLISHER_CONFIGS)) {
    const wallet = publisherWallets[name];
    const hashes = cfg.tags.map(tagHash);
    try {
      await sendCall(wallet, rawProvider, addrs.targetingRegistry, targetIface, "setTags", [hashes]);
      log("4", `  ${name}: ${cfg.tags.join(", ")}`);
    } catch (err) {
      log("4", `  ${name} tags failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. SET RELAY SIGNERS (all publishers → diana.address)
  //    The demo page signs attestations with Diana's key, so all campaigns
  //    (regardless of which publisher serves them) validate correctly.
  // ═══════════════════════════════════════════════════════════════════════════
  log("5", "--- Setting relay signers → Diana ---");

  for (const [name, wallet] of Object.entries(publisherWallets)) {
    try {
      const raw = await readCall(rawProvider, addrs.publishers, pubIface, "relaySigner", [wallet.address]);
      const current = pubIface.decodeFunctionResult("relaySigner", raw)[0] as string;
      if (current.toLowerCase() === diana.address.toLowerCase()) {
        log("5", `  ${name}: already set to Diana`);
        continue;
      }
      await sendCall(wallet, rawProvider, addrs.publishers, pubIface, "setRelaySigner", [diana.address]);
      log("5", `  ${name}: relaySigner → ${diana.address}`);
    } catch (err) {
      log("5", `  ${name} setRelaySigner failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. GRACE ALLOWLIST (Bob only — demonstrates per-publisher advertiser gating)
  // ═══════════════════════════════════════════════════════════════════════════
  log("6", "--- Configuring Grace's advertiser allowlist ---");
  try {
    await sendCall(grace, rawProvider, addrs.publishers, pubIface, "setAllowlistEnabled", [true]);
    log("6", "  Grace: allowlist enabled");
    await sendCall(grace, rawProvider, addrs.publishers, pubIface, "setAllowedAdvertiser", [bob.address, true]);
    log("6", `  Grace: Bob (${bob.address}) allowed`);
  } catch (err) {
    log("6", `  allowlist setup failed: ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. CREATE CAMPAIGNS
  // ═══════════════════════════════════════════════════════════════════════════
  log("7", "--- Creating campaigns ---");

  const publisherAddrs: Record<string, string> = {
    diana: diana.address, eve: eve.address, frank: frank.address,
    grace: grace.address, heidi: heidi.address,
    open: ethers.ZeroAddress,
  };

  const quorumRaw = await readCall(rawProvider, addrs.governanceV2, govIface, "quorumWeighted", []);
  const quorum = BigInt(quorumRaw);
  const VOTE_STAKE = quorum > parseDOT("10") ? quorum : parseDOT("2");
  log("7", `  Quorum: ${formatDOT(quorum)} PAS  |  vote stake: ${formatDOT(VOTE_STAKE)} PAS`);

  const campaignIds: bigint[] = [];

  for (let i = 0; i < CAMPAIGN_CONFIGS.length; i++) {
    const cfg = CAMPAIGN_CONFIGS[i];
    const advWallet = wallets[cfg.advertiser];
    const pubAddr = publisherAddrs[cfg.publisher];
    const reqTags = cfg.requiredTagSlugs.map(tagHash);
    const reward = tokenRewards[i];
    const rewardToken = reward?.token ?? ethers.ZeroAddress;
    const rewardPer  = reward?.rewardPerImpression ?? 0n;

    try {
      const nextRaw = await readCall(rawProvider, addrs.campaigns, campIface, "nextCampaignId", []);
      const cid = BigInt(nextRaw);

      await sendCall(advWallet, rawProvider, addrs.campaigns, campIface, "createCampaign",
        [pubAddr, cfg.budget, cfg.bidCpm, reqTags, false, rewardToken, rewardPer],
        cfg.budget,
      );

      campaignIds.push(cid);
      log("7", `  ${cfg.label} → ID ${cid}`);
    } catch (err) {
      console.error(`  FAILED to create ${cfg.label}: ${String(err).slice(0, 200)}`);
      process.exitCode = 1; return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. MINT + APPROVE + DEPOSIT ERC-20 TOKEN BUDGETS
  // ═══════════════════════════════════════════════════════════════════════════
  log("8", "--- Depositing ERC-20 token budgets ---");

  for (const [idxStr, reward] of Object.entries(tokenRewards)) {
    const i = Number(idxStr);
    if (!campaignIds[i]) continue;
    const cid = campaignIds[i];
    const cfg = CAMPAIGN_CONFIGS[i];
    const advWallet = wallets[cfg.advertiser];

    try {
      // Mint tokens to advertiser
      await sendCall(alice, rawProvider, reward.token, erc20Iface, "mint", [advWallet.address, reward.deposit]);
      // Advertiser approves tokenRewardVault
      await sendCall(advWallet, rawProvider, reward.token, erc20Iface, "approve", [addrs.tokenRewardVault, reward.deposit]);
      // Deposit
      await sendCall(advWallet, rawProvider, addrs.tokenRewardVault, vaultIface, "depositCampaignBudget", [cid, reward.token, reward.deposit]);
      log("8", `  Campaign ${cid}: ${formatDOT(reward.deposit * 10000n / 10n ** 18n)} (×10⁻⁴) tokens deposited`);
    } catch (err) {
      log("8", `  Campaign ${cid} token deposit failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. VOTE AYE (Frank) + ACTIVATE
  // ═══════════════════════════════════════════════════════════════════════════
  log("9", "--- Voting + activating all campaigns ---");

  const frankBal = await rawProvider.getBalance(frank.address);
  const neededForVotes = VOTE_STAKE * BigInt(campaignIds.length) + parseDOT("10");
  if (frankBal < neededForVotes) {
    log("9", `  WARNING: Frank has ${formatDOT(frankBal)} PAS, needs ${formatDOT(neededForVotes)} — some votes may fail`);
  }

  for (let i = 0; i < campaignIds.length; i++) {
    const cid = campaignIds[i];
    const label = `C${i + 1} (id=${cid})`;
    try {
      await sendCall(frank, rawProvider, addrs.governanceV2, govIface, "vote", [cid, true, 0], VOTE_STAKE);
      log("9", `  Frank voted aye on ${label}`);
    } catch (err) {
      log("9", `  vote failed for ${label}: ${String(err).slice(0, 100)}`);
      continue;
    }
    try {
      await sendCall(alice, rawProvider, addrs.governanceV2, govIface, "evaluateCampaign", [cid]);
      const sRaw = await readCall(rawProvider, addrs.campaigns, campIface, "getCampaignStatus", [cid]);
      const s = Number(BigInt(sRaw));
      log("9", `  ${label}: ${STATUS_NAMES[s] ?? s}`);
      if (s !== 1) log("9", `  WARNING: ${label} did not activate`);
    } catch (err) {
      log("9", `  evaluate failed for ${label}: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. SET METADATA
  // ═══════════════════════════════════════════════════════════════════════════
  log("10", "--- Setting metadata hashes ---");

  for (let i = 0; i < campaignIds.length; i++) {
    const cid = campaignIds[i];
    const cfg = CAMPAIGN_CONFIGS[i];
    const advWallet = wallets[cfg.advertiser];
    const metaHash = keccak256(toUtf8Bytes(`demo-campaign-${cfg.metaSuffix}-${cid}`));
    try {
      await sendCall(advWallet, rawProvider, addrs.campaigns, campIface, "setMetadata", [cid, metaHash]);
      log("10", `  Campaign ${cid}: ${metaHash.slice(0, 18)}...`);
    } catch (err) {
      log("10", `  setMetadata for campaign ${cid} failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. WIRE REPUTATION REPORTER (Diana)
  // ═══════════════════════════════════════════════════════════════════════════
  log("11", "--- Wiring reputation reporter ---");
  try {
    const isRep = await readCall(rawProvider, addrs.reputation, repIface, "reporters", [diana.address]);
    if (repIface.decodeFunctionResult("reporters", isRep)[0]) {
      log("11", "  Diana already a reporter");
    } else {
      await sendCall(alice, rawProvider, addrs.reputation, repIface, "addReporter", [diana.address]);
      log("11", `  Diana added as reporter`);
    }
  } catch (err) {
    log("11", `  addReporter failed: ${String(err).slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. SAVE + SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  demoData.campaigns = Object.fromEntries(campaignIds.map((id, i) => [i, id.toString()]));
  demoData.tokens = { SWAP: swapToken, DEV: devToken, FIT: fitToken };
  fs.writeFileSync(DEMO_FILE, JSON.stringify(demoData, null, 2) + "\n");
  log("DONE", `Saved to ${DEMO_FILE}`);

  console.log("\n=== Demo Setup Complete ===");
  console.log("\nPublishers:");
  for (const [name, cfg] of Object.entries(PUBLISHER_CONFIGS)) {
    const w = publisherWallets[name];
    console.log(`  ${cfg.name.padEnd(14)} ${w.address}  tags: ${cfg.tags.filter(t => t.startsWith("topic:")).map(t => t.replace("topic:", "")).join(", ")}${cfg.allowlist ? "  [allowlist: Bob only]" : ""}`);
  }
  console.log("\nCampaigns:");
  for (let i = 0; i < campaignIds.length; i++) {
    const cfg = CAMPAIGN_CONFIGS[i];
    const reward = tokenRewards[i];
    const cid = campaignIds[i];
    console.log(`  ID ${cid.toString().padEnd(4)} ${cfg.label}${reward ? `  +${reward.token === swapToken ? "SWAP" : reward.token === devToken ? "DEV" : "FIT"} rewards` : ""}`);
  }
  console.log("\nERC-20 Tokens:");
  console.log(`  SWAP: ${swapToken}`);
  console.log(`  DEV:  ${devToken}`);
  console.log(`  FIT:  ${fitToken}`);
  console.log("\nAll 5 publishers use Diana's key as relay signer.");
  console.log("Grace has advertiser allowlist enabled (Bob only).");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
