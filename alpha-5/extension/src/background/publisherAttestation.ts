// Publisher attestation — requests co-signature from publisher's attestation endpoint.
// The publisher signs an EIP-712 PublisherAttestation proving they served the ad.
//
// Endpoint: https://<publisher-domain>/.well-known/datum-attest
// Timeout: 3 seconds (attestation failure must NOT block impression recording)
// Fallback: returns empty signature with error reason (degraded trust mode)

const ATTESTATION_TIMEOUT_MS = 3000;

// A1-fix (2026-05-12): publisher now signs over claimsHash + deadlineBlock instead
// of (firstNonce, lastNonce, claimCount). Prevents replay of a captured cosig
// against altered claim contents and binds the cosig to an expiry block.
interface AttestationRequest {
  campaignId: string;
  user: string;
  claimsHash: string;   // 0x-prefixed keccak256(abi.encodePacked(claim.claimHash[]))
  deadlineBlock: string; // decimal-string block.number expiry
}

interface AttestationResponse {
  signature: string;
}

/** Structured result from publisher attestation request. */
export interface AttestationResult {
  signature: string;
  error?: string;
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
 * Returns { signature, error? } — empty signature with error on failure (degraded trust).
 */
export async function requestPublisherAttestation(
  publisherAddress: string,
  campaignId: string,
  userAddress: string,
  claimsHash: string,
  deadlineBlock: string | bigint
): Promise<AttestationResult> {
  try {
    const domain = await getPublisherDomain(publisherAddress);
    if (!domain) {
      // No known attestation endpoint — degraded trust mode
      return { signature: "", error: "No publisher relay URL configured" };
    }

    // Always HTTPS — strip any user-supplied protocol prefix and re-prepend https://.
    // A12: previous explicit http:// rejection was unreachable (regex stripped it
    // before the protocol re-prepend); behavior is preserved by always using HTTPS.
    const bareDomain = domain.replace(/^https?:\/\//, "");
    const url = `https://${bareDomain}/.well-known/datum-attest`;
    const body: AttestationRequest = {
      campaignId,
      user: userAddress,
      claimsHash,
      deadlineBlock: typeof deadlineBlock === "bigint" ? deadlineBlock.toString() : deadlineBlock,
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
      return { signature: "", error: `HTTP ${response.status} from publisher relay` };
    }

    const data: AttestationResponse = await response.json();
    if (!data.signature) {
      return { signature: "", error: "Invalid response format (no signature)" };
    }
    return { signature: data.signature };
  } catch (err) {
    // Distinguish timeout from other network errors
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn("[DATUM] Publisher attestation timed out");
      return { signature: "", error: `Network timeout (${ATTESTATION_TIMEOUT_MS / 1000}s)` };
    }
    console.warn("[DATUM] Publisher attestation unavailable:", err);
    const message = err instanceof Error ? err.message : String(err);
    return { signature: "", error: `Network error: ${message}` };
  }
}
