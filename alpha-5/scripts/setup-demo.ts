// setup-demo.ts — Multi-publisher demo seeding (alpha-5)
//
// Seeds 5 publishers, 3 MockERC20 tokens, and 24 campaigns spanning 7 verticals
// with competitive CPMs, ERC-20 rewards on 9 campaigns, and an allowlist showcase.
//
// Run AFTER deploy.ts (requires deployed-addresses.json).
// Re-run safe: skips already-registered publishers, reuses token addresses.
//
// Usage:
//   npx hardhat run scripts/setup-demo.ts --network polkadotTestnet

import { ethers, network } from "hardhat";
import { JsonRpcProvider, Wallet, Interface, keccak256, toUtf8Bytes, parseEther, formatEther } from "ethers";
import * as fs from "fs";
import * as path from "path";

// All native amounts are 18-decimal wei (the pallet-revive EVM scale). CPMs are
// quoted in PAS and centred on ~1 PAS (the historical 0.02–0.15 figures ×10), so
// a campaign pays CPM/1000 ≈ 0.001 PAS per impression (gross). Budgets are kept
// modest (the quoted figure ÷10 PAS) so testnet funding stays feasible.
const cpm = (pas: string) => parseEther((Number(pas) * 10).toFixed(6));
const bud = (pas: string) => parseEther((Number(pas) / 10).toFixed(6));
const dot = (pas: string) => parseEther(pas);
const fmt = (wei: bigint) => formatEther(wei);

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
    tags: ["topic:gaming", "topic:arts-entertainment", "topic:hobbies-leisure", "locale:en"],
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
  // ── Crypto / DeFi (6) — highest CPMs, compete on Diana + open slots ──────
  // C1: Bob → Diana  |  crypto+defi  |  SWAP rewards
  {
    label: "C1 LiquidityDAO (Bob→Diana, crypto+defi)",
    advertiser: "bob", publisher: "diana",
    requiredTagSlugs: ["topic:crypto-web3", "topic:defi"],
    bidCpm: cpm("0.150"), budget: bud("50"),
    metaSuffix: "liquiditydao",
  },
  // C2: Charlie → Diana  |  crypto
  {
    label: "C2 ChainSwap DEX (Charlie→Diana, crypto)",
    advertiser: "charlie", publisher: "diana",
    requiredTagSlugs: ["topic:crypto-web3"],
    bidCpm: cpm("0.120"), budget: bud("40"),
    metaSuffix: "chainswap-dex",
  },
  // C3: Bob → open  |  crypto+computers  |  DEV rewards
  {
    label: "C3 NFT Launchpad (Bob→open, crypto+tech)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:crypto-web3", "topic:computers-electronics"],
    bidCpm: cpm("0.100"), budget: bud("30"),
    metaSuffix: "nft-launchpad",
  },
  // C4: Charlie → open  |  defi
  {
    label: "C4 YieldFarm Pro (Charlie→open, defi)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: ["topic:defi"],
    bidCpm: cpm("0.090"), budget: bud("30"),
    metaSuffix: "yieldfarm-pro",
  },
  // C5: Bob → open  |  crypto+defi  |  SWAP rewards
  {
    label: "C5 PolkaHub Bridge (Bob→open, crypto+defi)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:crypto-web3", "topic:defi"],
    bidCpm: cpm("0.085"), budget: bud("25"),
    metaSuffix: "polkahub-bridge",
  },
  // C6: Charlie → Diana  |  crypto  |  second bid competing with C2
  {
    label: "C6 StakeEasy (Charlie→Diana, crypto)",
    advertiser: "charlie", publisher: "diana",
    requiredTagSlugs: ["topic:crypto-web3"],
    bidCpm: cpm("0.075"), budget: bud("20"),
    metaSuffix: "stakeeasy",
  },

  // ── Finance (4) — compete on Eve + open ──────────────────────────────────
  // C7: Charlie → Eve  |  finance  |  DEV rewards
  {
    label: "C7 WealthTrack AI (Charlie→Eve, finance)",
    advertiser: "charlie", publisher: "eve",
    requiredTagSlugs: ["topic:finance"],
    bidCpm: cpm("0.080"), budget: bud("30"),
    metaSuffix: "wealthtrack-ai",
  },
  // C8: Bob → Eve  |  finance+news
  {
    label: "C8 MarketPulse (Bob→Eve, finance+news)",
    advertiser: "bob", publisher: "eve",
    requiredTagSlugs: ["topic:finance", "topic:news"],
    bidCpm: cpm("0.065"), budget: bud("25"),
    metaSuffix: "marketpulse",
  },
  // C9: Charlie → open  |  finance+society
  {
    label: "C9 RetireDAO (Charlie→open, finance+society)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: ["topic:finance", "topic:people-society"],
    bidCpm: cpm("0.055"), budget: bud("20"),
    metaSuffix: "retiredao",
  },
  // C10: Bob → open  |  finance
  {
    label: "C10 CryptoTax Pro (Bob→open, finance)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:finance"],
    bidCpm: cpm("0.050"), budget: bud("20"),
    metaSuffix: "cryptotax-pro",
  },

  // ── Tech (4) — compete on Frank + open ───────────────────────────────────
  // C11: Bob → Frank  |  computers-electronics  |  DEV rewards
  {
    label: "C11 DevChain IDE (Bob→Frank, tech)",
    advertiser: "bob", publisher: "frank",
    requiredTagSlugs: ["topic:computers-electronics"],
    bidCpm: cpm("0.065"), budget: bud("25"),
    metaSuffix: "devchain-ide",
  },
  // C12: Charlie → Frank  |  tech+science
  {
    label: "C12 AI Research Hub (Charlie→Frank, tech+science)",
    advertiser: "charlie", publisher: "frank",
    requiredTagSlugs: ["topic:computers-electronics", "topic:science"],
    bidCpm: cpm("0.055"), budget: bud("20"),
    metaSuffix: "ai-research-hub",
  },
  // C13: Bob → open  |  internet-telecom  |  SWAP rewards
  {
    label: "C13 Web3 DNS (Bob→open, internet-telecom)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:internet-telecom"],
    bidCpm: cpm("0.045"), budget: bud("15"),
    metaSuffix: "web3-dns",
  },
  // C14: Charlie → open  |  computers-electronics
  {
    label: "C14 CloudMine PoW (Charlie→open, tech)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: ["topic:computers-electronics"],
    bidCpm: cpm("0.040"), budget: bud("15"),
    metaSuffix: "cloudmine-pow",
  },

  // ── Gaming (3) — compete on Heidi + open ─────────────────────────────────
  // C15: Charlie → Heidi  |  gaming  |  SWAP rewards
  {
    label: "C15 ArcadeChain NFTs (Charlie→Heidi, gaming)",
    advertiser: "charlie", publisher: "heidi",
    requiredTagSlugs: ["topic:gaming"],
    bidCpm: cpm("0.055"), budget: bud("20"),
    metaSuffix: "arcadechain",
  },
  // C16: Bob → Heidi  |  gaming+arts
  {
    label: "C16 PixelVerse (Bob→Heidi, gaming+arts)",
    advertiser: "bob", publisher: "heidi",
    requiredTagSlugs: ["topic:gaming", "topic:arts-entertainment"],
    bidCpm: cpm("0.048"), budget: bud("20"),
    metaSuffix: "pixelverse",
  },
  // C17: Charlie → open  |  gaming (lower CPM, broad open)
  {
    label: "C17 MetaArena (Charlie→open, gaming)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: ["topic:gaming"],
    bidCpm: cpm("0.038"), budget: bud("15"),
    metaSuffix: "meta-arena",
  },

  // ── Health / Sports (3) — Grace allowlist (Bob only) for C18+C19 ─────────
  // C18: Bob → Grace  |  sports  |  FIT rewards  |  allowlist
  {
    label: "C18 FitToken Gym (Bob→Grace, sports, allowlist)",
    advertiser: "bob", publisher: "grace",
    requiredTagSlugs: ["topic:sports"],
    bidCpm: cpm("0.045"), budget: bud("20"),
    metaSuffix: "fittoken-gym",
  },
  // C19: Bob → Grace  |  health+fitness  |  FIT rewards  |  allowlist
  {
    label: "C19 BioHack Labs (Bob→Grace, health+fitness, allowlist)",
    advertiser: "bob", publisher: "grace",
    requiredTagSlugs: ["topic:health", "topic:beauty-fitness"],
    bidCpm: cpm("0.040"), budget: bud("15"),
    metaSuffix: "biohack-labs",
  },
  // C20: Charlie → open  |  sports+health (no allowlist needed)
  {
    label: "C20 RunDAO (Charlie→open, sports+health)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: ["topic:sports", "topic:health"],
    bidCpm: cpm("0.030"), budget: bud("15"),
    metaSuffix: "rundao",
  },

  // ── News / Society (2) ────────────────────────────────────────────────────
  // C21: Charlie → Eve  |  news
  {
    label: "C21 ChainBreaker News (Charlie→Eve, news)",
    advertiser: "charlie", publisher: "eve",
    requiredTagSlugs: ["topic:news"],
    bidCpm: cpm("0.030"), budget: bud("15"),
    metaSuffix: "chainbreaker-news",
  },
  // C22: Bob → open  |  news+society
  {
    label: "C22 Civic3 (Bob→open, news+society)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:news", "topic:people-society"],
    bidCpm: cpm("0.025"), budget: bud("10"),
    metaSuffix: "civic3",
  },

  // ── Long-tail / broad (2) ─────────────────────────────────────────────────
  // C23: Bob → open  |  travel
  {
    label: "C23 TravelDAO (Bob→open, travel)",
    advertiser: "bob", publisher: "open",
    requiredTagSlugs: ["topic:travel"],
    bidCpm: cpm("0.028"), budget: bud("10"),
    metaSuffix: "traveldao",
  },
  // C24: Charlie → open  |  no tags  |  broad fallback for all publishers
  {
    label: "C24 Polkadot Ecosystem (Charlie→open, no tags)",
    advertiser: "charlie", publisher: "open",
    requiredTagSlugs: [],
    bidCpm: cpm("0.020"), budget: bud("20"),
    metaSuffix: "polkadot-ecosystem",
  },
];

