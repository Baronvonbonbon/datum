// BrandProfileLongTail — off-chain JSON shape pointed to by
// DatumBrandRegistry.profileHash. Pinned to IPFS, fetched lazily by
// profile pages.
//
// Schema versioned via `schemaVersion`. Unknown future versions are
// accepted but only the v1 fields are read; missing fields default to
// the empty shape so a partially-populated JSON degrades gracefully.

import { Contract, JsonRpcProvider } from "ethers";

export interface BrandSocials {
  twitter?: string;
  github?: string;
  mastodon?: string;
  discord?: string;
  matrix?: string;
  bluesky?: string;
  /// Free-form catch-all for sites we don't have a dedicated field for.
  other?: { label: string; url: string }[];
}

export interface BrandSupport {
  email?: string;
  url?: string;
}

export interface BrandAdditionalAddress {
  addr: string;
  label: string;
  purpose?: string;
}

export interface BrandProfileLongTail {
  schemaVersion: number;
  description?: string;          // <= 1024 chars (lightly enforced client-side)
  support?: BrandSupport;
  socials?: BrandSocials;
  additionalAddresses?: BrandAdditionalAddress[];
  /// Cached OpenGraph snapshot from the homepage at the time the brand
  /// was registered. Optional; if absent the UI doesn't show it.
  ogSnapshot?: { title?: string; description?: string; image?: string };
}

export const EMPTY_LONGTAIL: BrandProfileLongTail = { schemaVersion: 1 };

const ZERO_HASH = "0x" + "0".repeat(64);

const REGISTRY_ABI = [
  "function getBrand(address) view returns ((string name, bytes32 logoCid, string homepage, uint24 brandColor, bytes32 profileHash))",
];

const CACHE_PREFIX = "datum_brand_longtail:";
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry { v: number; cid: string; body: BrandProfileLongTail; ts: number; }

/** Validate a parsed JSON object against the v1 schema. Silently drops
 *  unknown fields; clips strings; ensures additionalAddresses entries
 *  are well-formed. Returns the sanitized object — safe to render. */
export function sanitizeLongTail(raw: any): BrandProfileLongTail {
  if (!raw || typeof raw !== "object") return EMPTY_LONGTAIL;
  const out: BrandProfileLongTail = { schemaVersion: Number(raw.schemaVersion) || 1 };
  if (typeof raw.description === "string") {
    out.description = raw.description.slice(0, 1024);
  }
  if (raw.support && typeof raw.support === "object") {
    out.support = {
      email: typeof raw.support.email === "string" ? raw.support.email.slice(0, 128) : undefined,
      url: typeof raw.support.url === "string" ? raw.support.url.slice(0, 256) : undefined,
    };
  }
  if (raw.socials && typeof raw.socials === "object") {
    const s: BrandSocials = {};
    for (const key of ["twitter", "github", "mastodon", "discord", "matrix", "bluesky"] as const) {
      if (typeof raw.socials[key] === "string") s[key] = raw.socials[key].slice(0, 128);
    }
    if (Array.isArray(raw.socials.other)) {
      s.other = raw.socials.other
        .filter((o: any) => o && typeof o.label === "string" && typeof o.url === "string")
        .slice(0, 8)
        .map((o: any) => ({ label: String(o.label).slice(0, 32), url: String(o.url).slice(0, 256) }));
    }
    out.socials = s;
  }
  if (Array.isArray(raw.additionalAddresses)) {
    out.additionalAddresses = raw.additionalAddresses
      .filter((a: any) => a && typeof a.addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.addr))
      .slice(0, 16)
      .map((a: any) => ({
        addr: String(a.addr).toLowerCase(),
        label: typeof a.label === "string" ? a.label.slice(0, 32) : "additional",
        purpose: typeof a.purpose === "string" ? a.purpose.slice(0, 64) : undefined,
      }));
  }
  if (raw.ogSnapshot && typeof raw.ogSnapshot === "object") {
    out.ogSnapshot = {
      title: typeof raw.ogSnapshot.title === "string" ? raw.ogSnapshot.title.slice(0, 256) : undefined,
      description: typeof raw.ogSnapshot.description === "string" ? raw.ogSnapshot.description.slice(0, 512) : undefined,
      image: typeof raw.ogSnapshot.image === "string" ? raw.ogSnapshot.image.slice(0, 512) : undefined,
    };
  }
  return out;
}

function readCache(cid: string): BrandProfileLongTail | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + cid);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.v !== 1) return null;
    if (Date.now() - parsed.ts > TTL_MS) return null;
    return parsed.body;
  } catch { return null; }
}

function writeCache(cid: string, body: BrandProfileLongTail) {
  try {
    localStorage.setItem(CACHE_PREFIX + cid, JSON.stringify({ v: 1, cid, body, ts: Date.now() }));
  } catch { /* skip */ }
}

/** Resolve the on-chain profileHash for `addr`, fetch the JSON from the
 *  configured IPFS gateway, validate, and cache. Returns the empty
 *  long-tail when no JSON is set or fetch fails. */
export async function fetchBrandLongTail(opts: {
  addr: string;
  registryAddr: string | null | undefined;
  ipfsGateway: string;
  provider: JsonRpcProvider;
}): Promise<BrandProfileLongTail> {
  const { addr, registryAddr, ipfsGateway, provider } = opts;
  if (!registryAddr || !addr) return EMPTY_LONGTAIL;
  try {
    const c = new Contract(registryAddr, REGISTRY_ABI, provider);
    const profile = await c.getBrand(addr);
    const profileHash = String(profile.profileHash ?? profile[4]);
    if (!profileHash || profileHash === ZERO_HASH) return EMPTY_LONGTAIL;

    const cached = readCache(profileHash);
    if (cached) return cached;

    // bytes32 raw digest → multibase-f CIDv1 raw-codec path on the gateway.
    const hex = profileHash.replace(/^0x/, "");
    if (hex.length !== 64) return EMPTY_LONGTAIL;
    const url = `${ipfsGateway.replace(/\/$/, "")}/ipfs/f01551220${hex}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) return EMPTY_LONGTAIL;
      const raw = await res.json();
      const body = sanitizeLongTail(raw);
      writeCache(profileHash, body);
      return body;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return EMPTY_LONGTAIL;
  }
}
