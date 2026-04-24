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
  /** bytes32 nonce from the view impression; enables click (type-1) claim */
  impressionNonce?: string;
  /** Called when user clicks the CTA (isTrusted + 500ms dwell guard applied in adSlot) */
  onCtaClick?: () => void;
  /** Mute this campaign for the user (no on-chain tx) */
  onReport?: () => void;
  /** Submit on-chain reportAd(campaignId, reason) */
  onReportAd?: (reason: number) => void;
  /** Submit on-chain reportPage(campaignId, reason) */
  onReportPage?: (reason: number) => void;
  /** Hide ads from this topic tag */
  onHideTopic?: () => void;
  /** Downvote ad interest score */
  onNotInterested?: () => void;
  /** First topic tag label for "Hide [topic] ads" button */
  topicLabel?: string;
}

const SLOT_ID = "datum-ad-slot";

// ── Reason codes ──────────────────────────────────────────────────────────────

const REPORT_REASONS: { code: number; label: string }[] = [
  { code: 1, label: "Misleading or false information" },
  { code: 2, label: "Spam or irrelevant" },
  { code: 3, label: "Offensive or harmful content" },
  { code: 4, label: "Fraud or scam" },
  { code: 5, label: "Other" },
];

// ── Design tokens (Datum brand, more pronounced than host page) ───────────────

const D = {
  bg:          "#10101f",
  bgCard:      "linear-gradient(160deg,#111128 0%,#191932 100%)",
  border:      "#5a5ab5",
  borderGlow:  "rgba(90,90,200,0.22)",
  accent:      "#b0b0ff",
  accentDim:   "#7a7aee",
  accentBtn:   "#2a2a58",
  accentBtnHover: "#363672",
  text:        "#e2e2f0",
  textMuted:   "#888",
  textFaint:   "#555",
  earning:     "#60c060",
  danger:      "#ff6b6b",
  dangerBtn:   "#3a1818",
  dangerBtnHover: "#4a2020",
  overlay:     "rgba(8,8,22,0.96)",
  radius:      "10px",
  radiusSm:    "6px",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  } catch { return "?"; }
}

function resolveImageUrl(imageUrl: string, gateway?: string): string | null {
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol === "https:") return parsed.href;
  } catch { /* not a full URL */ }
  if (imageUrl.startsWith("Qm") && imageUrl.length >= 46) {
    const gw = gateway || "https://dweb.link/ipfs/";
    return (gw.endsWith("/") ? gw : gw + "/") + imageUrl;
  }
  return null;
}

function ipfsLinkFromHash(hash?: string): string | null {
  if (!hash || hash === "0x" + "0".repeat(64)) return null;
  try { return `https://ipfs.io/ipfs/${bytes32ToCid(hash)}`; } catch { return null; }
}

const MECHANISM_LABELS: Record<string, { label: string; color: string }> = {
  "second-price": { label: "2nd Price", color: "#60a0ff" },
  "solo":         { label: "Solo",      color: "#c09060" },
  "floor":        { label: "Floor",     color: "#888"    },
};

function mechanismBadgeHtml(mechanism?: string): string {
  if (!mechanism) return "";
  const mech = MECHANISM_LABELS[mechanism];
  if (!mech) return "";
  return ` <span style="color:${mech.color};border:1px solid ${mech.color}33;padding:0 3px;border-radius:2px;font-size:9px;margin-left:4px;">${mech.label}</span>`;
}

// ── Overlay menu (report / hide) ──────────────────────────────────────────────

/**
 * Build and attach a full-cover overlay inside the shadow DOM.
 * Triggered by the Report button. Gives the user 3 top-level options,
 * with a reason-code picker for on-chain reports.
 */
