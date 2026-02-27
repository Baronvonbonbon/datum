// adSlot — injects a minimal ad banner when a matching campaign is found.
// The banner is dismissible and displays placeholder creative in MVP.

export interface AdSlotConfig {
  campaignId: string;
  publisherAddress: string;
  category: string;
}

const SLOT_ID = "datum-ad-slot";

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
    max-width: 280px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  `;

  slot.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
      <button id="${SLOT_ID}-close" style="
        background:none;border:none;color:#888;cursor:pointer;
        font-size:16px;line-height:1;padding:0 2px;
      ">✕</button>
    </div>
    <div style="color:#ccc;font-size:12px;margin-bottom:6px;">
      Earning for browsing: <strong style="color:#a0a0ff;">${config.category}</strong>
    </div>
    <div style="color:#666;font-size:11px;">
      Campaign #${config.campaignId} · Publisher ad
    </div>
    <div style="color:#555;font-size:10px;margin-top:4px;">
      🔒 Privacy-preserving · Polkadot Hub
    </div>
  `;

  document.body.appendChild(slot);

  document.getElementById(`${SLOT_ID}-close`)?.addEventListener("click", () => {
    slot.remove();
  });
}

export function removeAdSlot(): void {
  document.getElementById(SLOT_ID)?.remove();
}
