// migrationGuard — U6: detect the partial-migration window (RUNBOOK Phase 2,
// PRE-MAINNET-CHECKLIST §U6). During a U3 gas-paginated upgrade a router-current
// contract is populated batch-by-batch; until the final batch its state is
// INCOMPLETE and off-chain consumers (webapp, relay, indexer, extension) must
// NOT trust "current" reads. This module is the shared primitive that turns the
// on-chain DatumUpgradable signal into a clear phase.
//
// Subtlety: `migrated == false` alone is ambiguous — a freshly-deployed GENESIS
// contract has migrated == false forever (it was never a migration TARGET). The
// correct mid-migration signal is `migrationSource != 0 && migrated == false`:
// a successor that started copying state but hasn't finished. Paginated (U3)
// contracts also expose `migrationCursor` for a progress readout.

import { callContract } from "./contractRead";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type MigrationState = {
  migrated: boolean;
  migrationSource: string;
  /** Present only on U3-paginated contracts (e.g. DatumPublishers). */
  migrationCursor?: bigint;
};

export type MigrationPhase =
  | "live"       // genesis original (never a migration target) — fully usable
  | "migrating"  // successor mid-copy — PARTIAL WINDOW, do not trust reads
  | "migrated";  // successor finished copying — fully usable again

/**
 * Pure classifier. No network. See the module header for the genesis vs
 * mid-migration distinction.
 */
export function classifyMigration(s: MigrationState): MigrationPhase {
  const isTarget = !!s.migrationSource && s.migrationSource.toLowerCase() !== ZERO_ADDRESS;
  if (!isTarget) return "live";
  return s.migrated ? "migrated" : "migrating";
}

/** True only during the partial-migration window (state incomplete). */
export function isMidMigration(s: MigrationState): boolean {
  return classifyMigration(s) === "migrating";
}

const MIGRATION_ABI = [
  "function migrated() view returns (bool)",
  "function migrationSource() view returns (address)",
  "function migrationCursor() view returns (uint256)",
];

/**
 * Read a DatumUpgradable contract's migration state on-chain. `migrationCursor`
 * is optional — only U3-paginated contracts expose it (others are single-shot).
 */
export async function readMigrationState(address: string): Promise<MigrationState> {
  const [migrated, migrationSource] = await Promise.all([
    callContract<boolean>({ address, abi: MIGRATION_ABI, method: "migrated" }),
    callContract<string>({ address, abi: MIGRATION_ABI, method: "migrationSource" }),
  ]);
  let migrationCursor: bigint | undefined;
  try {
    migrationCursor = await callContract<bigint>({ address, abi: MIGRATION_ABI, method: "migrationCursor" });
  } catch {
    // single-shot contract — no cursor surface
  }
  return { migrated, migrationSource, migrationCursor };
}

/**
 * Given the router's current name→address map, return the names of any contracts
 * currently in the partial-migration window. The webapp surfaces a "protocol
 * upgrade in progress" banner when this is non-empty; the relay/indexer pause
 * writes through those contracts until it clears.
 *
 * `read` is injectable for testing. Contracts that don't implement the
 * DatumUpgradable surface (reads throw) are treated as "live" and skipped.
 */
export async function midMigrationContracts(
  current: Record<string, string>,
  read: (address: string) => Promise<MigrationState> = readMigrationState,
): Promise<string[]> {
  const names: string[] = [];
  await Promise.all(
    Object.entries(current).map(async ([name, address]) => {
      if (!address || address.toLowerCase() === ZERO_ADDRESS) return;
      try {
        if (isMidMigration(await read(address))) names.push(name);
      } catch {
        // not DatumUpgradable / unreachable → treat as live
      }
    }),
  );
  return names.sort();
}
