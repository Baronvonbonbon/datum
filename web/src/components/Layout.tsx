import { useState, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, Link } from "react-router-dom";
import { useWallet } from "../context/WalletContext";
import { useBlock } from "../hooks/useBlock";
import { useSettings } from "../context/SettingsContext";
import { useRoles } from "../hooks/useRoles";
import { usePaused } from "../hooks/usePaused";
import { useMidMigration } from "../hooks/useMidMigration";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";
import { formatDOT, weiToPlanck } from "@shared/dot";
import { AddressDisplay } from "./AddressDisplay";
import { WalletConnect } from "./WalletConnect";
import { PrivacyBanner } from "./PrivacyBanner";
import { Footer } from "./Footer";
import { BrandMark } from "./BrandMark";
import { PineStatusChip } from "./PineStatusChip";
import { RpcToggleChip } from "./RpcToggleChip";
import { PineWarmUpBanner } from "./PineWarmUpBanner";
import { RouterHealthBanner } from "./RouterHealthBanner";
import { useContracts } from "../hooks/useContracts";
import { isPathEnabled } from "../lib/features";
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
    matchPrefixes: ["/explorer", "/campaigns", "/publishers", "/advertisers", "/how-it-works", "/philosophy"],
    headerPath: "/explorer",
    headerExact: true,
    children: [
      { path: "/explorer", label: "Overview", exact: true },
      { path: "/explorer/campaigns", label: "Campaigns" },
      { path: "/explorer/publishers", label: "Publishers" },
      { path: "/explorer/how-it-works", label: "How It Works" },
      { path: "/explorer/philosophy", label: "Philosophy" },
    ],
  },
  {
    label: "Me",
    matchPrefixes: ["/me"],
    headerPath: "/me",
    headerExact: true,
    children: [
      { path: "/me", label: "Account", exact: true },
      { path: "/me/history", label: "History" },
      { path: "/me/identity", label: "Identity" },
      { path: "/me/assurance", label: "Assurance" },
      { path: "/me/dust", label: "Dust" },
    ],
  },
  {
    label: "Advertiser",
    matchPrefixes: ["/advertiser"],
    headerPath: "/advertiser",
    headerExact: true,
    children: [
      { path: "/advertiser", label: "Dashboard", exact: true },
      { path: "/advertiser/profile", label: "Profile" },
      { path: "/advertiser/create", label: "New Campaign" },
      { path: "/advertiser/analytics", label: "Analytics" },
    ],
  },
  {
    label: "Publisher",
    matchPrefixes: ["/publisher"],
    headerPath: "/publisher",
    headerExact: true,
    children: [
      { path: "/publisher", label: "Dashboard", exact: true },
      { path: "/publisher/earnings", label: "Earnings" },
      { path: "/publisher/stake", label: "Stake" },
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
    headerPath: "/governance",
    headerExact: true,
    children: [
      { path: "/governance", label: "Dashboard", exact: true },
      { path: "/governance/activation-bonds", label: "Activation Bonds" },
      { path: "/governance/advertiser-fraud", label: "Advertiser Fraud" },
      { path: "/governance/publisher-fraud", label: "Publisher Fraud" },
      { path: "/governance/council", label: "Council" },
      { path: "/governance/parameters", label: "Parameters" },
      { path: "/governance/phase-ladder", label: "Phase Ladder" },
      { path: "/governance/my-votes", label: "My Votes" },
    ],
  },
  {
    label: "Protocol",
    matchPrefixes: ["/protocol", "/admin"],
    headerPath: "/protocol",
    headerExact: true,
    children: [
      { path: "/protocol", label: "Dashboard", exact: true },
      { path: "/protocol/upgrades", label: "Upgrades" },
      { path: "/protocol/tag-curator", label: "Tag Curator" },
      { path: "/protocol/pause-registry", label: "Pause Registry" },
      { path: "/protocol/parameter-governance", label: "Parameter Gov" },
      { path: "/protocol/sybil-defense", label: "Sybil Defense" },
      { path: "/protocol/publisher-stake", label: "Publisher Stake" },
      { path: "/protocol/challenge-bonds", label: "Challenge Bonds" },
      { path: "/protocol/blocklist", label: "Blocklist" },
      { path: "/protocol/protocol-fees", label: "Protocol Fees" },
      { path: "/protocol/timelock", label: "Timelock" },
      { path: "/protocol/mint-authority", label: "Mint Authority" },
    ],
  },
  {
    label: "DATUM Token",
    matchPrefixes: ["/token"],
    headerPath: "/token",
    headerExact: true,
    children: [
      { path: "/token", label: "Dashboard", exact: true },
      { path: "/token/mint-coordinator", label: "Mint Coordinator" },
      { path: "/token/wrapper", label: "Wrapper" },
      { path: "/token/vesting", label: "Vesting" },
      { path: "/token/fee-share", label: "Fee Share" },
    ],
  },
  {
    label: "Identity",
    matchPrefixes: ["/identity"],
    headerPath: "/identity",
    headerExact: true,
    children: [
      { path: "/identity", label: "Dashboard", exact: true },
      { path: "/identity/people-chain", label: "People Chain" },
      { path: "/identity/zk", label: "ZK Tooling" },
    ],
  },
  {
    // All persona deep-dives live under /about/*. Kept consolidated so the
    // role sidebar sections stay action-focused and the About index is the
    // single discovery surface for the narrative content.
    label: "About",
    matchPrefixes: ["/about"],
    headerPath: "/about",
    headerExact: true,
    children: [
      { path: "/about", label: "Overview", exact: true },
      { path: "/about/me", label: "Me" },
      { path: "/about/advertiser", label: "Advertiser" },
      { path: "/about/publisher", label: "Publisher" },
      { path: "/about/governance", label: "Governance" },
      { path: "/about/token", label: "DATUM Token" },
      { path: "/about/rewards", label: "Sidecar Rewards" },
      { path: "/about/identity", label: "Identity" },
      { path: "/about/protocol", label: "Protocol" },
      { path: "/about/economics", label: "Economics" },
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
  const migratingContracts = useMidMigration();
  const { pineStatus, readProvider } = useContracts();
  const [showConnect, setShowConnect] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const mainRef = useFadeIn();
  const blockFlash = useBlockFlash(blockNumber);
  const location = useLocation();
  const sym = getCurrencySymbol(settings.network);

  // Feature-gate the nav: omit any section/child whose feature is not deployed
  // (its contract address is unset) or not in the required governance phase.
  // livePhase is Phase 0 (Admin) today — when the governance ladder advances,
  // swap this for a usePhase() read of router.phase(). Phase-gated surfaces
  // (e.g. Council at phase >= 1) stay hidden until then even though deployed.
  const featAddrs = settings.contractAddresses;
  const livePhase = 0 as const;
  const sections = NAV_SECTIONS
    .filter((s) => !s.adminOnly || isAdmin)
    .map((s) => ({ ...s, children: s.children.filter((c) => isPathEnabled(c.path, featAddrs, livePhase)) }))
    .filter((s) => isPathEnabled(s.headerPath ?? "/", featAddrs, livePhase) && s.children.length > 0);

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

      {/* ── Pine warm-up / offline indicator ────────────────────────────── */}
      <PineWarmUpBanner />

      {/* ── Router registry health (stale/wrong router address) ─────────── */}
      <RouterHealthBanner />

      {/* ── Protocol paused banner ──────────────────────────────────────── */}
      {protocolPaused && (
        <div className="nano-pause-banner">
          Protocol is paused — transactions will be rejected until an admin unpauses the system.
        </div>
      )}

      {/* ── Protocol-upgrade-in-progress banner (U6) ────────────────────── */}
      {migratingContracts.length > 0 && (
        <div className="nano-pause-banner">
          Protocol upgrade in progress — {migratingContracts.join(", ")} {migratingContracts.length === 1 ? "is" : "are"} migrating
          state. Displayed data may be incomplete; avoid transactions until this clears.
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="nano-header" style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexShrink: 1 }}>
          <Link to="/" style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, color: "var(--text-strong)", fontSize: 16, letterSpacing: "0.06em", flexShrink: 0, textDecoration: "none" }}>
            {/* BrackMark brackets follow currentColor; route through the
                theme-aware muted text so light mode doesn't white out the
                logo. Dot stays fixed Polkadot pink (set inside BrandMark). */}
            <span style={{ color: "var(--text-muted)" }}>
              <BrandMark size={16} />
            </span>
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
            {pineStatus !== "off" && <PineStatusChip />}
            <RpcToggleChip />
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
          <main ref={mainRef} style={{ flex: 1, padding: "28px 32px", maxWidth: "none" }}>
            {/* Route-level feature gate: direct navigation to a feature that is
                not deployed / not in the required phase shows an unavailable
                notice instead of the page (covers all routes via the Outlet). */}
            {isPathEnabled(location.pathname, featAddrs, livePhase) ? (
              <Outlet />
            ) : (
              <div className="nano-card" style={{ padding: 32, textAlign: "center", maxWidth: 540, margin: "40px auto" }}>
                <h2 style={{ marginTop: 0 }}>Feature not available</h2>
                <p style={{ color: "var(--text-muted)" }}>
                  This feature is not deployed on the current network, or is not active in
                  the current governance phase. It will appear here once enabled.
                </p>
              </div>
            )}
          </main>
          <Footer />
        </div>
      </div>

      {showConnect && <WalletConnect onClose={() => setShowConnect(false)} />}
      <PrivacyBanner />
    </div>
  );
}
