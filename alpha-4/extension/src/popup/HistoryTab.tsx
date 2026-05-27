// HistoryTab — popup view of the user's settled-claims history.
// Reads from chrome.storage.local; updates live via storage.onChanged.

import { useEffect, useMemo, useState } from "react";
import { formatDOT } from "@shared/dot";
import {
  earningsKey,
  emptyIndex,
  topCampaigns,
  TopSortKey,
  EarningsIndex,
} from "@shared/earningsIndex";
import { BrandChip } from "./BrandChip";
import { DEFAULT_SETTINGS } from "@shared/networks";
import { StoredSettings } from "@shared/types";
import { Contract, JsonRpcProvider } from "ethers";

const SORT_LABELS: Record<TopSortKey, string> = {
  totalUserPlanck: "Total earned",
  claimCount: "Claims",
  totalEvents: "Events",
  lastBlock: "Recently active",
};

interface Props {
  address: string | null;
}

export function HistoryTab({ address }: Props) {
  const [chainId, setChainId] = useState<number>(0);
  const [index, setIndex] = useState<EarningsIndex>(emptyIndex());
  const [sortBy, setSortBy] = useState<TopSortKey>("totalUserPlanck");
  const [webAppUrl, setWebAppUrl] = useState<string>("https://datum.javcon.io");
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  // Map: campaignId -> advertiser address. Resolved lazily from chain so the
  // chip can label both who served the ad (publisher, already in the row)
  // and who paid for it (advertiser).
  const [campaignAdvertisers, setCampaignAdvertisers] = useState<Record<string, string>>({});

  const NETWORK_CHAIN_IDS: Record<string, number> = {
    polkadotTestnet: 420420417,
    paseoEvm: 420420422,
    local: 31337,
  };
  useEffect(() => {
    chrome.storage.local.get(["settings"]).then((s) => {
      const stored = (s.settings as StoredSettings | undefined) ?? DEFAULT_SETTINGS;
      const network = stored.network ?? "polkadotTestnet";
      setChainId(NETWORK_CHAIN_IDS[network] ?? 0);
      setSettings(stored);
      setWebAppUrl("https://datum.javcon.io");
    });
  }, []);

  // Load index for the active (chainId, address)
  useEffect(() => {
    if (!address || !chainId) return;
    const key = earningsKey(chainId, address);
    chrome.storage.local.get(key).then((s) => {
      setIndex((s[key] as EarningsIndex | undefined) ?? emptyIndex());
    });

    // Live updates: re-load on storage change for our key
    const handler = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== "local") return;
      if (changes[key]) {
        setIndex((changes[key].newValue as EarningsIndex) ?? emptyIndex());
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [address, chainId]);

  const top = useMemo(() => topCampaigns(index, sortBy, 10), [index, sortBy]);
  const recent = useMemo(() => index.recent.slice(0, 10), [index]);

  // Lazily resolve campaignId → advertiser for the rows currently visible.
  // Cached in chrome.storage.local under "campaign_advertiser:<chainId>:<cid>"
  // so the same lookup doesn't run every popup open. Per-popup-open the
  // first lookup spans one RPC roundtrip per unique campaign.
  useEffect(() => {
    if (!settings.contractAddresses.campaigns || !settings.rpcUrl) return;
    const ids = new Set<string>();
    recent.forEach((r) => ids.add(r.campaignId));
    top.forEach((r) => ids.add(row(r).campaignId));
    if (ids.size === 0) return;
    const missing = Array.from(ids).filter((id) => !campaignAdvertisers[id]);
    if (missing.length === 0) return;

    let cancelled = false;
    (async () => {
      // Try cache first.
      const cacheKeys = missing.map((id) => `campaign_advertiser:${chainId}:${id}`);
      const cached = await chrome.storage.local.get(cacheKeys);
      const next: Record<string, string> = {};
      const stillMissing: string[] = [];
      for (const id of missing) {
        const k = `campaign_advertiser:${chainId}:${id}`;
        if (cached[k]) {
          next[id] = cached[k] as string;
        } else {
          stillMissing.push(id);
        }
      }

      if (stillMissing.length > 0) {
        try {
          const provider = new JsonRpcProvider(settings.rpcUrl);
          const c = new Contract(
            settings.contractAddresses.campaigns,
            ["function getCampaignAdvertiser(uint256) view returns (address)"],
            provider
          );
          await Promise.all(stillMissing.map(async (id) => {
            try {
              const addr = await c.getCampaignAdvertiser(BigInt(id));
              const a = String(addr);
              if (a && a !== "0x0000000000000000000000000000000000000000") {
                next[id] = a;
                await chrome.storage.local.set({ [`campaign_advertiser:${chainId}:${id}`]: a });
              }
            } catch { /* skip; will retry next render */ }
          }));
        } catch { /* RPC unavailable */ }
      }

      if (!cancelled && Object.keys(next).length > 0) {
        setCampaignAdvertisers((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
  }, [recent, top, chainId, settings.rpcUrl, settings.contractAddresses.campaigns]);

  function row(r: any) { return r as { campaignId: string }; }

  if (!address) {
    return (
      <div className="nano-fade" style={{ padding: 16, color: "var(--text-dim)" }}>
        Connect a wallet to view earnings history.
      </div>
    );
  }

  const hasAny = recent.length > 0 || top.length > 0;

  return (
    <div className="nano-fade" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header / link to web app for deeper history */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
          Settled-claim history
        </div>
        <a
          href={`${webAppUrl}/me/history?address=${address}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}
        >
          Deeper history →
        </a>
      </div>

      {!hasAny && (
        <div className="nano-card" style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
          No settled claims indexed yet for this wallet.<br />
          The extension scans the most recent ~3.5 days on first load. Use the
          web app's "Deeper history" view if you need a longer window.
        </div>
      )}

      {/* Recent (last 10) */}
      {recent.length > 0 && (
        <Section title="Recent">
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recent.map((r) => {
              const adv = campaignAdvertisers[r.campaignId];
              return (
                <div
                  key={`${r.txHash}:${r.logIndex}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    padding: "8px 0",
                    fontSize: 11,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "var(--text-dim)", fontFamily: "monospace" }}>
                      {r.blockTimestamp ? new Date(r.blockTimestamp * 1000).toLocaleDateString() : `#${r.blockNumber}`}
                    </span>
                    <span style={{ color: "var(--text)" }}>
                      Campaign #{r.campaignId}
                      <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>{actionTypeLabel(r.actionType)}</span>
                    </span>
                    <span style={{ color: "var(--ok)", fontFamily: "monospace" }}>
                      +{formatDOT(BigInt(r.userPaymentPlanck))}
                    </span>
                  </div>
                  {/* Brand row: who served vs. who paid. */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginLeft: 0 }}>
                    {adv && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)" }}>
                        <span style={{ minWidth: 56 }}>from:</span>
                        <BrandChip
                          address={adv}
                          size="xs"
                          rpcUrl={settings.rpcUrl}
                          addresses={settings.contractAddresses}
                          ipfsGateway={settings.ipfsGateway || "https://dweb.link/ipfs/"}
                        />
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)" }}>
                      <span style={{ minWidth: 56 }}>served by:</span>
                      <BrandChip
                        address={r.publisher}
                        size="xs"
                        rpcUrl={settings.rpcUrl}
                        addresses={settings.contractAddresses}
                        ipfsGateway={settings.ipfsGateway || "https://dweb.link/ipfs/"}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Top campaigns */}
      {top.length > 0 && (
        <Section
          title="Top campaigns"
          right={
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as TopSortKey)}
              className="nano-select"
              style={{ fontSize: 11, padding: "2px 6px" }}
            >
              {Object.entries(SORT_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          }
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            {top.map((row, i) => {
              const adv = campaignAdvertisers[row.campaignId];
              return (
                <div
                  key={row.campaignId}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    padding: "8px 0",
                    fontSize: 11,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>{i + 1}.</span>
                    <span style={{ color: "var(--text)" }}>
                      Campaign #{row.campaignId}
                      <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>
                        {row.totals.claimCount} claim{row.totals.claimCount === 1 ? "" : "s"}
                        {" · "}{row.totals.totalEvents} events
                      </span>
                    </span>
                    <span style={{ color: "var(--ok)", fontFamily: "monospace" }}>
                      {formatDOT(BigInt(row.totals.totalUserPlanck))}
                    </span>
                  </div>
                  {adv && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)", marginLeft: 28 }}>
                      <span>from:</span>
                      <BrandChip
                        address={adv}
                        size="xs"
                        rpcUrl={settings.rpcUrl}
                        addresses={settings.contractAddresses}
                        ipfsGateway={settings.ipfsGateway || "https://dweb.link/ipfs/"}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {hasAny && (
        <div style={{ color: "var(--text-muted)", fontSize: 10, padding: "0 4px" }}>
          Indexed up to block {index.lastScannedBlock.toLocaleString()}.
          {" "}Tracking {Object.keys(index.byCampaign).length} campaigns,
          {" "}{index.recent.length} recent settles.
        </div>
      )}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="nano-card" style={{ padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function actionTypeLabel(at: 0 | 1 | 2): string {
  return at === 0 ? "view" : at === 1 ? "click" : "action";
}
