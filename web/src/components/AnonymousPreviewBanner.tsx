// AnonymousPreviewBanner — sits above the dashboard hero on the
// per-address surfaces (/me, /publisher, /advertiser) when no
// wallet is connected. The dashboard itself still renders via
// pine so visitors can see the system in motion before installing
// anything. The banner explains what's personalized vs. global.

export function AnonymousPreviewBanner({
  surface,
}: {
  surface: "me" | "publisher" | "advertiser";
}) {
  const verb = SURFACE_COPY[surface];
  return (
    <div
      role="status"
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius, 4px)",
        background: "var(--bg-surface)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ color: "var(--text-strong)", fontSize: 13, fontWeight: 600 }}>
        Preview mode — no wallet connected
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.4 }}>
        The activity stream below is live for the whole network.{" "}
        Per-address stats ({verb}) appear once you connect a DATUM wallet.
      </div>
    </div>
  );
}

const SURFACE_COPY: Record<"me" | "publisher" | "advertiser", string> = {
  me: "balance, claims, settlements",
  publisher: "earnings, stake, take-rate",
  advertiser: "your campaigns, spend, claims",
};
