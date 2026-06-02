// Side-effect module: installs the chrome.* shim at import-evaluation time.
//
// extensionDaemon.ts now statically imports the shared background router, whose
// graph includes modules with top-level chrome.* side effects (e.g. pineBridge's
// chrome.runtime.onMessage.addListener). ES module imports are hoisted and
// evaluated before the importing module's body runs, so a body-level
// installChromeShim() call would run too late — those modules would touch an
// undefined `chrome` and crash the page on load.
//
// Importing THIS module first (before any @ext import) guarantees the shim exists
// before the router graph evaluates. installChromeShim() is idempotent.
import { installChromeShim } from "./chromeShim";

installChromeShim();
