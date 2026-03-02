// adSlot — injects an ad banner when a matching campaign is found.
// Renders creative content from IPFS metadata when available, falls back to placeholder.

export interface CampaignCreative {
  title: string;
  description: string;
  category: string;
  creative: {
    type: "text";
    text: string;
    cta: string;
    ctaUrl: string;
  };
  version: number;
}

export interface AdSlotConfig {
  campaignId: string;
  publisherAddress: string;
  category: string;
  metadata: CampaignCreative | null;
}

const SLOT_ID = "datum-ad-slot";

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

export function injectAdSlot(config: AdSlotConfig): void {
  // Don't inject twice
  if (document.getElementById(SLOT_ID)) return;

  const slot = document.createElement("div");
  slot.id = SLOT_ID;
  slot.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 2147483647;
    background: #1a1a2e;
    color: #e0e0e0;
    border: 1px solid #4a4a8a;
    border-radius: 8px;
    padding: 12px 16px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    max-width: 300px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  `;

  const meta = config.metadata;

  if (meta?.creative) {
    // Render actual creative from IPFS metadata
    const c = meta.creative;
    slot.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
        <button id="${SLOT_ID}-close" style="
          background:none;border:none;color:#888;cursor:pointer;
          font-size:16px;line-height:1;padding:0 2px;
        ">&#x2715;</button>
      </div>
      <div style="color:#e0e0e0;font-size:13px;font-weight:600;margin-bottom:4px;">
        ${escapeHtml(meta.title)}
      </div>
      <div style="color:#bbb;font-size:12px;margin-bottom:8px;">
        ${escapeHtml(c.text)}
      </div>
      <a id="${SLOT_ID}-cta" href="${escapeHtml(c.ctaUrl)}" target="_blank" rel="noopener" style="
        display:inline-block;background:#2a2a5a;color:#a0a0ff;
        border:1px solid #4a4a8a;border-radius:4px;
        padding:6px 12px;font-size:12px;text-decoration:none;cursor:pointer;
      ">${escapeHtml(c.cta)}</a>
      <div style="color:#555;font-size:10px;margin-top:6px;">
        Campaign #${escapeHtml(config.campaignId)} · Privacy-preserving · Polkadot Hub
      </div>
    `;
  } else {
    // Fallback: placeholder creative
    slot.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
        <button id="${SLOT_ID}-close" style="
          background:none;border:none;color:#888;cursor:pointer;
          font-size:16px;line-height:1;padding:0 2px;
        ">&#x2715;</button>
      </div>
      <div style="color:#ccc;font-size:12px;margin-bottom:6px;">
        Earning for browsing: <strong style="color:#a0a0ff;">${escapeHtml(config.category)}</strong>
      </div>
      <div style="color:#666;font-size:11px;">
        Campaign #${escapeHtml(config.campaignId)} · Publisher ad
      </div>
      <div style="color:#555;font-size:10px;margin-top:4px;">
        Privacy-preserving · Polkadot Hub
      </div>
    `;
  }

  document.body.appendChild(slot);

  document.getElementById(`${SLOT_ID}-close`)?.addEventListener("click", () => {
    slot.remove();
  });
}

export function removeAdSlot(): void {
  document.getElementById(SLOT_ID)?.remove();
}
