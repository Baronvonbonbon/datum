// register-publishers.mjs — bring the test-network publishers (manifest.publishers
// with register:true) up to a fully-usable on-chain state so they can serve ads
// and settle: fund (from the deployer) → registerPublisher → setPublisherTags
// (DatumTagSystem) → setRelaySigner → stake (DatumPublisherStake). Idempotent:
// each step is skipped when already satisfied.
//
//   node register-publishers.mjs            # all register:true publishers
//   node register-publishers.mjs --dry      # show what it would do
//
// Paseo unit note (see ../demo-network/README.md): eth_getBalance is 18-decimal
// WEI; tx value + on-chain msg.value/requiredStake are 10-decimal PLANCK (1e8 gap).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes, formatUnits } from "ethers";

const DIR = dirname(fileURLToPath(import.meta.url));
const ALPHA5 = resolve(DIR, "..", "..");
config({ path: resolve(ALPHA5, ".env") });

const DRY = process.argv.includes("--dry");
const manifest = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf8"));
const ADDR = JSON.parse(readFileSync(resolve(ALPHA5, "deployed-addresses.json"), "utf8"));
const RPC = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
const TX_OPTS = { gasLimit: 500000000n, type: 0, gasPrice: 1000000000000n };
const SCALE = 10n ** 8n; // wei (18d getBalance) per planck (10d tx value)
const STEP = 1_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ceilStep = (p) => (p % STEP === 0n ? p : p + (STEP - (p % STEP)));
const tagHash = (t) => keccak256(toUtf8Bytes(t));
const provider = new JsonRpcProvider(RPC);

// Send a tx and wait for confirmation (receipt OR nonce-advance, per Paseo null-receipt).
async function send(label, wallet, txReq) {
  if (DRY) { console.log(`  [dry] ${label}`); return; }
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const tx = await wallet.sendTransaction({ ...txReq, ...TX_OPTS });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = await provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (r) { if (Number(r.status) === 0) throw new Error(`${label} reverted (${tx.hash})`); console.log(`  ✓ ${label}  ${tx.hash}`); return; }
    if ((await provider.getTransactionCount(wallet.address, "latest")) > nonce) { console.log(`  ✓ ${label}  (submitted) ${tx.hash}`); return; }
    await sleep(2500);
  }
  console.log(`  ? ${label}  (timeout; check ${tx.hash})`);
}

async function main() {
  const alice = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const pubAbi = ["function getPublisher(address) view returns (tuple(bool registered,uint16 takeRateBps,address relaySigner,bytes32 profileHash))",
    "function relaySigner(address) view returns (address)",
    "function registerPublisher(uint16 takeRateBps)", "function setRelaySigner(address signer)"];
  const tagAbi = ["function setPublisherTags(bytes32[] tagHashes)"];
  const stakeAbi = ["function requiredStake(address) view returns (uint256)", "function isAdequatelyStaked(address) view returns (bool)", "function stake() payable"];

  // Paseo eth-rpc reserves the MAX fee (gasLimit×gasPrice = 5e8×1e12 = 500 PAS)
  // at submission, so an account must hold >500 PAS just to broadcast a tx (even
  // though the fee actually charged is tiny). Fund well above that.
  const FUND_MIN_WEI = 520n * 10n ** 18n;
  const FUND_TO_WEI = 700n * 10n ** 18n;

  for (const p of manifest.publishers) {
   try {
    if (!p.register) { console.log(`\n${p.site.name} (${p.account}) — register:false, leaving as-is`); continue; }
    const key = process.env[`${p.account}_PRIVATE_KEY`];
    if (!key) { console.warn(`\n${p.account}: no key in .env — skip`); continue; }
    const w = new Wallet(key, provider);
    console.log(`\n${p.site.name} — ${p.account} ${w.address}`);

    // 1. Fund from Alice if low.
    const bal = await provider.getBalance(w.address);
    if (bal < FUND_MIN_WEI) {
      const valuePlanck = ceilStep((FUND_TO_WEI - bal) / SCALE);
      console.log(`  funding: bal ${Number(formatUnits(bal, 18)).toFixed(2)} PAS → sending ${formatUnits(valuePlanck, 10)} PAS from deployer`);
      await send(`fund ${p.account}`, alice, { to: w.address, value: valuePlanck });
      // Wait for the recipient's balance to actually reflect the funds before it
      // transacts — otherwise its first tx hits 1010/1012 (can't cover max-fee reserve).
      const wantWei = FUND_MIN_WEI;
      for (let i = 0; i < 20; i++) { if ((await provider.getBalance(w.address)) >= wantWei) break; await sleep(3000); }
      console.log(`  funded balance now ${Number(formatUnits(await provider.getBalance(w.address), 18)).toFixed(2)} PAS`);
    }

    const publishers = new Contract(ADDR.publishers, pubAbi, w);
    const tags = new Contract(ADDR.tagSystem, tagAbi, w);
    const stake = new Contract(ADDR.publisherStake, stakeAbi, w);

    // 2. Register.
    const info = await publishers.getPublisher(w.address).catch(() => null);
    if (info && info.registered) console.log(`  registered: already (take ${Number(info.takeRateBps) / 100}%)`);
    else await send(`registerPublisher(${p.takeRateBps}bps)`, w, { to: ADDR.publishers, data: publishers.interface.encodeFunctionData("registerPublisher", [p.takeRateBps]) });

    // 3. Tags.
    await send(`setPublisherTags [${p.tags.join(", ")}]`, w, { to: ADDR.tagSystem, data: tags.interface.encodeFunctionData("setPublisherTags", [p.tags.map(tagHash)]) });

    // 4. Relay signer (self = the publisher's own address; the relay must hold this key to co-sign at settle).
    const desiredRelay = p.relaySigner === "self" ? w.address : p.relaySigner;
    const curRelay = await publishers.relaySigner(w.address).catch(() => "0x0000000000000000000000000000000000000000");
    if (curRelay.toLowerCase() === desiredRelay.toLowerCase()) console.log(`  relaySigner: already ${desiredRelay}`);
    else { try { await send(`setRelaySigner(${desiredRelay})`, w, { to: ADDR.publishers, data: publishers.interface.encodeFunctionData("setRelaySigner", [desiredRelay]) }); } catch (e) { console.warn(`  ⚠ setRelaySigner skipped: ${String(e.message).slice(0, 60)}`); } }

    // 5. Stake.
    if (await stake.isAdequatelyStaked(w.address).catch(() => false)) console.log(`  stake: already adequate`);
    else {
      const req = await stake.requiredStake(w.address);
      const value = ceilStep(req);
      console.log(`  staking ${formatUnits(value, 10)} PAS (required ${formatUnits(req, 10)})`);
      await send(`stake`, w, { to: ADDR.publisherStake, data: stake.interface.encodeFunctionData("stake", []), value });
    }
   } catch (e) {
    console.warn(`  ⚠ ${p.account} step failed (continuing): ${String(e.message).slice(0, 100)}`);
   }
  }
  console.log(`\n✓ publisher registration pass complete${DRY ? " (dry run)" : ""}.`);
}

main().catch((e) => { console.error("\nFAILED:", e.message || e); process.exit(1); });
