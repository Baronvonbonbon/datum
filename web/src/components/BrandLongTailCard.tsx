// BrandLongTailCard — renders the off-chain JSON pointed to by
// DatumBrandRegistry.profileHash. Fetches lazily, sanitizes, displays
// description + socials + additional-addresses + OG snapshot.
//
// Drops into either explorer profile page (Publisher / Advertiser) below
// the BrandChip header. Renders nothing when the address has no
// long-tail JSON set — the page degrades gracefully.

import { useEffect, useState } from "react";
import { useContracts } from "../hooks/useContracts";
import { useSettings } from "../context/SettingsContext";
import { fetchBrandLongTail, EMPTY_LONGTAIL, BrandProfileLongTail } from "../lib/brandProfileJson";
import { AddressDisplay } from "./AddressDisplay";

export function BrandLongTailCard({ address }: { address: string }) {
  const contracts = useContracts();
  const { settings } = useSettings();
  const [body, setBody] = useState<BrandProfileLongTail>(EMPTY_LONGTAIL);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address || !settings.contractAddresses.brandRegistry) return;
    let cancelled = false;
    setLoading(true);
    fetchBrandLongTail({
      addr: address,
      registryAddr: settings.contractAddresses.brandRegistry,
      ipfsGateway: settings.ipfsGateway || "https://ipfs.io",
      provider: contracts.readProvider as any,
    }).then((b) => {
      if (cancelled) return;
      setBody(b);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [address, settings.contractAddresses.brandRegistry, settings.ipfsGateway, contracts.readProvider]);

  // Detect whether any field is populated. If not, render nothing.
  const hasContent =
    !!body.description ||
    !!body.support?.email || !!body.support?.url ||
    !!body.socials?.twitter || !!body.socials?.github ||
    !!body.socials?.mastodon || !!body.socials?.discord ||
    !!body.socials?.matrix || !!body.socials?.bluesky ||
    (body.socials?.other?.length ?? 0) > 0 ||
    (body.additionalAddresses?.length ?? 0) > 0 ||
    !!body.ogSnapshot?.title;

  if (loading) {
    return (
      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading brand details…</div>
      </section>
    );
  }
  if (!hasContent) return null;

  return (
    <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
      <h2 style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>
        About
      </h2>

      {body.description && (
        <p style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.55, marginTop: 0, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {body.description}
        </p>
      )}

      {(body.support?.email || body.support?.url) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Support</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
            {body.support.email && (
              <a href={`mailto:${body.support.email}`} style={{ color: "var(--accent)" }}>
                {body.support.email}
              </a>
            )}
            {body.support.url && (
              <a href={body.support.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                {body.support.url} ↗
              </a>
            )}
          </div>
        </div>
      )}

      {body.socials && Object.values(body.socials).some(Boolean) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Socials</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {body.socials.twitter && <SocialChip label="Twitter" url={normalizeUrl(body.socials.twitter, "https://twitter.com/")} />}
            {body.socials.github && <SocialChip label="GitHub" url={normalizeUrl(body.socials.github, "https://github.com/")} />}
            {body.socials.mastodon && <SocialChip label="Mastodon" url={body.socials.mastodon} />}
            {body.socials.discord && <SocialChip label="Discord" url={body.socials.discord} />}
            {body.socials.matrix && <SocialChip label="Matrix" url={body.socials.matrix} />}
            {body.socials.bluesky && <SocialChip label="Bluesky" url={normalizeUrl(body.socials.bluesky, "https://bsky.app/profile/")} />}
            {(body.socials.other ?? []).map((o, i) => (
              <SocialChip key={i} label={o.label} url={o.url} />
            ))}
          </div>
        </div>
      )}

      {(body.additionalAddresses?.length ?? 0) > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Additional addresses</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {body.additionalAddresses!.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                <AddressDisplay address={a.addr} chars={6} />
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{a.label}</span>
                {a.purpose && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>· {a.purpose}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {body.ogSnapshot && (body.ogSnapshot.title || body.ogSnapshot.description) && (
        <div style={{ marginTop: 12, padding: 10, background: "var(--bg-raised)", borderRadius: 4, border: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>Site snapshot</div>
          {body.ogSnapshot.title && (
            <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600 }}>{body.ogSnapshot.title}</div>
          )}
          {body.ogSnapshot.description && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>{body.ogSnapshot.description}</div>
          )}
        </div>
      )}
    </section>
  );
}

function SocialChip({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="nano-badge"
      style={{ color: "var(--accent)", textDecoration: "none", fontSize: 11, padding: "2px 8px" }}
    >
      {label}
    </a>
  );
}

function normalizeUrl(value: string, prefix: string): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return prefix + value.replace(/^@/, "");
}
