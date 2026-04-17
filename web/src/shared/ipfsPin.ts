// IPFS pinning utility for campaign metadata.
// Supports Pinata, Web3.Storage, Filebase, NFT.Storage, self-hosted Datum node, and custom endpoints.

export const SELFHOSTED_UPLOAD_URL = "https://ipfs-datum.javcon.io/add";
export const SELFHOSTED_GATEWAY_URL = "https://ipfs-datum.javcon.io";

import { CampaignMetadata, IpfsProvider } from "./types";

export interface PinResult {
  ok: boolean;
  cid?: string;
  error?: string;
}

export interface PinConfig {
  provider: IpfsProvider;
  apiKey: string;
  /** Required when provider === "custom" */
  endpoint?: string;
}

// ── Provider descriptors ──────────────────────────────────────────────────────

export interface ProviderInfo {
  label: string;
  placeholder: string;
  keyLabel: string;
  docsUrl: string;
  /** true = endpoint field shown */
  needsEndpoint: boolean;
}

export const IPFS_PROVIDERS: Record<IpfsProvider, ProviderInfo> = {
  pinata: {
    label: "Pinata",
    placeholder: "eyJ... (JWT)",
    keyLabel: "Pinata JWT",
    docsUrl: "https://app.pinata.cloud/developers/api-keys",
    needsEndpoint: false,
  },
  web3storage: {
    label: "Web3.Storage",
    placeholder: "eyJ... (API token)",
    keyLabel: "Web3.Storage API Token",
    docsUrl: "https://web3.storage/tokens/",
    needsEndpoint: false,
  },
  filebase: {
    label: "Filebase",
    placeholder: "Filebase S3 Bearer token",
    keyLabel: "Filebase API Token",
    docsUrl: "https://docs.filebase.com/api-documentation/ipfs-pinning-service-api",
    needsEndpoint: false,
  },
  nftstorage: {
    label: "NFT.Storage",
    placeholder: "eyJ... (API token)",
    keyLabel: "NFT.Storage API Token",
    docsUrl: "https://nft.storage/manage/",
    needsEndpoint: false,
  },
  selfhosted: {
    label: "Self-hosted (Datum Node)",
    placeholder: "64-char hex key from ipfs-node/.env",
    keyLabel: "Upload API key",
    docsUrl: "",
    needsEndpoint: false,
  },
  localipfs: {
    label: "Local IPFS node (no key needed)",
    placeholder: "(leave blank — no auth required for localhost)",
    keyLabel: "API key (optional, only if you configured Kubo auth)",
    docsUrl: "",
    needsEndpoint: true,
  },
  custom: {
    label: "Custom endpoint",
    placeholder: "Bearer token or API key",
    keyLabel: "API Key / Bearer Token",
    docsUrl: "",
    needsEndpoint: true,
  },
};

// ── Pinning implementations ───────────────────────────────────────────────────

async function pinViaPinata(apiKey: string, metadata: CampaignMetadata): Promise<PinResult> {
  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: { name: `datum-campaign-${metadata.title.slice(0, 30)}` },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `Pinata ${response.status}: ${text.slice(0, 200)}` };
  }
  const data = await response.json();
  const cid: string = data.IpfsHash;
  if (!cid) return { ok: false, error: "Pinata returned no CID" };
  return { ok: true, cid };
}

async function pinViaWeb3Storage(apiKey: string, metadata: CampaignMetadata): Promise<PinResult> {
  // Web3.Storage v1 uploads a CAR blob; use the simpler /upload endpoint for JSON
  const blob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
  const response = await fetch("https://api.web3.storage/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Name": `datum-campaign-${metadata.title.slice(0, 30)}`,
    },
    body: blob,
  });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `Web3.Storage ${response.status}: ${text.slice(0, 200)}` };
  }
  const data = await response.json();
  const cid: string = data.cid;
  if (!cid) return { ok: false, error: "Web3.Storage returned no CID" };
  return { ok: true, cid };
}

