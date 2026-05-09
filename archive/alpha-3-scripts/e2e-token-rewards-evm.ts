/**
 * e2e-token-rewards.ts — Full E2E: Campaign with sidecar ERC-20 token rewards
 * ===========================================================================
 * Tests the complete token reward flow:
 *   1. Deploy a fresh MockERC20 token
 *   2. Create a campaign with rewardToken + rewardPerImpression (Bob → Diana)
 *   3. Advertiser deposits token budget into TokenRewardVault
 *   4. Activate via governance (Frank votes aye)
 *   5. Settle impressions (Grace as user)
 *   6. Verify TokenRewardCredited event + userTokenBalance
 *   7. Grace withdraws tokens to self (withdraw)
 *   8. Credit again → Grace withdraws to a third address (withdrawTo)
 *   9. Create a second tiny-budget campaign, exhaust it, complete it,
 *      then advertiser reclaims leftover token budget (reclaimExpiredBudget)
 *
 * Usage:
 *   npx hardhat run scripts/e2e-token-rewards.ts --network polkadotTestnet
 *
 * Prerequisites:
 *   setup-testnet.ts has run (Diana registered, Frank has PAS for voting)
 */

import { ethers, network } from "hardhat";
import {
  JsonRpcProvider, Wallet, Interface,
  solidityPacked, getBytes, ZeroHash, ZeroAddress,
  keccak256, toUtf8Bytes, AbiCoder,
} from "ethers";
import { parseDOT, formatDOT } from "../test/helpers/dot";
import * as fs from "fs";
import * as path from "path";

// ── Accounts ─────────────────────────────────────────────────────────────────
const ACCOUNTS = {
  alice:   "0x6eda5379102df818a7b24bc99f005d3bcb7c12eaa6303c01bb8a40ba4ec64ac8",
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  charlie: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1",
  diana:   "0x40d6fab8165a332c4319f25682c480748a01bb1e06808ffe8fd34e8cd56230d0",
  frank:   "0xd8947fdc847ae7e902cf126b449cb8d9e7a9becdd0816397eaeb3b046d77986c",
  grace:   "0xdfafb7d12292bad165e40ba13bd2254f91123b656f991e3f308e5ccbcfc6a235",
};

const TX_OPTS = { gasLimit: 500_000_000n, type: 0, gasPrice: 1_000_000_000_000n };

// ── ABIs ──────────────────────────────────────────────────────────────────────

const erc20Abi = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

const tokenVaultAbi = [
  "function depositCampaignBudget(uint256 campaignId, address token, uint256 amount)",
  "function creditReward(uint256 campaignId, address token, address user, uint256 amount)",
  "function withdraw(address token)",
  "function withdrawTo(address token, address recipient)",
  "function reclaimExpiredBudget(uint256 campaignId, address token)",
  "function userTokenBalance(address token, address user) view returns (uint256)",
  "function campaignTokenBudget(address token, uint256 campaignId) view returns (uint256)",
  "function setSettlement(address addr)",
  "event TokenRewardCredited(uint256 indexed campaignId, address indexed token, address indexed user, uint256 amount)",
  "event TokenWithdrawal(address indexed user, address indexed token, uint256 amount)",
  "event TokenBudgetDeposited(uint256 indexed campaignId, address indexed token, uint256 amount)",
  "event BudgetExhausted(uint256 indexed campaignId, address indexed token)",
];

const campaignsAbi = [
  "function createCampaign(address publisher, uint256 dailyCap, uint256 bidCpm, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
  "function getCampaignStatus(uint256 campaignId) view returns (uint8)",
  "function nextCampaignId() view returns (uint256)",
];

const govV2Abi = [
  "function quorumWeighted() view returns (uint256)",
  "function vote(uint256 campaignId, bool aye, uint8 conviction) payable",
  "function evaluateCampaign(uint256 campaignId)",
];

