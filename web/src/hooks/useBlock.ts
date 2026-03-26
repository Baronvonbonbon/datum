import { useState, useEffect, useRef } from "react";
import { JsonRpcProvider } from "ethers";
import { useSettings } from "../context/SettingsContext";

export function useBlock() {
  const { settings } = useSettings();
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!settings.rpcUrl) return;

    async function poll() {
      try {
        const provider = new JsonRpcProvider(settings.rpcUrl);
        const n = await provider.getBlockNumber();
        setBlockNumber(n);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }

    poll();
    intervalRef.current = setInterval(poll, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [settings.rpcUrl]);

  return { blockNumber, connected };
}
