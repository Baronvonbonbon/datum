/**
 * fix-metadata-hashes.ts
 *
 * Reads metadata-cids.json (which contains the actual IPFS CIDs returned by the
 * selfhosted node after pinning) and calls setMetadata() on DatumCampaigns with
 * cidToBytes32(actualCid) for each campaign.
 *
 * Background: setup-testnet.ts stored sha256(raw JSON) as the on-chain bytes32.
 * bytes32ToCid() treats that sha256 as a multihash and produces a CIDv0 that
 * does NOT match the actual IPFS CID (which is sha256 of the UnixFS dag-pb
 * encoding, not the raw JSON). This script fixes all 100 campaigns.
 *
 * Usage:
 *   npx ts-node scripts/fix-metadata-hashes.ts
 */

import { JsonRpcProvider, Wallet, Interface } from "ethers";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = "https://eth-rpc-testnet.polkadot.io/";

const ACCOUNTS = {
  bob:     "0x8a4dee9fc3885e92f76305592570259afa4a1f91999c891734e7427f9e41fd52",
  charlie: "0x1560b7b8d38c812b182b08e8ef739bb88c806d7ba36bd7b01c9177b3536654c1",
};

const TX_OPTS = {
  gasLimit: 500000000n,
  type: 0 as const,
  gasPrice: 1000000000000n,
};

// ── CID conversion (inline, no shared import needed) ─────────────────────────

