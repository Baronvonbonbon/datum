// rpcSettings — operator-route RPC endpoint configuration.
//
// Per design doc §1 (r3 revision): end-user paths (Explorer, /me,
// public dashboards) are pine-only. Operator paths (/publisher/*,
// /advertiser/*, and a couple admin pages) get a per-query RPC
// fallback for history beyond pine's rolling window. Operators
// configure their own endpoint at /settings/rpc — by default we
// point at the public Paseo gateway.
//
// Storage: localStorage["rpcEndpoint"] = url string. Persistent per
// origin (per browser profile, per dApp). No sync — operators
// running across multiple machines can re-configure each.

const STORAGE_KEY = "rpcEndpoint";

/// Public Paseo Hub RPC gateway. Documented in alpha-5 deploy docs.
/// Operators running their own archive node SHOULD override this
/// for privacy + performance (faster historical queries; no leaking
/// metadata to a third-party gateway).
export const DEFAULT_RPC_ENDPOINT =
  "https://eth-rpc-testnet.polkadot.io/";

/// Routes that are allowed to use the per-query RPC fallback. End-user
/// pages outside this prefix list must not — see design doc §9.10.
/// Editing this list is a security-relevant change: adding a route
/// here lets pages on it leak query metadata to the configured RPC
/// endpoint.
const OPERATOR_PATH_PREFIXES = [
  "/publisher",
  "/advertiser",
  "/protocol",  // protocol dashboard reads guardian/admin state
  "/governance/parameters",
  "/governance/protocol-params",
  "/settings/rpc",
];

/// Return the current RPC endpoint URL. Falls back to the default
/// gateway if nothing is persisted or the persisted value isn't a
/// valid http(s) URL.
export function getRpcEndpoint(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidRpcUrl(stored)) return stored;
  } catch {
    // localStorage may be unavailable (Safari private mode, etc.).
  }
  return DEFAULT_RPC_ENDPOINT;
}

/// Persist a new RPC endpoint. Throws if the URL isn't http(s) or
/// fails the basic structural check. Callers (Settings UI) should
/// catch and surface the error.
export function setRpcEndpoint(url: string): void {
  const trimmed = url.trim();
  if (!isValidRpcUrl(trimmed)) {
    throw new Error("RPC endpoint must be an https:// or http:// URL");
  }
  try {
    localStorage.setItem(STORAGE_KEY, trimmed);
  } catch (err) {
    throw new Error(
      "Couldn't save RPC endpoint — localStorage may be disabled in this browser context."
    );
  }
}

/// Reset to the default. Used by Settings → "Use public Paseo gateway".
export function resetRpcEndpoint(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same handling as set — if storage is disabled, nothing to do.
  }
}

/// True iff the current page is on an operator route. End-user pages
/// see `false` and queryWithFallback ignores RPC settings entirely.
export function isOperatorRoute(pathname: string): boolean {
  // Normalize: strip trailing slash, lowercase. Routes are case-
  // sensitive on the server but case-insensitive matching here keeps
  // the gate stricter (an attacker can't bypass by URL-casing).
  const normalized = pathname.toLowerCase().replace(/\/+$/, "");
  return OPERATOR_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

/// Best-effort connectivity check. POSTs eth_chainId to the endpoint
/// and reports whether the result looks like a hex-encoded chainId
/// that matches Paseo. Used by the Settings UI to validate a freshly-
/// pasted URL before persisting.
///
/// Returns { ok: true, chainId } on success.
/// Returns { ok: false, error } on any failure mode (DNS, CORS, bad
/// JSON, non-Paseo chainId).
export async function pingRpcEndpoint(
  url: string
): Promise<{ ok: true; chainId: string } | { ok: false; error: string }> {
  if (!isValidRpcUrl(url)) {
    return { ok: false, error: "Not a valid http(s) URL." };
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as { result?: string; error?: { message?: string } };
    if (json.error) {
      return { ok: false, error: json.error.message ?? "RPC returned an error" };
    }
    const chainId = json.result;
    if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId)) {
      return { ok: false, error: "Response wasn't a hex chainId" };
    }
    return { ok: true, chainId };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ─── Internals ─────────────────────────────────────────────────────

function isValidRpcUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