// gasLimit 1e9 (not 5e8): closed campaigns with required tags trigger publisher
// tag VALIDATION in DatumTagSystem (cross-contract) at createCampaign — heavier
// than open campaigns, so 5e8 runs out of weight on Paseo and the tx
// silently reverts (nonce advances). 1e9 is still under the per-tx cap.
const TX_OPTS = { gasLimit: 1000000000n, type: 0, gasPrice: 1000000000000n };
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
  txOpts?: typeof TX_OPTS,
): Promise<void> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  // Pin the nonce: Paseo's getTransactionCount lags, so letting ethers
  // auto-fetch it for rapid same-sender txs (the create loop) yields stale/
  // duplicate nonces → the tx is mined-but-reverted (nonce advances, no effect).
  await signer.sendTransaction({ to, data, value: value ?? 0n, ...(txOpts ?? TX_OPTS), nonce });
  await waitForNonce(provider, signer.address, nonce);
}

async function sendTransfer(signer: Wallet, provider: JsonRpcProvider, to: string, value: bigint): Promise<void> {
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, value, ...TX_OPTS, nonce });
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

// alpha-4/5: publisher tags live on DatumTagSystem (carved out of Campaigns).
const tagSystemAbi = ["function setPublisherTags(bytes32[] tagHashes)"];

