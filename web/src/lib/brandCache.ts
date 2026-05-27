// Brand profile cache + verification helpers.
//
// Reads a brand from DatumBrandRegistry (hot fields only — name/logoCid/
// homepage/brandColor) and caches the result in localStorage keyed on
// the lastUpdateBlock so we re-fetch automatically when the brand changes.
//
// Separately, computes the "verification level" displayed in the chip:
//   - council    — DatumBrandCurator.isCouncilVerified(addr) == true
//   - identity   — DatumPeopleChainIdentity.isVerified(addr, 1)+
//   - domain     — fetched lazily via /.well-known/datum-verify.json
//   - self       — name set but nothing else verified
//   - none       — empty profile

import { Contract, JsonRpcProvider } from "ethers";

export interface BrandHotFields {
  name: string;
  logoCid: string;       // bytes32 hex
  homepage: string;
  brandColor: number;    // uint24
  lastUpdateBlock: number;
}

export type VerificationLevel = "council" | "identity" | "domain" | "self" | "none";

const STORAGE_PREFIX = "datum_brand:";
const STORAGE_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000; // 24h; we also gate on lastUpdateBlock

interface CacheEntry {
  v: number;
  hot: BrandHotFields;
  ts: number;
}

function key(addr: string): string {
  return STORAGE_PREFIX + addr.toLowerCase();
}

function readCache(addr: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key(addr));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.v !== STORAGE_VERSION) return null;
    if (Date.now() - parsed.ts > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(addr: string, hot: BrandHotFields) {
  try {
    localStorage.setItem(key(addr), JSON.stringify({ v: STORAGE_VERSION, hot, ts: Date.now() }));
  } catch {
    /* localStorage disabled — skip silently */
  }
}

const REGISTRY_ABI = [
  "function getBrandHotFields(address) view returns (string,bytes32,string,uint24)",
  "function lastUpdateBlock(address) view returns (uint256)",
];

const CURATOR_ABI = [
  "function isCouncilVerified(address) view returns (bool)",
  "function revoked(address) view returns (bool)",
];

const IDENTITY_ABI = [
  "function isVerified(address,uint8) view returns (bool)",
];

/** Fetch the brand hot fields for an address, with cache-aside semantics.
 *  Returns the empty profile (name="") when the registry is not set on
 *  this network or the address has no brand. */
export async function fetchBrand(
  registryAddr: string | null | undefined,
  addr: string,
  provider: JsonRpcProvider
): Promise<BrandHotFields> {
  const empty: BrandHotFields = { name: "", logoCid: "0x" + "0".repeat(64), homepage: "", brandColor: 0, lastUpdateBlock: 0 };
  if (!registryAddr || !addr) return empty;

  // Cache-aside: read on-chain lastUpdateBlock first; if it matches our
  // cached value, return the cached hot fields without another call.
  const cached = readCache(addr);
  const c = new Contract(registryAddr, REGISTRY_ABI, provider);
  let lastBlock = 0n;
  try {
    lastBlock = await c.lastUpdateBlock(addr);
  } catch { /* unreachable or unset */ }
  if (cached && BigInt(cached.hot.lastUpdateBlock) === lastBlock && lastBlock !== 0n) {
    return cached.hot;
  }

  if (lastBlock === 0n) return empty;

  try {
    const [name, logoCid, homepage, brandColor] = await c.getBrandHotFields(addr);
    const hot: BrandHotFields = {
      name: String(name),
      logoCid: String(logoCid),
      homepage: String(homepage),
      brandColor: Number(brandColor),
      lastUpdateBlock: Number(lastBlock),
    };
    writeCache(addr, hot);
    return hot;
  } catch {
    return empty;
  }
}

/** Read the Council verification status. */
export async function fetchCouncilVerified(
  curatorAddr: string | null | undefined,
  addr: string,
  provider: JsonRpcProvider
): Promise<{ verified: boolean; revoked: boolean }> {
  if (!curatorAddr || !addr) return { verified: false, revoked: false };
  try {
    const c = new Contract(curatorAddr, CURATOR_ABI, provider);
    const [verified, revoked] = await Promise.all([
      c.isCouncilVerified(addr) as Promise<boolean>,
      c.revoked(addr) as Promise<boolean>,
    ]);
    return { verified: Boolean(verified), revoked: Boolean(revoked) };
  } catch {
    return { verified: false, revoked: false };
  }
}

/** Read People Chain identity at the lowest level (Reasonable). */
export async function fetchIdentityVerified(
  identityAddr: string | null | undefined,
  addr: string,
  provider: JsonRpcProvider
): Promise<boolean> {
  if (!identityAddr || !addr) return false;
  try {
    const c = new Contract(identityAddr, IDENTITY_ABI, provider);
    return Boolean(await c.isVerified(addr, 1));
  } catch {
    return false;
  }
}

/** Best-effort domain verification. Fetches /.well-known/datum-verify.json
 *  from the brand's homepage; the file should contain a JSON object with
 *  an "addresses" array including (case-insensitive) the EOA address. */
export async function fetchDomainVerified(homepage: string, addr: string): Promise<boolean> {
  if (!homepage || !addr) return false;
  try {
    const url = new URL(homepage);
    const verifyUrl = `${url.origin}/.well-known/datum-verify.json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(verifyUrl, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) return false;
      const body = await res.json();
      const list: string[] = Array.isArray(body?.addresses) ? body.addresses : [];
      return list.map((s) => String(s).toLowerCase()).includes(addr.toLowerCase());
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/** Convenience — derive the highest applicable verification level. */
export function deriveLevel(opts: {
  hasBrand: boolean;
  councilVerified: boolean;
  revoked: boolean;
  identityVerified: boolean;
  domainVerified: boolean;
}): VerificationLevel {
  if (opts.revoked) return "none"; // UI still renders, but as warning — handled separately
  if (opts.councilVerified) return "council";
  if (opts.identityVerified) return "identity";
  if (opts.domainVerified) return "domain";
  if (opts.hasBrand) return "self";
  return "none";
}
