import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useWallet } from "../context/WalletContext";
import { useBlock } from "../hooks/useBlock";
import { useSettings } from "../context/SettingsContext";
import { getCurrencySymbol, getNetworkDisplayName } from "@shared/networks";
import { AddressDisplay } from "./AddressDisplay";
import { WalletConnect } from "./WalletConnect";

const NAV_ITEMS = [
  { path: "/", label: "Explorer", exact: true },
  { path: "/advertiser", label: "Advertiser" },
  { path: "/publisher", label: "Publisher" },
  { path: "/governance", label: "Governance" },
  { path: "/settings", label: "Settings" },
  { path: "/demo/", label: "Demo", external: true },
];

const navLinkStyle = ({ isActive }: { isActive: boolean }): React.CSSProperties => ({
  display: "block",
  padding: "10px 16px",
  color: isActive ? "#a0a0ff" : "#666",
  background: isActive ? "#1a1a2e" : "transparent",
  borderLeft: isActive ? "2px solid #a0a0ff" : "2px solid transparent",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: isActive ? 600 : 400,
  transition: "color 0.1s",
});

export function Layout() {
  const { address, disconnect, method } = useWallet();
  const { blockNumber, connected } = useBlock();
  const { settings } = useSettings();
  const [showConnect, setShowConnect] = useState(false);

  const sym = getCurrencySymbol(settings.network);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Header */}
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        height: 52,
        background: "#0f0f1a",
        borderBottom: "1px solid #1a1a2e",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 700, color: "#a0a0ff", fontSize: 18, letterSpacing: 1 }}>DATUM</span>
          {/* Chain status dot */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "monospace" }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: connected ? "#40c040" : "#c04040",
              display: "inline-block",
            }} />
            {connected
              ? <span style={{ color: "#608060" }}>#{blockNumber} · {getNetworkDisplayName(settings.network)}</span>
              : <span style={{ color: "#806060" }}>Disconnected</span>
            }
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {address ? (
            <>
              {method === "manual" && (
                <span style={{ fontSize: 10, color: "#ff9040", fontWeight: 600 }}>TEST KEY</span>
              )}
              <AddressDisplay address={address} style={{ fontSize: 13 }} />
              <button
                onClick={disconnect}
                style={{ padding: "4px 12px", background: "#1a0a0a", color: "#ff8080", border: "1px solid #3a1a1a", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowConnect(true)}
              style={{ padding: "6px 16px", background: "#1a1a3a", color: "#a0a0ff", border: "1px solid #4a4a8a", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
            >
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <div style={{ display: "flex", flex: 1 }}>
        {/* Sidebar */}
        <nav style={{
          width: 180,
          flexShrink: 0,
          background: "#0a0a12",
          borderRight: "1px solid #1a1a2e",
          paddingTop: 16,
        }}>
          {NAV_ITEMS.map((item) => (
              <div key={item.path}>
                {(item as any).external ? (
                  <a
                    href={item.path}
                    style={{
                      display: "block",
                      padding: "10px 16px",
                      color: "#666",
                      borderLeft: "2px solid transparent",
                      textDecoration: "none",
                      fontSize: 14,
                    }}
                  >
                    {item.label} ↗
                  </a>
                ) : (
                <NavLink
                  to={item.path}
                  end={item.exact}
                  style={navLinkStyle}
                >
                  {item.label}
                </NavLink>
                )}
              </div>
          ))}
        </nav>

        {/* Main content */}
        <main style={{ flex: 1, overflow: "auto", padding: 24 }}>
          <Outlet />
        </main>
      </div>

      {showConnect && <WalletConnect onClose={() => setShowConnect(false)} />}
    </div>
  );
}
