import { useState, useEffect } from "react";
import { useSettings } from "../context/SettingsContext";
import { midMigrationContracts } from "../lib/migrationGuard";

// U6: surface the partial-migration window in the UI. Returns the names of any
// configured contracts currently mid-upgrade (state being copied batch-by-batch,
// `migrated == false`). The Layout renders a "protocol upgrade in progress"
// banner while this is non-empty, so the dashboards don't present incomplete
// state as current. Polled on a slow interval (migrations are rare, operator-
// driven, and last minutes) rather than per-block to keep the RPC footprint low.
const POLL_MS = 60_000;

export function useMidMigration(): string[] {
  const { settings } = useSettings();
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    const addrs = settings.contractAddresses as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(addrs)) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) map[k] = v;
    }
    let cancelled = false;
    const check = () =>
      midMigrationContracts(map)
        .then((n) => { if (!cancelled) setNames(n); })
        .catch(() => {});
    check();
    const id = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [settings.contractAddresses]);

  return names;
}
