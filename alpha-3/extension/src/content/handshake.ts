// Challenge-response handshake with the DATUM Publisher SDK.
// Generates a random challenge, dispatches it via CustomEvent,
// and waits for the SDK's signed response.
// XM-10: Verifies HMAC-SHA-256 signature (keyed by publisher address) to prevent spoofing.

export interface Attestation {
  publisher: string;
  challenge: string;
  nonce: string;
  signature: string;
  timestamp: number;
}

/**
 * XM-10: Compute HMAC-SHA-256 signature for handshake verification.
 * Key = publisher address, message = challenge + ":" + nonce.
 * HMAC prevents length-extension attacks and binds the signature to the publisher key.
 * Must match the SDK's computation: HMAC-SHA-256(key=publisher, msg=challenge:nonce)
 */
async function computeExpectedSignature(publisher: string, challenge: string, nonce: string): Promise<string> {
  const keyData = new TextEncoder().encode(publisher);
  const msgData = new TextEncoder().encode(`${challenge}:${nonce}`);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const sigArray = Array.from(new Uint8Array(sigBuffer));
  return "0x" + sigArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Perform a challenge-response handshake with the publisher SDK.
 * Returns the attestation on success, null on timeout (3s) or failed verification.
 */
export function performHandshake(publisher: string): Promise<Attestation | null> {
  return new Promise((resolve) => {
    let resolved = false;

    // Generate random challenge (32 bytes hex)
    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challenge = Array.from(challengeBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Generate nonce
    const nonceBytes = new Uint8Array(8);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    async function onResponse(e: Event) {
      if (resolved) return;
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.challenge !== challenge) return;

      // Verify the publisher address matches what we expect
      const responsePublisher = String(detail.publisher || "");
      if (responsePublisher.toLowerCase() !== publisher.toLowerCase()) {
        resolved = true;
        document.removeEventListener("datum:response", onResponse);
        resolve(null); // publisher mismatch — reject
        return;
      }

      // Verify the SHA-256 signature: prevents spoofing by page scripts
      // that don't know the publisher address bound to the SDK script tag
      const sig = String(detail.signature || "");
      if (!sig || sig === "0x") {
        resolved = true;
        document.removeEventListener("datum:response", onResponse);
        resolve(null); // empty signature — degraded, reject handshake
        return;
      }

      const expectedSig = await computeExpectedSignature(publisher, challenge, nonce);
      if (sig !== expectedSig) {
        resolved = true;
        document.removeEventListener("datum:response", onResponse);
        resolve(null); // signature mismatch — spoofed response
        return;
      }

      resolved = true;
      document.removeEventListener("datum:response", onResponse);

      resolve({
        publisher,
        challenge,
        nonce,
        signature: sig,
        timestamp: Date.now(),
      });
    }

    document.addEventListener("datum:response", onResponse);

    // Dispatch challenge to the SDK
    document.dispatchEvent(
      new CustomEvent("datum:challenge", {
        detail: { challenge, nonce },
      })
    );

    // Timeout: 3 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        document.removeEventListener("datum:response", onResponse);
        resolve(null);
      }
    }, 3000);
  });
}
