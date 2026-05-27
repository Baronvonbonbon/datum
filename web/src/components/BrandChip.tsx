// BrandChip — addresses with branding, verification, and identicon fallback.
//
// Replaces <AddressDisplay> everywhere a brand/role identity is shown.
// Falls back gracefully: when no brand is registered, renders the
// deterministic identicon + truncated address. When a brand is set, shows
// the logo + name and (on hover) the verification badge + homepage link.
//
// Three size variants:
//   - "sm" — 18px logo, name + truncated addr inline. Default for lists.
//   - "md" — 28px logo, name on top + addr below. Default for cards.
//   - "lg" — 48px logo, name + homepage + verification badge. Profile pages.
//
// Verification badges (rendered on the chip, with tooltip detail on hover):
//   ✓ Council  — bg-emerald, brightest
//   ✓ Identity — bg-blue
//   ✓ Domain   — bg-violet
//   · Self     — muted, no badge by default
//   ⚠ Revoked  — red, shown as warning even if other badges would apply
//
// Caches the hot fields aggressively (see lib/brandCache.ts). Domain
// verification is opt-in via the `verifyDomain` prop because it costs
// an off-chain fetch per render.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../context/SettingsContext";
import { useContracts } from "../hooks/useContracts";
import {
  fetchBrand,
  fetchCouncilVerified,
  fetchIdentityVerified,
  fetchDomainVerified,
  deriveLevel,
  type BrandHotFields,
  type VerificationLevel,
} from "../lib/brandCache";
import { identiconDataUrl } from "../lib/identicon";

type Size = "sm" | "md" | "lg";

interface BrandChipProps {
  address: string;
  size?: Size;
  /** When true, attempt /.well-known/datum-verify.json lookup. Slow; only
   *  use on profile pages and the Cosign review panel. */
  verifyDomain?: boolean;
  /** Optional link target for the chip. If omitted, the chip is non-link;
   *  if set to "auto", links to /publishers/:address or /advertisers/:address
   *  based on the caller-passed role. */
  linkTo?: string;
  /** Role hint used for the "auto" link target. Ignored if linkTo is set. */
  role?: "publisher" | "advertiser" | "user" | "council";
  /** Layout style: "inline" packs everything on one line; "stacked" puts
   *  name above address (default for md/lg). */
  layout?: "inline" | "stacked";
}

const SIZES: Record<Size, { logo: number; nameSize: number; addrSize: number; badgeSize: number }> = {
  sm: { logo: 18, nameSize: 12, addrSize: 10, badgeSize: 10 },
  md: { logo: 28, nameSize: 13, addrSize: 11, badgeSize: 11 },
  lg: { logo: 48, nameSize: 16, addrSize: 12, badgeSize: 12 },
};

const ZERO_HASH = "0x" + "0".repeat(64);

function logoUrl(cid: string, ipfsGateway: string): string | null {
  if (!cid || cid === ZERO_HASH) return null;
  // The on-chain CID is a raw 32-byte digest. We render with the configured
  // IPFS gateway; the multihash + codec are inferred (sha2-256 + raw).
  // For now we just pass the hex digest through to a known gateway-friendly
  // form: the multibase-prefix-less variant. Most gateways accept either
  // bafyk… or the bare digest with `/ipfs/`; we fall back to `f`-prefixed
  // CIDv1 hex (multibase prefix `f`).
  const hex = cid.replace(/^0x/, "");
  if (hex.length !== 64) return null;
  return `${ipfsGateway.replace(/\/$/, "")}/ipfs/f01551220${hex}`;
}