function attachReportOverlay(
  shadow: ShadowRoot,
  wrapper: HTMLElement,
  host: HTMLElement,
  config: AdSlotConfig,
): void {
  // Ensure wrapper is a positioning context
  wrapper.style.position = "relative";
  wrapper.style.overflow = "hidden";

  // ── Overlay shell ──
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: absolute;
    inset: 0;
    z-index: 50;
    background: ${D.overlay};
    border-radius: ${D.radius};
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 14px 14px 12px;
    font-family: system-ui, -apple-system, sans-serif;
    box-sizing: border-box;
  `;

  // ── Header row shared by all screens ──
  function makeHeader(title: string): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    `;
    const label = document.createElement("span");
    label.style.cssText = `
      color: ${D.accent}; font-size: 11px; font-weight: 700;
      letter-spacing: 1px; text-transform: uppercase;
    `;
    label.textContent = "DATUM";
    const titleEl = document.createElement("span");
    titleEl.style.cssText = `color: ${D.text}; font-size: 12px; font-weight: 500;`;
    titleEl.textContent = title;
    row.appendChild(label);
    row.appendChild(titleEl);
    return row;
  }

  // ── Button factory ──
  function makeBtn(
    text: string,
    opts: { danger?: boolean; ghost?: boolean; small?: boolean } = {},
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = text;
    const bg   = opts.danger ? D.dangerBtn   : opts.ghost ? "transparent" : D.accentBtn;
    const col  = opts.danger ? D.danger       : opts.ghost ? D.textMuted   : D.accent;
    const brd  = opts.danger ? "#6a1a1a"     : opts.ghost ? "transparent"  : D.border + "55";
    btn.style.cssText = `
      display: block; width: 100%; text-align: left; cursor: pointer;
      background: ${bg}; color: ${col};
      border: 1px solid ${brd}; border-radius: ${D.radiusSm};
      padding: ${opts.small ? "5px 10px" : "8px 12px"};
      font-size: ${opts.small ? "11px" : "12px"}; font-family: inherit;
      margin-bottom: 6px; transition: background 0.12s;
    `;
    btn.addEventListener("mouseenter", () => {
      btn.style.background = opts.danger ? D.dangerBtnHover : opts.ghost ? "rgba(255,255,255,0.05)" : D.accentBtnHover;
    });
    btn.addEventListener("mouseleave", () => { btn.style.background = bg; });
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  // ── Screen 1: main options ──
  function showMain(): void {
    overlay.innerHTML = "";
    overlay.appendChild(makeHeader("Ad options"));

    overlay.appendChild(makeBtn("Hide this ad", {}, () => {
      config.onReport?.();
      host.remove();
    }));

    if (config.topicLabel && config.onHideTopic) {
      const topicLabel = config.topicLabel;
      overlay.appendChild(makeBtn(`Hide "${topicLabel}" ads`, {}, () => {
        config.onHideTopic!();
        host.remove();
      }));
    }

    if (config.onNotInterested) {
      overlay.appendChild(makeBtn("Not interested", { ghost: true }, () => {
        config.onNotInterested!();
        overlay.remove();
      }));
    }

    if (config.onReportAd) {
      overlay.appendChild(makeBtn("Report this ad →", { danger: true }, () => showReasons("ad")));
    }

    if (config.onReportPage) {
      overlay.appendChild(makeBtn("Report publisher / page →", { danger: true }, () => showReasons("page")));
    }

    const cancel = makeBtn("Cancel", { ghost: true }, () => overlay.remove());
    cancel.style.marginTop = "2px";
    overlay.appendChild(cancel);
  }

  // ── Screen 2: reason picker ──
  function showReasons(target: "ad" | "page"): void {
    overlay.innerHTML = "";
    const title = target === "ad" ? "Why report this ad?" : "Why report this page?";
    overlay.appendChild(makeHeader(title));

    for (const { code, label } of REPORT_REASONS) {
      overlay.appendChild(makeBtn(`${code}. ${label}`, { small: true }, () => {
        if (target === "ad") {
          config.onReportAd!(code);
        } else {
          config.onReportPage!(code);
        }
        // Show brief confirmation then remove
        showConfirmation();
      }));
    }

    const back = makeBtn("← Back", { ghost: true }, showMain);
    overlay.appendChild(back);
  }

  // ── Screen 3: confirmation ──
  function showConfirmation(): void {
    overlay.innerHTML = "";
    const msg = document.createElement("div");
    msg.style.cssText = `
      color: ${D.accent}; font-size: 12px; text-align: center;
      padding: 20px 0; font-weight: 500;
    `;
    msg.textContent = "Report submitted. Thank you.";
    overlay.appendChild(msg);
    setTimeout(() => host.remove(), 1400);
  }

  // Hook the shadow's .datum-report button — overlay only opens on click
  shadow.querySelector(".datum-report")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (wrapper.contains(overlay)) {
      overlay.remove();
    } else {
      showMain();
      wrapper.appendChild(overlay);
    }
  });
}

