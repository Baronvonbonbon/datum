// useWallet — React hook around walletConnector.
//
// Components subscribe to wallet state with `useWallet()`:
//
//   const { status, address, connect } = useWallet();
//   if (status === "uninstalled") return <NeedsExtension />;
//   if (status === "disconnected") return <button onClick={connect}>Connect</button>;
//   return <div>Connected as {address}</div>;
//
// The hook fires init() on mount so callers don't have to. Init is
// idempotent — first mount pays the discovery cost; subsequent mounts
// reuse the cached resolution.

import { useEffect, useState, useCallback } from "react";
import {
  walletConnector,
  type WalletConnectorState,
} from "../lib/walletConnector";

export type UseWalletResult = WalletConnectorState & {
  /// True iff the DATUM extension was discovered. Equivalent to
  /// `status !== "uninstalled"` but cheaper to read against.
  installed: boolean;
  /// True iff the wallet is currently connected to this dApp's origin.
  connected: boolean;
  /// Trigger the popup approval flow (or no-op if already connected).
  connect: () => Promise<string | null>;
};

export function useWallet(): UseWalletResult {
  const [state, setState] = useState<WalletConnectorState>(() =>
    walletConnector.getState()
  );

  useEffect(() => {
    // Best-effort init. Discovery has its own grace period;
    // we don't surface init errors because there's nothing the
    // page can do — fallthrough to "uninstalled" is the same UX.
    walletConnector.init().catch(() => undefined);
    return walletConnector.onChange(setState);
  }, []);

  const connect = useCallback(async () => {
    return walletConnector.connect();
  }, []);

  return {
    ...state,
    installed: state.status !== "uninstalled",
    connected: state.status === "connected" && state.address !== null,
    connect,
  };
}
