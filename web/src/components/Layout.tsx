import { useState, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useWallet } from "../context/WalletContext";
import { useBlock } from "../hooks/useBlock";
import { useSettings } from "../context/SettingsContext";
import { getCurrencySymbol, getNetworkDisplayName, getExplorerUrl } from "@shared/networks";
import { AddressDisplay } from "./AddressDisplay";
import { WalletConnect } from "./WalletConnect";

/** Animates the block number ticking up when it changes. */
function useBlockFlash(blockNumber: number | null) {
  const [flash, setFlash] = useState(false);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (blockNumber !== null && blockNumber !== prev.current) {
      prev.current = blockNumber;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(t);
    }
  }, [blockNumber]);
  return flash;
}

const NAV_ITEMS = [
  { path: "/", label: "Explorer", exact: true },
  { path: "/advertiser", label: "Advertiser" },
  { path: "/publisher", label: "Publisher" },
  { path: "/governance", label: "Governance" },
  { path: "/settings", label: "Settings" },
  { path: "/demo/", label: "Demo ↗", external: true },
];

/** Trigger the Nano staggered fade-in on every route change.
 *  Elements default to visible (opacity:1). On route change, elements present
 *  at render time get briefly hidden then revealed with stagger. Elements that
 *  mount later (async data) are immediately visible — no observer needed. */
function useFadeIn() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;

    // Staggered reveal for elements present at route render time
    const items = el.querySelectorAll<HTMLElement>(".nano-fade");
    items.forEach((item) => item.classList.add("nano-fade--hide"));
    const timers: ReturnType<typeof setTimeout>[] = [];
    items.forEach((item, i) => {
      timers.push(setTimeout(() => item.classList.remove("nano-fade--hide"), i * 120));
    });

    return () => {
      timers.forEach(clearTimeout);
      // Ensure nothing stays hidden if cleanup fires early (StrictMode)
      items.forEach((item) => item.classList.remove("nano-fade--hide"));
    };
  }, [location.pathname]);

  return mainRef;
}

export function Layout() {
  const { address, disconnect, method } = useWallet();
  const { blockNumber, connected } = useBlock();
  const { settings } = useSettings();
  const [showConnect, setShowConnect] = useState(false);
  const mainRef = useFadeIn();
  const blockFlash = useBlockFlash(blockNumber);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* ── Experimental warning ────────────────────────────────────────── */}
      <div className="nano-warning-banner">
        ⚠ Experimental build — Paseo testnet only. Do not connect a wallet holding real funds.
        If you don't know why, close this tab, step away from the computer, raise your hand, and wait for an adult.
      </div>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="nano-header">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 700, color: "var(--text-strong)", fontSize: 16, letterSpacing: "0.06em" }}>
            DATUM
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "monospace" }}>
            <span className={connected ? "nano-heartbeat" : undefined} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: connected ? "var(--ok)" : "var(--error)",
              display: "inline-block",
              flexShrink: 0,
            }} />
            {connected
              ? <span className={blockFlash ? "nano-block-flash" : undefined} style={{ color: "var(--text-muted)" }}>
                  #{blockNumber} · {getNetworkDisplayName(settings.network)}
                  {getExplorerUrl(settings.network) && (
                    <a href={getExplorerUrl(settings.network)} target="_blank" rel="noreferrer"
                      style={{ color: "var(--accent-dim)", marginLeft: 8, fontSize: 10, textDecoration: "none" }}>
                      Explorer ↗
                    </a>
                  )}
                </span>
              : <span style={{ color: "var(--text-muted)" }}>Disconnected</span>
            }
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {address ? (
            <>
              {method === "manual" && (
                <span style={{ fontSize: 10, color: "var(--warn)", fontWeight: 600, letterSpacing: "0.06em" }}>TEST KEY</span>
              )}
              <AddressDisplay address={address} style={{ fontSize: 12, color: "var(--text)" }} />
              <button
                onClick={disconnect}
                className="nano-btn"
                style={{ fontSize: 12, padding: "4px 10px" }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button onClick={() => setShowConnect(true)} className="nano-btn nano-btn-accent">
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <div style={{ display: "flex", flex: 1 }}>
        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <nav className="nano-sidebar">
          {NAV_ITEMS.map((item) => (
            <div key={item.path}>
              {(item as any).external ? (
                <a href={item.path} className="nano-navlink" style={{ color: "var(--text-muted)" }} target="_blank" rel="noopener noreferrer">
                  {item.label}
                </a>
              ) : (
                <NavLink
                  to={item.path}
                  end={item.exact}
                  className={({ isActive }) => `nano-navlink${isActive ? " active" : ""}`}
                >
                  {item.label}
                </NavLink>
              )}
            </div>
          ))}
        </nav>

        {/* ── Main content ─────────────────────────────────────────────── */}
        <main ref={mainRef} style={{ flex: 1, overflow: "auto", padding: "28px 32px", maxWidth: "none" }}>
          <Outlet />
        </main>
      </div>

      {showConnect && <WalletConnect onClose={() => setShowConnect(false)} />}
    </div>
  );
}
