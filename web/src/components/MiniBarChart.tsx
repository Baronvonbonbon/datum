/** Lightweight SVG bar chart — no dependencies. */

interface Bar {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  bars: Bar[];
  height?: number;
  showLabels?: boolean;
  showValues?: boolean;
  formatValue?: (v: number) => string;
}

export function MiniBarChart({ bars, height = 120, showLabels = true, showValues = true, formatValue = String }: Props) {
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const barWidth = Math.min(40, Math.max(16, Math.floor(400 / bars.length) - 8));
  const gap = 6;
  const svgWidth = bars.length * (barWidth + gap) - gap;
  const chartH = height - (showLabels ? 22 : 0) - (showValues ? 16 : 0);

  return (
    <svg viewBox={`0 0 ${svgWidth} ${height}`} width="100%" height={height} style={{ display: "block" }}>
      {bars.map((bar, i) => {
        const x = i * (barWidth + gap);
        const barH = Math.max(2, (bar.value / max) * chartH);
        const y = (showValues ? 16 : 0) + chartH - barH;
        const color = bar.color ?? "rgba(255,255,255,0.5)";
        return (
          <g key={i}>
            <rect x={x} y={y} width={barWidth} height={barH} rx={2} fill={color}>
              <title>{bar.label}: {formatValue(bar.value)}</title>
            </rect>
            {showValues && (
              <text x={x + barWidth / 2} y={y - 3} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
                {formatValue(bar.value)}
              </text>
            )}
            {showLabels && (
              <text x={x + barWidth / 2} y={height - 2} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
                {bar.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
