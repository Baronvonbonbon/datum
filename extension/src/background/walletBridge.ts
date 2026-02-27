// walletBridge — background-side wallet state management.
// Note: actual wallet signing (window.ethereum / window.injectedWeb3) must happen
// in the popup context, since service workers have no DOM/window access.
// The background stores the connected address and passes sign requests to the popup.

const CONNECTED_KEY = "connectedAddress";

export const walletBridge = {
  async getConnectedAddress(): Promise<string | null> {
    const stored = await chrome.storage.local.get(CONNECTED_KEY);
    return stored[CONNECTED_KEY] ?? null;
  },

  async setConnectedAddress(address: string): Promise<void> {
    await chrome.storage.local.set({ [CONNECTED_KEY]: address });
  },

  async clearConnectedAddress(): Promise<void> {
    await chrome.storage.local.remove(CONNECTED_KEY);
  },
};
