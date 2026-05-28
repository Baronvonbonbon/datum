import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from "react";
import { Signer } from "ethers";
import {
  ConnectionMethod,
  WalletConnection,
  connectDatum,
  connectInjected,
  connectManual,
  isDatumExtensionAvailable,
  isInjectedProviderAvailable,
  waitForDatum,
} from "../lib/walletProvider";
import { humanizeError } from "@shared/errorCodes";

// localStorage key for the auto-reconnect hint. We only persist the *method*
// (datum / injected) -- never any private key. "manual" is intentionally not
// persisted: the key would have to be re-entered on reload anyway, and we
// will never write it to disk.
const STORAGE_METHOD_KEY = "datum_wallet_method";
type PersistedMethod = "datum" | "injected";

function readPersistedMethod(): PersistedMethod | null {
  try {
    const v = localStorage.getItem(STORAGE_METHOD_KEY);
    return v === "datum" || v === "injected" ? v : null;
  } catch { return null; }
}

function writePersistedMethod(method: ConnectionMethod | null): void {
  try {
    if (method === "datum" || method === "injected") {
      localStorage.setItem(STORAGE_METHOD_KEY, method);
    } else {
      localStorage.removeItem(STORAGE_METHOD_KEY);
    }
  } catch { /* storage disabled */ }
}

interface WalletContextValue {
  address: string | null;
  signer: Signer | null;
  method: ConnectionMethod | null;
  isDatumAvailable: boolean;
  isInjectedAvailable: boolean;
  connect: (method: ConnectionMethod, opts?: { privateKey?: string; rpcUrl?: string }) => Promise<void>;
  disconnect: () => void;
  error: string | null;
  clearError: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [datumReady, setDatumReady] = useState(isDatumExtensionAvailable());
  const autoReconnectTried = useRef(false);

  // Wait for window.datum injection (content script can lag page load)
  useEffect(() => {
    if (!datumReady) {
      waitForDatum().then(setDatumReady);
    }
  }, [datumReady]);

  // Auto-reconnect on mount if the user previously connected via datum or
  // injected. Manual is never auto-reconnected (we don't keep the key).
  // The attempt is one-shot per page load -- if it fails (user revoked
  // access, extension uninstalled, etc.) we clear the hint silently and the
  // user can reconnect manually. No error toast on cold start.
  useEffect(() => {
    if (autoReconnectTried.current) return;
    if (connection) return; // already connected (e.g. user clicked Connect)
    const persisted = readPersistedMethod();
    if (!persisted) return;
    if (persisted === "datum" && !datumReady) return; // wait for content script
    autoReconnectTried.current = true;
    (async () => {
      try {
        const conn = persisted === "datum" ? await connectDatum() : await connectInjected();
        setConnection(conn);
      } catch {
        // Silent failure -- user removed extension, locked wallet, revoked
        // injected permissions, etc. Drop the hint so we don't try again
        // until they actively click Connect.
        writePersistedMethod(null);
      }
    })();
  }, [datumReady, connection]);

  // Listen for account changes on injected wallets (MetaMask, SubWallet, etc.)
  useEffect(() => {
    if (!connection || connection.method !== "injected" || !window.ethereum) return;

    const handleAccountsChanged = async (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (!accounts || accounts.length === 0) {
        // User disconnected all accounts
        setConnection(null);
        writePersistedMethod(null);
        return;
      }
      const newAddr = accounts[0];
      if (newAddr.toLowerCase() !== connection.address.toLowerCase()) {
        // Reconnect with the new account
        try {
          const conn = await connectInjected();
          setConnection(conn);
        } catch (err) {
          setError(humanizeError(err));
          setConnection(null);
        }
      }
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    return () => { window.ethereum?.removeListener("accountsChanged", handleAccountsChanged); };
  }, [connection]);

  const connect = useCallback(async (
    method: ConnectionMethod,
    opts?: { privateKey?: string; rpcUrl?: string }
  ) => {
    setError(null);
    try {
      let conn: WalletConnection;
      if (method === "datum") {
        conn = await connectDatum();
      } else if (method === "injected") {
        conn = await connectInjected();
      } else {
        if (!opts?.privateKey) throw new Error("Private key required for manual connection");
        if (!opts?.rpcUrl) throw new Error("RPC URL required for manual connection");
        conn = connectManual(opts.privateKey, opts.rpcUrl);
      }
      setConnection(conn);
      writePersistedMethod(method);
    } catch (err) {
      setError(humanizeError(err));
    }
  }, []);

  function disconnect() {
    setConnection(null);
    setError(null);
    writePersistedMethod(null);
  }

  return (
    <WalletContext.Provider value={{
      address: connection?.address ?? null,
      signer: connection?.signer ?? null,
      method: connection?.method ?? null,
      isDatumAvailable: datumReady,
      isInjectedAvailable: isInjectedProviderAvailable(),
      connect,
      disconnect,
      error,
      clearError: () => setError(null),
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