async function pinViaFilebase(apiKey: string, metadata: CampaignMetadata): Promise<PinResult> {
  // Filebase IPFS Pinning Service API (IPFS Pinning Service spec)
  const response = await fetch("https://api.filebase.io/v1/ipfs/pins", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      cid: "", // ignored for new pins — Filebase accepts raw content via their S3 API
      name: `datum-campaign-${metadata.title.slice(0, 30)}`,
      meta: { content: JSON.stringify(metadata) },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `Filebase ${response.status}: ${text.slice(0, 200)}` };
  }
  const data = await response.json();
  const cid: string = data.pin?.cid ?? data.cid;
  if (!cid) return { ok: false, error: "Filebase returned no CID" };
  return { ok: true, cid };
}

async function pinViaNftStorage(apiKey: string, metadata: CampaignMetadata): Promise<PinResult> {
  const blob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
  const response = await fetch("https://api.nft.storage/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: blob,
  });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `NFT.Storage ${response.status}: ${text.slice(0, 200)}` };
  }
  const data = await response.json();
  const cid: string = data.value?.cid ?? data.cid;
  if (!cid) return { ok: false, error: "NFT.Storage returned no CID" };
  return { ok: true, cid };
}

/**
 * Pin via a local Kubo IPFS node using the multipart/form-data API.
 * Kubo requires multipart — raw JSON to /api/v0/add will return a 400.
 * The caller supplies the node base URL (e.g. http://localhost:5001); we
 * append /api/v0/add automatically.
 *
 * CORS note: Kubo's API port (default 5001) blocks cross-origin requests
 * by default. Run: ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
 * and restart the daemon.
 */
async function pinViaKubo(endpoint: string, apiKey: string, metadata: CampaignMetadata): Promise<PinResult> {
  const base = endpoint.trim().replace(/\/$/, "");
  if (!base) return { ok: false, error: "No IPFS node endpoint configured" };
  const urlError = validateEndpointUrl(base);
  if (urlError) return { ok: false, error: urlError };

  const json = JSON.stringify(metadata, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const form = new FormData();
  form.append("file", blob, "metadata.json");

  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers["Authorization"] = apiKey.trim().startsWith("Bearer ")
    ? apiKey.trim()
    : `Bearer ${apiKey.trim()}`;

  const response = await fetch(`${base}/api/v0/add?pin=true`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    // Kubo returns NDJSON on success; a non-OK status means a real error
    return { ok: false, error: `IPFS node ${response.status}: ${text.slice(0, 300)}` };
  }

  // Kubo streams NDJSON — last line is the root object with the final CID
  const text = await response.text();
  const lines = text.trim().split("\n").filter(Boolean);
  let cid: string | undefined;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Kubo uses "Hash" field; pick up whichever variant appears
      const candidate: string = obj.Hash ?? obj.hash ?? obj.IpfsHash ?? obj.cid;
      if (candidate) cid = candidate;
    } catch { /* skip malformed line */ }
  }
  if (!cid) return { ok: false, error: "IPFS node response contained no CID — check CORS and node version" };
  return { ok: true, cid };
}

/** Validate custom endpoint URL — reject private/internal IPs and non-HTTPS */
function validateEndpointUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Reject non-HTTPS (allow localhost for dev)
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (!isLocal && parsed.protocol !== "https:") return "Custom endpoint must use HTTPS";
    // Reject internal/private hostnames
    const host = parsed.hostname.toLowerCase();
    if (host === "metadata.google.internal" || host.endsWith(".internal")) return "Internal hostnames are not allowed";
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(host)) return "Private IP addresses are not allowed";
    if (host === "0.0.0.0" || host === "[::]") return "Invalid hostname";
    return null;
  } catch {
    return "Invalid URL format";
  }
}

async function pinViaCustom(apiKey: string, endpoint: string, metadata: CampaignMetadata): Promise<PinResult> {
  if (!endpoint.trim()) return { ok: false, error: "Custom endpoint URL is required" };
  const urlError = validateEndpointUrl(endpoint.trim());
  if (urlError) return { ok: false, error: urlError };
  const response = await fetch(endpoint.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `Custom endpoint ${response.status}: ${text.slice(0, 200)}` };
  }
  const data = await response.json();
  // Accept common CID field names
  const cid: string = data.IpfsHash ?? data.cid ?? data.Hash ?? data.hash;
  if (!cid) return { ok: false, error: "Endpoint response contained no CID (tried: IpfsHash, cid, Hash, hash)" };
  return { ok: true, cid };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pin a CampaignMetadata object via the configured IPFS provider.
 */
