// Challenge-response handshake with the DATUM Publisher SDK.
// Generates a random challenge, dispatches it via CustomEvent,
// and waits for the SDK's signed response.

export interface Attestation {
  publisher: string;
  challenge: string;
  nonce: string;
  signature: string;
  timestamp: number;
}

/**
 * Perform a challenge-response handshake with the publisher SDK.
 * Returns the attestation on success, null on timeout (3s).
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

    function onResponse(e: Event) {
      if (resolved) return;
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.challenge !== challenge) return;

      resolved = true;
      document.removeEventListener("datum:response", onResponse);

      resolve({
        publisher: String(detail.publisher || publisher),
        challenge,
        nonce,
        signature: String(detail.signature || "0x"),
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
