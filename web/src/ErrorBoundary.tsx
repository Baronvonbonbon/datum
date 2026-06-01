// Root error boundary. Without one, any uncaught render/lifecycle error unmounts
// the whole React tree (React 18) — leaving just the page background, which is
// exactly the "page crashed, only background shows" symptom. This catches those,
// keeps the app mounted, and shows the actual error (with stack) so it can be
// read/copied instead of vanishing. Self-contained inline styles so it renders
// even if the crash is style/context related.
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    this.setState({ componentStack: info?.componentStack ?? null });
    // Always log so it lands in the console + any log capture.
    // eslint-disable-next-line no-console
    console.error("[DATUM] UI crash:", error, info?.componentStack);
  }

  private text(): string {
    const e = this.state.error;
    const name = e?.name ?? "Error";
    const msg = e?.message ?? String(e);
    return `${name}: ${msg}\n\n${e?.stack ?? "(no stack)"}\n\nComponent stack:${this.state.componentStack ?? " (none)"}`;
  }

  render() {
    if (!this.state.error) return this.props.children;
    const text = this.text();
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          overflow: "auto",
          background: "#0b0e16",
          color: "#e8ecf5",
          font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
          padding: "28px 22px",
          zIndex: 2147483647,
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "ui-sans-serif, system-ui, sans-serif", marginBottom: 6 }}>
            Something broke
          </div>
          <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", color: "#9aa6bd", marginBottom: 16 }}>
            The page hit an unexpected error. The details below identify the bug — copy
            them or reload to recover.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button onClick={() => location.reload()} style={btn("#3aa0ff", "#06122a")}>
              Reload
            </button>
            <button onClick={() => void navigator.clipboard?.writeText(text)} style={btn("#1c2333", "#e8ecf5")}>
              Copy error
            </button>
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#070a11",
              border: "1px solid #1c2333",
              borderRadius: 8,
              padding: 14,
              margin: 0,
              color: "#ff9aa2",
              maxHeight: "70vh",
              overflow: "auto",
            }}
          >
            {text}
          </pre>
        </div>
      </div>
    );
  }
}

function btn(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: "none",
    borderRadius: 7,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  };
}
