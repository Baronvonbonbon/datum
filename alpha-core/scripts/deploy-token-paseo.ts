// Paseo-compatible token-plane deploy (port of deploy-token.ts, which is
// devnet-only — its ethers waitForDeployment()/.wait() hang on Paseo's
// getTransactionReceipt-null bug). Uses the hybrid pattern: hardhat factory for
// bytecode/ABI + raw JsonRpcProvider with nonce polling (same as
// deploy-advertiser-registry.ts / deploy.ts).
//
// Deploys the 5-contract token stack (AssetHubPrecompileMock, MintAuthority,
// Wrapper/WDATUM, Vesting, FeeShare), wires it into the live spine
// (mintAuthority<->coordinator, paymentVault<->feeShare), and MERGES the token
// addresses into deployed-addresses.json so the webapp feature-gate enables the
// /token surfaces. Re-run safe (reuses contracts that already have code).
//
//   npx hardhat run scripts/deploy-token-paseo.ts --network polkadotTestnet
//
// TESTNET-GRADE: devnetUnwrapShimEnabled = true (AssetHubPrecompileMock). Mainnet
// needs the XCM-aware Wrapper (PRE-MAINNET-CHECKLIST §L3) + a real Asset Hub asset.
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR_FILE = path.join(__dirname, "..", "deployed-addresses.json");
const EXT_ADDR_FILE = path.join(__dirname, "..", "extension", "deployed-addresses.json");
const WEB_ADDR_FILE = path.join(__dirname, "..", "..", "web", "public", "deployed-addresses.json");
const ASSET_ID = BigInt(process.env.TOKEN_ASSET_ID ?? "31337");

