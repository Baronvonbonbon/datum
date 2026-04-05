// adSlot — injects an ad banner when a matching campaign is found.
// Renders creative content from IPFS metadata when available, falls back to placeholder.
// Uses Shadow DOM for isolation from host page CSS/JS.

import { sanitizeCtaUrl } from "@shared/contentSafety";
import { bytes32ToCid } from "@shared/ipfs";

export interface CampaignCreative {
  title: string;
  description: string;
  category: string;
  creative: {
    type: "text";
    text: string;
    cta: string;
    ctaUrl: string;
    imageUrl?: string;
  };
  version: number;
}

export interface AdSlotConfig {
  campaignId: string;
  publisherAddress: string;
  category: string;
  metadata: CampaignCreative | null;
  metadataHash?: string;  // bytes32 from on-chain CampaignMetadataSet
  auctionMechanism?: "second-price" | "solo" | "floor";
  clearingCpmPlanck?: string;
  ipfsGateway?: string;
  currencySymbol?: string;
  onReport?: () => void;
}

const SLOT_ID = "datum-ad-slot";

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function formatCpm(planckStr?: string): string {
  if (!planckStr) return "?";
  try {
    const planck = BigInt(planckStr);
    const dot = Number(planck) / 1e10;
    if (dot >= 0.01) return dot.toFixed(2);
    if (dot >= 0.001) return dot.toFixed(3);
    return dot.toFixed(4);
  } catch {
    return "?";
  }
}

/**
 * Resolve an image URL for rendering. Accepts:
 * - Full HTTPS URL: returned as-is
 * - IPFS CID (Qm...): resolved via gateway
 * Returns null if URL is unsafe.
 */
function resolveImageUrl(imageUrl: string, gateway?: string): string | null {
  // Full HTTPS URL
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol === "https:") return parsed.href;
  } catch { /* not a full URL */ }

  // IPFS CID (Qm...)
  if (imageUrl.startsWith("Qm") && imageUrl.length >= 46) {
    const gw = gateway || "https://dweb.link/ipfs/";
    const base = gw.endsWith("/") ? gw : gw + "/";
    return base + imageUrl;
  }

  return null;
}

/** Compute https://ipfs.io/ipfs/{CID} from a bytes32 metadata hash. Returns null if zero/invalid. */
function ipfsLinkFromHash(hash?: string): string | null {
  if (!hash || hash === "0x" + "0".repeat(64)) return null;
  try {
    return `https://ipfs.io/ipfs/${bytes32ToCid(hash)}`;
  } catch { return null; }
}

const MECHANISM_LABELS: Record<string, { label: string; color: string }> = {
  "second-price": { label: "2nd Price", color: "#60a0ff" },
  "solo": { label: "Solo", color: "#c09060" },
  "floor": { label: "Floor", color: "#888" },
};

/** Render a small mechanism badge for the campaign footer line. Returns empty string if no mechanism set. */
function mechanismBadgeHtml(mechanism?: string): string {
  if (!mechanism) return "";
  const mech = MECHANISM_LABELS[mechanism];
  if (!mech) return "";
  return ` <span style="color:${mech.color};border:1px solid ${mech.color}33;padding:0 3px;border-radius:2px;font-size:9px;margin-left:4px;">${mech.label}</span>`;
}

/** Render report + close buttons for ad header. */
function headerButtonsHtml(hasReport: boolean): string {
  const reportBtn = hasReport
    ? `<button class="datum-report" style="
        background:none;border:none;color:#999;cursor:pointer;
        font-size:10px;line-height:1;padding:0 4px;font-family:system-ui,sans-serif;
      ">Report</button>`
    : "";
  return `${reportBtn}<button class="datum-close" style="
    background:none;border:none;color:#888;cursor:pointer;
    font-size:16px;line-height:1;padding:0 2px;
  ">&#x2715;</button>`;
}

