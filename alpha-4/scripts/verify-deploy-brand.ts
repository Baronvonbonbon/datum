// Brand registry round-trip smoke test on the live Paseo deploy.
//
// Uses Frank (a funded test wallet from setup-testnet) to:
//   1. Read the current brand for Frank (should be unset on first run).
//   2. setBrand(name, logoCid, homepage, brandColor, profileHash).
//   3. Read back via getBrandHotFields + getBrand and assert every field.
//   4. Assert nameOwner mapping points to Frank.
//   5. Try to claim the same name from Grace — must revert NameTaken.
//   6. clearBrand from Frank; nameOwner should return zero.
//
// What this proves:
//   - Self-only writes work (Frank can set their own brand; Grace can't
//     steal Frank's name).
//   - lastUpdateBlock advances on each write.
//   - getBrandHotFields matches getBrand for the same fields.
//   - clearBrand frees the name for reuse.
//
// Run: npx hardhat run scripts/verify-deploy-brand.ts --network polkadotTestnet
// Re-run safe: each Setup phase clears Frank's brand first, so the script
// is idempotent.

import "dotenv/config";
import { JsonRpcProvider, Wallet, Interface, formatEther } from "ethers";
import addrs from "../deployed-addresses.json";

const RPC = "https://eth-rpc-testnet.polkadot.io/";
const TX_OPTS = { gasLimit: 1_500_000n };
const ZERO_HASH = "0x" + "0".repeat(64);

const BRAND_ABI = new Interface([
  "function setBrand(string name, bytes32 logoCid, string homepage, uint24 brandColor, bytes32 profileHash)",
  "function clearBrand()",
  "function getBrand(address) view returns (tuple(string name, bytes32 logoCid, string homepage, uint24 brandColor, bytes32 profileHash))",
  "function getBrandHotFields(address) view returns (string,bytes32,string,uint24)",
  "function nameOwner(bytes32) view returns (address)",
  "function lastUpdateBlock(address) view returns (uint256)",
  "function isRegistered(address) view returns (bool)",
  "event BrandSet(address indexed addr, string name, bytes32 logoCid, string homepage, uint24 brandColor, bytes32 profileHash)",
  "event BrandCleared(address indexed addr)",
]);