// ── Shared wrapper styles ─────────────────────────────────────────────────────

function wrapperStyles(maxWidth: string, fixedHeight = false): string {
  return `
    background: ${D.bgCard};
    color: ${D.text};
    border: 1.5px solid ${D.border};
    border-top: 2.5px solid ${D.accentDim};
    border-radius: ${D.radius};
    padding: 12px 14px 10px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    max-width: ${maxWidth};
    box-shadow: 0 4px 24px ${D.borderGlow}, 0 0 0 1px rgba(100,100,255,0.07);
    position: relative;
    ${fixedHeight ? "min-height: 100px;" : ""}
  `;
}

function datumBadge(): string {
  return `<span style="
    font-weight: 700; color: ${D.accent}; font-size: 10px;
    letter-spacing: 1.2px; text-transform: uppercase;
  ">◆ DATUM</span>`;
}

function reportBtnHtml(): string {
  return `<button class="datum-report" style="
    background: none; border: none; color: ${D.textMuted}; cursor: pointer;
    font-size: 10px; line-height: 1; padding: 2px 6px;
    font-family: inherit; border-radius: 3px;
    transition: color 0.12s;
  " title="Report or hide this ad">⚑ Report</button>`;
}

function closeBtnHtml(): string {
  return `<button class="datum-close" style="
    background: none; border: none; color: ${D.textFaint}; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 0 2px;
  " title="Close">&#x2715;</button>`;
}

function earningHtml(cpm?: string, symbol?: string, mech?: { label: string; color: string }): string {
  if (!cpm) return "";
  return `<div style="color:${D.earning};font-size:10px;margin-top:6px;">
    Earning: ${formatCpm(cpm)} ${symbol ?? "DOT"}/1000 views
    ${mech ? `<span style="color:${mech.color};margin-left:4px;border:1px solid ${mech.color}33;padding:0 4px;border-radius:2px;font-size:9px;">${mech.label}</span>` : ""}
  </div>`;
}

// ── CTA click capture (type-1 / CPC) ─────────────────────────────────────────

/**
 * Attaches a click listener to the CTA <a> inside a shadow root.
 * Guards:
 *  - isTrusted (blocks synthetic clicks)
 *  - 500ms minimum dwell time since adInjectedAt
 */
function attachCtaClickCapture(shadow: ShadowRoot, config: AdSlotConfig, adInjectedAt: number): void {
  if (!config.onCtaClick) return;
  const cta = shadow.querySelector("a[target='_blank']") as HTMLAnchorElement | null;
  if (!cta) return;
  cta.addEventListener("click", (e: MouseEvent) => {
    if (!e.isTrusted) return; // block synthetic clicks
    if (Date.now() - adInjectedAt < 500) return; // 500ms dwell guard
    config.onCtaClick!();
  });
}

// ── injectAdSlot (fixed overlay) ──────────────────────────────────────────────

