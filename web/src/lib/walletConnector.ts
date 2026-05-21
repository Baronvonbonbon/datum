// walletConnector.ts — webapp-side connector for the DATUM extension's
// EIP-1193 provider (window.datum).
//
// Discovery:
//   1. EIP-6963 announcement event ("eip6963:announceProvider") —
//      preferred. We fire "eip6963:requestProvider" on init to ask
//      the injector to re-announce so we don't depend on load order.
//   2. window.datum direct binding — fallback for the same provider
//      when EIP-6963 missed (older injector revisions, edge cases).
//
// We never touch window.ethereum. DATUM ships its own namespace to
// avoid colliding with MetaMask et al.; dApps that mix providers use
// EIP-6963's `rdns` selector to disambiguate.
//
// State model:
//   "uninstalled"  — no DATUM provider in the page after grace period
//   "disconnected" — provider present, no account exposed (locked or
//                    not yet granted)
//   "connecting"   — connect() in flight, awaiting popup approval
//   "connected"    — granted + unlocked, active address known
//
// Listeners are notified on every transition. The webapp's
// useWallet hook (hooks/useWallet.ts) subscribes via this layer.

const DISCOVERY_TIMEOUT_MS = 1_000;

/// Minimal EIP-1193 shape the injector exposes. We avoid importing
/// from the extension package — keeps the webapp build self-contained.
export type Eip1193Provider = {
  request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  isDatum?: boolean;
};

export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type WalletConnectorState = {
  /// Lifecycle phase. See module header for semantics.
  status: "uninstalled" | "disconnected" | "connecting" | "connected";
  /// 0x-prefixed lowercase address, or null when not connected.
  address: string | null;
  /// 0x-prefixed hex chainId, populated once a provider is bound.
  chainId: string | null;
  /// Most recent error message — connect rejection, request failure,
  /// etc. Cleared on the next successful op.
  error: string | null;
};

type Listener = (state: WalletConnectorState) => void;

class WalletConnector {
  private _provider: Eip1193Provider | null = null;
  private _info: Eip6963ProviderInfo | null = null;
  private _state: WalletConnectorState = {
    status: "uninstalled",
    address: null,
    chainId: null,
    error: null,
  };
  private _listeners = new Set<Listener>();
  private _initPromise: Promise<void> | null = null;

  /// Discover the provider via EIP-6963 first, then window.datum.
  /// Idempotent — first caller pays the cost; later callers reuse the
  /// resolved promise.
  init(): Promise<void> {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._init();
    return this._initPromise;
  }

  private async _init(): Promise<void> {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        info: Eip6963ProviderInfo;
        provider: Eip1193Provider;
      };
      if (!detail || detail.info?.rdns !== "io.javcon.datum") return;
      if (this._provider) return; // already bound
      this._bindProvider(detail.provider, detail.info);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    // Ask any pre-existing injectors to re-announce so we don't depend
    // on script-load order.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Wait briefly for the announce to fire. If nothing arrives we
    // fall back to window.datum directly.
    await new Promise<void>((r) => setTimeout(r, DISCOVERY_TIMEOUT_MS));
    window.removeEventListener("eip6963:announceProvider", onAnnounce);

    if (this._provider) return;

