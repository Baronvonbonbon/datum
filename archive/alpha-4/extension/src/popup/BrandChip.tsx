// BrandChip — extension version. Renders logo + name + verify badge
// next to a truncated address. Identicon fallback when no brand set.
//
// Differences vs the webapp chip:
//   - No react-router; no linking out of the popup.
//   - chrome.storage-backed cache via shared/brandCache.
//   - Provider is supplied by the caller (popup creates one from
//     settings.rpcUrl), so this component is decoupled from a hook.

import { useEffect, useMemo, useState } from "react";
import { JsonRpcProvider } from "ethers";
import {
  fetchBrand,
  fetchCouncilVerified,
  fetchIdentityVerified,
  fetchDomainVerified,
  deriveLevel,
  type BrandHotFields,
  type VerificationLevel,
} from "@shared/brandCache";
import { identiconDataUrl } from "@shared/identicon";
import type { ContractAddresses } from "@shared/types";

type Size = "xs" | "sm" | "md";

interface Props {
  address: string;
  size?: Size;
  rpcUrl: string;
  addresses: ContractAddresses;
  ipfsGateway: string;
  verifyDomain?: boolean;
  /** Optional override label that replaces the auto-fetched name. Useful
   *  when the chip is rendered next to a role label that already implies
   *  the role (e.g. "Publisher: <chip>"). */
  labelFallback?: string;
}

const SIZES: Record<Size, { logo: number; nameSize: number; addrSize: number; badgeSize: number }> = {
  xs: { logo: 14, nameSize: 11, addrSize: 9,  badgeSize: 9  },
  sm: { logo: 18, nameSize: 12, addrSize: 10, badgeSize: 10 },
  md: { logo: 24, nameSize: 13, addrSize: 11, badgeSize: 10 },
};

const ZERO_HASH = "0x" + "0".repeat(64);

function logoUrl(cid: string, gateway: string): string | null {
  if (!cid || cid === ZERO_HASH) return null;
  const hex = cid.replace(/^0x/, "");
  if (hex.length !== 64) return null;
  return `${gateway.replace(/\/$/, "")}/ipfs/f01551220${hex}`;
}

export function BrandChip({
  address,
  size = "sm",
  rpcUrl,
  addresses,
  ipfsGateway,
  verifyDomain = false,
  labelFallback,
}: Props) {
  const s = SIZES[size];
  const [hot, setHot] = useState<BrandHotFields>({ name: "", logoCid: ZERO_HASH, homepage: "", brandColor: 0, lastUpdateBlock: 0 });
  const [council, setCouncil] = useState<{ verified: boolean; revoked: boolean }>({ verified: false, revoked: false });
  const [identityOK, setIdentityOK] = useState(false);
  const [domainOK, setDomainOK] = useState(false);

  useEffect(() => {
    if (!address || !rpcUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = new JsonRpcProvider(rpcUrl);
        const h = await fetchBrand(addresses.brandRegistry, address, provider);
        if (cancelled) return;
        setHot(h);
        const [cv, idOk] = await Promise.all([
          fetchCouncilVerified(addresses.brandCurator, address, provider),
          fetchIdentityVerified(addresses.peopleChainIdentity, address, provider),
        ]);
        if (cancelled) return;
        setCouncil(cv);
        setIdentityOK(idOk);
        if (verifyDomain && h.homepage) {
          const ok = await fetchDomainVerified(h.homepage, address);
          if (!cancelled) setDomainOK(ok);
        }
      } catch { /* fall through */ }
    })();
    return () => { cancelled = true; };
  }, [address, rpcUrl, addresses.brandRegistry, addresses.brandCurator, addresses.peopleChainIdentity, verifyDomain]);

  const hasBrand = useMemo(() => Boolean(hot.name || hot.homepage || (hot.logoCid && hot.logoCid !== ZERO_HASH)), [hot]);
  const level: VerificationLevel = useMemo(
    () => deriveLevel({ hasBrand, councilVerified: council.verified, revoked: council.revoked, identityVerified: identityOK, domainVerified: domainOK }),
    [hasBrand, council, identityOK, domainOK]
  );

  const shortAddr = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const logoSrc = logoUrl(hot.logoCid, ipfsGateway) ?? identiconDataUrl(address || "0x", s.logo);
  const accent = hot.brandColor && hot.brandColor !== 0
    ? `#${hot.brandColor.toString(16).padStart(6, "0")}`
    : "var(--border)";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%" }}>
      <img
        src={logoSrc}
        alt=""
        width={s.logo}
        height={s.logo}
        style={{
          width: s.logo, height: s.logo,
          borderRadius: 3, border: `1px solid ${accent}`,
          objectFit: "cover", flexShrink: 0,
          background: "var(--bg-raised)",
        }}
        onError={(e) => {
          const el = e.currentTarget;
          el.onerror = null;
          el.src = identiconDataUrl(address || "0x", s.logo);
        }}
      />
      <span style={{ display: "inline-flex", flexDirection: "column", minWidth: 0, lineHeight: 1.15 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: council.revoked ? "var(--text-muted)" : "var(--text-strong)", fontSize: s.nameSize, fontWeight: 600, minWidth: 0 }}>
          <span style={{
            textDecoration: council.revoked ? "line-through" : "none",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140,
          }}>
            {hot.name || labelFallback || ""}
          </span>
          <VerifyBadge level={level} size={s.badgeSize} />
          {council.revoked && (
            <span title="Council-flagged" style={{ color: "var(--warn)", fontSize: s.badgeSize, flexShrink: 0 }}>⚠</span>
          )}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: s.addrSize, fontFamily: "monospace", flexShrink: 0 }}>
          {shortAddr}
        </span>
      </span>
    </span>
  );
}

function VerifyBadge({ level, size }: { level: VerificationLevel; size: number }) {
  const base = {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    padding: "0 4px",
    borderRadius: 6,
    fontSize: size,
    flexShrink: 0,
  };
  if (level === "council") return <span title="Council-verified" style={{ ...base, color: "#0a3", background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.35)" }}>✓C</span>;
  if (level === "identity") return <span title="People Chain identity verified" style={{ ...base, color: "#48a", background: "rgba(96,165,250,0.10)", border: "1px solid rgba(96,165,250,0.30)" }}>✓ID</span>;
  if (level === "domain") return <span title="Domain verified" style={{ ...base, color: "#96f", background: "rgba(167,139,250,0.10)", border: "1px solid rgba(167,139,250,0.30)" }}>✓D</span>;
  return null;
}