// alpha-5: multi-pot createCampaign + optimistic activation. setMetadata moved
// to DatumCampaignCreative. Old single-pot createCampaign + governance-vote
// activation are gone.
const campaignsAbi = [
  "function createCampaignWithActivation(address publisher, tuple(uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount, uint256 activationBondAmount) payable returns (uint256)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
];

const creativeAbi = ["function setMetadata(uint256 campaignId, bytes32 metadataHash)"];

const activationAbi = [
  "function activate(uint256 campaignId)",
  "function minBond() view returns (uint256)",
  "function timelockBlocks() view returns (uint64)",
  "function setTimelockBlocks(uint64 v)",
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

  // alpha-5 contract set (merged satellites: targetingRegistry/campaignValidator
  // → Campaigns; governanceHelper/Slash → GovernanceV2; rateLimiter →
  // settlementRateLimiter; reputation → publisherReputation; tags → tagSystem).
  const required = [
    "pauseRegistry", "publishers", "campaigns", "budgetLedger", "paymentVault",
    "campaignLifecycle", "settlement", "relay", "zkVerifier", "claimValidator",
    "tagSystem", "tokenRewardVault", "activationBonds", "campaignCreative",
  ];
  const missing = required.filter(k => !addrs[k]);
  if (missing.length > 0) {
    console.error("Missing contract addresses:", missing.join(", "));
    process.exitCode = 1; return;
  }

  // Build interfaces
  const pubIface = new Interface(publishersAbi);
  const tagIface = new Interface(tagSystemAbi);
  const campIface = new Interface(campaignsAbi);
  const creativeIface = new Interface(creativeAbi);
  const activationIface = new Interface(activationAbi);
  const erc20Iface = new Interface(erc20Abi);
  const vaultIface = new Interface(vaultAbi);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. FUND ACCOUNTS
  // ═══════════════════════════════════════════════════════════════════════════
  log("1", "--- Funding accounts ---");
  const aliceBal = await rawProvider.getBalance(alice.address);
  log("1", `Alice balance: ${fmt(aliceBal)} PAS`);

  // alpha-5: optimistic activation (no Frank governance votes), so advertisers
  // need budget + gas, publishers just gas.
  const toFund: [string, Wallet, bigint][] = [
    ["bob",     bob,     dot("350")],  // 12 campaigns × ~22 PAS avg budget + gas
    ["charlie", charlie, dot("350")],
    ["diana",   diana,   dot("50")],
    ["eve",     eve,     dot("50")],
    ["frank",   frank,   dot("50")],
    ["grace",   grace,   dot("50")],
    ["heidi",   heidi,   dot("50")],
  ];
  for (const [name, wallet, amount] of toFund) {
    const bal = await rawProvider.getBalance(wallet.address);
    const threshold = dot("40");
    if (bal >= threshold) {
      log("1", `  ${name}: ${fmt(bal)} PAS — skipping`);
      continue;
    }
    try {
      await sendTransfer(alice, rawProvider, wallet.address, amount);
      log("1", `  ${name}: funded ${fmt(amount)} PAS`);
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

  // Assign token rewards to campaign configs (indices match CAMPAIGN_CONFIGS above)
  const R_PER = BigInt("1000000000000000"); // 0.001 token per impression (18 decimals)
  const DEPOSIT = BigInt("1000") * 10n ** 18n; // 1000 tokens per campaign
  const tokenRewards: Record<number, { token: string; rewardPerImpression: bigint; deposit: bigint }> = {
     0: { token: swapToken, rewardPerImpression: R_PER, deposit: DEPOSIT }, // C1  SWAP (crypto+defi, Bob→Diana)
     2: { token: devToken,  rewardPerImpression: R_PER, deposit: DEPOSIT }, // C3  DEV  (crypto+nfts, Bob→open)
     4: { token: swapToken, rewardPerImpression: R_PER, deposit: DEPOSIT }, // C5  SWAP (crypto+polkadot, Bob→open)
     6: { token: devToken,  rewardPerImpression: R_PER, deposit: DEPOSIT }, // C7  DEV  (finance, Charlie→Eve)
    10: { token: devToken,  rewardPerImpression: R_PER, deposit: DEPOSIT }, // C11 DEV  (tech, Bob→Frank)
    12: { token: swapToken, rewardPerImpression: R_PER, deposit: DEPOSIT }, // C13 SWAP (internet-telecom, Bob→open)
    14: { token: swapToken, rewardPerImpression: R_PER, deposit: DEPOSIT }, // C15 SWAP (gaming, Charlie→Heidi)
    17: { token: fitToken,  rewardPerImpression: R_PER, deposit: DEPOSIT }, // C18 FIT  (sports, Bob→Grace)
    18: { token: fitToken,  rewardPerImpression: R_PER, deposit: DEPOSIT }, // C19 FIT  (health+fitness, Bob→Grace)
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
  log("4", "--- Setting publisher tags (TagSystem) ---");

  for (const [name, cfg] of Object.entries(PUBLISHER_CONFIGS)) {
    const wallet = publisherWallets[name];
    const hashes = cfg.tags.map(tagHash);
    try {
      await sendCall(wallet, rawProvider, addrs.tagSystem, tagIface, "setPublisherTags", [hashes]);
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

  // Optimistic activation: shrink the bond timelock to ~1 min for the seed +
  // read minBond (each campaign opens a bond at creation, activated below).
  const TIMELOCK = 10n;
  const curTl = activationIface.decodeFunctionResult("timelockBlocks",
    await readCall(rawProvider, addrs.activationBonds, activationIface, "timelockBlocks", []))[0] as bigint;
  if (BigInt(curTl) !== TIMELOCK) {
    await sendCall(alice, rawProvider, addrs.activationBonds, activationIface, "setTimelockBlocks", [TIMELOCK]);
    log("7", `  shrunk ActivationBonds.timelockBlocks ${BigInt(curTl)} → ${TIMELOCK} for seed`);
  }
  const minBond = activationIface.decodeFunctionResult("minBond",
    await readCall(rawProvider, addrs.activationBonds, activationIface, "minBond", []))[0] as bigint;
  log("7", `  ActivationBonds.minBond: ${fmt(BigInt(minBond))} PAS`);

  const campaignIds: bigint[] = [];
  // Compute ids from base + offset — Paseo's eth_call lags state, so re-reading
  // nextCampaignId() right after a create returns the stale value (would alias
  // every campaign to the same id). Read the base once.
  const baseCampaignId = BigInt(await readCall(rawProvider, addrs.campaigns, campIface, "nextCampaignId", []));

  for (let i = 0; i < CAMPAIGN_CONFIGS.length; i++) {
    const cfg = CAMPAIGN_CONFIGS[i];
    const advWallet = wallets[cfg.advertiser];
    const pubAddr = publisherAddrs[cfg.publisher];
    const reqTags = cfg.requiredTagSlugs.map(tagHash);
    const reward = tokenRewards[i];
    const rewardToken = reward?.token ?? ethers.ZeroAddress;
    const rewardPer  = reward?.rewardPerImpression ?? 0n;
    // CPM and budget are both 18-decimal wei (PAS) now — no cross-scale fudge.
    const rate = cfg.bidCpm;
    const pots = [{ actionType: 0, budgetPlanck: cfg.budget, dailyCapPlanck: cfg.budget, ratePlanck: rate, actionVerifier: ethers.ZeroAddress }];
    const cid = baseCampaignId + BigInt(campaignIds.length);

    try {
      await sendCall(advWallet, rawProvider, addrs.campaigns, campIface, "createCampaignWithActivation",
        [pubAddr, pots, reqTags, false, rewardToken, rewardPer, 0n, BigInt(minBond)],
        cfg.budget + BigInt(minBond),
      );
      campaignIds.push(cid);
      log("7", `  ${cfg.label} → ID ${cid} (CPM ${fmt(ratePlanck)} PAS)`);
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
      log("8", `  Campaign ${cid}: ${fmt(reward.deposit * 10000n / 10n ** 18n)} (×10⁻⁴) tokens deposited`);
    } catch (err) {
      log("8", `  Campaign ${cid} token deposit failed: ${String(err).slice(0, 100)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. ACTIVATE (permissionless, post-timelock — optimistic activation)
  // ═══════════════════════════════════════════════════════════════════════════
  log("9", "--- Activating campaigns (permissionless, post-timelock) ---");

  const targetBlock = (await rawProvider.getBlockNumber()) + Number(TIMELOCK) + 1;
  log("9", `  waiting for activation timelock (block ${targetBlock})...`);
  while (await rawProvider.getBlockNumber() < targetBlock) await new Promise(r => setTimeout(r, 6000));

  let activated = 0;
  for (let i = 0; i < campaignIds.length; i++) {
    const cid = campaignIds[i];
    const label = `C${i + 1} (id=${cid})`;
    try {
      await sendCall(alice, rawProvider, addrs.activationBonds, activationIface, "activate", [cid]);
      const s = Number(BigInt(await readCall(rawProvider, addrs.campaigns, campIface, "getCampaignStatus", [cid])));
      if (s === 1) activated++; else log("9", `  WARNING: ${label} status ${STATUS_NAMES[s] ?? s}`);
    } catch (err) {
      log("9", `  activate failed for ${label}: ${String(err).slice(0, 100)}`);
    }
  }
  log("9", `  activated ${activated}/${campaignIds.length}`);

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
      await sendCall(advWallet, rawProvider, addrs.campaignCreative, creativeIface, "setMetadata", [cid, metaHash]);
      log("10", `  Campaign ${cid}: ${metaHash.slice(0, 18)}...`);
    } catch (err) {
      log("10", `  setMetadata for campaign ${cid} failed: ${String(err).slice(0, 100)}`);
    }
  }

  // (alpha-5: publisherReputation.setSettlement is wired by deploy.ts — no
  //  setup-time wiring needed here.)

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. SAVE + SUMMARY
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
    const tokenName = reward ? (reward.token === swapToken ? "SWAP" : reward.token === devToken ? "DEV" : "FIT") : null;
    console.log(`  ID ${cid.toString().padEnd(4)} ${cfg.label}${tokenName ? `  +${tokenName} rewards` : ""}`);
  }
  console.log("\nERC-20 Tokens:");
  console.log(`  SWAP: ${swapToken}`);
  console.log(`  DEV:  ${devToken}`);
  console.log(`  FIT:  ${fitToken}`);
  console.log("\nAll 5 publishers use Diana's key as relay signer.");
  console.log("Grace has advertiser allowlist enabled (Bob only).");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
