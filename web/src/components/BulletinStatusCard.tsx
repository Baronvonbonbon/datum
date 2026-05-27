// BulletinStatusCard — Settings-page widget that surfaces:
//   - which Polkadot-native wallet extensions are installed
//   - for each extension's accounts, whether they're authorized on
//     Paseo Bulletin Chain (via TransactionStorage.Authorizations)
//   - a faucet link to grant authorization when not yet set
//
// The Bulletin Chain is a substrate chain that doesn't share keypairs
// with the user's EVM Datum wallet. Most advertisers don't realize
// they need a *separate* Polkadot extension + account; this card makes
// that requirement legible up front, in the same panel where they pick
// "Bulletin Chain" as their IPFS provider.

import { useEffect, useState } from "react";

interface Account {
  address: string;
  name?: string;
}

interface ExtensionStatus {
  name: string;
  accounts: Account[];
  error?: string;
}

interface AccountAuth {
  authorized: boolean;
  expirationBlock?: number;
}

const FAUCET_URL = "https://paritytech.github.io/polkadot-bulletin-chain/";

export function BulletinStatusCard() {
  const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
  const [auths, setAuths] = useState<Record<string, AccountAuth>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function detect() {
    setLoading(true);
    setError(null);
    try {
      const { listInjectedExtensions } = await import("@shared/bulletinChainClient");
      const names = await listInjectedExtensions();
      const stubs: ExtensionStatus[] = names.map((n) => ({ name: n, accounts: [] }));
      setExtensions(stubs);
    } catch (err) {
      setError(String(err).slice(0, 160));
    } finally {
      setLoading(false);
    }
  }

  async function connect(name: string) {
    setConnecting(true);
    setError(null);
    try {
      const { connectExtension, getAuthorization } = await import("@shared/bulletinChainClient");
      const { accounts } = await connectExtension(name);
      setExtensions((prev) =>
        prev.map((e) => e.name === name ? { ...e, accounts: accounts.map((a) => ({ address: a.address, name: a.name })) } : e)
      );

      // Fan out authorization queries. Bulletin RPC handles bursts fine
      // because Authorizations is a simple storage read.
      const next: Record<string, AccountAuth> = {};
      await Promise.all(accounts.map(async (a) => {
        try {
          const info = await getAuthorization(a.address);
          next[a.address.toLowerCase()] = { authorized: info.authorized, expirationBlock: info.expirationBlock };
        } catch {
          next[a.address.toLowerCase()] = { authorized: false };
        }
      }));
      setAuths((prev) => ({ ...prev, ...next }));
    } catch (err) {
      setError(String(err).slice(0, 160));
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => { detect(); }, []);

  return (
    <div className="nano-card" style={{ padding: 14, marginTop: 12 }}>
      <div style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        Bulletin Chain Status
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 10, lineHeight: 1.55 }}>
        Bulletin Chain is a separate substrate chain. Uploads need a Polkadot-native
        wallet extension (not MetaMask) and a one-time authorization grant from the
        Paseo faucet. Skip this section unless you plan to use Bulletin Chain for
        creative storage.
      </div>

      {loading && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Detecting extensions…</div>}

      {!loading && extensions.length === 0 && (
        <div style={{ fontSize: 12 }}>
          <div style={{ color: "var(--warn)" }}>No Polkadot extension detected.</div>
          <div style={{ color: "var(--text-muted)", marginTop: 4 }}>
            Install <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>polkadot{`{.js}`}</a>,{" "}
            <a href="https://www.talisman.xyz/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Talisman</a>,{" "}
            <a href="https://subwallet.app/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>SubWallet</a>, or{" "}
            <a href="https://fearlesswallet.io/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Fearless</a> and reload.
          </div>
        </div>
      )}

      {!loading && extensions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {extensions.map((ext) => (
            <div
              key={ext.name}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: 10,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ color: "var(--text-strong)", fontSize: 12, fontWeight: 600 }}>
                  {ext.name}
                </div>
                {ext.accounts.length === 0 ? (
                  <button
                    type="button"
                    className="nano-btn"
                    disabled={connecting}
                    onClick={() => connect(ext.name)}
                    style={{ padding: "3px 10px", fontSize: 11 }}
                  >
                    {connecting ? "Connecting…" : "Connect"}
                  </button>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                    {ext.accounts.length} account{ext.accounts.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {ext.accounts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {ext.accounts.map((a) => {
                    const auth = auths[a.address.toLowerCase()];
                    const isAuthorized = auth?.authorized;
                    return (
                      <div
                        key={a.address}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: 11,
                          padding: "4px 0",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          {a.name && (
                            <span style={{ color: "var(--text)", fontWeight: 600, marginRight: 6 }}>{a.name}</span>
                          )}
                          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono, ui-monospace)" }}>
                            {a.address.slice(0, 8)}…{a.address.slice(-6)}
                          </span>
                        </div>
                        {auth === undefined ? (
                          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>checking…</span>
                        ) : isAuthorized ? (
                          <span
                            title={auth.expirationBlock ? `Auth expires at Bulletin block #${auth.expirationBlock}` : ""}
                            style={{
                              color: "var(--ok)", fontSize: 10, fontWeight: 700,
                              padding: "1px 6px", borderRadius: 8,
                              background: "rgba(74,222,128,0.10)", border: "1px solid rgba(74,222,128,0.30)",
                            }}
                          >
                            ✓ Authorized
                          </span>
                        ) : (
                          <a
                            href={FAUCET_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "var(--accent)", fontSize: 10, textDecoration: "none" }}
                          >
                            Authorize →
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ color: "var(--error)", fontSize: 11, marginTop: 8 }}>{error}</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 10, color: "var(--text-muted)" }}>
        <a href={FAUCET_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
          Paseo Bulletin faucet ↗
        </a>
        <button
          type="button"
          onClick={() => { detect(); setAuths({}); }}
          className="nano-btn"
          style={{ padding: "2px 8px", fontSize: 10 }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