export function injectAdSlot(config: AdSlotConfig): HTMLElement | null {
  if (document.getElementById(SLOT_ID)) return null;

  const host = document.createElement("div");
  host.id = SLOT_ID;
  host.style.cssText = `
    position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
  `;

  const shadow = host.attachShadow({ mode: "closed" });
  const wrapper = document.createElement("div");
  wrapper.style.cssText = wrapperStyles("300px");

  const meta = config.metadata;
  const mech = config.auctionMechanism ? MECHANISM_LABELS[config.auctionMechanism] : null;

  const headerControls = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      ${datumBadge()}
      <div style="display:flex;align-items:center;gap:2px;">
        ${config.onReport || config.onReportAd || config.onReportPage ? reportBtnHtml() : ""}
        ${closeBtnHtml()}
      </div>
    </div>
  `;

  if (meta?.creative) {
    const c = meta.creative;
    const safeUrl = sanitizeCtaUrl(c.ctaUrl);
    const imgUrl = c.imageUrl ? resolveImageUrl(c.imageUrl, config.ipfsGateway) : null;

    const ctaHtml = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" style="
          display:inline-block;background:${D.accentBtn};color:${D.accent};
          border:1px solid ${D.border}55;border-radius:${D.radiusSm};
          padding:6px 14px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;
        ">${escapeHtml(c.cta)} →</a>`
      : `<span style="
          display:inline-block;background:${D.accentBtn};color:${D.textMuted};
          border:1px solid ${D.border}33;border-radius:${D.radiusSm};
          padding:6px 14px;font-size:12px;
        ">${escapeHtml(c.cta)}</span>`;

    const imgHtml = imgUrl
      ? `<img src="${escapeHtml(imgUrl)}" alt="" style="
          max-width:100%;max-height:150px;border-radius:${D.radiusSm};
          margin-bottom:8px;display:block;object-fit:cover;
        " class="datum-ad-img" />`
      : "";

    wrapper.innerHTML = `
      ${headerControls}
      ${imgHtml}
      <div style="color:${D.text};font-size:14px;font-weight:600;margin-bottom:4px;line-height:1.3;">
        ${escapeHtml(meta.title)}
      </div>
      <div style="color:#bbb;font-size:12px;margin-bottom:10px;line-height:1.4;">
        ${escapeHtml(c.text)}
      </div>
      <div style="margin-bottom:6px;">${ctaHtml}</div>
      <div style="color:${D.textFaint};font-size:10px;margin-top:6px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Privacy-preserving · Polkadot Hub
      </div>
      ${earningHtml(config.clearingCpmPlanck, config.currencySymbol, mech ?? undefined)}
    `;
  } else {
    const ipfsLink = ipfsLinkFromHash(config.metadataHash);
    wrapper.innerHTML = `
      ${headerControls}
      <div style="color:#ccc;font-size:12px;margin-bottom:6px;">
        Earning for browsing: <strong style="color:${D.accent};">${escapeHtml(config.category)}</strong>
      </div>
      <div style="color:#666;font-size:11px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Publisher ad
      </div>
      <div style="color:${D.textFaint};font-size:10px;margin-top:4px;">Privacy-preserving · Polkadot Hub</div>
      ${ipfsLink ? `<div style="margin-top:6px;">
        <a href="${escapeHtml(ipfsLink)}" target="_blank" rel="noopener" style="
          display:inline-block;background:${D.accentBtn};color:${D.accent};
          border:1px solid ${D.border}55;border-radius:${D.radiusSm};
          padding:4px 10px;font-size:11px;text-decoration:none;cursor:pointer;
        ">View Ad Details →</a>
      </div>` : ""}
      ${earningHtml(config.clearingCpmPlanck, config.currencySymbol, mech ?? undefined)}
    `;
  }

  shadow.appendChild(wrapper);
  document.body.appendChild(host);

  const injectedAt = Date.now();

  // Image error suppression (XL-3)
  shadow.querySelectorAll(".datum-ad-img").forEach((img: Element) => {
    (img as HTMLImageElement).onerror = () => { (img as HTMLElement).style.display = "none"; };
  });

  // Close button
  shadow.querySelector(".datum-close")?.addEventListener("click", () => host.remove());

  // Report overlay (replaces simple mute-and-remove)
  attachReportOverlay(shadow, wrapper, host, config);

  // CTA click capture (type-1 CPC claim)
  attachCtaClickCapture(shadow, config, injectedAt);

  return host;
}

