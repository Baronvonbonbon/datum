import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useSettings } from "../../context/SettingsContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { bitmaskToCategories } from "../../components/CategoryPicker";
import { CATEGORY_NAMES } from "@shared/types";
import { getExplorerUrl } from "@shared/networks";
import { queryFilterBounded } from "@shared/eventQuery";

interface PublisherRow {
  address: string;
  takeRateBps: number;
  categoryBitmask: bigint;
  allowlistEnabled: boolean;
  blocked: boolean;
}

export function Publishers() {
  const contracts = useContracts();
  const { settings } = useSettings();
  const EXPLORER = getExplorerUrl(settings.network);
  const [publishers, setPublishers] = useState<PublisherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.contractAddresses.publishers) return;
    load();
  }, [settings.contractAddresses.publishers]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Get publisher addresses from PublisherRegistered events
      const filter = contracts.publishers.filters.PublisherRegistered();
      const logs = await queryFilterBounded(contracts.publishers, filter);
      const addresses = [...new Set(logs.map((l: any) => l.args?.publisher as string).filter(Boolean))];

      const rows = await Promise.all(addresses.map(async (addr) => {
        try {
          const data = await contracts.publishers.getPublisher(addr);
          const allowlist = await contracts.publishers.allowlistEnabled(addr).catch(() => false);
          const blocked = await contracts.publishers.isBlocked(addr).catch(() => false);
          return {
            address: addr,
            takeRateBps: Number(data.takeRateBps ?? data[1] ?? 0),
            categoryBitmask: BigInt(data.categoryBitmask ?? data[2] ?? 0),
            allowlistEnabled: Boolean(allowlist),
            blocked: Boolean(blocked),
          };
        } catch {
          return null;
        }
      }));

      setPublishers(rows.filter(Boolean) as PublisherRow[]);
    } catch (err) {
      setError(String(err).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="nano-fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700 }}>Publishers</h1>
        <button onClick={load} className="nano-btn" style={{ fontSize: 12 }}>Refresh</button>
      </div>

      {error && <div className="nano-info nano-info--error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && <div style={{ color: "var(--text-muted)" }}>Loading publishers...</div>}

      {!loading && publishers.length === 0 && !error && (
        <div style={{ color: "var(--text-muted)", padding: 20, textAlign: "center" }}>No publishers registered yet.</div>
      )}

      {publishers.map((pub) => {
        const categories = bitmaskToCategories(pub.categoryBitmask);
        return (
          <div key={pub.address} className="nano-card" style={{
            border: `1px solid ${pub.blocked ? "rgba(252,165,165,0.3)" : "var(--border)"}`,
            padding: 16,
            marginBottom: 10,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div>
                <AddressDisplay address={pub.address} chars={8} explorerBase={EXPLORER} style={{ fontSize: 14, color: "var(--text-strong)" }} />
                {pub.blocked && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: "var(--error)", fontWeight: 600 }}>BLOCKED</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 13, color: "var(--text)" }}>
                <span>Take: <span style={{ color: "var(--text-strong)" }}>{(pub.takeRateBps / 100).toFixed(0)}%</span></span>
                <span>Allowlist: <span style={{ color: pub.allowlistEnabled ? "var(--warn)" : "var(--text-muted)" }}>{pub.allowlistEnabled ? "On" : "Off"}</span></span>
              </div>
            </div>
            {categories.size > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {[...categories].map((id) => (
                  <span key={id} className="nano-badge">
                    {CATEGORY_NAMES[id] ?? `Cat ${id}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
