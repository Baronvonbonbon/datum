import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { Signer } from "ethers";
import {
  ConnectionMethod,
  WalletConnection,
  connectDatum,
  connectInjected,
  connectManual,
  isDatumExtensionAvailable,
  isInjectedProviderAvailable,
} from "../lib/walletProvider";
import { humanizeError } from "@shared/errorCodes";

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
    } catch (err) {
      setError(humanizeError(err));
    }
  }, []);

  function disconnect() {
    setConnection(null);
    setError(null);
  }

  return (
    <WalletContext.Provider value={{
      address: connection?.address ?? null,
      signer: connection?.signer ?? null,
      method: connection?.method ?? null,
      isDatumAvailable: isDatumExtensionAvailable(),
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
