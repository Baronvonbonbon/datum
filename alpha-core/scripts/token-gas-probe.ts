// Token-plane gas probe (EVM in-process). Deploys the DATUM token stack
// (precompile mock + MintAuthority + Wrapper + FeeShare + Vesting) and measures
// the user-facing ops the role-gas-report harness can't (it doesn't deploy the
// token plane). Run: npx hardhat run scripts/token-gas-probe.ts
import { ethers } from "hardhat";

const ASSET_ID = 31337n;
const DEC = 10n;
const ONE = 10n ** DEC; // 1 DATUM (10 decimals)

async function gas(label: string, txp: Promise<any>) {
  try {
    const r = await (await txp).wait();
    console.log(`  ${label.padEnd(34)} ${r.gasUsed.toString().padStart(9)} gas`);
    return r.gasUsed as bigint;
  } catch (e: any) {
    console.log(`  ${label.padEnd(34)} SKIPPED: ${String(e.shortMessage ?? e.message ?? e).slice(0, 70)}`);
    return 0n;
  }
}

async function main() {
  const [deployer, holder] = await ethers.getSigners();
  console.log(`Token-plane gas probe (Hardhat EVM). deployer=${deployer.address}\n`);

  const precompile = await (await ethers.getContractFactory("AssetHubPrecompileMock")).deploy();
  const authority = await (await ethers.getContractFactory("DatumMintAuthority")).deploy(await precompile.getAddress(), ASSET_ID);
  const wrapper = await (await ethers.getContractFactory("DatumWrapper")).deploy(
    await authority.getAddress(), await precompile.getAddress(), ASSET_ID, true);
  await (await authority.setWrapper(await wrapper.getAddress())).wait();
  const feeShare = await (await ethers.getContractFactory("DatumFeeShare")).deploy(await wrapper.getAddress());
  const start = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const vesting = await (await ethers.getContractFactory("DatumVesting")).deploy(holder.address, await authority.getAddress(), start);

  // Register asset with deployer as issuer so we can mint canonical for the test.
  await (await precompile.registerAsset(ASSET_ID, deployer.address, "DATUM", "DATUM", DEC)).wait();
  await (await precompile.mint(ASSET_ID, holder.address, 1000n * ONE)).wait();

  const W = wrapper.connect(holder);
  const P = precompile.connect(holder);
  const F = feeShare.connect(holder);
  const ahRecipient = ethers.zeroPadValue(holder.address, 32);

  console.log("Token-plane ops (holder = a WDATUM user):");
  await gas("precompile.approve(wrapper)", P.approve(ASSET_ID, await wrapper.getAddress(), 1000n * ONE));
  await gas("wrapper.wrap (canonical→WDATUM)", W.wrap(500n * ONE));
  await gas("wrapper.approve(feeShare)", (W as any).approve(await feeShare.getAddress(), 1000n * ONE));
  await gas("feeShare.stake", F.stake(300n * ONE));
  await gas("feeShare.claim (no fees)", F.claim());
  // Fund a fee inflow so claim/unstake exercise the payout path.
  await gas("feeShare.fund (DOT inflow)", (feeShare.connect(deployer) as any).fund({ value: ethers.parseEther("1") }));
  await gas("feeShare.claim (with fees)", F.claim());
  await gas("feeShare.unstake", F.unstake(300n * ONE));
  await gas("wrapper.unwrap (WDATUM→canonical)", (W as any).unwrap(200n * ONE, ahRecipient));
  await gas("vesting.release", vesting.connect(holder).release());

  console.log("\nNote: mintForSettlement (settlement→mint) needs the full settlement spine; covered in the EVM settle benchmark's mint path, not here.");
}
main().catch((e) => { console.error(e); process.exit(1); });
