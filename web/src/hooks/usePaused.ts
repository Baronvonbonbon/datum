import { useState, useEffect } from "react";
import { useContracts } from "./useContracts";
import { useBlock } from "./useBlock";

/** Polls the PauseRegistry to check if the protocol is paused. */
export function usePaused(): boolean {
  const contracts = useContracts();
  const { blockNumber } = useBlock();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    contracts.pauseRegistry.paused()
      .then((p: boolean) => setPaused(Boolean(p)))
      .catch(() => {}); // PauseRegistry not available
  }, [contracts, blockNumber]);

  return paused;
}
