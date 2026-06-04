/// Storage-layout invariant for the DatumCampaigns migration DELEGATECALL.
///
/// DatumCampaigns.migrateDelegate() DELEGATECALLs DatumCampaignsMigrationLogic,
/// which keeps the caller's storage context. The Logic therefore MUST declare
/// the exact same storage layout as DatumCampaigns or its writes land in the
/// wrong slots and corrupt campaign state.
///
/// Unlike the Settlement split (which shares DatumSettlementStorage), the Logic
/// duplicates the layout: IDatumCampaigns names 8 of these fields as interface
/// getters, so a shared interface-free base would force DatumCampaigns to drop
/// the interface (cascading qualification + a createCampaign stack blow-up). The
/// duplication is deliberate and THIS test is what makes it safe — any drift
/// between DatumCampaigns' storage and the Logic's copy fails here at CI time,
/// before it can corrupt a live deployment.
import { expect } from "chai";
import { artifacts } from "hardhat";

type Slot = {
  astId: number;
  contract: string;
  label: string;
  offset: number;
  slot: string;
  type: string;
};

type StorageLayout = { storage: Slot[]; types: Record<string, unknown> | null };

async function readStorageLayout(contractName: string): Promise<StorageLayout> {
  const buildInfo = await artifacts.getBuildInfo(
    `contracts/${contractName}.sol:${contractName}`
  );
  if (!buildInfo) throw new Error(`No build info for ${contractName}`);
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

/** Strip build-state noise (astId, owning contract, the `(...)<digits>` type
 *  suffix solc emits per compilation unit). The load-bearing fields — slot
 *  index, byte offset, label, base type — survive. */
function normalizeSlot(slot: Slot): Omit<Slot, "astId" | "contract"> {
  return {
    label: slot.label,
    offset: slot.offset,
    slot: slot.slot,
    type: slot.type.replace(/\)\d+/g, ")"),
  };
}

describe("DatumCampaigns migration storage-layout invariant", function () {
  let layoutCampaigns: StorageLayout;
  let layoutLogic: StorageLayout;

  before(async function () {
    layoutCampaigns = await readStorageLayout("DatumCampaigns");
    layoutLogic = await readStorageLayout("DatumCampaignsMigrationLogic");
  });

  it("both contracts have the same number of storage slots", function () {
    expect(layoutLogic.storage.length).to.equal(
      layoutCampaigns.storage.length,
      "MigrationLogic slot count differs from DatumCampaigns -- a field was " +
        "added/removed/reordered on one but not the other."
    );
  });

  it("DatumCampaigns vs DatumCampaignsMigrationLogic: slot-by-slot identical", function () {
    const a = layoutCampaigns.storage.map(normalizeSlot);
    const b = layoutLogic.storage.map(normalizeSlot);
    expect(b).to.deep.equal(
      a,
      "Campaigns / MigrationLogic storage layout drift -- migrateDelegate() " +
        "DELEGATECALL would write the wrong slots and corrupt campaign state."
    );
  });
});
