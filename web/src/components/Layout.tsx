import { useState, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, Link } from "react-router-dom";
import { useWallet } from "../context/WalletContext";
import { useBlock } from "../hooks/useBlock";
import { useSettings } from "../context/SettingsContext";
import { useRoles } from "../hooks/useRoles";
import { usePaused } from "../hooks/usePaused";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";
import { formatDOT, weiToPlanck } from "@shared/dot";
import { AddressDisplay } from "./AddressDisplay";
import { WalletConnect } from "./WalletConnect";
import { PrivacyBanner } from "./PrivacyBanner";
import { useContracts } from "../hooks/useContracts";
import type { JsonRpcApiProvider } from "ethers";

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

/** Trigger the Nano staggered fade-in on every route change. */
function useFadeIn() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;

    const items = el.querySelectorAll<HTMLElement>(".nano-fade");
    items.forEach((item) => item.classList.add("nano-fade--hide"));
    const timers: ReturnType<typeof setTimeout>[] = [];
    items.forEach((item, i) => {
      timers.push(setTimeout(() => item.classList.remove("nano-fade--hide"), i * 120));
    });

    return () => {
      timers.forEach(clearTimeout);
      items.forEach((item) => item.classList.remove("nano-fade--hide"));
    };
  }, [location.pathname]);

  return mainRef;
}

interface NavChild { path: string; label: string; exact?: boolean; }
interface NavSection {
  label: string;
  /** The section header is a link itself when provided */
  headerPath?: string;
  headerExact?: boolean;
  /** Paths that should keep this section active (prefix match) */
  matchPrefixes?: string[];
  children: NavChild[];
  adminOnly?: boolean;
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Explorer",
    matchPrefixes: ["/campaigns", "/publishers", "/advertisers", "/how-it-works", "/philosophy"],
    headerPath: "/",
    headerExact: true,
    children: [
      { path: "/", label: "Overview", exact: true },
      { path: "/campaigns", label: "Campaigns" },
      { path: "/publishers", label: "Publishers" },
      { path: "/how-it-works", label: "How It Works" },
      { path: "/philosophy", label: "Philosophy" },
    ],
  },
  {
    label: "Advertiser",
    matchPrefixes: ["/advertiser"],
    children: [
      { path: "/advertiser", label: "My Campaigns", exact: true },
      { path: "/advertiser/analytics", label: "Analytics" },
      { path: "/advertiser/create", label: "New Campaign" },
    ],
  },
  {
    label: "Publisher",
    matchPrefixes: ["/publisher"],
    children: [
      { path: "/publisher", label: "Dashboard", exact: true },
      { path: "/publisher/earnings", label: "Earnings" },
      { path: "/publisher/categories", label: "Tags" },
      { path: "/publisher/allowlist", label: "Allowlist" },
      { path: "/publisher/rate", label: "Take Rate" },
      { path: "/publisher/sdk", label: "SDK Setup" },
      { path: "/publisher/profile", label: "Profile" },
    ],
  },
  {
    label: "Governance",
    matchPrefixes: ["/governance"],
    children: [
      { path: "/governance", label: "Campaigns", exact: true },
      { path: "/governance/my-votes", label: "My Votes" },
      { path: "/governance/parameters", label: "Parameters" },
    ],
  },
  {
    label: "Admin",
    matchPrefixes: ["/admin"],
    adminOnly: true,
    children: [
      { path: "/admin/timelock", label: "Timelock" },
      { path: "/admin/pause", label: "Pause" },
      { path: "/admin/blocklist", label: "Blocklist" },
      { path: "/admin/protocol", label: "Protocol Fees" },
      { path: "/admin/rate-limiter", label: "Rate Limiter" },
      { path: "/admin/reputation", label: "Reputation" },
      { path: "/admin/parameter-governance", label: "Param Gov" },
      { path: "/admin/publisher-stake", label: "Pub Stake" },
      { path: "/admin/publisher-governance", label: "Pub Gov" },
      { path: "/admin/challenge-bonds", label: "Bonds" },
      { path: "/admin/nullifier-registry", label: "Nullifiers" },
    ],
  },
  {
    label: "Settings",
    matchPrefixes: ["/settings"],
    children: [{ path: "/settings", label: "Settings", exact: true }],
  },
  {
    label: "Demo",
    matchPrefixes: ["/demo"],
    children: [{ path: "/demo", label: "Demo", exact: true }],
  },
];

