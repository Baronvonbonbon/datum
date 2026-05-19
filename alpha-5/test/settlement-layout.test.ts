/// Storage-layout snapshot test for the Settlement DELEGATECALL stack
/// (phase 8d-5).
///
/// The two-Logic split (`DatumSettlement` -> `DatumSettlementLogicA` ->
/// `DatumSettlementLogicB`) relies on every participating contract
/// declaring the exact same storage layout: each DELEGATECALL keeps the
/// caller's storage context, so any slot mismatch between the three
/// contracts corrupts state at the first cross-call.
///
/// All three inherit `DatumSettlementStorage` (the single source of
/// truth). This test compiles each contract, reads its storage layout
/// from the build-info artifact, and asserts the three layouts are
/// identical -- catching any future regression (a stray state var on a
/// child contract, a missing override, an inheritance-order change)
/// before deploy time.
import { expect } from "chai";
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

type StorageLayout = {
  storage: Slot[];
  types: Record<string, unknown> | null;
};

async function readStorageLayout(
  contractName: string
): Promise<StorageLayout> {
  const buildInfo = await artifacts.getBuildInfo(
    `contracts/${contractName}.sol:${contractName}`
  );
  if (!buildInfo) {
    throw new Error(`No build info for ${contractName}`);
  }
  const contracts = buildInfo.output.contracts as Record<
    string,
    Record<string, { storageLayout?: StorageLayout }>
  >;
  const entry = contracts[`contracts/${contractName}.sol`]?.[contractName];
  if (!entry?.storageLayout) {
    throw new Error(
      `Storage layout missing for ${contractName} -- check hardhat.config outputSelection`
    );
  }
  return entry.storageLayout;
}

/** Normalize a slot for cross-contract comparison: strip astId + contract
 *  (those legitimately differ across the three contracts since the AST
 *  nodes live in different files), keep label/offset/slot/type which are
 *  the load-bearing layout invariants. */
function normalizeSlot(slot: Slot): Omit<Slot, "astId" | "contract"> {
  return {
    label: slot.label,
    offset: slot.offset,
    slot: slot.slot,
    type: slot.type,
  };
}

describe("Settlement storage layout invariant (phase 8d-5)", function () {
  let layoutSettlement: StorageLayout;
  let layoutLogicA: StorageLayout;
  let layoutLogicB: StorageLayout;

  before(async function () {
    layoutSettlement = await readStorageLayout("DatumSettlement");
    layoutLogicA = await readStorageLayout("DatumSettlementLogicA");
    layoutLogicB = await readStorageLayout("DatumSettlementLogicB");
  });

  it("all three contracts have the same number of storage slots", function () {
    expect(layoutLogicA.storage.length).to.equal(
      layoutSettlement.storage.length,
      "LogicA slot count differs from Settlement -- new state on LogicA?"
    );
    expect(layoutLogicB.storage.length).to.equal(
      layoutSettlement.storage.length,
      "LogicB slot count differs from Settlement -- new state on LogicB?"
    );
  });

  it("DatumSettlement vs DatumSettlementLogicA: slot-by-slot identical", function () {
    const a = layoutSettlement.storage.map(normalizeSlot);
    const b = layoutLogicA.storage.map(normalizeSlot);
    expect(b).to.deep.equal(
      a,
      "Settlement / LogicA storage layout drift -- DELEGATECALL would corrupt slots."
    );
  });

  it("DatumSettlement vs DatumSettlementLogicB: slot-by-slot identical", function () {
    const a = layoutSettlement.storage.map(normalizeSlot);
    const b = layoutLogicB.storage.map(normalizeSlot);
    expect(b).to.deep.equal(
      a,
      "Settlement / LogicB storage layout drift -- DELEGATECALL would corrupt slots."
    );
  });

  it("DatumSettlementLogicA vs DatumSettlementLogicB: slot-by-slot identical", function () {
    const a = layoutLogicA.storage.map(normalizeSlot);
    const b = layoutLogicB.storage.map(normalizeSlot);
    expect(b).to.deep.equal(
      a,
      "LogicA / LogicB storage layout drift -- chained DELEGATECALL would corrupt slots."
    );
  });

  it("current layout matches settlement-layout.snapshot.json (committed)", function () {
    // Phase 8d hedge #1: the previous three tests guarantee the THREE
    // contracts agree with EACH OTHER, but they don't catch the case
    // where DatumSettlementStorage is intentionally modified (adding a
    // new field, changing a type) without the change being reviewed.
    // The committed snapshot anchors the layout: any change to it must
    // appear in a PR diff and be approved alongside the storage change.
    //
    // To regenerate after an intentional storage-base change:
    //   npx hardhat run scripts/dump-settlement-layout.ts
    const snapPath = path.resolve(
      __dirname,
      "..",
      "settlement-layout.snapshot.json"
    );
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf-8")) as {
      slotCount: number;
      storage: Omit<Slot, "astId" | "contract">[];
    };
    const current = layoutSettlement.storage.map(normalizeSlot);
    expect(current.length).to.equal(
      snap.slotCount,
      `Slot count drift: snapshot has ${snap.slotCount}, code has ${current.length}. ` +
      `If intentional, regenerate via npx hardhat run scripts/dump-settlement-layout.ts.`
    );
    expect(current).to.deep.equal(
      snap.storage,
      "Storage layout drifted from settlement-layout.snapshot.json. " +
      "If intentional, regenerate via npx hardhat run scripts/dump-settlement-layout.ts. " +
      "If not, you just changed Settlement's storage layout -- existing deployments " +
      "would be corrupted by an upgrade."
    );
  });
});
