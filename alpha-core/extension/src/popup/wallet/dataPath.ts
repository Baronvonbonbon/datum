// Data-path preference: how the extension reads chain state.
//   "pine" — smoldot light client validates blocks in-browser; no gateway sees
//            your reads (private, slower first sync). usePine=true, rpcEnabled=false.
//   "rpc"  — centralized RPC gateway; instant reads, but the gateway sees your
//            query metadata. usePine=false, rpcEnabled=true.
// Writes (tx broadcast) always use RPC regardless — smoldot can't broadcast.
//
// Persisted into the same StoredSettings the background reads (chrome.storage.local
// "settings"), so a choice here takes effect on the next poll.

export type DataPath = "pine" | "rpc";

export async function getDataPath(): Promise<DataPath> {
  const { settings } = await chrome.storage.local.get("settings");
  // Default is Pine (cypherpunk posture); only explicit usePine===false is "rpc".
  return settings?.usePine === false ? "rpc" : "pine";
}

export async function setDataPath(mode: DataPath): Promise<void> {
  const { settings } = await chrome.storage.local.get("settings");
  const next = {
    ...(settings ?? {}),
    usePine: mode === "pine",
    rpcEnabled: mode === "rpc",
  };
  await chrome.storage.local.set({ settings: next });
  // Nudge the background to re-poll immediately on the new path (best-effort).
  try {
    chrome.runtime.sendMessage({ type: "POLL_CAMPAIGNS" });
  } catch {
    /* background may be asleep; the alarm poll will pick up the new setting */
  }
}