// ── injectAdSlotInline (SDK inline slot) ──────────────────────────────────────

export function injectAdSlotInline(target: HTMLElement, config: AdSlotConfig): HTMLElement | null {
  const shadow = (target as any).__datumShadow ?? target.attachShadow({ mode: "closed" });
  (target as any).__datumShadow = shadow;
  if (shadow.querySelector(".datum-inline-wrapper")) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "datum-inline-wrapper";
  wrapper.style.cssText = wrapperStyles("728px");

  const meta = config.metadata;
  const mech = config.auctionMechanism ? MECHANISM_LABELS[config.auctionMechanism] : null;

  const headerControls = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      ${datumBadge()}
      <div style="display:flex;align-items:center;gap:4px;">
        ${config.onReport || config.onReportAd || config.onReportPage ? reportBtnHtml() : ""}
        <span style="color:${D.textFaint};font-size:10px;">Inline · SDK</span>
      </div>
    </div>
  `;

  if (meta?.creative) {
    const c = meta.creative;
    const safeUrl = sanitizeCtaUrl(c.ctaUrl);
    const imgUrl = c.imageUrl ? resolveImageUrl(c.imageUrl, config.ipfsGateway) : null;

    const ctaHtml = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" style="
          display:inline-block;background:${D.accentBtn};color:${D.accent};
          border:1px solid ${D.border}55;border-radius:${D.radiusSm};
          padding:6px 14px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;
        ">${escapeHtml(c.cta)} →</a>`
      : `<span style="
          display:inline-block;background:${D.accentBtn};color:${D.textMuted};
          border:1px solid ${D.border}33;border-radius:${D.radiusSm};
          padding:6px 14px;font-size:12px;
        ">${escapeHtml(c.cta)}</span>`;

    const imgHtml = imgUrl
      ? `<img src="${escapeHtml(imgUrl)}" alt="" style="
          max-width:100%;max-height:200px;border-radius:${D.radiusSm};
          margin-bottom:8px;display:block;object-fit:cover;
        " class="datum-ad-img" />`
      : "";

    wrapper.innerHTML = `
      ${headerControls}
      ${imgHtml}
      <div style="color:${D.text};font-size:14px;font-weight:600;margin-bottom:4px;line-height:1.3;">
        ${escapeHtml(meta.title)}
      </div>
      <div style="color:#bbb;font-size:12px;margin-bottom:10px;line-height:1.4;">
        ${escapeHtml(c.text)}
      </div>
      <div style="margin-bottom:6px;">${ctaHtml}</div>
      <div style="color:${D.textFaint};font-size:10px;margin-top:6px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Privacy-preserving · Polkadot Hub
      </div>
      ${earningHtml(config.clearingCpmPlanck, config.currencySymbol, mech ?? undefined)}
    `;
  } else {
    const ipfsLink = ipfsLinkFromHash(config.metadataHash);
    wrapper.innerHTML = `
      ${headerControls}
      <div style="color:#ccc;font-size:12px;margin-bottom:6px;">
        Earning for browsing: <strong style="color:${D.accent};">${escapeHtml(config.category)}</strong>
      </div>
      <div style="color:#666;font-size:11px;">
        Campaign #${escapeHtml(config.campaignId)}${mechanismBadgeHtml(config.auctionMechanism)} · Publisher ad
      </div>
      <div style="color:${D.textFaint};font-size:10px;margin-top:4px;">Privacy-preserving · Polkadot Hub</div>
      ${ipfsLink ? `<div style="margin-top:6px;">
        <a href="${escapeHtml(ipfsLink)}" target="_blank" rel="noopener" style="
          display:inline-block;background:${D.accentBtn};color:${D.accent};
          border:1px solid ${D.border}55;border-radius:${D.radiusSm};
          padding:4px 10px;font-size:11px;text-decoration:none;cursor:pointer;
        ">View Ad Details →</a>
      </div>` : ""}
      ${earningHtml(config.clearingCpmPlanck, config.currencySymbol, mech ?? undefined)}
    `;
  }

  shadow.appendChild(wrapper);

  const injectedAt = Date.now();

  // Image error suppression (XL-3)
  shadow.querySelectorAll(".datum-ad-img").forEach((img: Element) => {
    (img as HTMLImageElement).onerror = () => { (img as HTMLElement).style.display = "none"; };
  });

  // Report overlay (target is the host element for inline; use wrapper removal on hide)
  const inlineHost: HTMLElement = {
    ...target,
    remove: () => wrapper.remove(),
  } as unknown as HTMLElement;
  attachReportOverlay(shadow, wrapper, inlineHost, {
    ...config,
    onReport: () => { config.onReport?.(); wrapper.remove(); },
  });

  // CTA click capture (type-1 CPC claim)
  attachCtaClickCapture(shadow, config, injectedAt);

  return target;
}