export function injectAdSlot(config: AdSlotConfig): HTMLElement | null {
  // Don't inject twice
  if (document.getElementById(SLOT_ID)) return null;

  const host = document.createElement("div");
  host.id = SLOT_ID;
  host.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 2147483647;
  `;

  // Shadow DOM: isolates ad content from host page CSS/JS (XM-9: closed mode)
  const shadow = host.attachShadow({ mode: "closed" });

  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
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
  const mech = config.auctionMechanism ? MECHANISM_LABELS[config.auctionMechanism] : null;

  // Earning footer
  const earningHtml = config.clearingCpmPlanck
    ? `<div style="color:#60a060;font-size:10px;margin-top:4px;">
         Earning: ${formatCpm(config.clearingCpmPlanck)} ${config.currencySymbol ?? "DOT"}/1000 views
         ${mech ? `<span style="color:${mech.color};margin-left:4px;border:1px solid ${mech.color}33;padding:0 4px;border-radius:2px;font-size:9px;">${mech.label}</span>` : ""}
       </div>`
    : "";

  if (meta?.creative) {
    const c = meta.creative;
    const safeUrl = sanitizeCtaUrl(c.ctaUrl);
    const imageUrl = c.imageUrl ? resolveImageUrl(c.imageUrl, config.ipfsGateway) : null;

    // CTA: clickable <a> if URL passes, non-clickable <span> otherwise
    const ctaHtml = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" style="
          display:inline-block;background:#2a2a5a;color:#a0a0ff;
          border:1px solid #4a4a8a;border-radius:4px;
          padding:6px 14px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;
        ">${escapeHtml(c.cta)} &rarr;</a>`
      : `<span style="
          display:inline-block;background:#2a2a5a;color:#888;
          border:1px solid #4a4a8a;border-radius:4px;
          padding:6px 14px;font-size:12px;
        ">${escapeHtml(c.cta)}</span>`;

    // Creative image (HTTPS only, max 280px wide, constrained height)
    const imageHtml = imageUrl
      ? `<img src="${escapeHtml(imageUrl)}" alt="" style="
          max-width:100%;max-height:160px;border-radius:4px;margin-bottom:8px;
          display:block;object-fit:cover;
        " class="datum-ad-img" />`
      : "";

    wrapper.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:600;color:#a0a0ff;font-size:11px;letter-spacing:0.5px;">DATUM</span>
        <div style="display:flex;align-items:center;gap:2px;">
          ${headerButtonsHtml(!!config.onReport)}
        </div>
      </div>
      ${imageHtml}
      <div style="color:#e0e0e0;font-size:14px;font-weight:600;margin-bottom:4px;line-height:1.3;">
        ${escapeHtml(meta.title)}
      </div>
      <div style="color:#bbb;font-size:12px;margin-bottom:10px;line-height:1.4;">
        ${escapeHtml(c.text)}
      </div>
      <div style="margin-bottom:6px;">
        ${ctaHtml}
      </div>
      <div style="color:#555;font-size:10px;margin-top:6px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Privacy-preserving · Polkadot Hub
      </div>
      ${earningHtml}
    `;
  } else {
    const ipfsLink = ipfsLinkFromHash(config.metadataHash);
    wrapper.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
        <div style="display:flex;align-items:center;gap:2px;">
          ${headerButtonsHtml(!!config.onReport)}
        </div>
      </div>
      <div style="color:#ccc;font-size:12px;margin-bottom:6px;">
        Earning for browsing: <strong style="color:#a0a0ff;">${escapeHtml(config.category)}</strong>
      </div>
      <div style="color:#666;font-size:11px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Publisher ad
      </div>
      <div style="color:#555;font-size:10px;margin-top:4px;">
        Privacy-preserving · Polkadot Hub
      </div>
      ${ipfsLink ? `<div style="margin-top:6px;">
        <a href="${escapeHtml(ipfsLink)}" target="_blank" rel="noopener" style="
          display:inline-block;background:#2a2a5a;color:#a0a0ff;
          border:1px solid #4a4a8a;border-radius:4px;
          padding:4px 10px;font-size:11px;text-decoration:none;cursor:pointer;
        ">View Ad Details &rarr;</a>
      </div>` : ""}
      ${earningHtml}
    `;
  }

  shadow.appendChild(wrapper);
  document.body.appendChild(host);

  // XL-3: Programmatic error handler instead of inline onerror attribute
  shadow.querySelectorAll(".datum-ad-img").forEach((img: Element) => {
    (img as HTMLImageElement).onerror = () => { (img as HTMLElement).style.display = "none"; };
  });

  // Close button via shadow DOM query
  shadow.querySelector(".datum-close")?.addEventListener("click", () => {
    host.remove();
  });

  // Report button: block campaign + remove ad
  shadow.querySelector(".datum-report")?.addEventListener("click", () => {
    config.onReport?.();
    host.remove();
  });

  return host;
}

