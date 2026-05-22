// Dashboard — shared template per design doc §6.
//
//   +--------------------------------------------------+
//   | HERO STATS                                       |
//   |   4–6 big-number cards                           |
//   +--------------------------------------------------+
//   | TELEMETRY STREAM                                 |
//   |   rolling event window                           |
//   +--------------------------------------------------+
//   | ACTION HOOKS                                     |
//   |   2–4 buttons                                    |
//   +--------------------------------------------------+
//
// Per-section config is passed in; the template owns layout +
// loading states only. Each section renders an empty placeholder
// when its config is absent so a dashboard can ship hero-only,
// stream-only, or any combination.

import { Link } from "react-router-dom";
import { useHeroStat, type HeroStat } from "../hooks/useHeroStat";
import {
  useTelemetryStream,
  type TelemetryStreamOpts,
  type StreamRow,
} from "../hooks/useTelemetryStream";

export type ActionHook = {
  label: string;
  /// Router target. Most actions go to `/role/page` paths.
  route: string;
  /// Optional gating predicate. The button hides when this returns
  /// false. Useful for "Stake DOT" buttons that only appear when
  /// the user isn't staked yet.
  when?: () => boolean;
  /// Secondary description rendered under the label on wide screens.
  description?: string;
};

export type DashboardProps = {
  /// Page heading, rendered above the hero strip.
  title: string;
  /// Free-form subtitle (optional).
  subtitle?: string;
  /// 1–6 cards. More than 6 wraps to a second row.
  heroStats?: HeroStat[];
  /// Multi-source event feed config.
  stream?: TelemetryStreamOpts;
  /// 0–4 primary action buttons.
  actions?: ActionHook[];
};

export function Dashboard({
  title,
  subtitle,
  heroStats,
  stream,
  actions,
}: DashboardProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ marginBottom: 4 }}>
        <h1
          style={{
            color: "var(--text-strong)",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "0.01em",
            margin: 0,
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
            {subtitle}
          </div>
        )}
      </header>

      {heroStats && heroStats.length > 0 && <HeroStatsRow stats={heroStats} />}

      {stream && <TelemetryStreamPanel opts={stream} />}

      {actions && actions.length > 0 && <ActionHooksRow actions={actions} />}
    </div>
  );
}

// ─── Hero stats ───────────────────────────────────────────────────

function HeroStatsRow({ stats }: { stats: HeroStat[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 12,
      }}
    >
      {stats.map((s, i) => (
        <HeroStatCard key={`${s.label}-${i}`} stat={s} />
      ))}
    </div>
  );
}

function HeroStatCard({ stat }: { stat: HeroStat }) {
  const state = useHeroStat(stat);
  const content = (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: stat.link ? "pointer" : "default",
      }}
    >
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 10,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
        }}
      >
        {stat.label}
      </div>
      <div
        style={{
          color: "var(--text-strong)",
          fontSize: 24,
          fontWeight: 600,
          fontFamily: "var(--font-mono, ui-monospace)",
          lineHeight: 1.1,
          minHeight: 26,
        }}
      >
        {state.error ? "—" : state.formatted}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 16,
        }}
      >
        {state.delta && <DeltaChip delta={state.delta} />}
        {state.sparkline && state.sparkline.length > 1 && (
          <Sparkline values={state.sparkline} />
        )}
      </div>
    </div>
  );
  if (stat.link) {
    return (
      <Link to={stat.link} style={{ textDecoration: "none" }}>
        {content}
      </Link>
    );
  }
  return content;
}

function DeltaChip({ delta }: { delta: { value: number | bigint; sign: "up" | "down" | "flat" } }) {
  const color =
    delta.sign === "up" ? "var(--ok)" : delta.sign === "down" ? "var(--error)" : "var(--text-muted)";
  const arrow = delta.sign === "up" ? "↑" : delta.sign === "down" ? "↓" : "→";
  return (
    <span style={{ color, fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}>
      {arrow} {String(delta.value)}
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  // Inline SVG polyline normalized to the bounding box. We don't
  // bother with axes / labels — these are decoration to convey
  // direction; the hero number carries the precise value.
  const width = 80;
  const height = 18;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Telemetry stream ─────────────────────────────────────────────

function TelemetryStreamPanel({ opts }: { opts: TelemetryStreamOpts }) {
  const { rows, ready, viaRpc, truncatedTo } = useTelemetryStream(opts);
  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "12px 14px",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            color: "var(--text-strong)",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Recent activity
        </div>
        {viaRpc && <ViaRpcBadge />}
      </header>
      {truncatedTo !== undefined && (
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 10,
            marginBottom: 6,
            fontStyle: "italic",
          }}
        >
          History begins at block {truncatedTo}.
        </div>
      )}
      {!ready ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "12px 4px" }}>
          Syncing…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "12px 4px" }}>
          No recent events in this window.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {rows.slice(0, 50).map((row) => (
            <StreamRowView key={row.id} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function StreamRowView({ row }: { row: StreamRow }) {
  const content = (
    <div
      style={{
        padding: "8px 0",
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 10,
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          color: "var(--text-muted)",
          fontSize: 10,
          fontFamily: "var(--font-mono, ui-monospace)",
          minWidth: 80,
        }}
      >
        {formatRelativeTime(row.ts)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: "var(--text-strong)",
            fontSize: 12,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {row.title}
        </div>
        {row.subtitle && (
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: 11,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {row.subtitle}
          </div>
        )}
      </div>
      <span
        style={{
          color: "var(--text-muted)",
          fontSize: 9,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
        }}
      >
        {row.type}
      </span>
    </div>
  );
  if (row.route) {
    return (
      <Link to={row.route} style={{ textDecoration: "none" }}>
        {content}
      </Link>
    );
  }
  return content;
}

function ViaRpcBadge() {
  return (
    <span
      title="History past pine's window was fetched via RPC."
      style={{
        color: "var(--warn)",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 3,
        padding: "1px 6px",
        fontSize: 9,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      via RPC
    </span>
  );
}

function formatRelativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Action hooks ─────────────────────────────────────────────────

function ActionHooksRow({ actions }: { actions: ActionHook[] }) {
  const visible = actions.filter((a) => !a.when || a.when());
  if (visible.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      {visible.map((a, i) => (
        <Link
          key={`${a.label}-${i}`}
          to={a.route}
          style={{
            padding: "10px 14px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-strong)",
            fontSize: 13,
            fontWeight: 500,
            textDecoration: "none",
            display: "inline-flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span>{a.label}</span>
          {a.description && (
            <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 400 }}>
              {a.description}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
