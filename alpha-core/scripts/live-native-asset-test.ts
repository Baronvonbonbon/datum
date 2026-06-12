// live-native-asset-test.ts — prove the sidecar handles a doc-accurate native
// pallet_assets ERC-20 precompile (NO decimals/name/symbol) end-to-end on Paseo.
//
//   1. deploy MockNativeAssetPrecompile (a new "native asset", core ERC-20 only)
//   2. BUG DEMO: the live production vault (old _isErc20, requires decimals())
//      rejects it — setAssetAllowed reverts "not-erc20"
//   3. FIX: a fresh fixed vault (deployer = settlement, so we can drive credit)
//      allowlists it via the guaranteed totalSupply()+balanceOf() probe
//   4. FLOW: mint → advertiser deposits budget → settlement credits a user →
//      user withdraws the native asset
//
// Run: npx hardhat run scripts/live-native-asset-test.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const GAS = { gasLimit: 500_000_000n, gasPrice: 1_000_000_000_000n, type: 0 as const };
const CID = 8n; // campaign whose advertiser is the deployer

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 120) {
  for (let i = 0; i < tries; i++) { if ((await p.getTransactionCount(a)) > prev) return; if (i % 10 === 0 && i > 0) console.log(`    ...awaiting (${i}s)`); await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`nonce stuck > ${prev}`);
}
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${d ? "  (" + d + ")" : ""}`); ok ? pass++ : fail++; };

async function main() {
  const provider = new JsonRpcProvider(process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/");
  const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const A = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
  const BOB = new Wallet(process.env.BOB_PRIVATE_KEY!, provider);

  const view = async (to: string, sig: string, n: string, args: any[] = []) => { const i = new ethers.Interface([`function ${sig}`]); return i.decodeFunctionResult(n, await provider.call({ to, data: i.encodeFunctionData(n, args) }))[0]; };
  const send = async (signer: Wallet, to: string, frag: string, n: string, args: any[]) => { const i = new ethers.Interface([`function ${frag}`]); const nonce = await provider.getTransactionCount(signer.address); await signer.sendTransaction({ to, data: i.encodeFunctionData(n, args), ...GAS, nonce }); await waitForNonce(provider, signer.address, nonce); };
  const deploy = async (name: string, args: any[] = []) => { const f = (await ethers.getContractFactory(name)).connect(w); const tx = await f.getDeployTransaction(...args); const nonce = await provider.getTransactionCount(w.address); await w.sendTransaction({ ...tx, ...GAS, nonce }); await waitForNonce(provider, w.address, nonce); const addr = ethers.getCreateAddress({ from: w.address, nonce }); if ((await provider.getCode(addr)) === "0x") throw new Error(`${name} no code`); return addr; };

  // 1. Deploy the native-asset precompile (no decimals)
  console.log("1) Deploy MockNativeAssetPrecompile (native asset, no decimals/name/symbol)");
  const native = await deploy("MockNativeAssetPrecompile");
  console.log(`   native asset ${native}`);
  let hasDecimals = true;
  try { await view(native, "decimals() view returns(uint8)", "decimals"); } catch { hasDecimals = false; }
  check("native asset has NO decimals() (doc-accurate)", !hasDecimals);

  // 2. Bug demo: production vault (old check) rejects the no-decimals native asset
  console.log("2) Bug demo — production vault.setAssetAllowed(native) should revert (old check requires decimals())");
  let prodReverts = false;
  try {
    const i = new ethers.Interface(["function setAssetAllowed(address,bool)"]);
    await provider.call({ to: A.tokenRewardVault, from: w.address, data: i.encodeFunctionData("setAssetAllowed", [native, true]) });
  } catch (e: any) { prodReverts = /not-erc20|revert/i.test(String(e.shortMessage || e)); }
  check("production vault rejects the native asset (no decimals)", prodReverts, "eth_call; from honored on Paseo for owner calls");

  // 3. Fix: fresh fixed vault accepts it
  console.log("3) Deploy fixed vault (deployer = settlement) + allowlist the native asset");
  const vault = await deploy("DatumTokenRewardVault", [A.campaigns]);
  await send(w, vault, "setSettlement(address)", "setSettlement", [w.address]); // deployer drives creditReward
  await send(w, vault, "setAssetAllowed(address,bool)", "setAssetAllowed", [native, true]);
  check("fixed vault allowlists the no-decimals native asset", await view(vault, "isAssetPermitted(address) view returns(bool)", "isAssetPermitted", [native]) === true);
  check("default mode is compliant (allowlist)", await view(vault, "assetAllowlistEnabled() view returns(bool)", "assetAllowlistEnabled") === true);

  // 4. Full flow: mint → deposit → credit → withdraw
  console.log("4) Flow: mint → advertiser deposit → settlement credit → user withdraw");
  const MINT = 1_000_000_000n, BUDGET = 500_000_000n, REWARD = 200_000_000n;
  await send(w, native, "mint(address,uint256)", "mint", [w.address, MINT]);            // Assets-pallet issuance stand-in
  await send(w, native, "approve(address,uint256)", "approve", [vault, BUDGET]);
  await send(w, vault, "depositCampaignBudget(uint256,address,uint256)", "depositCampaignBudget", [CID, native, BUDGET]); // deployer is CID 8 advertiser
  check("budget funded", (await view(vault, "campaignTokenBudget(address,uint256) view returns(uint256)", "campaignTokenBudget", [native, CID])).toString() === BUDGET.toString());

  const bobBefore = await view(native, "balanceOf(address) view returns(uint256)", "balanceOf", [BOB.address]);
  await send(w, vault, "creditReward(uint256,address,address,uint256)", "creditReward", [CID, native, BOB.address, REWARD]); // deployer = settlement
  check("user credited in vault", (await view(vault, "userTokenBalance(address,address) view returns(uint256)", "userTokenBalance", [native, BOB.address])).toString() === REWARD.toString());

  await send(BOB, vault, "withdraw(address)", "withdraw", [native]);
  const bobAfter = await view(native, "balanceOf(address) view returns(uint256)", "balanceOf", [BOB.address]);
  check("user withdrew the native asset", (bobAfter - bobBefore).toString() === REWARD.toString(), `+${bobAfter - bobBefore}`);
  check("vault balance cleared", (await view(vault, "userTokenBalance(address,address) view returns(uint256)", "userTokenBalance", [native, BOB.address])).toString() === "0");

  console.log(`\n${pass} passed, ${fail} failed.`);
  console.log(`Native asset ${native} | test vault ${vault} (throwaway, deployer-as-settlement).`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