/**
 * Inject an ad inline into a publisher-provided target element (e.g. <div id="datum-ad-slot">).
 * Uses Shadow DOM for isolation. Does not use fixed positioning — renders in-flow.
 */
export function injectAdSlotInline(target: HTMLElement, config: AdSlotConfig): HTMLElement | null {
  // XM-9: closed shadow DOM — store ref on element since .shadowRoot returns null for closed
  const shadow = (target as any).__datumShadow ?? target.attachShadow({ mode: "closed" });
  (target as any).__datumShadow = shadow;

  // Don't inject twice
  if (shadow.querySelector(".datum-inline-wrapper")) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "datum-inline-wrapper";
  wrapper.style.cssText = `
    background: #1a1a2e;
    color: #e0e0e0;
    border: 1px solid #4a4a8a;
    border-radius: 8px;
    padding: 12px 16px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    max-width: 728px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;

  const meta = config.metadata;
  const mech = config.auctionMechanism ? MECHANISM_LABELS[config.auctionMechanism] : null;

  const earningHtml = config.clearingCpmPlanck
    ? `<div style="color:#60a060;font-size:10px;margin-top:4px;">
         Earning: ${formatCpm(config.clearingCpmPlanck)} ${config.currencySymbol ?? "DOT"}/1000 views
         ${mech ? `<span style="color:${mech.color};margin-left:4px;border:1px solid ${mech.color}33;padding:0 4px;border-radius:2px;font-size:9px;">${mech.label}</span>` : ""}
       </div>`
    : "";

  if (meta?.creative) {
    const c = meta.creative;
    const safeUrl = sanitizeCtaUrl(c.ctaUrl);
    const imageUrl = c.imageUrl ? resolveImageUrl(c.imageUrl, config.ipfsGateway) : null;
    const ctaHtml = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" style="
          display:inline-block;background:#2a2a5a;color:#a0a0ff;
          border:1px solid #4a4a8a;border-radius:4px;
          padding:6px 14px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;
        ">${escapeHtml(c.cta)} &rarr;</a>`
      : `<span style="
          display:inline-block;background:#2a2a5a;color:#888;
          border:1px solid #4a4a8a;border-radius:4px;
          padding:6px 14px;font-size:12px;
        ">${escapeHtml(c.cta)}</span>`;

    const imageHtml = imageUrl
      ? `<img src="${escapeHtml(imageUrl)}" alt="" style="
          max-width:100%;max-height:200px;border-radius:4px;margin-bottom:8px;
          display:block;object-fit:cover;
        " class="datum-ad-img" />`
      : "";

    wrapper.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:600;color:#a0a0ff;font-size:11px;letter-spacing:0.5px;">DATUM</span>
        <div style="display:flex;align-items:center;gap:4px;">
          ${config.onReport ? `<button class="datum-report" style="
            background:none;border:none;color:#999;cursor:pointer;
            font-size:10px;line-height:1;padding:0 4px;font-family:system-ui,sans-serif;
          ">Report</button>` : ""}
          <span style="color:#555;font-size:10px;">Inline &middot; SDK</span>
        </div>
      </div>
      ${imageHtml}
      <div style="color:#e0e0e0;font-size:14px;font-weight:600;margin-bottom:4px;line-height:1.3;">
        ${escapeHtml(meta.title)}
      </div>
      <div style="color:#bbb;font-size:12px;margin-bottom:10px;line-height:1.4;">
        ${escapeHtml(c.text)}
      </div>
      <div style="margin-bottom:6px;">
        ${ctaHtml}
      </div>
      <div style="color:#555;font-size:10px;margin-top:6px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Privacy-preserving · Polkadot Hub
      </div>
      ${earningHtml}
    `;
  } else {
    const ipfsLink = ipfsLinkFromHash(config.metadataHash);
    wrapper.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
        <div style="display:flex;align-items:center;gap:4px;">
          ${config.onReport ? `<button class="datum-report" style="
            background:none;border:none;color:#999;cursor:pointer;
            font-size:10px;line-height:1;padding:0 4px;font-family:system-ui,sans-serif;
          ">Report</button>` : ""}
          <span style="color:#555;font-size:10px;">Inline &middot; SDK</span>
        </div>
      </div>
      <div style="color:#ccc;font-size:12px;margin-bottom:6px;">
        Earning for browsing: <strong style="color:#a0a0ff;">${escapeHtml(config.category)}</strong>
      </div>
      <div style="color:#666;font-size:11px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Publisher ad
      </div>
      <div style="color:#555;font-size:10px;margin-top:4px;">
        Privacy-preserving · Polkadot Hub
      </div>
      ${ipfsLink ? `<div style="margin-top:6px;">
        <a href="${escapeHtml(ipfsLink)}" target="_blank" rel="noopener" style="
          display:inline-block;background:#2a2a5a;color:#a0a0ff;
          border:1px solid #4a4a8a;border-radius:4px;
          padding:4px 10px;font-size:11px;text-decoration:none;cursor:pointer;
        ">View Ad Details &rarr;</a>
      </div>` : ""}
      ${earningHtml}
    `;
  }

  shadow.appendChild(wrapper);

  // XL-3: Programmatic error handler instead of inline onerror attribute
  shadow.querySelectorAll(".datum-ad-img").forEach((img: Element) => {
    (img as HTMLImageElement).onerror = () => { (img as HTMLElement).style.display = "none"; };
  });

  // Report button: block campaign + remove inline ad content
  shadow.querySelector(".datum-report")?.addEventListener("click", () => {
    config.onReport?.();
    wrapper.remove();
  });

  return target;
}

const HOUSE_AD_MESSAGES: string[] = [
  "In a world of algorithmic noise, truth should be verifiable — not just asserted. Polkadot builds infrastructure where claims can be proven, not just trusted.",
  "Sovereignty isn't granted by platforms — it's exercised by individuals. Polkadot is built on the belief that you alone should control your identity, your data, and your choices online.",
  "Privacy is not a feature. It is the foundation of free thought, free speech, and free society. Polkadot exists to restore it.",
  "Every click tracked, every preference profiled, every identity harvested. Polkadot is the alternative — a web where you participate on your own terms, verifiably and without compromise.",
  "When truth becomes optional and trust is manufactured, the only antidote is a system no one controls. Polkadot makes the web provably honest again.",
  "Your data. Your rules. Your truth. Polkadot builds the web that puts agency back in your hands.",
  "Freedom requires infrastructure. Individual agency means nothing without systems that enforce it. Polkadot is that infrastructure — resilient, open, and resistant to capture by any single authority.",
  "The web was built on consent that was never really given. Polkadot is rebuilding it on consent that is cryptographically guaranteed.",
  "You have the right to know what is true. You have the right to decide who to trust. Polkadot protects both — without asking permission from anyone.",
  "Surveillance is not security. It is control. Polkadot is built for a world where neither governments nor corporations can surveil their way to power.",
  "Post-truth is not a philosophy. It is what happens when the infrastructure of trust is owned by those with the most to gain from distorting it. Polkadot changes who owns the infrastructure.",
  "Resilient societies need resilient systems. Systems that cannot be captured, corrupted, or silenced. That is what Polkadot builds.",
  "Your attention, your identity, your beliefs — these are not products to be harvested. Polkadot is built on the premise that human dignity is non-negotiable online.",
  "No single point of control. No single point of failure. No single authority over truth. This is what the web was supposed to be.",
  "Privacy, sovereignty, and verifiable truth are not radical ideas. They are the original promises of the open web. Polkadot is here to keep them.",
];

function pickHouseAdMessage(): string {
  const index = Math.floor(Date.now() / 1000) % HOUSE_AD_MESSAGES.length;
  return HOUSE_AD_MESSAGES[index];
}

/**
 * Inject a default/house ad when no campaigns match.
 * Points to Polkadot philosophy page. No earning, no campaign tracking.
 * Rotates through 15 messages on each page load.
 */
export function injectDefaultAd(): HTMLElement | null {
  if (document.getElementById(SLOT_ID)) return null;

  const host = document.createElement("div");
  host.id = SLOT_ID;
  host.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 2147483647;
  `;

  // XM-9: closed shadow DOM
  const shadow = host.attachShadow({ mode: "closed" });

  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
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

  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
      <button class="datum-close" style="
        background:none;border:none;color:#888;cursor:pointer;
        font-size:16px;line-height:1;padding:0 2px;
      ">&#x2715;</button>
    </div>
    <div style="color:#e0e0e0;font-size:13px;font-weight:600;margin-bottom:4px;">
      A better web is possible
    </div>
    <div style="color:#bbb;font-size:12px;margin-bottom:8px;">
      ${escapeHtml(pickHouseAdMessage())}
    </div>
    <a href="https://polkadot.com/philosophy" target="_blank" rel="noopener" style="
      display:inline-block;background:#2a2a5a;color:#a0a0ff;
      border:1px solid #4a4a8a;border-radius:4px;
      padding:6px 12px;font-size:12px;text-decoration:none;cursor:pointer;
    ">Learn More</a>
    <div style="color:#555;font-size:10px;margin-top:6px;">
      No campaigns available &middot; Powered by DATUM on Polkadot Hub
    </div>
  `;

  shadow.appendChild(wrapper);
  document.body.appendChild(host);

  shadow.querySelector(".datum-close")?.addEventListener("click", () => {
    host.remove();
  });

  return host;
}

/**
 * Inject a default/house ad inline into a publisher-provided target element.
 * Points to Polkadot philosophy page. No earning, no campaign tracking.
 */
export function injectDefaultAdInline(target: HTMLElement): HTMLElement | null {
  // XM-9: closed shadow DOM — reuse stored ref
  const existing = (target as any).__datumShadow;
  if (existing?.querySelector(".datum-inline-wrapper")) return null;

  const shadow = existing ?? target.attachShadow({ mode: "closed" });
  (target as any).__datumShadow = shadow;

  const wrapper = document.createElement("div");
  wrapper.className = "datum-inline-wrapper";
  wrapper.style.cssText = `
    background: #1a1a2e;
    color: #e0e0e0;
    border: 1px solid #4a4a8a;
    border-radius: 8px;
    padding: 12px 16px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    max-width: 728px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;

  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-weight:600;color:#a0a0ff;">DATUM</span>
      <span style="color:#555;font-size:10px;">Inline &middot; SDK</span>
    </div>
    <div style="color:#e0e0e0;font-size:13px;font-weight:600;margin-bottom:4px;">
      A better web is possible
    </div>
    <div style="color:#bbb;font-size:12px;margin-bottom:8px;">
      ${escapeHtml(pickHouseAdMessage())}
    </div>
    <a href="https://polkadot.com/philosophy" target="_blank" rel="noopener" style="
      display:inline-block;background:#2a2a5a;color:#a0a0ff;
      border:1px solid #4a4a8a;border-radius:4px;
      padding:6px 12px;font-size:12px;text-decoration:none;cursor:pointer;
    ">Learn More</a>
    <div style="color:#555;font-size:10px;margin-top:6px;">
      No campaigns available &middot; Powered by DATUM on Polkadot Hub
    </div>
  `;

  shadow.appendChild(wrapper);
  return target;
}

export function removeAdSlot(): void {
  document.getElementById(SLOT_ID)?.remove();
}
