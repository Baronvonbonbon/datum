import { useState, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useWallet } from "../context/WalletContext";
import { useBlock } from "../hooks/useBlock";
import { useSettings } from "../context/SettingsContext";
import { useRoles } from "../hooks/useRoles";
import { usePaused } from "../hooks/usePaused";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";
import { formatDOT } from "@shared/dot";
import { AddressDisplay } from "./AddressDisplay";
import { WalletConnect } from "./WalletConnect";
import { JsonRpcProvider } from "ethers";

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
  { path: "/how-it-works", label: "How It Works" },
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
  const { settings, updateSettings } = useSettings();
  const { isAdvertiser, isPublisher, isVoter } = useRoles();
  const protocolPaused = usePaused();
  const [showConnect, setShowConnect] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const mainRef = useFadeIn();
  const blockFlash = useBlockFlash(blockNumber);
  const location = useLocation();
  const sym = getCurrencySymbol(settings.network);

  // Close mobile menu on navigation
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

  // Fetch wallet balance
  useEffect(() => {
    if (!address || !settings.rpcUrl) { setBalance(null); return; }
    const provider = new JsonRpcProvider(settings.rpcUrl);
    provider.getBalance(address).then(setBalance).catch(() => setBalance(null));
  }, [address, settings.rpcUrl, blockNumber]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* ── Experimental warning ────────────────────────────────────────── */}
      <div className="nano-warning-banner">
        ⚠ Experimental build — Paseo testnet only. Do not connect a wallet holding real funds.
        If you don't know why, close this tab, step away from the computer, raise your hand, and wait for an adult.
      </div>

      {/* ── Protocol paused banner ──────────────────────────────────────── */}
      {protocolPaused && (
        <div className="nano-pause-banner">
          Protocol is paused — transactions will be rejected until an admin unpauses the system.
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="nano-header" style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexShrink: 1 }}>
          <span style={{ fontWeight: 700, color: "var(--text-strong)", fontSize: 16, letterSpacing: "0.06em", flexShrink: 0 }}>
            DATUM
          </span>
          <div className="nano-header-status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <span className={connected ? "nano-heartbeat" : undefined} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: connected ? "var(--ok)" : "var(--error)",
              display: "inline-block",
              flexShrink: 0,
            }} />
            {connected
              ? <span className={blockFlash ? "nano-block-flash" : undefined} style={{ color: "var(--text-muted)" }}>
                  #{blockNumber} · {getNetworkDisplayName(settings.network)}
                </span>
              : <span style={{ color: "var(--text-muted)" }}>Disconnected</span>
            }
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {address ? (
            <>
              {method === "manual" && (
                <span style={{ fontSize: 10, color: "var(--warn)", fontWeight: 600, letterSpacing: "0.06em" }}>TEST</span>
              )}
              {balance !== null && (
                <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                  {formatDOT(balance)} {sym}
                </span>
              )}
              <AddressDisplay address={address} style={{ fontSize: 12, color: "var(--text)" }} />
              <div className="nano-role-badges" style={{ display: "flex", gap: 3 }}>
                {isAdvertiser && <span className="nano-badge nano-badge--accent" style={{ fontSize: 9, padding: "1px 5px" }}>ADV</span>}
                {isPublisher && <span className="nano-badge nano-badge--ok" style={{ fontSize: 9, padding: "1px 5px" }}>PUB</span>}
                {isVoter && <span className="nano-badge nano-badge--warn" style={{ fontSize: 9, padding: "1px 5px" }}>GOV</span>}
              </div>
              <button
                onClick={disconnect}
                className="nano-btn"
                style={{ fontSize: 11, padding: "3px 8px" }}
              >
                ✕
              </button>
            </>
          ) : (
            <button onClick={() => setShowConnect(true)} className="nano-btn nano-btn-accent" style={{ fontSize: 12, padding: "5px 12px", whiteSpace: "nowrap" }}>
              Connect
            </button>
          )}
          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="nano-btn nano-mobile-menu-btn"
            style={{ fontSize: 16, padding: "4px 8px", lineHeight: 1 }}
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1 }}>
        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <nav className={`nano-sidebar${mobileMenuOpen ? " nano-sidebar--open" : ""}`}>
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
          <div style={{ padding: "12px 16px", marginTop: "auto", borderTop: "1px solid var(--border)" }}>
            <button
              onClick={() => updateSettings({ theme: settings.theme === "light" ? "dark" : "light" })}
              className="nano-btn"
              style={{ fontSize: 11, padding: "3px 10px", width: "100%" }}
              title="Toggle light/dark theme"
            >
              {settings.theme === "light" ? "Dark Mode" : "Light Mode"}
            </button>
          </div>
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