    // Fallback path — direct window.datum binding. The injector sets
    // this whether or not EIP-6963 announced successfully.
    const direct = (window as unknown as { datum?: Eip1193Provider }).datum;
    if (direct && (direct.isDatum || typeof direct.request === "function")) {
      this._bindProvider(direct, {
        uuid: "fallback",
        name: "DATUM",
        icon: "",
        rdns: "io.javcon.datum",
      });
      return;
    }
    // No provider — leave status="uninstalled". Pages that require
    // signing will render <NeedsExtension> instead of the form.
  }

  /// Snapshot of the connector state. Always returns a fresh copy.
  getState(): WalletConnectorState {
    return { ...this._state };
  }

  /// Whether the DATUM extension was detected. False before init()
  /// resolves and after init() if nothing announced.
  isInstalled(): boolean {
    return this._provider !== null;
  }

  /// EIP-6963 info if known.
  getInfo(): Eip6963ProviderInfo | null {
    return this._info;
  }

  /// Subscribe to state changes. The callback fires synchronously
  /// with the current snapshot before any future updates.
  onChange(listener: Listener): () => void {
    this._listeners.add(listener);
    try {
      listener(this.getState());
    } catch (err) {
      console.error("[walletConnector] listener threw on initial emit", err);
    }
    return () => {
      this._listeners.delete(listener);
    };
  }

  /// Request an account from the extension. Triggers the popup
  /// approval flow on first call from a new origin; subsequent calls
  /// resolve immediately.
  async connect(): Promise<string | null> {
    if (!this._provider) {
      this._setState({ status: "uninstalled", error: "Extension not installed" });
      return null;
    }
    this._setState({ status: "connecting", error: null });
    try {
      const accounts = (await this._provider.request<string[]>({
        method: "eth_requestAccounts",
      })) ?? [];
      const address = accounts[0]?.toLowerCase() ?? null;
      this._setState({
        status: address ? "connected" : "disconnected",
        address,
        error: null,
      });
      return address;
    } catch (err: any) {
      this._setState({
        status: "disconnected",
        address: null,
        error: String(err?.message ?? err),
      });
      throw err;
    }
  }

  /// Send an EIP-1193 request as-is. Used for read RPCs the page
  /// wants to make through the wallet (so they go via pine instead
  /// of an external RPC). Most callers should use ethers' BrowserProvider
  /// wrapper around `getProvider()` instead.
  async request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T> {
    if (!this._provider) {
      throw new Error("DATUM extension not installed");
    }
    return this._provider.request<T>(args);
  }

  /// Expose the underlying EIP-1193 provider for ethers wrappers
  /// (new ethers.BrowserProvider(walletConnector.getProvider()!)).
  getProvider(): Eip1193Provider | null {
    return this._provider;
  }

  // ── Internals ────────────────────────────────────────────────────

  private _bindProvider(p: Eip1193Provider, info: Eip6963ProviderInfo): void {
    this._provider = p;
    this._info = info;
    // We start in "disconnected" once a provider is detected — actual
    // connect requires the user to grant via the popup.
    this._setState({ status: "disconnected", error: null });
    // Pull the current chainId immediately; it's free (no permission
    // required) and lets the page render network-aware UI.
    p.request<string>({ method: "eth_chainId" })
      .then((chainId) => this._setState({ chainId }))
      .catch(() => undefined);
    // Subscribe to EIP-1193 events. accountsChanged tracks switches
    // (also fires on lock with []); chainChanged covers future
    // multi-chain support.
    p.on("accountsChanged", (...args: unknown[]) => {
      const accounts = (args[0] as string[]) ?? [];
      const address = accounts[0]?.toLowerCase() ?? null;
      this._setState({
        status: address ? "connected" : "disconnected",
        address,
      });
    });
    p.on("chainChanged", (...args: unknown[]) => {
      const chainId = typeof args[0] === "string" ? args[0] : null;
      this._setState({ chainId });
    });
    p.on("disconnect", () => {
      this._setState({
        status: "disconnected",
        address: null,
      });
    });
  }

  private _setState(patch: Partial<WalletConnectorState>): void {
    this._state = { ...this._state, ...patch };
    for (const listener of this._listeners) {
      try {
        listener(this.getState());
      } catch (err) {
        console.error("[walletConnector] listener threw", err);
      }
    }
  }
}

/// Singleton — pages should not instantiate their own connector.
export const walletConnector = new WalletConnector();

// ── Test surface ─────────────────────────────────────────────────────

export const __test = {
  /// Reset the singleton's state. Tests reach for this; nothing in
  /// production should call it.
  reset(): void {
    // Re-create the singleton's private state via casting since the
    // class fields are private.
    const w = walletConnector as unknown as {
      _provider: Eip1193Provider | null;
      _info: Eip6963ProviderInfo | null;
      _state: WalletConnectorState;
      _listeners: Set<Listener>;
      _initPromise: Promise<void> | null;
    };
    w._provider = null;
    w._info = null;
    w._state = {
      status: "uninstalled",
      address: null,
      chainId: null,
      error: null,
    };
    w._listeners.clear();
    w._initPromise = null;
  },
};