async function waitForNonce(p: JsonRpcProvider, addr: string, prev: number, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(addr)) > prev) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce did not advance after 180s");
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const isPaseo = net.chainId === 420420417n;
  const rpcUrl = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  const p = new JsonRpcProvider(rpcUrl);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("set DEPLOYER_PRIVATE_KEY");
  const deployer = new Wallet(key, p);
  const GAS = isPaseo ? 500_000_000n : 15_000_000n;
  const GP = isPaseo ? 1_000_000_000_000n : 1_000_000_000n;

  const addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));
  const founder = process.env.TOKEN_FOUNDER_ADDRESS ?? deployer.address;
  console.log(`Token-plane deploy — deployer ${deployer.address}  chainId ${net.chainId}  assetId ${ASSET_ID}`);

  // Deploy or reuse a contract via the hybrid hardhat-factory + raw-tx pattern.
  async function deployOrReuse(key: string, name: string, args: any[]): Promise<string> {
    const existing = addresses[key];
    if (existing && existing !== ZERO && (await p.getCode(existing)) !== "0x") {
      console.log(`  ${name}: reusing ${existing}`);
      return existing;
    }
    const factory = await ethers.getContractFactory(name);
    const data = (await factory.getDeployTransaction(...args)).data;
    const nonce = await p.getTransactionCount(deployer.address);
    const addr = ethers.getCreateAddress({ from: deployer.address, nonce });
    const tx = await deployer.sendTransaction({ data, gasLimit: GAS, type: 0, gasPrice: GP });
    console.log(`  ${name}: tx ${tx.hash} (nonce ${nonce}) -> ${addr}`);
    await waitForNonce(p, deployer.address, nonce);
    if ((await p.getCode(addr)) === "0x") throw new Error(`no code at ${addr} for ${name}`);
    addresses[key] = addr;
    fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
    return addr;
  }

  // Send an onlyOwner setter via raw tx + nonce poll. iface from a hardhat factory.
  async function wire(label: string, to: string, name: string, fn: string, args: any[]) {
    const iface = (await ethers.getContractFactory(name)).interface;
    const data = iface.encodeFunctionData(fn, args);
    const nonce = await p.getTransactionCount(deployer.address);
    const tx = await deployer.sendTransaction({ to, data, gasLimit: GAS, type: 0, gasPrice: GP });
    console.log(`  wire ${label}: tx ${tx.hash}`);
    await waitForNonce(p, deployer.address, nonce);
  }

  // ── Deploy the stack ────────────────────────────────────────────────────────
  const precompile = await deployOrReuse("assetHubPrecompile", "AssetHubPrecompileMock", []);
  const authority  = await deployOrReuse("mintAuthority", "DatumMintAuthority", [precompile, ASSET_ID]);
  const wrapper    = await deployOrReuse("wrapper", "DatumWrapper", [authority, precompile, ASSET_ID, true]);
  const block = await p.getBlock("latest");
  const vesting    = await deployOrReuse("vesting", "DatumVesting", [founder, authority, BigInt(block!.timestamp)]);
  const feeShare   = await deployOrReuse("feeShare", "DatumFeeShare", [wrapper]);

  // ── Register canonical DATUM asset on the (mock) Asset Hub precompile ────────
  // CRITICAL: the authority mints canonical into the wrapper reserve via
  // precompile.mint(ASSET_ID, wrapper, total) before issuing WDATUM. That call
  // is onlyIssuer(ASSET_ID); without registration issuerOf is address(0) and
  // every emission mint reverts "E18" — caught fail-soft, so DOT settles but no
  // WDATUM is ever issued (the bug that left authority.totalMinted at 0 on the
  // first Paseo token deploy). Idempotent: skip if already registered.
  {
    const pc = new ethers.Contract(precompile, ["function issuerOf(uint256) view returns (address)"], p);
    const curIssuer: string = await pc.issuerOf(ASSET_ID);
    if (curIssuer === ZERO) {
      await wire("AssetHubPrecompileMock.registerAsset", precompile, "AssetHubPrecompileMock", "registerAsset", [ASSET_ID, authority, "DATUM", "DATUM", 10]);
    } else if (curIssuer.toLowerCase() !== authority.toLowerCase()) {
      console.warn(`  WARN: asset ${ASSET_ID} issuer is ${curIssuer}, not the authority ${authority} — emission mint will fail; use transferIssuer.`);
    } else {
      console.log(`  OK (already): asset ${ASSET_ID} issuer = authority`);
    }
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  console.log("\nWiring token plane into the spine...");
  const auth = new ethers.Contract(authority, [
    "function wrapper() view returns (address)", "function vesting() view returns (address)", "function settlement() view returns (address)",
  ], p);
  if ((await auth.wrapper()) === ZERO) await wire("MintAuthority.setWrapper", authority, "DatumMintAuthority", "setWrapper", [wrapper]);
  if ((await auth.vesting()) === ZERO) await wire("MintAuthority.setVesting", authority, "DatumMintAuthority", "setVesting", [vesting]);

  // mintAuthority <-> coordinator (the carve-out: settlement mints via coordinator)
  const settlement = addresses.settlement;
  if (settlement) {
    const st = new ethers.Contract(settlement, ["function mintCoordinator() view returns (address)"], p);
    const coord = await st.mintCoordinator();
    if (coord && coord !== ZERO) {
      if ((await auth.settlement()) === ZERO) await wire("MintAuthority.setSettlement(coordinator)", authority, "DatumMintAuthority", "setSettlement", [coord]);
      const co = new ethers.Contract(coord, ["function mintAuthority() view returns (address)"], p);
      try { if ((await co.mintAuthority()) === ZERO) await wire("MintCoordinator.setMintAuthority", coord, "DatumMintCoordinator", "setMintAuthority", [authority]); }
      catch (e) { console.warn(`  SKIP MintCoordinator.setMintAuthority — ${(e as Error).message.slice(0, 60)}`); }
    } else console.warn("  SKIP: settlement.mintCoordinator unset");
  }

  // paymentVault <-> feeShare
  const paymentVault = addresses.paymentVault;
  if (paymentVault) {
    try { await wire("PaymentVault.setFeeShareRecipient", paymentVault, "DatumPaymentVault", "setFeeShareRecipient", [feeShare]); }
    catch (e) { console.warn(`  SKIP PaymentVault.setFeeShareRecipient — ${(e as Error).message.slice(0, 60)}`); }
    try { await wire("FeeShare.setPaymentVault", feeShare, "DatumFeeShare", "setPaymentVault", [paymentVault]); }
    catch (e) { console.warn(`  SKIP FeeShare.setPaymentVault — ${(e as Error).message.slice(0, 60)}`); }
  }

  // ── Persist + propagate ─────────────────────────────────────────────────────
  addresses.tokenAssetId = ASSET_ID.toString();
  fs.writeFileSync(ADDR_FILE, JSON.stringify(addresses, null, 2) + "\n");
  for (const f of [EXT_ADDR_FILE, WEB_ADDR_FILE]) { try { fs.writeFileSync(f, JSON.stringify(addresses, null, 2) + "\n"); } catch { /* optional */ } }

  console.log(`\n✅ Token plane deployed + wired + merged into deployed-addresses.json:`);
  console.log(`   mintAuthority=${authority}  wrapper=${wrapper}  vesting=${vesting}  feeShare=${feeShare}  precompile=${precompile}`);
  console.log(`   The webapp /token surfaces now gate ON (wrapper + mintAuthority present).`);
  console.log(`   NOTE: Council grant-token + TagRegistry/ZKStake (need WDATUM) are follow-ups; founder grant via governance.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
