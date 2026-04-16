import { useState, useEffect, useRef } from "react";
import type { JsonRpcApiProvider } from "ethers";
import { useContracts } from "./useContracts";

export function useBlock() {
  const { readProvider, pineStatus } = useContracts();
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const provider = readProvider as JsonRpcApiProvider;
    if (!provider) return;

    function clearTimers() {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (retryRef.current)    { clearTimeout(retryRef.current);    retryRef.current = null; }
    }

    async function poll() {
      try {
        const n = await provider.getBlockNumber();
        setBlockNumber(n);
        setConnected(true);
        // Ensure steady-state interval is running
        if (!intervalRef.current) {
          intervalRef.current = setInterval(poll, 6_000);
        }
      } catch {
        setConnected(false);
        // Retry quickly on failure rather than waiting the full interval
        if (!retryRef.current) {
          retryRef.current = setTimeout(() => {
            retryRef.current = null;
            poll();
          }, 3_000);
        }
      }
    }

    clearTimers();
    poll();
    intervalRef.current = setInterval(poll, 6_000);

    const onVisible = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimers();
      document.removeEventListener("visibilitychange", onVisible);
    };
  // Re-run only when the active provider changes (Pine connects/disconnects or rpcUrl changes).
  // getProvider() is cached by URL so signer changes don't create a new readProvider reference,
  // preventing spurious polling resets on wallet connect/disconnect.
  }, [readProvider, pineStatus]);

  return { blockNumber, connected };
}