const settlementAbi = [
  "function settleClaims((address user, uint256 campaignId, (uint256 campaignId, address publisher, uint256 impressionCount, uint256 clearingCpmPlanck, uint256 nonce, bytes32 previousClaimHash, bytes32 claimHash, bytes zkProof)[] claims)[] batches) returns (uint256 settledCount, uint256 rejectedCount)",
  "function lastNonce(address user, uint256 campaignId) view returns (uint256)",
  "function lastClaimHash(address user, uint256 campaignId) view returns (bytes32)",
];

const lifecycleAbi = [
  "function completeCampaign(uint256 campaignId)",
];

const STATUS_NAMES = ["Pending", "Active", "Paused", "Completed", "Terminated", "Expired"];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Passet Hub: SYSTEM precompile at 0x900 has code at chain level, visible to both
// PVM and EVM contracts — so blake256 path always fires (keccak256 fallback never used).
const sysIface = new Interface(["function hashBlake256(bytes) view returns (bytes32)"]);
const SYS_ADDR = "0x0000000000000000000000000000000000000900";

async function claimHash(provider: JsonRpcProvider, packed: Uint8Array): Promise<string> {
  const data = sysIface.encodeFunctionData("hashBlake256", [packed]);
  const raw = await provider.call({ to: SYS_ADDR, data });
  return sysIface.decodeFunctionResult("hashBlake256", raw)[0] as string;
}