export function BrandChip({
  address,
  size = "sm",
  verifyDomain = false,
  linkTo,
  role,
  layout,
}: BrandChipProps) {
  const { settings } = useSettings();
  const contracts = useContracts();
  const sizeSpec = SIZES[size];
  const effectiveLayout = layout ?? (size === "sm" ? "inline" : "stacked");

  const [hot, setHot] = useState<BrandHotFields>({ name: "", logoCid: ZERO_HASH, homepage: "", brandColor: 0, lastUpdateBlock: 0 });
  const [council, setCouncil] = useState<{ verified: boolean; revoked: boolean }>({ verified: false, revoked: false });
  const [identityOK, setIdentityOK] = useState<boolean>(false);
  const [domainOK, setDomainOK] = useState<boolean>(false);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = contracts.readProvider;
        const addrs = settings.contractAddresses;
        const h = await fetchBrand(addrs.brandRegistry, address, provider as any);
        if (cancelled) return;
        setHot(h);
        const [cv, idOk] = await Promise.all([
          fetchCouncilVerified(addrs.brandCurator, address, provider as any),
          fetchIdentityVerified(addrs.peopleChainIdentity, address, provider as any),
        ]);
        if (cancelled) return;
        setCouncil(cv);
        setIdentityOK(idOk);
        if (verifyDomain && h.homepage) {
          const ok = await fetchDomainVerified(h.homepage, address);
          if (cancelled) return;
          setDomainOK(ok);
        }
      } catch {
        /* keep defaults */
      }
    })();
    return () => { cancelled = true; };
  }, [address, settings.contractAddresses, contracts.readProvider, verifyDomain]);

  const hasBrand = useMemo(() => Boolean(hot.name || hot.homepage || (hot.logoCid && hot.logoCid !== ZERO_HASH)), [hot]);
  const level: VerificationLevel = useMemo(() => deriveLevel({
    hasBrand,
    councilVerified: council.verified,
    revoked: council.revoked,
    identityVerified: identityOK,
    domainVerified: domainOK,
  }), [hasBrand, council, identityOK, domainOK]);

  const shortAddr = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const ipfsGateway = settings.ipfsGateway || "https://ipfs.io";
  const logoSrc = logoUrl(hot.logoCid, ipfsGateway) ?? identiconDataUrl(address || "0x", sizeSpec.logo);

  // Color accent — only applied if the brand opted in (color != 0).
  const accent = hot.brandColor && hot.brandColor !== 0
    ? `#${hot.brandColor.toString(16).padStart(6, "0")}`
    : "var(--border)";

  // Auto-resolve linkTo when caller passed role="auto"-ish.
  const resolvedHref = (() => {
    if (linkTo) return linkTo;
    if (role === "publisher") return `/publishers/${address}`;
    if (role === "advertiser") return `/advertisers/${address}`;
    return undefined;
  })();

  const inner = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
      <img
        src={logoSrc}
        alt=""
        width={sizeSpec.logo}
        height={sizeSpec.logo}
        style={{
          width: sizeSpec.logo, height: sizeSpec.logo,
          borderRadius: 4, border: `1px solid ${accent}`,
          objectFit: "cover", flexShrink: 0,
          background: "var(--bg-raised)",
        }}
        // Failed logo fetch → swap to identicon. Use a ref-less inline handler
        // so the swap is local and we don't re-run the effect.
        onError={(e) => {
          const el = e.currentTarget;
          el.onerror = null;
          el.src = identiconDataUrl(address || "0x", sizeSpec.logo);
        }}
      />
      <span style={{ display: "flex", flexDirection: effectiveLayout === "inline" ? "row" : "column", gap: effectiveLayout === "inline" ? 8 : 0, alignItems: effectiveLayout === "inline" ? "center" : "flex-start", minWidth: 0 }}>
        {hot.name ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: council.revoked ? "var(--text-muted)" : "var(--text-strong)", fontSize: sizeSpec.nameSize, fontWeight: 600, lineHeight: 1.2, minWidth: 0 }}>
            <span style={{ textDecoration: council.revoked ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{hot.name}</span>
            <VerifyBadge level={level} size={sizeSpec.badgeSize} />
            {council.revoked && (
              <span title="This brand has been flagged by the Council. Use caution." style={{ color: "var(--warn)", fontSize: sizeSpec.badgeSize, flexShrink: 0 }}>⚠</span>
            )}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)", fontSize: sizeSpec.nameSize, fontStyle: "italic", lineHeight: 1.2 }}>
            (unregistered)
          </span>
        )}
        <span style={{ color: "var(--text-muted)", fontSize: sizeSpec.addrSize, fontFamily: "var(--font-mono, ui-monospace)", flexShrink: 0 }}>
          {shortAddr}
        </span>
      </span>
      {size === "lg" && hot.homepage && (
        <a
          href={hot.homepage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ color: "var(--accent)", fontSize: 11, textDecoration: "none", marginLeft: 8 }}
        >
          {prettyDomain(hot.homepage)} ↗
        </a>
      )}
    </span>
  );

  if (resolvedHref) {
    return (
      <Link to={resolvedHref} style={{ textDecoration: "none", color: "inherit" }}>
        {inner}
      </Link>
    );
  }
  return inner;
}

function VerifyBadge({ level, size }: { level: VerificationLevel; size: number }) {
  if (level === "council") {
    return (
      <span
        title="Council-verified brand"
        style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "0 5px", borderRadius: 8, fontSize: size, color: "#0a3", background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.35)" }}
      >
        ✓ Council
      </span>
    );
  }
  if (level === "identity") {
    return (
      <span
        title="Brand owner has a verified Polkadot People Chain identity"
        style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "0 5px", borderRadius: 8, fontSize: size, color: "#48a", background: "rgba(96,165,250,0.10)", border: "1px solid rgba(96,165,250,0.30)" }}
      >
        ✓ ID
      </span>
    );
  }
  if (level === "domain") {
    return (
      <span
        title="Domain ownership verified via /.well-known/datum-verify.json"
        style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "0 5px", borderRadius: 8, fontSize: size, color: "#96f", background: "rgba(167,139,250,0.10)", border: "1px solid rgba(167,139,250,0.30)" }}
      >
        ✓ Domain
      </span>
    );
  }
  return null;
}

function prettyDomain(homepage: string): string {
  try {
    return new URL(homepage).host;
  } catch {
    return homepage.replace(/^https?:\/\//, "").split("/")[0];
  }
}
