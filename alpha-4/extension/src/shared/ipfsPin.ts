// Pinata IPFS pinning utility for campaign metadata.
// Pins a CampaignMetadata JSON object to Pinata and returns the CIDv0 string.

import { CampaignMetadata } from "./types";

const PINATA_API_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

export interface PinResult {
  ok: boolean;
  cid?: string;
  error?: string;
}

/**
 * Pin a CampaignMetadata object to Pinata IPFS.
 * @param apiKey Pinata JWT or API key (Bearer token)
 * @param metadata Campaign metadata matching the CampaignMetadata schema
 * @returns PinResult with CID on success
 */
export async function pinToIPFS(
  apiKey: string,
  metadata: CampaignMetadata
): Promise<PinResult> {
  if (!apiKey.trim()) {
    return { ok: false, error: "No Pinata API key configured. Add it in Settings." };
  }

  try {
    const response = await fetch(PINATA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        pinataContent: metadata,
        pinataMetadata: {
          name: `datum-campaign-${metadata.title.slice(0, 30)}`,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `Pinata error ${response.status}: ${text.slice(0, 200)}` };
    }

    const data = await response.json();
    const cid: string = data.IpfsHash;
    if (!cid) {
      return { ok: false, error: "Pinata returned no CID" };
    }

    return { ok: true, cid };
  } catch (err) {
    return { ok: false, error: `Pin failed: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Test a Pinata API key by fetching account info.
 */
export async function testPinataKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("https://api.pinata.cloud/data/testAuthentication", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `Auth failed: ${response.status}` };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 100) };
  }
}
