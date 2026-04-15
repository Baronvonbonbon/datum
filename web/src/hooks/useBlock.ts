import { useState, useEffect, useRef } from "react";
import type { BrowserProvider, JsonRpcProvider } from "ethers";
import { useSettings } from "../context/SettingsContext";
import { useContracts } from "./useContracts";

export function useBlock() {
  const { settings } = useSettings();
  const { readProvider, pineStatus } = useContracts();
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const provider = readProvider as BrowserProvider | JsonRpcProvider;
    if (!provider) return;

    async function poll() {
      try {
        const n = await provider.getBlockNumber();
        setBlockNumber(n);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }

    poll();
    intervalRef.current = setInterval(poll, 10_000);

    const onVisible = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  // Re-run when the active provider changes (Pine connects/disconnects or rpcUrl changes)
  // readProvider already captures rpcUrl (changes when rpcUrl changes and Pine is off).
  // Including rpcUrl directly causes spurious re-runs while Pine is active, briefly
  // flashing "Disconnected" on every rpcUrl edit even though Pine is the active provider.
  }, [readProvider, pineStatus]);

  return { blockNumber, connected };
}
