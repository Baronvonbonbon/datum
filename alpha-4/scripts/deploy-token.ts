// DATUM token deploy script — devnet-only.
//
// Deploys the full v0.6 token stack:
//   1. AssetHubPrecompileMock (devnet stand-in for the real Asset Hub precompile)
//   2. DatumMintAuthority (single bridge contract)
//   3. DatumWrapper (WDATUM ERC-20)
//   4. DatumVesting (5M founder allocation, 4y/1y cliff)
//   5. DatumBootstrapPool (1M house-ad onboarding pool)
//   6. DatumFeeShare (stake WDATUM, earn DOT)
//
// Then wires:
//   - Asset Hub asset registration (ID 31337 by default)
//   - MintAuthority ← Wrapper, Vesting, BootstrapPool, Settlement
//   - PaymentVault ← FeeShare (if PaymentVault address is provided)
//   - Settlement ← MintAuthority (if Settlement address is provided)
//   - DatumCouncil grant token = WDATUM (if Council address is provided)
//
// Usage:
//   npx hardhat run scripts/deploy-token.ts --network localhost
//
// Configuration via env:
//   TOKEN_FOUNDER_ADDRESS       — vesting beneficiary (defaults to deployer)
//   TOKEN_ASSET_ID              — asset ID on Asset Hub (default 31337)
//   TOKEN_SETTLEMENT_ADDRESS    — existing DatumSettlement (optional; will wire if present)
//   TOKEN_PAYMENT_VAULT_ADDRESS — existing DatumPaymentVault (optional)
//   TOKEN_COUNCIL_ADDRESS       — existing DatumCouncil (optional)

