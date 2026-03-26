import { useState, useEffect } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useSettings } from "../../context/SettingsContext";
import { AddressDisplay } from "../../components/AddressDisplay";
import { bitmaskToCategories } from "../../components/CategoryPicker";
import { CATEGORY_NAMES } from "@shared/types";

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
      const logs = await contracts.publishers.queryFilter(filter);
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
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 700 }}>Publishers</h1>
        <button onClick={load} style={btnStyle}>Refresh</button>
      </div>

      {error && <div style={errorBox}>{error}</div>}
      {loading && <div style={{ color: "#555" }}>Loading publishers...</div>}

      {!loading && publishers.length === 0 && !error && (
        <div style={{ color: "#555", padding: 20, textAlign: "center" }}>No publishers registered yet.</div>
      )}

      {publishers.map((pub) => {
        const categories = bitmaskToCategories(pub.categoryBitmask);
        return (
          <div key={pub.address} style={{
            background: "#0d0d18",
            border: `1px solid ${pub.blocked ? "#3a1a1a" : "#1a1a2e"}`,
            borderRadius: 8,
            padding: 16,
            marginBottom: 10,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div>
                <AddressDisplay address={pub.address} chars={8} style={{ fontSize: 14, color: "#e0e0e0" }} />
                {pub.blocked && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: "#ff6060", fontWeight: 600 }}>BLOCKED</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 13, color: "#888" }}>
                <span>Take: <span style={{ color: "#e0e0e0" }}>{(pub.takeRateBps / 100).toFixed(0)}%</span></span>
                <span>Allowlist: <span style={{ color: pub.allowlistEnabled ? "#c0c060" : "#555" }}>{pub.allowlistEnabled ? "On" : "Off"}</span></span>
              </div>
            </div>
            {categories.size > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {[...categories].map((id) => (
                  <span key={id} style={{
                    padding: "2px 6px", background: "#1a1a2e", border: "1px solid #2a2a4a",
                    borderRadius: 3, fontSize: 11, color: "#888",
                  }}>
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

const btnStyle: React.CSSProperties = { padding: "5px 12px", background: "#111", border: "1px solid #2a2a4a", borderRadius: 4, color: "#888", fontSize: 12, cursor: "pointer" };
const errorBox: React.CSSProperties = { padding: "10px 14px", background: "#1a0a0a", border: "1px solid #3a1a1a", borderRadius: 6, color: "#ff8080", fontSize: 13, marginBottom: 12 };