async function waitForNonce(provider: JsonRpcProvider, address: string, targetNonce: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await provider.getTransactionCount(address) > targetNonce) return;
    if (i % 15 === 0 && i > 0) process.stdout.write(`    ...waiting (${i}s)\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function send(signer: Wallet, provider: JsonRpcProvider, to: string, iface: Interface, method: string, args: any[], value = 0n): Promise<void> {
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, data: iface.encodeFunctionData(method, args), value, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
}

async function read(provider: JsonRpcProvider, to: string, iface: Interface, method: string, args: any[]): Promise<any[]> {
  const raw = await provider.call({ to, data: iface.encodeFunctionData(method, args) });
  return iface.decodeFunctionResult(method, raw) as any[];
}

// Deploy a contract from its artifact bytecode
async function deployContract(
  signer: Wallet,
  provider: JsonRpcProvider,
  artifactPath: string,
  constructorArgs: any[],
  constructorTypes: string[],
): Promise<string> {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const encoded = constructorTypes.length > 0
    ? AbiCoder.defaultAbiCoder().encode(constructorTypes, constructorArgs).slice(2)
    : "";
  const deployData = artifact.bytecode + encoded;
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ data: deployData, value: 0n, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
  // Derive deployed address from sender + nonce
  const deployed = ethers.getCreateAddress({ from: signer.address, nonce });
  const code = await provider.getCode(deployed);
  if (code === "0x" || code.length < 4) throw new Error(`Deploy failed: no code at ${deployed}`);
  return deployed;
}

async function buildClaims(
  provider: JsonRpcProvider,
  campaignId: bigint,
  publisherAddr: string,
  userAddr: string,
  count: number,
  cpm: bigint,
  impressions: bigint,
  startNonce = 1n,
  startPrevHash = ZeroHash,
) {
  const claims = [];
  let prevHash = startPrevHash;
  for (let i = 0; i < count; i++) {
    const nonce = startNonce + BigInt(i);
    const packed = getBytes(solidityPacked(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [campaignId, publisherAddr, userAddr, impressions, cpm, nonce, prevHash],
    ));
    const hash = await claimHash(provider, packed);
    claims.push({ campaignId, publisher: publisherAddr, impressionCount: impressions, clearingCpmPlanck: cpm, nonce, previousClaimHash: prevHash, claimHash: hash, zkProof: "0x" });
    prevHash = hash;
  }
  return claims;
}

// ── Result tracking ───────────────────────────────────────────────────────────

interface Result { id: string; label: string; passed: boolean; ms: number; notes: string }
const results: Result[] = [];

function pass(id: string, label: string, ms: number, notes = "") {
  results.push({ id, label, passed: true, ms, notes });
  console.log(`  [PASS] ${id}: ${label} (${ms}ms)${notes ? "  — " + notes : ""}`);
}
function fail(id: string, label: string, ms: number, reason: string) {
  results.push({ id, label, passed: false, ms, notes: reason });
  console.log(`  [FAIL] ${id}: ${label} (${ms}ms)  — ${reason}`);
}
function info(msg: string) { console.log(`  [INFO] ${msg}`); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl = (network.config as any).url || "http://127.0.0.1:8545";
  const provider = new JsonRpcProvider(rpcUrl);

  const alice  = new Wallet(ACCOUNTS.alice,   provider);
  const bob    = new Wallet(ACCOUNTS.bob,     provider);
  const diana  = new Wallet(ACCOUNTS.diana,   provider);
  const frank  = new Wallet(ACCOUNTS.frank,   provider);
  const grace  = new Wallet(ACCOUNTS.grace,   provider);

  const addrFile = path.resolve(__dirname, "../deployed-addresses-evm.json");
  if (!fs.existsSync(addrFile)) { console.error("No deployed-addresses-evm.json"); process.exitCode = 1; return; }
  const A = JSON.parse(fs.readFileSync(addrFile, "utf-8"));

  if (!A.tokenRewardVault) { console.error("tokenRewardVault not in deployed-addresses-evm.json"); process.exitCode = 1; return; }

  const campIface  = new Interface(campaignsAbi);
  const govIface   = new Interface(govV2Abi);
  const settleIface = new Interface(settlementAbi);
  const vaultIface = new Interface(tokenVaultAbi);
  const erc20Iface = new Interface(erc20Abi);
  const lcIface    = new Interface(lifecycleAbi);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Datum Alpha-3 — E2E: Sidecar ERC-20 Token Rewards");
  console.log("  Network:", rpcUrl);
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── Governance quorum ─────────────────────────────────────────────────────
  const quorumRaw = await read(provider, A.governanceV2, govIface, "quorumWeighted", []);
  const QUORUM = BigInt(quorumRaw[0]);
  const VOTE_STAKE = QUORUM > parseDOT("10") ? QUORUM : parseDOT("10");
  info(`Governance quorum: ${formatDOT(QUORUM)} PAS  (vote stake: ${formatDOT(VOTE_STAKE)} PAS)`);

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E1: Deploy MockERC20 token
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E1: Deploy MockERC20 ─────────────────────────────────");
  let tokenAddr: string;
  {
    const t0 = Date.now();
    try {
      const artifactPath = path.resolve(__dirname, "../artifacts-evm/contracts/MockERC20.sol/MockERC20.json");
      tokenAddr = await deployContract(alice, provider, artifactPath, ["DatumTestToken", "DTT"], ["string", "string"]);
      pass("TR-E1", "Deploy MockERC20 (DTT)", Date.now() - t0, `address: ${tokenAddr}`);
    } catch (err: any) {
      fail("TR-E1", "Deploy MockERC20", Date.now() - t0, String(err).slice(0, 150));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E2: Mint tokens and approve TokenRewardVault
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E2: Mint + Approve ───────────────────────────────────");
  const TOKEN_MINT = ethers.parseEther("10000");
  const TOKEN_BUDGET = ethers.parseEther("1000");
  const REWARD_PER_IMP = ethers.parseEther("1"); // 1 DTT per impression
  {
    const t0 = Date.now();
    try {
      // Mint to Bob (advertiser)
      await send(alice, provider, tokenAddr, erc20Iface, "mint", [bob.address, TOKEN_MINT]);
      const bal = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [bob.address]))[0];
      info(`Bob balance: ${ethers.formatEther(bal)} DTT`);

      // Approve TokenRewardVault
      await send(bob, provider, tokenAddr, erc20Iface, "approve", [A.tokenRewardVault, TOKEN_MINT]);
      const allowance = (await read(provider, tokenAddr, erc20Iface, "allowance", [bob.address, A.tokenRewardVault]))[0];
      pass("TR-E2", "Mint DTT to Bob + approve TokenRewardVault", Date.now() - t0,
        `balance=${ethers.formatEther(bal)} DTT  allowance=${ethers.formatEther(allowance)} DTT`);
    } catch (err: any) {
      fail("TR-E2", "Mint + Approve", Date.now() - t0, String(err).slice(0, 150));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E3: Create campaign with sidecar token
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E3: Create sidecar campaign ──────────────────────────");
  const CPM = parseDOT("0.1");
  const DOT_BUDGET = parseDOT("2");
  let campaignId: bigint;
  {
    const t0 = Date.now();
    try {
      const nextRaw = await read(provider, A.campaigns, campIface, "nextCampaignId", []);
      campaignId = BigInt(nextRaw[0]);

      await send(bob, provider, A.campaigns, campIface, "createCampaign", [
        diana.address,      // fixed publisher: Diana
        DOT_BUDGET,         // dailyCap
        CPM,                // bidCpm
        [],                 // no required tags
        false,              // no ZK proof
        tokenAddr,          // rewardToken = DTT
        REWARD_PER_IMP,     // rewardPerImpression = 1 DTT
      ], DOT_BUDGET);

      pass("TR-E3", "createCampaign with sidecar DTT token", Date.now() - t0,
        `cid=${campaignId}  rewardPerImp=${ethers.formatEther(REWARD_PER_IMP)} DTT`);
    } catch (err: any) {
      fail("TR-E3", "createCampaign", Date.now() - t0, String(err).slice(0, 150));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E4: Deposit token budget into TokenRewardVault
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E4: Deposit token budget into vault ──────────────────");
  {
    const t0 = Date.now();
    try {
      await send(bob, provider, A.tokenRewardVault, vaultIface, "depositCampaignBudget",
        [campaignId, tokenAddr, TOKEN_BUDGET]);
      const budgetOnChain = (await read(provider, A.tokenRewardVault, vaultIface,
        "campaignTokenBudget", [tokenAddr, campaignId]))[0];
      if (BigInt(budgetOnChain) !== TOKEN_BUDGET) {
        fail("TR-E4", "depositCampaignBudget", Date.now() - t0,
          `expected ${ethers.formatEther(TOKEN_BUDGET)} DTT, got ${ethers.formatEther(budgetOnChain)}`);
        process.exitCode = 1; return;
      }
      pass("TR-E4", "depositCampaignBudget", Date.now() - t0,
        `budget: ${ethers.formatEther(budgetOnChain)} DTT in vault for cid=${campaignId}`);
    } catch (err: any) {
      fail("TR-E4", "depositCampaignBudget", Date.now() - t0, String(err).slice(0, 150));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E5: Vote + activate campaign
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E5: Governance vote + activate ───────────────────────");
  {
    const t0 = Date.now();
    try {
      await send(frank, provider, A.governanceV2, govIface, "vote", [campaignId, true, 0], VOTE_STAKE);
      await send(alice, provider, A.governanceV2, govIface, "evaluateCampaign", [campaignId]);
      const statusRaw = await read(provider, A.campaigns, campIface, "getCampaignStatus", [campaignId]);
      const status = Number(BigInt(statusRaw[0]));
      if (status !== 1) {
        fail("TR-E5", "Campaign activation", Date.now() - t0, `status=${STATUS_NAMES[status]} (expected Active)`);
        process.exitCode = 1; return;
      }
      pass("TR-E5", "Frank voted aye → campaign Active", Date.now() - t0, `cid=${campaignId}`);
    } catch (err: any) {
      fail("TR-E5", "Vote + activate", Date.now() - t0, String(err).slice(0, 150));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E6: Settle 3 claims (Grace as user) → verify token rewards credited
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E6: Settle claims + verify TokenRewardCredited ───────");
  const IMPRESSIONS = 10n;
  const CLAIM_COUNT = 3;
  {
    const t0 = Date.now();
    try {
      const graceBefore = (await read(provider, A.tokenRewardVault, vaultIface,
        "userTokenBalance", [tokenAddr, grace.address]))[0];
      const budgetBefore = (await read(provider, A.tokenRewardVault, vaultIface,
        "campaignTokenBudget", [tokenAddr, campaignId]))[0];

      info(`Grace token balance before: ${ethers.formatEther(graceBefore)} DTT`);
      info(`Campaign token budget before: ${ethers.formatEther(budgetBefore)} DTT`);

      const claims = await buildClaims(provider, campaignId, diana.address, grace.address, CLAIM_COUNT, CPM, IMPRESSIONS);
      const batch = { user: grace.address, campaignId, claims };

      // Static-call first
      const staticRaw = await provider.call({
        to: A.settlement,
        data: settleIface.encodeFunctionData("settleClaims", [[batch]]),
        from: grace.address,
      });
      const decoded = settleIface.decodeFunctionResult("settleClaims", staticRaw);
      const settledCount = BigInt(decoded[0]);
      const rejectedCount = BigInt(decoded[1]);
      info(`Static call: settled=${settledCount} rejected=${rejectedCount}`);

      if (settledCount !== BigInt(CLAIM_COUNT)) {
        fail("TR-E6", "settleClaims static preview", Date.now() - t0,
          `expected ${CLAIM_COUNT} settled, got ${settledCount} (rejected=${rejectedCount})`);
        process.exitCode = 1; return;
      }

      // Execute
      await send(grace, provider, A.settlement, settleIface, "settleClaims", [[batch]]);

      const graceAfter = (await read(provider, A.tokenRewardVault, vaultIface,
        "userTokenBalance", [tokenAddr, grace.address]))[0];
      const budgetAfter = (await read(provider, A.tokenRewardVault, vaultIface,
        "campaignTokenBudget", [tokenAddr, campaignId]))[0];

      const graceGain = BigInt(graceAfter) - BigInt(graceBefore);
      const budgetDrop = BigInt(budgetBefore) - BigInt(budgetAfter);

      info(`Grace token balance after:  ${ethers.formatEther(graceAfter)} DTT  (+${ethers.formatEther(graceGain)})`);
      info(`Campaign token budget after: ${ethers.formatEther(budgetAfter)} DTT  (-${ethers.formatEther(budgetDrop)})`);

      // Expected: IMPRESSIONS * CLAIM_COUNT * REWARD_PER_IMP (capped to actual budget used)
      const expectedReward = IMPRESSIONS * BigInt(CLAIM_COUNT) * REWARD_PER_IMP;
      if (graceGain === 0n) {
        fail("TR-E6", "TokenRewardCredited: Grace earned tokens", Date.now() - t0, "graceGain=0");
        process.exitCode = 1; return;
      }
      if (graceGain !== expectedReward) {
        // Capping is OK (if budget was smaller) — but with 1000 DTT budget and 30 rewards, no cap expected
        fail("TR-E6", "TokenRewardCredited: exact reward", Date.now() - t0,
          `expected ${ethers.formatEther(expectedReward)} DTT, got ${ethers.formatEther(graceGain)}`);
        process.exitCode = 1; return;
      }
      if (budgetDrop !== graceGain) {
        fail("TR-E6", "Budget drop matches grace gain", Date.now() - t0,
          `budgetDrop=${ethers.formatEther(budgetDrop)} graceGain=${ethers.formatEther(graceGain)}`);
        process.exitCode = 1; return;
      }
      pass("TR-E6", `settleClaims (${CLAIM_COUNT} claims × ${IMPRESSIONS} imps) → TokenRewardCredited`, Date.now() - t0,
        `Grace earned ${ethers.formatEther(graceGain)} DTT  budget remaining: ${ethers.formatEther(budgetAfter)} DTT`);
    } catch (err: any) {
      fail("TR-E6", "Settle + verify credits", Date.now() - t0, String(err).slice(0, 200));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E7: Grace withdraws tokens to self (withdraw)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E7: withdraw() — Grace to self ───────────────────────");
  {
    const t0 = Date.now();
    try {
      const vaultBalBefore = (await read(provider, A.tokenRewardVault, vaultIface,
        "userTokenBalance", [tokenAddr, grace.address]))[0];
      const walletBalBefore = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [grace.address]))[0];

      info(`Grace vault balance before withdraw: ${ethers.formatEther(vaultBalBefore)} DTT`);
      info(`Grace wallet balance before: ${ethers.formatEther(walletBalBefore)} DTT`);

      await send(grace, provider, A.tokenRewardVault, vaultIface, "withdraw", [tokenAddr]);

      const vaultBalAfter = (await read(provider, A.tokenRewardVault, vaultIface,
        "userTokenBalance", [tokenAddr, grace.address]))[0];
      const walletBalAfter = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [grace.address]))[0];

      const withdrawn = BigInt(walletBalAfter) - BigInt(walletBalBefore);
      info(`Grace wallet balance after: ${ethers.formatEther(walletBalAfter)} DTT  (+${ethers.formatEther(withdrawn)})`);
      info(`Grace vault balance after:  ${ethers.formatEther(vaultBalAfter)} DTT`);

      if (BigInt(vaultBalAfter) !== 0n) {
        fail("TR-E7", "withdraw() clears vault balance", Date.now() - t0,
          `vault balance still ${ethers.formatEther(vaultBalAfter)} DTT after withdrawal`);
        process.exitCode = 1; return;
      }
      if (withdrawn !== BigInt(vaultBalBefore)) {
        fail("TR-E7", "withdraw() transfers correct amount", Date.now() - t0,
          `transferred ${ethers.formatEther(withdrawn)}, expected ${ethers.formatEther(vaultBalBefore)}`);
        process.exitCode = 1; return;
      }
      pass("TR-E7", "withdraw() — tokens landed in Grace's wallet", Date.now() - t0,
        `withdrew ${ethers.formatEther(withdrawn)} DTT  vault balance: 0`);
    } catch (err: any) {
      fail("TR-E7", "withdraw()", Date.now() - t0, String(err).slice(0, 150));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E8: Settle more impressions, then withdrawTo(token, alice) — third party
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E8: withdrawTo() — Grace to Alice ────────────────────");
  {
    const t0 = Date.now();
    try {
      // Settle 2 more claims to give Grace a new balance
      // Query on-chain nonce/hash so these claims continue from where TR-E6 left off
      const [graceLastNonce] = await read(provider, A.settlement, settleIface, "lastNonce", [grace.address, campaignId]);
      const [graceLastHash]  = await read(provider, A.settlement, settleIface, "lastClaimHash", [grace.address, campaignId]);
      const claims2 = await buildClaims(provider, campaignId, diana.address, grace.address, 2, CPM, IMPRESSIONS,
        BigInt(graceLastNonce) + 1n, graceLastHash);
      const batch2 = { user: grace.address, campaignId, claims: claims2 };

      // Static check
      const staticRaw2 = await provider.call({
        to: A.settlement,
        data: settleIface.encodeFunctionData("settleClaims", [[batch2]]),
        from: grace.address,
      });
      const dec2 = settleIface.decodeFunctionResult("settleClaims", staticRaw2);
      info(`Static call (2 more claims): settled=${BigInt(dec2[0])} rejected=${BigInt(dec2[1])}`);

      await send(grace, provider, A.settlement, settleIface, "settleClaims", [[batch2]]);

      const graceVaultBal = (await read(provider, A.tokenRewardVault, vaultIface,
        "userTokenBalance", [tokenAddr, grace.address]))[0];
      info(`Grace vault balance (new credits): ${ethers.formatEther(graceVaultBal)} DTT`);

      if (BigInt(graceVaultBal) === 0n) {
        fail("TR-E8", "New credits before withdrawTo", Date.now() - t0, "graceVaultBal=0 — settle may have rejected");
        process.exitCode = 1; return;
      }

      // Alice's token balance before
      const aliceWalletBefore = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [alice.address]))[0];

      // Grace withdraws to Alice
      await send(grace, provider, A.tokenRewardVault, vaultIface, "withdrawTo", [tokenAddr, alice.address]);

      const graceVaultAfter = (await read(provider, A.tokenRewardVault, vaultIface,
        "userTokenBalance", [tokenAddr, grace.address]))[0];
      const aliceWalletAfter = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [alice.address]))[0];

      const aliceGain = BigInt(aliceWalletAfter) - BigInt(aliceWalletBefore);
      info(`Alice received: ${ethers.formatEther(aliceGain)} DTT`);
      info(`Grace vault after withdrawTo: ${ethers.formatEther(graceVaultAfter)} DTT`);

      if (BigInt(graceVaultAfter) !== 0n) {
        fail("TR-E8", "withdrawTo() clears vault balance", Date.now() - t0,
          `vault balance still ${ethers.formatEther(graceVaultAfter)} DTT`);
        process.exitCode = 1; return;
      }
      if (aliceGain !== BigInt(graceVaultBal)) {
        fail("TR-E8", "withdrawTo() correct amount to recipient", Date.now() - t0,
          `alice received ${ethers.formatEther(aliceGain)}, expected ${ethers.formatEther(graceVaultBal)}`);
        process.exitCode = 1; return;
      }
      pass("TR-E8", "withdrawTo() — tokens sent to Alice (third party)", Date.now() - t0,
        `Alice received ${ethers.formatEther(aliceGain)} DTT  Grace vault: 0`);
    } catch (err: any) {
      fail("TR-E8", "withdrawTo()", Date.now() - t0, String(err).slice(0, 200));
      process.exitCode = 1; return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TR-E9: reclaimExpiredBudget — create tiny campaign, terminate, reclaim
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── TR-E9: reclaimExpiredBudget() ───────────────────────────");
  {
    const t0 = Date.now();
    try {
      // Mint more tokens to Bob for second campaign
      await send(alice, provider, tokenAddr, erc20Iface, "mint", [bob.address, ethers.parseEther("500")]);
      await send(bob, provider, tokenAddr, erc20Iface, "approve", [A.tokenRewardVault, ethers.parseEther("500")]);

      // Create a new tiny campaign (same token)
      const nextRaw = await read(provider, A.campaigns, campIface, "nextCampaignId", []);
      const cid2 = BigInt(nextRaw[0]);
      const TINY_DOT_BUDGET = parseDOT("0.5");
      const TINY_TOKEN_BUDGET = ethers.parseEther("50");

      await send(bob, provider, A.campaigns, campIface, "createCampaign", [
        diana.address, TINY_DOT_BUDGET, CPM, [], false, tokenAddr, REWARD_PER_IMP,
      ], TINY_DOT_BUDGET);
      info(`Tiny campaign created: cid=${cid2}`);

      // Deposit token budget
      await send(bob, provider, A.tokenRewardVault, vaultIface, "depositCampaignBudget",
        [cid2, tokenAddr, TINY_TOKEN_BUDGET]);
      const budgetDeposited = (await read(provider, A.tokenRewardVault, vaultIface,
        "campaignTokenBudget", [tokenAddr, cid2]))[0];
      info(`Tiny campaign token budget: ${ethers.formatEther(budgetDeposited)} DTT`);

      // Vote + activate
      await send(frank, provider, A.governanceV2, govIface, "vote", [cid2, true, 0], VOTE_STAKE);
      await send(alice, provider, A.governanceV2, govIface, "evaluateCampaign", [cid2]);
      const statusRaw = await read(provider, A.campaigns, campIface, "getCampaignStatus", [cid2]);
      const status = Number(BigInt(statusRaw[0]));
      info(`Tiny campaign status: ${STATUS_NAMES[status]}`);
      if (status !== 1) { fail("TR-E9", "Tiny campaign activation", Date.now() - t0, STATUS_NAMES[status]); return; }

      // Bob completes his own campaign (advertiser can call completeCampaign)
      // terminateCampaign requires governance — completeCampaign is callable by advertiser
      if (!A.campaignLifecycle) {
        fail("TR-E9", "reclaimExpiredBudget — lifecycle", Date.now() - t0, "campaignLifecycle not deployed");
        return;
      }
      await send(bob, provider, A.campaignLifecycle, lcIface, "completeCampaign", [cid2]);

      const statusAfterRaw = await read(provider, A.campaigns, campIface, "getCampaignStatus", [cid2]);
      const statusAfter = Number(BigInt(statusAfterRaw[0]));
      info(`Tiny campaign status after complete: ${STATUS_NAMES[statusAfter]}`);
      if (statusAfter < 3) {
        fail("TR-E9", "Campaign completed (status >= 3)", Date.now() - t0,
          `status=${STATUS_NAMES[statusAfter]} — reclaimExpiredBudget requires Completed/Terminated`);
        process.exitCode = 1; return;
      }

      // Bob reclaims token budget
      const bobWalletBefore = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [bob.address]))[0];
      await send(bob, provider, A.tokenRewardVault, vaultIface, "reclaimExpiredBudget", [cid2, tokenAddr]);
      const bobWalletAfter = (await read(provider, tokenAddr, erc20Iface, "balanceOf", [bob.address]))[0];
      const bobGain = BigInt(bobWalletAfter) - BigInt(bobWalletBefore);

      const remainingBudget = (await read(provider, A.tokenRewardVault, vaultIface,
        "campaignTokenBudget", [tokenAddr, cid2]))[0];

      info(`Bob reclaimed: ${ethers.formatEther(bobGain)} DTT`);
      info(`Remaining vault budget for cid2: ${ethers.formatEther(remainingBudget)} DTT`);

      if (bobGain !== BigInt(budgetDeposited)) {
        fail("TR-E9", "reclaimExpiredBudget returns full budget", Date.now() - t0,
          `got ${ethers.formatEther(bobGain)}, expected ${ethers.formatEther(budgetDeposited)}`);
        process.exitCode = 1; return;
      }
      if (BigInt(remainingBudget) !== 0n) {
        fail("TR-E9", "reclaimExpiredBudget zeroes vault budget", Date.now() - t0,
          `remaining=${ethers.formatEther(remainingBudget)} DTT`);
        process.exitCode = 1; return;
      }
      pass("TR-E9", "reclaimExpiredBudget() — Bob reclaimed full token budget", Date.now() - t0,
        `reclaimed ${ethers.formatEther(bobGain)} DTT  vault budget: 0`);
    } catch (err: any) {
      fail("TR-E9", "reclaimExpiredBudget", Date.now() - t0, String(err).slice(0, 200));
      process.exitCode = 1;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const total  = results.length;
  const avgMs  = Math.round(results.reduce((s, r) => s + r.ms, 0) / total);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed}/${total} PASS  avg ${avgMs}ms`);
  console.log("══════════════════════════════════════════════════════════════");
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    const detail = r.notes ? `  (${r.notes})` : "";
    console.log(`  ${icon} ${r.id.padEnd(8)} ${r.label}${detail}`);
  }

  if (passed < total) {
    console.log(`\n  ${total - passed} test(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\n  All E2E token reward tests passed.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