import hre, { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEFAULT_ASSET_ID = 31337n;
const DEFAULT_DECIMALS = 10;

interface DeployedAddresses {
  network: string;
  deployedAt: string;
  assetId: string;
  precompile: string;
  authority: string;
  wrapper: string;
  vesting: string;
  bootstrapPool: string;
  feeShare: string;
  // Optional cross-wirings if existing alpha-4 contracts were available
  settlement?: string;
  paymentVault?: string;
  council?: string;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = hre.network.name;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(` DATUM Token Deploy — ${network}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
  console.log(`Deployer:     ${deployer.address}`);

  const founder = process.env.TOKEN_FOUNDER_ADDRESS ?? deployer.address;
  const assetId = BigInt(process.env.TOKEN_ASSET_ID ?? DEFAULT_ASSET_ID.toString());

  console.log(`Founder:      ${founder}`);
  console.log(`Asset ID:     ${assetId}`);

  const existingSettlement   = process.env.TOKEN_SETTLEMENT_ADDRESS;
  const existingPaymentVault = process.env.TOKEN_PAYMENT_VAULT_ADDRESS;
  const existingCouncil      = process.env.TOKEN_COUNCIL_ADDRESS;
  if (existingSettlement)   console.log(`Settlement:   ${existingSettlement}`);
  if (existingPaymentVault) console.log(`PaymentVault: ${existingPaymentVault}`);
  if (existingCouncil)      console.log(`Council:      ${existingCouncil}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 1. AssetHubPrecompileMock (devnet only)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[1] Deploying AssetHubPrecompileMock...");
  const PrecompileF = await ethers.getContractFactory("AssetHubPrecompileMock");
  const precompile = await PrecompileF.deploy();
  await precompile.waitForDeployment();
  console.log(`    AssetHubPrecompileMock: ${await precompile.getAddress()}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. DatumMintAuthority
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[2] Deploying DatumMintAuthority...");
  const AuthorityF = await ethers.getContractFactory("DatumMintAuthority");
  const authority = await AuthorityF.deploy(await precompile.getAddress(), assetId);
  await authority.waitForDeployment();
  console.log(`    DatumMintAuthority:     ${await authority.getAddress()}`);

  // Register the asset with authority as issuer
  console.log("\n[2b] Registering canonical DATUM asset on (mock) Asset Hub...");
  await (await precompile.registerAsset(
    assetId,
    await authority.getAddress(),
    "DATUM",
    "DATUM",
    DEFAULT_DECIMALS,
  )).wait();
  console.log(`    Asset ${assetId} registered: name=DATUM, symbol=DATUM, decimals=${DEFAULT_DECIMALS}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. DatumWrapper (WDATUM)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[3] Deploying DatumWrapper (WDATUM)...");
  const WrapperF = await ethers.getContractFactory("DatumWrapper");
  const wrapper = await WrapperF.deploy(
    await authority.getAddress(),
    await precompile.getAddress(),
    assetId,
  );
  await wrapper.waitForDeployment();
  console.log(`    DatumWrapper:           ${await wrapper.getAddress()}`);

  // Wire wrapper into authority
  await (await authority.setWrapper(await wrapper.getAddress())).wait();
  console.log(`    Wired: MintAuthority.wrapper = ${await wrapper.getAddress()}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 4. DatumVesting (founder allocation)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[4] Deploying DatumVesting (5M founder allocation)...");
  const latestBlock = await ethers.provider.getBlock("latest");
  const startTime = BigInt(latestBlock!.timestamp);
  const VestingF = await ethers.getContractFactory("DatumVesting");
  const vesting = await VestingF.deploy(founder, await authority.getAddress(), startTime);
  await vesting.waitForDeployment();
  console.log(`    DatumVesting:           ${await vesting.getAddress()}`);
  console.log(`    Beneficiary:            ${founder}`);
  console.log(`    Start:                  ${new Date(Number(startTime) * 1000).toISOString()}`);

  await (await authority.setVesting(await vesting.getAddress())).wait();
  console.log(`    Wired: MintAuthority.vesting = ${await vesting.getAddress()}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 5. DatumBootstrapPool (house-ad onboarding)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[5] Deploying DatumBootstrapPool (1M reserve, 3 WDATUM/addr)...");
  // The pool needs a settlement caller. For devnet, we use the deployer if
  // no real Settlement was passed, so the deployer can simulate house-ad claims.
  const settlementCaller = existingSettlement ?? deployer.address;
  const BootstrapF = await ethers.getContractFactory("DatumBootstrapPool");
  const bootstrap = await BootstrapF.deploy(settlementCaller, await authority.getAddress());
  await bootstrap.waitForDeployment();
  console.log(`    DatumBootstrapPool:     ${await bootstrap.getAddress()}`);
  console.log(`    Settlement caller:      ${settlementCaller}`);

  await (await authority.setBootstrapPool(await bootstrap.getAddress())).wait();
  console.log(`    Wired: MintAuthority.bootstrapPool = ${await bootstrap.getAddress()}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 6. DatumFeeShare
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[6] Deploying DatumFeeShare (stake WDATUM, earn DOT)...");
  const FeeShareF = await ethers.getContractFactory("DatumFeeShare");
  const feeShare = await FeeShareF.deploy(await wrapper.getAddress());
  await feeShare.waitForDeployment();
  console.log(`    DatumFeeShare:          ${await feeShare.getAddress()}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-wire with existing alpha-4 contracts (optional)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[7] Cross-wiring with existing alpha-4 contracts (if provided)...");

  if (existingSettlement) {
    await (await authority.setSettlement(existingSettlement)).wait();
    console.log(`    Wired: MintAuthority.settlement = ${existingSettlement}`);

    const settlement = await ethers.getContractAt("DatumSettlement", existingSettlement);
    try {
      await (await settlement.setMintAuthority(await authority.getAddress())).wait();
      console.log(`    Wired: Settlement.mintAuthority = ${await authority.getAddress()}`);
    } catch (err) {
      console.warn(`    SKIP: Settlement.setMintAuthority — ${err instanceof Error ? err.message : err}`);
    }
  } else {
    console.log("    (no settlement address provided — skipping)");
  }

  if (existingPaymentVault) {
    const paymentVault = await ethers.getContractAt("DatumPaymentVault", existingPaymentVault);
    try {
      await (await paymentVault.setFeeShareRecipient(await feeShare.getAddress())).wait();
      console.log(`    Wired: PaymentVault.feeShareRecipient = ${await feeShare.getAddress()}`);
    } catch (err) {
      console.warn(`    SKIP: PaymentVault.setFeeShareRecipient — ${err instanceof Error ? err.message : err}`);
    }
    await (await feeShare.setPaymentVault(existingPaymentVault)).wait();
    console.log(`    Wired: FeeShare.paymentVault = ${existingPaymentVault}`);
  } else {
    console.log("    (no PaymentVault address provided — skipping)");
  }

  if (existingCouncil) {
    console.log("    (Council grant token wiring requires council self-vote — surface for governance proposal)");
    console.log(`    Use: council.proposeGrant(... setGrantToken(${await wrapper.getAddress()}) ...)`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persist addresses
  // ─────────────────────────────────────────────────────────────────────────
  const out: DeployedAddresses = {
    network,
    deployedAt: new Date().toISOString(),
    assetId: assetId.toString(),
    precompile: await precompile.getAddress(),
    authority: await authority.getAddress(),
    wrapper: await wrapper.getAddress(),
    vesting: await vesting.getAddress(),
    bootstrapPool: await bootstrap.getAddress(),
    feeShare: await feeShare.getAddress(),
    settlement: existingSettlement,
    paymentVault: existingPaymentVault,
    council: existingCouncil,
  };

  const outPath = path.resolve(__dirname, `../token-addresses-${network}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Addresses written to ${outPath}`);

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(` Deploy complete.`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log("\nNext steps:");
  console.log("  - Trigger a settlement to verify mint flow.");
  console.log("  - Stake WDATUM into FeeShare; call FeeShare.sweep() after fees accrue.");
  console.log("  - Call vesting.release() after 12-month cliff to begin founder unlock.");
  console.log("  - For council: governance proposal calling council.setGrantToken(wrapper).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