const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array {
  let num = 0n;
  for (const c of s) {
    const idx = BASE58_CHARS.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 char: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  // count leading '1's (map to 0x00 bytes)
  let leadingZeros = 0;
  for (const c of s) {
    if (c === "1") leadingZeros++;
    else break;
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

/**
 * Convert a CIDv0 (base58 multihash) to a 32-byte hex string (strips the 0x1220 prefix).
 * This is the value stored on-chain as metadataHash.
 */
function cidToBytes32(cid: string): string {
  const decoded = base58Decode(cid);
  // decoded = [0x12, 0x20, <32 bytes sha256>]
  if (decoded.length !== 34 || decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(`Not a CIDv0 sha256 multihash: ${cid} (decoded length ${decoded.length})`);
  }
  const hash = decoded.slice(2);
  return "0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Paseo nonce-polling pattern ───────────────────────────────────────────────

async function waitForNonce(
  provider: JsonRpcProvider,
  address: string,
  targetNonce: number,
  maxWait = 120,
): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) process.stdout.write(`    ...waiting for tx (${i}s)\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function sendCall(
  signer: Wallet,
  provider: JsonRpcProvider,
  to: string,
  iface: Interface,
  method: string,
  args: unknown[],
): Promise<void> {
  const data = iface.encodeFunctionData(method, args);
  const nonce = await provider.getTransactionCount(signer.address);
  await signer.sendTransaction({ to, data, value: 0n, ...TX_OPTS });
  await waitForNonce(provider, signer.address, nonce);
}

async function readCall(
  provider: JsonRpcProvider,
  to: string,
  iface: Interface,
  method: string,
  args: unknown[],
): Promise<string> {
  const data = iface.encodeFunctionData(method, args);
  return await provider.call({ to, data });
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface CidRecord {
  campaignIndex: number;
  wikiArticle: string;
  bytes32: string;     // sha256(raw JSON) — what's currently on-chain (wrong)
  cid: string | null;  // actual IPFS CID from selfhosted node
}

async function main() {
  const scriptDir = path.dirname(new URL("file://" + __filename).pathname);
  const addrsPath = path.resolve(scriptDir, "../deployed-addresses.json");
  const cidsPath  = path.resolve(scriptDir, "metadata-cids.json");

  const addrs = JSON.parse(fs.readFileSync(addrsPath, "utf8"));
  const cids: CidRecord[] = JSON.parse(fs.readFileSync(cidsPath, "utf8"));

  const campaignsAddr: string = addrs.campaigns;
  if (!campaignsAddr) throw new Error("campaigns address missing from deployed-addresses.json");

  console.log(`Campaigns contract: ${campaignsAddr}`);
  console.log(`Loaded ${cids.length} CID records from metadata-cids.json`);

  const rawProvider = new JsonRpcProvider(RPC_URL);
  const bob     = new Wallet(ACCOUNTS.bob,     rawProvider);
  const charlie = new Wallet(ACCOUNTS.charlie, rawProvider);

  console.log(`Bob:     ${bob.address}`);
  console.log(`Charlie: ${charlie.address}`);

  const campIface = new Interface([
    "function nextCampaignId() view returns (uint256)",
    "function setMetadata(uint256 campaignId, bytes32 metadataHash)",
    "function getCampaignMetadata(uint256 campaignId) view returns (bytes32)",
  ]);

  // Determine base campaign ID: read nextCampaignId, subtract 100
  const nextIdRaw = await readCall(rawProvider, campaignsAddr, campIface, "nextCampaignId", []);
  const nextCampaignId = BigInt(nextIdRaw);
  const baseCampaignId = nextCampaignId - BigInt(cids.length);
  console.log(`nextCampaignId: ${nextCampaignId}  →  base: ${baseCampaignId}`);

  // Verify: check that campaign at baseCampaignId has the bytes32 that matches cids[0]
  const c0Raw = await readCall(rawProvider, campaignsAddr, campIface, "getCampaignMetadata", [baseCampaignId]);
  const onChainHash0 = campIface.decodeFunctionResult("getCampaignMetadata", c0Raw)[0] as string;
  const expected0 = cids[0].bytes32.toLowerCase();
  const actual0   = onChainHash0.toLowerCase();
  if (actual0 !== expected0) {
    console.warn(`WARNING: campaign ${baseCampaignId} metadataHash mismatch.`);
    console.warn(`  Expected (from json): ${expected0}`);
    console.warn(`  On-chain:             ${actual0}`);
    console.warn(`  Proceeding anyway — adjust baseCampaignId if needed.`);
  } else {
    console.log(`Verification OK: campaign ${baseCampaignId} hash matches cids[0].bytes32`);
  }

  // Count valid CIDs
  const validEntries = cids.filter(r => r.cid !== null && r.cid !== "");
  console.log(`\nCIDs to update: ${validEntries.length}/${cids.length}`);
  if (validEntries.length === 0) {
    console.error("No valid CIDs found. Run repin-metadata.ts selfhosted first.");
    process.exit(1);
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < cids.length; i++) {
    const record = cids[i];
    if (!record.cid) {
      console.log(`[${(i+1).toString().padStart(3)}] SKIP  spec ${i} — no CID`);
      skipped++;
      continue;
    }

    const campaignId = baseCampaignId + BigInt(i);
    const signer = (i % 2 === 0) ? bob : charlie;
    const signerName = (i % 2 === 0) ? "bob" : "charlie";

    let correctBytes32: string;
    try {
      correctBytes32 = cidToBytes32(record.cid);
    } catch (err) {
      console.log(`[${(i+1).toString().padStart(3)}] SKIP  ID ${campaignId} — invalid CID ${record.cid}: ${err}`);
      skipped++;
      continue;
    }

    try {
      await sendCall(signer, rawProvider, campaignsAddr, campIface, "setMetadata", [campaignId, correctBytes32]);
      ok++;
      console.log(`[${(i+1).toString().padStart(3)}] OK    ID ${campaignId} (${signerName}) ${record.cid} → ${correctBytes32.slice(0, 18)}...`);
    } catch (err) {
      failed++;
      console.log(`[${(i+1).toString().padStart(3)}] FAIL  ID ${campaignId} (${signerName}): ${String(err).slice(0, 120)}`);
    }
  }

  console.log(`\nDone: ${ok} updated, ${skipped} skipped, ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
