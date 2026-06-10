// Off-chain orchestrator for DatumCampaigns migration.
//
// Campaigns is EIP-170-bound, so the heavy full-import loop lives in
// DatumCampaignsMigrationLogic, reached via DatumCampaigns.migrateDelegate() —
// a governance-gated DELEGATECALL passthrough. Governance (an EOA on Paseo)
// drives the migration with this script: it reads each campaign's FULL state
// from the FROZEN predecessor — core struct + pots + every scalar gate —
// ABI-encodes an importCampaignFull() call, and replays it into the new
// Campaigns via migrateDelegate().
//
// Sequence (run AFTER deploying the new Campaigns + `new.migrate(old)` and AFTER
// `old.freeze()`):
//   OLD_CAMPAIGNS=0x.. NEW_CAMPAIGNS=0x.. \
//   [MIGRATION_LOGIC=0x..] npx hardhat run scripts/migrate-campaigns.ts --network polkadotTestnet
//
// If MIGRATION_LOGIC is unset and the new Campaigns has no migrationLogic wired,
// this script deploys DatumCampaignsMigrationLogic and calls setMigrationLogic
// (lock-once) before importing.
//
// Budgets live in DatumBudgetLedger (migrated there). The legacy nested
// per-campaign publisher allowlist snapshot is NOT replayed — the canonical
// allowlist lives in DatumCampaignAllowlist (migrated separately).
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
  const logicIface = (await ethers.getContractFactory("DatumCampaignsMigrationLogic")).interface;

  if (!(await oldC.frozen())) throw new Error("predecessor must be frozen first (old.freeze())");

  const send = async (label: string, data: string) => {
    const nonce = await raw.getTransactionCount(gov.address);
    const tx = await gov.sendTransaction({ to: newAddr, data, gasLimit: GAS_LIMIT, type: 0, gasPrice: GAS_PRICE });
    console.log(`  ${label}: tx ${tx.hash}`);
    await waitForNonce(raw, gov.address, nonce);
  };

  // 1) Ensure the migration logic is wired (lock-once).
  let logicAddr = await newC.migrationLogic();
  if (logicAddr === ethers.ZeroAddress) {
    logicAddr = process.env.MIGRATION_LOGIC || "";
    if (!logicAddr) {
      console.log("Deploying DatumCampaignsMigrationLogic ...");
      const logic = await (await ethers.getContractFactory("DatumCampaignsMigrationLogic", gov)).deploy({ gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE });
      await logic.waitForDeployment();
      logicAddr = await logic.getAddress();
      console.log(`  logic @ ${logicAddr}`);
    }
    await send(`setMigrationLogic(${logicAddr})`, newC.interface.encodeFunctionData("setMigrationLogic", [logicAddr]));
  } else {
    console.log(`migrationLogic already wired @ ${logicAddr}`);
  }

  // 2) Replay every campaign's FULL state.
  const nextId: bigint = await oldC.nextCampaignId();
  console.log(`Migrating campaigns 1..${nextId - 1n}  ${oldAddr} → ${newAddr}`);

  let migrated = 0;
  for (let id = 1n; id < nextId; id++) {
    const core = await oldC.getCampaignStruct(id);
    if (core.advertiser === ethers.ZeroAddress) continue; // gap / never created

    const fullImport = {
      core,
      pots: await oldC.getCampaignPots(id),
      allowlistEnabled: await oldC.campaignAllowlistEnabled(id),
      assuranceLevel: await oldC.campaignAssuranceLevel(id),
      minStake: await oldC.campaignMinStake(id),
      requiredCategory: await oldC.campaignRequiredCategory(id),
      userEventCap: await oldC.userEventCapPerWindow(id),
      userCapWindow: await oldC.userCapWindowBlocks(id),
      minHistory: await oldC.minUserSettledHistory(id),
      minIdentityLevel: await oldC.campaignMinIdentityLevel(id),
    };
    const inner = logicIface.encodeFunctionData("importCampaignFull", [id, fullImport]);
    await send(`campaign ${id}`, newC.interface.encodeFunctionData("migrateDelegate", [inner]));
    migrated++;
  }

  // 3) Bump the id counter so post-migration creations get fresh ids.
  await send(`migrateBumpNextId(${nextId})`, newC.interface.encodeFunctionData("migrateBumpNextId", [nextId]));

  console.log(`\n✅ Migrated ${migrated} campaigns (full state: struct + pots + all gates). nextCampaignId = ${nextId}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
