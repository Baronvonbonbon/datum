// Mock chrome.storage.local for unit tests.
// Provides an in-memory store that mimics the chrome.storage.local API.

const store: Record<string, any> = {};

export function resetStore() {
  for (const key of Object.keys(store)) delete store[key];
}

export function seedStore(data: Record<string, any>) {
  Object.assign(store, data);
}

export function getStore(): Record<string, any> {
  return { ...store };
}

const chromeStorageLocal = {
  async get(keys?: string | string[] | null): Promise<Record<string, any>> {
    if (!keys) return { ...store };
    const keyList = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, any> = {};
    for (const k of keyList) {
      if (k in store) result[k] = store[k];
    }
    return result;
  },
  async set(items: Record<string, any>): Promise<void> {
    Object.assign(store, items);
  },
  async remove(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) delete store[k];
  },
};

// Install global chrome mock
(globalThis as any).chrome = {
  storage: {
    local: chromeStorageLocal,
  },
  runtime: {
    getURL: (path: string) => `chrome-extension://test-id/${path}`,
    sendMessage: async () => ({}),
  },
};
