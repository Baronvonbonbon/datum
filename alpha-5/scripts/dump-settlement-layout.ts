// Helper to regenerate settlement-layout.snapshot.json from the
// current compiled artifacts. Run via:
//
//   npx hardhat run scripts/dump-settlement-layout.ts
//
// Use after any *intentional* change to DatumSettlementStorage. The
// committed snapshot is the source of truth checked by
// test/settlement-layout.test.ts (CI) and deploy.ts (pre-deploy gate)
// so the dump should be reviewed in PR alongside the storage change.

import { artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Slot = {
  astId: number;
  contract: string;
  label: string;
  offset: number;
  slot: string;
  type: string;
};

async function dump(contract: string): Promise<{
  label: string;
  offset: number;
  slot: string;
  type: string;
}[]> {
  const buildInfo = await artifacts.getBuildInfo(
    `contracts/${contract}.sol:${contract}`
  );
  if (!buildInfo) {
    throw new Error(`No build info for ${contract}`);
  }
  const out = buildInfo.output.contracts as Record<
    string,
    Record<string, { storageLayout?: { storage: Slot[] } }>
  >;
  const sl = out[`contracts/${contract}.sol`]?.[contract]?.storageLayout;
  if (!sl) {
    throw new Error(
      `Storage layout missing for ${contract} -- check hardhat.config outputSelection`
    );
  }
  return sl.storage.map((s) => ({
    label: s.label,
    offset: s.offset,
    slot: s.slot,
    type: s.type,
  }));
}

async function main(): Promise<void> {
  const layout = await dump("DatumSettlement");
  const sanityA = await dump("DatumSettlementLogicA");
  const sanityB = await dump("DatumSettlementLogicB");
  if (JSON.stringify(layout) !== JSON.stringify(sanityA)) {
    throw new Error("DatumSettlement / LogicA layout already diverges -- fix that first");
  }
  if (JSON.stringify(layout) !== JSON.stringify(sanityB)) {
    throw new Error("DatumSettlement / LogicB layout already diverges -- fix that first");
  }
  const snap = {
    note:
      "Storage layout snapshot for the Settlement two-Logic split. " +
      "DatumSettlement, DatumSettlementLogicA, and DatumSettlementLogicB " +
      "must all share this exact layout (DELEGATECALL invariant). " +
      "Regenerate via scripts/dump-settlement-layout.ts after any " +
      "intentional change to DatumSettlementStorage; the file is " +
      "checked in test/settlement-layout.test.ts (CI) and at the top " +
      "of scripts/deploy.ts (pre-deploy gate).",
    contract: "DatumSettlement, DatumSettlementLogicA, DatumSettlementLogicB",
    slotCount: layout.length,
    storage: layout,
  };
  const out = path.resolve(__dirname, "..", "settlement-layout.snapshot.json");
  fs.writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");
  console.log(`Wrote ${out} -- ${layout.length} slots`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
