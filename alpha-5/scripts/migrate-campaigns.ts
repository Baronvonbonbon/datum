// Off-chain orchestrator for DatumCampaigns migration.
//
// Campaigns is EIP-170-bound, so an on-chain migrator contract (which would need
// governor-delegation code) won't fit. Instead governance — an EOA on Paseo —
// drives the migration via this script: it reads each campaign's struct + scalar
// gates from the FROZEN predecessor and replays them into the new Campaigns
// through the gated write hooks (migrateImportCampaign / migrateBumpNextId).
//
// Sequence (run AFTER deploying the new Campaigns + `new.migrate(old)` and AFTER
// `old.freeze()`):
//   OLD_CAMPAIGNS=0x.. NEW_CAMPAIGNS=0x.. npx hardhat run scripts/migrate-campaigns.ts --network polkadotTestnet
//
// CAVEAT: only the core struct + assurance/minStake/identityLevel gates migrate.
// Nested/array side-state (pots, per-campaign allowlist snapshot, tags,
// requiredCategory, userEventCap, minUserSettledHistory) is NOT replayed — there
// is no EIP-170 headroom for more import code. Until Campaigns is slimmed (the
// carve-out remerge), those must be re-set post-migration by advertisers or
// reconstructed off-chain. Budgets live in DatumBudgetLedger (migrated there).
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";

async function waitForNonce(p: JsonRpcProvider, a: string, prev: number, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if ((await p.getTransactionCount(a)) > prev) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("nonce did not advance after 120s");
}

async function main() {
  const oldAddr = process.env.OLD_CAMPAIGNS;
  const newAddr = process.env.NEW_CAMPAIGNS;
  if (!oldAddr || !newAddr) throw new Error("set OLD_CAMPAIGNS and NEW_CAMPAIGNS");

  const net = await ethers.provider.getNetwork();
  const isPaseo = net.chainId === 420420417n;
  const rpcUrl = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io";
  const raw = new JsonRpcProvider(rpcUrl);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("set DEPLOYER_PRIVATE_KEY (must be the router governor)");
  const gov = new Wallet(key, raw);
  const GAS_LIMIT = isPaseo ? 500_000_000n : 15_000_000n;
  const GAS_PRICE = isPaseo ? 1_000_000_000_000n : 1_000_000_000n;

  const oldC = await ethers.getContractAt("DatumCampaigns", oldAddr);
  const newC = await ethers.getContractAt("DatumCampaigns", newAddr, gov);

  if (!(await oldC.frozen())) throw new Error("predecessor must be frozen first (old.freeze())");

  const nextId: bigint = await oldC.nextCampaignId();
  console.log(`Migrating campaigns 1..${nextId - 1n}  ${oldAddr} → ${newAddr}`);

  let migrated = 0;
  for (let id = 1n; id < nextId; id++) {
    const c = await oldC.getCampaignStruct(id);
    if (c.advertiser === ethers.ZeroAddress) continue; // gap / never created
    const assurance = await oldC.campaignAssuranceLevel(id);
    const minStake = await oldC.campaignMinStake(id);
    const idLevel = await oldC.campaignMinIdentityLevel(id);

    const data = newC.interface.encodeFunctionData("migrateImportCampaign", [id, c, assurance, minStake, idLevel]);
    const nonce = await raw.getTransactionCount(gov.address);
    const tx = await gov.sendTransaction({ to: newAddr, data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    console.log(`  campaign ${id}: tx ${tx.hash}`);
    await waitForNonce(raw, gov.address, nonce);
    migrated++;
  }

  // Bump the id counter so post-migration creations get fresh ids.
  {
    const data = newC.interface.encodeFunctionData("migrateBumpNextId", [nextId]);
    const nonce = await raw.getTransactionCount(gov.address);
    const tx = await gov.sendTransaction({ to: newAddr, data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    console.log(`  migrateBumpNextId(${nextId}): tx ${tx.hash}`);
    await waitForNonce(raw, gov.address, nonce);
  }

  console.log(`\n✅ Migrated ${migrated} campaigns. nextCampaignId set to ${nextId}.`);
  console.log(`   Reminder: re-set per-campaign pots/allowlist/tags/caps where used (EIP-170 carve-out pending).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
