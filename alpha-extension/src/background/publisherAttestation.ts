// Publisher attestation — requests co-signature from publisher's attestation endpoint.
// The publisher signs an EIP-712 PublisherAttestation proving they served the ad.
//
// Endpoint: https://<publisher-domain>/.well-known/datum-attest
// Timeout: 3 seconds (attestation failure must NOT block impression recording)
// Fallback: returns empty string (degraded trust mode)

const ATTESTATION_TIMEOUT_MS = 3000;

interface AttestationRequest {
  campaignId: string;
  user: string;
  firstNonce: string;
  lastNonce: string;
  claimCount: number;
}

interface AttestationResponse {
  signature: string;
}

/**
 * Resolve a publisher address to their attestation endpoint domain.
 * MVP: uses a simple lookup from cached campaign metadata.
 * Post-MVP: publishers register their domain on-chain.
 */
async function getPublisherDomain(publisherAddress: string): Promise<string | null> {
  // Check if we have a cached publisher domain mapping
  const key = `publisherDomain:${publisherAddress.toLowerCase()}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

/**
 * Request a publisher co-signature for a claim batch.
 * Returns the signature hex string, or empty string on failure (degraded trust).
 */
export async function requestPublisherAttestation(
  publisherAddress: string,
  campaignId: string,
  userAddress: string,
  firstNonce: string,
  lastNonce: string,
  claimCount: number
): Promise<string> {
  try {
    const domain = await getPublisherDomain(publisherAddress);
    if (!domain) {
      // No known attestation endpoint — degraded trust mode
      return "";
    }

    // M6: Warn on non-HTTPS for non-localhost domains
    const isLocal = domain === "localhost" || domain.startsWith("localhost:") || domain.startsWith("127.");
    if (!isLocal && !domain.startsWith("https://")) {
      console.warn(`[DATUM] Publisher attestation: refusing HTTP for non-local domain ${domain}`);
      return "";
    }

    const url = `https://${domain}/.well-known/datum-attest`;
    const body: AttestationRequest = {
      campaignId,
      user: userAddress,
      firstNonce,
      lastNonce,
      claimCount,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ATTESTATION_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[DATUM] Publisher attestation failed: ${response.status} from ${url}`);
      return "";
    }

    const data: AttestationResponse = await response.json();
    return data.signature ?? "";
  } catch (err) {
    // Timeout, network error, or parse error — degrade gracefully
    console.warn("[DATUM] Publisher attestation unavailable:", err);
    return "";
  }
}
