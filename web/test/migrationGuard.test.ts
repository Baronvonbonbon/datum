import { describe, it, expect } from "vitest";
import {
  classifyMigration,
  isMidMigration,
  midMigrationContracts,
  ZERO_ADDRESS,
  type MigrationState,
} from "../src/lib/migrationGuard";

const SRC = "0x1111111111111111111111111111111111111111";

describe("migrationGuard — U6 partial-migration classifier", () => {
  it("genesis original (migrationSource == 0) is 'live' regardless of migrated", () => {
    // migrated is false forever for a contract that was never a migration TARGET.
    expect(classifyMigration({ migrated: false, migrationSource: ZERO_ADDRESS })).to.equal("live");
    // even a (degenerate) migrated==true with zero source reads as live, not a window
    expect(classifyMigration({ migrated: true, migrationSource: ZERO_ADDRESS })).to.equal("live");
  });

  it("successor mid-copy (source set, not migrated) is the partial window", () => {
    const s: MigrationState = { migrated: false, migrationSource: SRC, migrationCursor: 50n };
    expect(classifyMigration(s)).to.equal("migrating");
    expect(isMidMigration(s)).to.equal(true);
  });

  it("successor finished (source set, migrated) is 'migrated' / live again", () => {
    const s: MigrationState = { migrated: true, migrationSource: SRC, migrationCursor: 110n };
    expect(classifyMigration(s)).to.equal("migrated");
    expect(isMidMigration(s)).to.equal(false);
  });

  it("is case-insensitive on the source address", () => {
    expect(isMidMigration({ migrated: false, migrationSource: SRC.toUpperCase() })).to.equal(true);
    expect(isMidMigration({ migrated: false, migrationSource: ZERO_ADDRESS.toUpperCase() })).to.equal(false);
  });
});

describe("midMigrationContracts — banner trigger over the router-current set", () => {
  const states: Record<string, MigrationState> = {
    "0xAAa0000000000000000000000000000000000000": { migrated: false, migrationSource: SRC },     // migrating
    "0xBBb0000000000000000000000000000000000000": { migrated: true, migrationSource: SRC },      // done
    "0xCCc0000000000000000000000000000000000000": { migrated: false, migrationSource: ZERO_ADDRESS }, // genesis
  };
  const fakeRead = async (addr: string) => states[addr];

  it("returns only the contracts in the partial window", async () => {
    const current = {
      campaigns: "0xAAa0000000000000000000000000000000000000",
      publishers: "0xBBb0000000000000000000000000000000000000",
      settlement: "0xCCc0000000000000000000000000000000000000",
    };
    expect(await midMigrationContracts(current, fakeRead)).to.deep.equal(["campaigns"]);
  });

  it("skips unset (zero / empty) addresses without reading them", async () => {
    let reads = 0;
    const counting = async (addr: string) => { reads++; return states[addr]; };
    const current = { a: ZERO_ADDRESS, b: "", campaigns: "0xAAa0000000000000000000000000000000000000" };
    const out = await midMigrationContracts(current, counting);
    expect(out).to.deep.equal(["campaigns"]);
    expect(reads).to.equal(1); // only the non-empty address was read
  });

  it("treats a non-DatumUpgradable / unreachable contract as live (no false banner)", async () => {
    const throwing = async () => { throw new Error("execution reverted"); };
    const current = { legacy: "0xDDd0000000000000000000000000000000000000" };
    expect(await midMigrationContracts(current, throwing)).to.deep.equal([]);
  });

  it("returns an empty list when nothing is migrating (no banner)", async () => {
    const current = {
      publishers: "0xBBb0000000000000000000000000000000000000",
      settlement: "0xCCc0000000000000000000000000000000000000",
    };
    expect(await midMigrationContracts(current, fakeRead)).to.deep.equal([]);
  });
});