export async function pinToIPFS(config: PinConfig, metadata: CampaignMetadata): Promise<PinResult> {
  const key = config.apiKey.trim();
  const noKeyProviders: IpfsProvider[] = ["custom", "selfhosted", "localipfs"];
  if (!key && !noKeyProviders.includes(config.provider)) {
    return { ok: false, error: `No API key configured for ${IPFS_PROVIDERS[config.provider].label}. Add it in Settings.` };
  }

  try {
    switch (config.provider) {
      case "pinata":      return await pinViaPinata(key, metadata);
      case "web3storage": return await pinViaWeb3Storage(key, metadata);
      case "filebase":    return await pinViaFilebase(key, metadata);
      case "nftstorage":  return await pinViaNftStorage(key, metadata);
      case "selfhosted":  return await pinViaCustom(key, SELFHOSTED_UPLOAD_URL, metadata);
      case "localipfs":   return await pinViaKubo(config.endpoint ?? "", key, metadata);
      case "custom":      return await pinViaCustom(key, config.endpoint ?? "", metadata);
    }
  } catch (err) {
    return { ok: false, error: `Pin failed: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Test that an API key/endpoint is valid by attempting a lightweight auth check.
 */
export async function testPinConfig(config: PinConfig): Promise<{ ok: boolean; error?: string }> {
  const key = config.apiKey.trim();
  try {
    switch (config.provider) {
      case "pinata": {
        const r = await fetch("https://api.pinata.cloud/data/testAuthentication", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (r.ok) return { ok: true };
        return { ok: false, error: `Auth failed: ${r.status}` };
      }
      case "web3storage": {
        const r = await fetch("https://api.web3.storage/user/account", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (r.ok) return { ok: true };
        return { ok: false, error: `Auth failed: ${r.status}` };
      }
      case "filebase": {
        const r = await fetch("https://api.filebase.io/v1/ipfs/pins?limit=1", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (r.ok) return { ok: true };
        return { ok: false, error: `Auth failed: ${r.status}` };
      }
      case "nftstorage": {
        const r = await fetch("https://api.nft.storage/", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (r.ok) return { ok: true };
        return { ok: false, error: `Auth failed: ${r.status}` };
      }
      case "selfhosted": {
        // First check node reachability
        const health = await fetch(`${SELFHOSTED_GATEWAY_URL}/health`);
        if (!health.ok) return { ok: false, error: `Datum node unreachable: ${health.status}` };
        // Then verify the API key with a minimal authenticated request
        if (!key) return { ok: false, error: "No API key configured for self-hosted node" };
        const auth = await fetch(`${SELFHOSTED_GATEWAY_URL}/pins?limit=1`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (auth.ok || auth.status === 404) return { ok: true }; // 404 = endpoint exists, key accepted
        return { ok: false, error: `API key rejected by Datum node: ${auth.status}` };
      }
      case "localipfs": {
        if (!config.endpoint?.trim()) return { ok: false, error: "No IPFS node endpoint configured (e.g. http://localhost:5001)" };
        const base = config.endpoint.trim().replace(/\/$/, "");
        const urlError = validateEndpointUrl(base);
        if (urlError) return { ok: false, error: urlError };
        try {
          // Kubo API endpoints use POST even for reads
          const r = await fetch(`${base}/api/v0/version`, { method: "POST" });
          if (r.ok) return { ok: true };
          if (r.status === 403 || r.status === 401) return { ok: false, error: "IPFS node rejected request — check auth config" };
          return { ok: false, error: `IPFS node returned ${r.status} — check CORS headers and that daemon is running` };
        } catch {
          return { ok: false, error: "Cannot reach IPFS node — is it running? Check: ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '[\"*\"]'" };
        }
      }
      case "custom": {
        if (!config.endpoint?.trim()) return { ok: false, error: "No endpoint URL set" };
        return { ok: true };
      }
    }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 100) };
  }
}

// ── Legacy shim ───────────────────────────────────────────────────────────────
// For any callers that haven't been updated yet.
export async function testPinataKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  return testPinConfig({ provider: "pinata", apiKey });
}
