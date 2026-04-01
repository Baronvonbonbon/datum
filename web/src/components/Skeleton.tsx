/** Animated loading text with bouncing dots. */
export function LoadingText({ text = "Loading" }: { text?: string }) {
  return (
    <span className="nano-pending-text" style={{ color: "var(--text-muted)", fontSize: 13 }}>
      {text}<span className="nano-pending-dots"><span>.</span><span>.</span><span>.</span></span>
    </span>
  );
}

/** Shimmer placeholder for loading states. Uses the .nano-skeleton CSS class. */
export function Skeleton({ width, height = 16, style }: { width?: number | string; height?: number | string; style?: React.CSSProperties }) {
  return (
    <div
      className="nano-skeleton"
      style={{ width: width ?? "100%", height, display: "inline-block", ...style }}
    />
  );
}

/** Stat card placeholder matching the Overview grid. */
export function StatCardSkeleton() {
  return (
    <div className="nano-card" style={{ padding: "16px 18px" }}>
      <Skeleton width={80} height={11} style={{ marginBottom: 8 }} />
      <Skeleton width={48} height={22} />
    </div>
  );
}

/** Table row placeholder. */
export function TableRowSkeleton({ columns = 3 }: { columns?: number }) {
  return (
    <tr>
      {Array.from({ length: columns }, (_, i) => (
        <td key={i} style={{ padding: "9px 12px" }}>
          <Skeleton width={i === 0 ? 60 : 80} height={14} />
        </td>
      ))}
    </tr>
  );
}
