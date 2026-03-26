// window.datum provider bridge.
// Injects a window.datum object into all pages so the DATUM web app can
// request wallet operations via the extension without exposing private keys.
//
// The web app expects an EIP-1193-compatible interface:
//   window.datum.isConnected()  → boolean
//   window.datum.getAddress()   → Promise<string>
//   window.datum.request({ method, params }) → Promise<unknown>
//
// ethers.BrowserProvider wraps request() to derive a Signer.
//
// Communication flow:
//   Page → window.datum.request() → CustomEvent(datum:request) → content script
//   Content script → chrome.runtime.sendMessage → background
//   Background → response → content script → CustomEvent(datum:response) → page

const PROVIDER_SCRIPT = `
(function () {
  if (window.datum) return;

  // Pending request map — supports concurrent calls without race conditions
  var _pending = {};

  function dispatchRequest(method, params) {
    return new Promise(function (resolve, reject) {
      var requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      _pending[requestId] = { resolve: resolve, reject: reject };

      window.dispatchEvent(new CustomEvent('datum:request', {
        detail: { method: method, params: params, requestId: requestId }
      }));

      // Timeout after 60 seconds
      setTimeout(function () {
        if (_pending[requestId]) {
          _pending[requestId].reject(new Error('DATUM provider request timed out'));
          delete _pending[requestId];
        }
      }, 60000);
    });
  }

  window.addEventListener('datum:response', function (e) {
    var d = e.detail;
    if (!d || !d.requestId || !_pending[d.requestId]) return;
    var p = _pending[d.requestId];
    delete _pending[d.requestId];
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.result);
  });

  // Track connection state in page context
  var _connected = false;
  var _address = null;

  window.datum = {
    /** EIP-1193 compatible request method — used by ethers.BrowserProvider */
    request: function (args) {
      var method = args.method;
      var params = args.params || [];

      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return dispatchRequest('eth_accounts', []).then(function (addr) {
            if (addr) { _connected = true; _address = addr; }
            return addr ? [addr] : [];
          });

        case 'eth_chainId':
          return dispatchRequest('eth_chainId', []);

        case 'personal_sign':
          return dispatchRequest('personal_sign', params);

        case 'eth_signTypedData_v4':
          return dispatchRequest('eth_signTypedData_v4', params);

        default:
          // Proxy all other RPC calls (eth_call, eth_getCode, etc.)
          return dispatchRequest(method, params);
      }
    },

    /** Check if wallet is connected (synchronous) */
    isConnected: function () {
      return _connected;
    },

    /** Get the connected address */
    getAddress: function () {
      return dispatchRequest('eth_accounts', []).then(function (addr) {
        if (addr) { _connected = true; _address = addr; }
        return addr || null;
      });
    },

    /** Feature detection */
    isDatum: true,
  };

  // Probe connection status on load
  window.datum.getAddress().catch(function () {});
})();
`;

// Inject the provider script into the page context (MAIN world)
function injectProvider() {
  const script = document.createElement("script");
  script.textContent = PROVIDER_SCRIPT;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// Forward datum:request events from page to background
function listenForRequests() {
  window.addEventListener("datum:request", async (e: Event) => {
    const evt = e as CustomEvent;
    const { method, params, requestId } = evt.detail ?? {};
    if (!requestId) return;

    let result: unknown = null;
    let error: string | undefined;

    try {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts": {
          const resp = await chrome.runtime.sendMessage({ type: "PROVIDER_GET_ADDRESS" });
          result = resp?.address ?? null;
          break;
        }

        case "eth_chainId": {
          const resp = await chrome.runtime.sendMessage({ type: "PROVIDER_GET_CHAIN_ID" });
          result = resp?.chainId ?? "0x1";
          break;
        }

        case "personal_sign": {
          const [message, address] = params ?? [];
          const resp = await chrome.runtime.sendMessage({
            type: "PROVIDER_PERSONAL_SIGN",
            message,
            address,
            requestId,
          });
          if (resp?.error) throw new Error(resp.error);
          result = resp?.signature ?? null;
          break;
        }

        case "eth_signTypedData_v4": {
          // params[0] = address, params[1] = JSON string of typed data
          const [, typedDataJson] = params ?? [];
          const typedData = typeof typedDataJson === "string" ? JSON.parse(typedDataJson) : typedDataJson;
          const resp = await chrome.runtime.sendMessage({
            type: "PROVIDER_SIGN_TYPED_DATA",
            domain: typedData.domain,
            types: typedData.types,
            value: typedData.message,
            requestId,
          });
          if (resp?.error) throw new Error(resp.error);
          result = resp?.signature ?? null;
          break;
        }

        default: {
          // Proxy RPC calls (eth_call, eth_getCode, eth_blockNumber, etc.)
          // to the extension's configured RPC endpoint
          const resp = await chrome.runtime.sendMessage({
            type: "PROVIDER_RPC_PROXY",
            method,
            params,
            requestId,
          });
          if (resp?.error) throw new Error(resp.error);
          result = resp?.result;
          break;
        }
      }
    } catch (err) {
      error = String(err instanceof Error ? err.message : err);
    }

    window.dispatchEvent(new CustomEvent("datum:response", {
      detail: { requestId, result, error },
    }));
  });
}

// Initialize provider bridge
injectProvider();
listenForRequests();