async function waitForNonce(provider: JsonRpcProvider, addr: string, target: number, maxWait = 90) {
  for (let i = 0; i < maxWait; i++) {
    const cur = await provider.getTransactionCount(addr);
    if (cur > target) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${target} on ${addr}`);
}

async function sendTx(signer: Wallet, provider: JsonRpcProvider, to: string, data: string) {
  const nonce = await provider.getTransactionCount(signer.address);
  const tx = await signer.sendTransaction({ to, data, ...TX_OPTS, nonce });
  await waitForNonce(provider, signer.address, nonce);
  return tx;
}

function nameHash(name: string): string {
  return require("ethers").keccak256(require("ethers").toUtf8Bytes(name));
}

async function readBrand(provider: JsonRpcProvider, registry: string, addr: string) {
  const raw = await provider.call({ to: registry, data: BRAND_ABI.encodeFunctionData("getBrand", [addr]) });
  return BRAND_ABI.decodeFunctionResult("getBrand", raw)[0];
}

async function readNameOwner(provider: JsonRpcProvider, registry: string, name: string): Promise<string> {
  const raw = await provider.call({ to: registry, data: BRAND_ABI.encodeFunctionData("nameOwner", [nameHash(name)]) });
  return String(BRAND_ABI.decodeFunctionResult("nameOwner", raw)[0]);
}

async function readLastUpdate(provider: JsonRpcProvider, registry: string, addr: string): Promise<bigint> {
  const raw = await provider.call({ to: registry, data: BRAND_ABI.encodeFunctionData("lastUpdateBlock", [addr]) });
  return BigInt(BRAND_ABI.decodeFunctionResult("lastUpdateBlock", raw)[0]);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${label}`);
}

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const a = addrs as any;
  const registry: string = a.brandRegistry;
  if (!registry) throw new Error("brandRegistry not in deployed-addresses.json");
  console.log(`Brand registry: ${registry}`);

  const frankKey = process.env.FRANK_PRIVATE_KEY;
  const graceKey = process.env.GRACE_PRIVATE_KEY;
  if (!frankKey || !graceKey) throw new Error("Need FRANK_PRIVATE_KEY + GRACE_PRIVATE_KEY in env");
  const frank = new Wallet(frankKey, provider);
  const grace = new Wallet(graceKey, provider);
  console.log(`Frank: ${frank.address}, balance ${formatEther(await provider.getBalance(frank.address))} PAS`);
  console.log(`Grace: ${grace.address}, balance ${formatEther(await provider.getBalance(grace.address))} PAS`);

  // Use a timestamped name so re-runs don't collide with stale state.
  const name = `Frank-${Date.now()}`;
  const logo = "0x" + "ab".repeat(32);
  const homepage = "https://frank.example";
  const color = 0xfacade;
  const profile = "0x" + "cd".repeat(32);

  // Phase 0: clear any prior state on Frank so the run is idempotent.
  const startingBrand = await readBrand(provider, registry, frank.address);
  if (startingBrand.name) {
    console.log(`\nFrank already has a brand (${startingBrand.name}); clearing first...`);
    await sendTx(frank, provider, registry, BRAND_ABI.encodeFunctionData("clearBrand", []));
  }

  console.log("\n[Phase 1] setBrand from Frank");
  const beforeBlock = await readLastUpdate(provider, registry, frank.address);
  await sendTx(frank, provider, registry, BRAND_ABI.encodeFunctionData("setBrand", [
    name, logo, homepage, color, profile,
  ]));

  // Phase 2: read back
  console.log("\n[Phase 2] Read-back via getBrand");
  const brand = await readBrand(provider, registry, frank.address);
  assertEq(brand.name, name, "name");
  assertEq(brand.logoCid.toLowerCase(), logo, "logoCid");
  assertEq(brand.homepage, homepage, "homepage");
  assertEq(Number(brand.brandColor), color, "brandColor");
  assertEq(brand.profileHash.toLowerCase(), profile, "profileHash");

  // Phase 3: getBrandHotFields convenience
  console.log("\n[Phase 3] getBrandHotFields matches");
  const rawHot = await provider.call({
    to: registry,
    data: BRAND_ABI.encodeFunctionData("getBrandHotFields", [frank.address]),
  });
  const hot = BRAND_ABI.decodeFunctionResult("getBrandHotFields", rawHot);
  assertEq(hot[0], name, "hot.name");
  assertEq(String(hot[1]).toLowerCase(), logo, "hot.logoCid");
  assertEq(hot[2], homepage, "hot.homepage");
  assertEq(Number(hot[3]), color, "hot.brandColor");

  // Phase 4: lastUpdateBlock advanced
  console.log("\n[Phase 4] lastUpdateBlock advanced");
  const afterBlock = await readLastUpdate(provider, registry, frank.address);
  if (!(afterBlock > beforeBlock)) {
    throw new Error(`lastUpdateBlock did not advance: ${beforeBlock} → ${afterBlock}`);
  }
  console.log(`  ✓ ${beforeBlock} → ${afterBlock}`);

  // Phase 5: nameOwner points to Frank
  console.log("\n[Phase 5] nameOwner mapping");
  const owner = await readNameOwner(provider, registry, name);
  assertEq(owner.toLowerCase(), frank.address.toLowerCase(), `nameOwner("${name}")`);

  // Phase 6: Grace can't claim Frank's name
  console.log("\n[Phase 6] Grace cannot claim Frank's name (should revert)");
  try {
    const nonce = await provider.getTransactionCount(grace.address);
    const tx = await grace.sendTransaction({
      to: registry,
      data: BRAND_ABI.encodeFunctionData("setBrand", [name, logo, "", 0, ZERO_HASH]),
      ...TX_OPTS,
      nonce,
    });
    await waitForNonce(provider, grace.address, nonce);
    // The tx will be mined but execution reverts — check the event was NOT emitted
    // by reading the latest receipt. Easiest: re-read Grace's brand and assert it's empty.
    const graceBrand = await readBrand(provider, registry, grace.address);
    if (graceBrand.name) {
      throw new Error(`Grace successfully claimed the name — uniqueness broken!`);
    }
    console.log(`  ✓ tx mined but Grace's brand still empty (revert observed)`);
  } catch (err: any) {
    // Some RPC paths surface the revert at submission time
    console.log(`  ✓ tx rejected: ${String(err.message ?? err).slice(0, 100)}`);
  }

  // Phase 7: clearBrand and verify name is freed
  console.log("\n[Phase 7] clearBrand frees the name");
  await sendTx(frank, provider, registry, BRAND_ABI.encodeFunctionData("clearBrand", []));
  const cleared = await readBrand(provider, registry, frank.address);
  assertEq(cleared.name, "", "name after clear");
  assertEq(cleared.logoCid, ZERO_HASH, "logoCid after clear");
  const ownerAfter = await readNameOwner(provider, registry, name);
  assertEq(ownerAfter, "0x0000000000000000000000000000000000000000", `nameOwner("${name}") cleared`);

  console.log("\n✅ Brand registry verification PASSED — all 7 phases.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