// ── House / default ad ────────────────────────────────────────────────────────

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
  return HOUSE_AD_MESSAGES[Math.floor(Date.now() / 1000) % HOUSE_AD_MESSAGES.length];
}

export function injectDefaultAd(): HTMLElement | null {
  if (document.getElementById(SLOT_ID)) return null;

  const host = document.createElement("div");
  host.id = SLOT_ID;
  host.style.cssText = `position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;`;

  const shadow = host.attachShadow({ mode: "closed" });
  const wrapper = document.createElement("div");
  wrapper.style.cssText = wrapperStyles("300px");

  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      ${datumBadge()}
      ${closeBtnHtml()}
    </div>
    <div style="color:${D.text};font-size:13px;font-weight:600;margin-bottom:6px;">
      A better web is possible
    </div>
    <div style="color:#bbb;font-size:12px;margin-bottom:10px;line-height:1.5;">
      ${escapeHtml(pickHouseAdMessage())}
    </div>
    <a href="https://polkadot.com/philosophy" target="_blank" rel="noopener" style="
      display:inline-block;background:${D.accentBtn};color:${D.accent};
      border:1px solid ${D.border}55;border-radius:${D.radiusSm};
      padding:6px 12px;font-size:12px;text-decoration:none;cursor:pointer;
    ">Learn More →</a>
    <div style="color:${D.textFaint};font-size:10px;margin-top:8px;">
      No campaigns available · Powered by DATUM on Polkadot Hub
    </div>
  `;

  shadow.appendChild(wrapper);
  document.body.appendChild(host);
  shadow.querySelector(".datum-close")?.addEventListener("click", () => host.remove());
  return host;
}

export function injectDefaultAdInline(target: HTMLElement): HTMLElement | null {
  const existing = (target as any).__datumShadow;
  if (existing?.querySelector(".datum-inline-wrapper")) return null;
  const shadow = existing ?? target.attachShadow({ mode: "closed" });
  (target as any).__datumShadow = shadow;

  const wrapper = document.createElement("div");
  wrapper.className = "datum-inline-wrapper";
  wrapper.style.cssText = wrapperStyles("728px");

  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      ${datumBadge()}
      <span style="color:${D.textFaint};font-size:10px;">Inline · SDK</span>
    </div>
    <div style="color:${D.text};font-size:13px;font-weight:600;margin-bottom:6px;">
      A better web is possible
    </div>
    <div style="color:#bbb;font-size:12px;margin-bottom:10px;line-height:1.5;">
      ${escapeHtml(pickHouseAdMessage())}
    </div>
    <a href="https://polkadot.com/philosophy" target="_blank" rel="noopener" style="
      display:inline-block;background:${D.accentBtn};color:${D.accent};
      border:1px solid ${D.border}55;border-radius:${D.radiusSm};
      padding:6px 12px;font-size:12px;text-decoration:none;cursor:pointer;
    ">Learn More →</a>
    <div style="color:${D.textFaint};font-size:10px;margin-top:8px;">
      No campaigns available · Powered by DATUM on Polkadot Hub
    </div>
  `;

  shadow.appendChild(wrapper);
  return target;
}

export function removeAdSlot(): void {
  document.getElementById(SLOT_ID)?.remove();
}
