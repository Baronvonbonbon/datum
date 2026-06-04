// Live Paseo dry-run of the redeploy-migrate-rewire upgrade model.
//
// Exercises the real on-chain lifecycle against Paseo's pallet-revive quirks
// (null receipts -> nonce polling + getCreateAddress; weight-unit gas; clean
// 1e6 denomination) on DatumPublisherStake — a fund + state contract:
//   deploy v1 -> stake() real PAS -> freeze -> deploy v2 -> migrate ->
//   migrateFundsTo -> verify state + native balance + version carried over.
//
// Throwaway contracts; uses a MockOpenGovRouter with the deployer as governor.
//   npx hardhat run scripts/upgrade-dryrun-paseo.ts --network polkadotTestnet
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet, Contract, formatEther } from "ethers";

const GAS_LIMIT = 500_000_000n;
const GAS_PRICE = 1_000_000_000_000n;
const STAKE = ethers.parseEther("0.05"); // 5e16 wei, clean multiple of 1e6

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(a)) > prev) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce did not advance");
}

async function main() {
  const rpc = process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  const p = new JsonRpcProvider(rpc);
  const gov = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, p);
  console.log(`Paseo dry-run | deployer ${gov.address}`);
  const startBal = await p.getBalance(gov.address);
  console.log(`start balance: ${formatEther(startBal)} PAS\n`);

  async function deploy(name: string, args: any[] = []): Promise<string> {
    const f = await ethers.getContractFactory(name);
    const data = (await f.getDeployTransaction(...args)).data;
    const nonce = await p.getTransactionCount(gov.address);
    const addr = ethers.getCreateAddress({ from: gov.address, nonce });
    const tx = await gov.sendTransaction({ data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    await waitForNonce(p, gov.address, nonce);
    const code = await p.getCode(addr);
    if (!code || code.length <= 2) throw new Error(`${name}: no code at ${addr}`);
    console.log(`  deployed ${name} @ ${addr} (tx ${tx.hash})`);
    return addr;
  }
  async function send(to: string, iface: Contract, method: string, args: any[], value = 0n) {
    const data = iface.interface.encodeFunctionData(method, args);
    const nonce = await p.getTransactionCount(gov.address);
    const tx = await gov.sendTransaction({ to, data, value, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE, nonce });
    await waitForNonce(p, gov.address, nonce);
    console.log(`  ${method}(${args.join(",")})${value ? " value=" + formatEther(value) : ""}  tx ${tx.hash}`);
    return tx.hash;
  }

  // ── 1. router (deployer = governor, OpenGov phase) ──
  console.log("[1] deploy + wire MockOpenGovRouter");
  const routerAddr = await deploy("MockOpenGovRouter");
  const router = new Contract(routerAddr, ["function setGovernor(address)", "function setPhase(uint8)", "function governor() view returns(address)", "function phase() view returns(uint8)"], gov);
  await send(routerAddr, router, "setGovernor", [gov.address]);

  // ── 2. deploy v1, wire router, load real state + funds ──
  console.log("\n[2] deploy DatumPublisherStake v1 + stake()");
  const v1Addr = await deploy("DatumPublisherStake", [1_000_000n, 1_000n, 10n]);
  const stakeAbi = [
    "function setRouter(address)", "function stake() payable", "function freeze()",
    "function migrate(address)", "function migrateFundsTo(address)",
    "function staked(address) view returns(uint256)", "function stakerCount() view returns(uint256)",
    "function version() view returns(uint256)", "function frozen() view returns(bool)",
    "function fundsMigratedOut() view returns(bool)", "function migrationSource() view returns(address)",
  ];
  const v1 = new Contract(v1Addr, stakeAbi, gov);
  await send(v1Addr, v1, "setRouter", [routerAddr]);
  await send(v1Addr, v1, "stake", [], STAKE);

  const stakedV1 = await v1.staked(gov.address);
  const balV1 = await p.getBalance(v1Addr);
  console.log(`  -> v1.staked(deployer) = ${formatEther(stakedV1)} PAS | v1 balance = ${formatEther(balV1)} PAS | stakerCount = ${await v1.stakerCount()}`);

  // ── 3. freeze v1, deploy v2 (bumped), migrate, sweep funds ──
  console.log("\n[3] freeze v1 -> deploy v2 -> migrate -> migrateFundsTo");
  await send(v1Addr, v1, "freeze", []);
  const v2Addr = await deploy("MockPublisherStakeV2", [1_000_000n, 1_000n, 10n]);
  const v2 = new Contract(v2Addr, stakeAbi, gov);
  await send(v2Addr, v2, "setRouter", [routerAddr]);
  await send(v2Addr, v2, "migrate", [v1Addr]);
  await send(v1Addr, v1, "migrateFundsTo", [v2Addr]);

  // ── 4. verify ──
  console.log("\n[4] verify carry-over");
  const stakedV2 = await v2.staked(gov.address);
  const balV2 = await p.getBalance(v2Addr);
  const balV1after = await p.getBalance(v1Addr);
  const checks: [string, boolean][] = [
    [`v2.staked == v1.staked (${formatEther(stakedV2)} PAS)`, stakedV2 === stakedV1],
    [`v2 balance == swept amount (${formatEther(balV2)} PAS)`, balV2 === balV1],
    [`v1 drained to 0 (${formatEther(balV1after)} PAS)`, balV1after === 0n],
    [`v2.version (${await v2.version()}) > v1.version (${await v1.version()})`, (await v2.version()) > (await v1.version())],
    [`v1.frozen == true`, (await v1.frozen()) === true],
    [`v1.fundsMigratedOut == true`, (await v1.fundsMigratedOut()) === true],
    [`v2.migrationSource == v1`, (await v2.migrationSource()).toLowerCase() === v1Addr.toLowerCase()],
    [`v2.stakerCount == 1`, (await v2.stakerCount()) === 1n],
  ];
  let ok = true;
  for (const [label, pass] of checks) { console.log(`  ${pass ? "✅" : "❌"} ${label}`); ok = ok && pass; }

  const endBal = await p.getBalance(gov.address);
  console.log(`\nend balance: ${formatEther(endBal)} PAS | spent (gas+stake): ${formatEther(startBal - endBal)} PAS`);
  console.log(`\n${ok ? "✅ DRY-RUN PASSED — upgrade lifecycle works on live Paseo" : "❌ DRY-RUN FAILED"}`);
  console.log(`addresses: router=${routerAddr} v1=${v1Addr} v2=${v2Addr}`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
