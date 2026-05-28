// Brand profile cache for the extension. Mirrors web/src/lib/brandCache.ts
// but uses chrome.storage.local instead of localStorage (extension service
// workers don't have localStorage; chrome.storage is shared with the popup).
//
// Reads hot fields from DatumBrandRegistry, caches by lastUpdateBlock, plus
// best-effort verification queries against DatumBrandCurator and the
// People Chain identity contract. Domain verification is opt-in: the
// extension fetches /.well-known/datum-verify.json with a short timeout
// only when the caller asks (e.g. ad-slot render where the user sees
// the brand on a publisher's site).

import { Contract, JsonRpcProvider } from "ethers";

export interface BrandHotFields {
  name: string;
  logoCid: string;       // bytes32 hex
  homepage: string;
  brandColor: number;    // uint24
  lastUpdateBlock: number;
}

export type VerificationLevel = "council" | "identity" | "domain" | "self" | "none";

const STORAGE_PREFIX = "brand:";
const STORAGE_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry { v: number; hot: BrandHotFields; ts: number; }

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

function key(addr: string): string {
  return STORAGE_PREFIX + addr.toLowerCase();
}

async function readCache(addr: string): Promise<CacheEntry | null> {
  try {
    const k = key(addr);
    const stored = await chrome.storage.local.get(k);
    const parsed = (stored as any)[k] as CacheEntry | undefined;
    if (!parsed || parsed.v !== STORAGE_VERSION) return null;
    if (Date.now() - parsed.ts > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(addr: string, hot: BrandHotFields): Promise<void> {
  try {
    await chrome.storage.local.set({ [key(addr)]: { v: STORAGE_VERSION, hot, ts: Date.now() } });
  } catch {
    /* storage full or disabled — silent */
  }
}

export async function fetchBrand(
  registryAddr: string | null | undefined,
  addr: string,
  provider: JsonRpcProvider
): Promise<BrandHotFields> {
  const empty: BrandHotFields = { name: "", logoCid: "0x" + "0".repeat(64), homepage: "", brandColor: 0, lastUpdateBlock: 0 };
  if (!registryAddr || !addr) return empty;

  const cached = await readCache(addr);
  const c = new Contract(registryAddr, REGISTRY_ABI, provider);
  let lastBlock = 0n;
  try {
    lastBlock = await c.lastUpdateBlock(addr);
  } catch { /* unreachable */ }

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
    await writeCache(addr, hot);
    return hot;
  } catch {
    return empty;
  }
}

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

/** Domain verification with a chrome.storage cache. Positive results live
 *  24h, negative 1h. Aborts after 4s. */
const DOMAIN_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DOMAIN_NEGATIVE_TTL_MS = 1 * 60 * 60 * 1000;

interface DomainCacheEntry { v: number; ok: boolean; ts: number; }

async function readDomainCache(origin: string, addr: string): Promise<boolean | null> {
  try {
    const k = `domain_verify:${origin.toLowerCase()}:${addr.toLowerCase()}`;
    const stored = await chrome.storage.local.get(k);
    const parsed = (stored as any)[k] as DomainCacheEntry | undefined;
    if (!parsed || parsed.v !== 1) return null;
    const ttl = parsed.ok ? DOMAIN_POSITIVE_TTL_MS : DOMAIN_NEGATIVE_TTL_MS;
    if (Date.now() - parsed.ts > ttl) return null;
    return parsed.ok;
  } catch { return null; }
}

async function writeDomainCache(origin: string, addr: string, ok: boolean): Promise<void> {
  try {
    const k = `domain_verify:${origin.toLowerCase()}:${addr.toLowerCase()}`;
    await chrome.storage.local.set({ [k]: { v: 1, ok, ts: Date.now() } });
  } catch { /* skip */ }
}

export async function fetchDomainVerified(homepage: string, addr: string): Promise<boolean> {
  if (!homepage || !addr) return false;
  let origin: string;
  try { origin = new URL(homepage).origin; } catch { return false; }

  const cached = await readDomainCache(origin, addr);
  if (cached !== null) return cached;

  let ok = false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${origin}/.well-known/datum-verify.json`, { signal: controller.signal, redirect: "follow" });
      if (res.ok) {
        const body = await res.json();
        const list: string[] = Array.isArray(body?.addresses) ? body.addresses : [];
        ok = list.map((s) => String(s).toLowerCase()).includes(addr.toLowerCase());
      }
    } finally {
      clearTimeout(t);
    }
  } catch {
    ok = false;
  }
  await writeDomainCache(origin, addr, ok);
  return ok;
}

export function deriveLevel(opts: {
  hasBrand: boolean;
  councilVerified: boolean;
  revoked: boolean;
  identityVerified: boolean;
  domainVerified: boolean;
}): VerificationLevel {
  if (opts.revoked) return "none";
  if (opts.councilVerified) return "council";
  if (opts.identityVerified) return "identity";
  if (opts.domainVerified) return "domain";
  if (opts.hasBrand) return "self";
  return "none";
}