function isSectionActive(section: NavSection, pathname: string): boolean {
  const prefixes = section.matchPrefixes ?? [];
  if (prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  return section.children.some((c) =>
    c.exact ? pathname === c.path : pathname === c.path || pathname.startsWith(c.path + "/")
  );
}

function SidebarSection({
  section,
  pathname,
  onNavigate,
}: {
  section: NavSection;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isSectionActive(section, pathname);
  const isLeaf = section.children.length === 1 && section.children[0].path === section.children[0].path;
  const isSingleLeaf = section.children.length === 1;
  const [open, setOpen] = useState(active);

  // Keep open when navigating into this section
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  if (isSingleLeaf) {
    // Render as a simple navlink
    const child = section.children[0];
    return (
      <NavLink
        to={child.path}
        end={child.exact}
        className={({ isActive }) => `nano-navlink${isActive ? " active" : ""}`}
        onClick={onNavigate}
      >
        {section.label}
      </NavLink>
    );
  }

  return (
    <div className="nano-nav-section">
      <button
        className={`nano-nav-section-header${active ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        {section.label}
        <span className={`nano-nav-section-arrow${open ? " nano-nav-section-arrow--open" : ""}`}>▶</span>
      </button>
      <div className={`nano-nav-children${open ? " nano-nav-children--open" : ""}`}>
        {section.children.map((child) => (
          <NavLink
            key={child.path}
            to={child.path}
            end={child.exact}
            className={({ isActive }) => `nano-navlink--child${isActive ? " active" : ""}`}
            onClick={onNavigate}
          >
            {child.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

export function Layout() {
  const { address, disconnect, method } = useWallet();
  const { blockNumber, connected } = useBlock();
  const { settings, updateSettings } = useSettings();
  const { isAdmin } = useRoles();
  const { isAdvertiser, isPublisher, isVoter } = useRoles();
  const protocolPaused = usePaused();
  const { pineStatus, readProvider } = useContracts();
  const [showConnect, setShowConnect] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const mainRef = useFadeIn();
  const blockFlash = useBlockFlash(blockNumber);
  const location = useLocation();
  const sym = getCurrencySymbol(settings.network);

  const sections = NAV_SECTIONS.filter((s) => !s.adminOnly || isAdmin);

  // Close mobile menu on navigation
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

  // Fetch wallet balance
  useEffect(() => {
    if (!address || !readProvider) { setBalance(null); return; }
    const provider = readProvider as JsonRpcApiProvider;
    provider.getBalance(address).then(wei => setBalance(weiToPlanck(wei))).catch(() => setBalance(null));
  }, [address, readProvider, blockNumber]);

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
          <Link to="/" style={{ fontWeight: 700, color: "var(--text-strong)", fontSize: 16, letterSpacing: "0.06em", flexShrink: 0, textDecoration: "none" }}>
            DATUM
          </Link>
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
            {pineStatus !== "off" && (
              <span
                className={pineStatus === "connecting" ? "nano-pine-syncing" : undefined}
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: pineStatus === "connected" ? "var(--ok)" : pineStatus === "connecting" ? "rgba(251,191,36,0.15)" : "rgba(248,113,113,0.15)",
                  border: `1px solid ${pineStatus === "connected" ? "rgba(74,222,128,0.4)" : pineStatus === "connecting" ? "rgba(251,191,36,0.4)" : "rgba(248,113,113,0.4)"}`,
                  color: pineStatus === "connected" ? "#000" : pineStatus === "connecting" ? "var(--warn)" : "var(--error)",
                }}
              >
                {pineStatus === "connected" ? "PINE" : pineStatus === "connecting" ? "PINE…" : "PINE ERR"}
              </span>
            )}
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
                {isAdvertiser && <span className="nano-badge nano-badge--advertiser" style={{ fontSize: 9, padding: "1px 5px" }}>ADV</span>}
                {isPublisher && <span className="nano-badge nano-badge--publisher" style={{ fontSize: 9, padding: "1px 5px" }}>PUB</span>}
                {isVoter && <span className="nano-badge nano-badge--voter" style={{ fontSize: 9, padding: "1px 5px" }}>GOV</span>}
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
          {sections.map((section) => (
            <SidebarSection
              key={section.label}
              section={section}
              pathname={location.pathname}
              onNavigate={() => setMobileMenuOpen(false)}
            />
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
      <PrivacyBanner />
    </div>
  );
}
