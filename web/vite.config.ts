import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const EXT_SRC = path.resolve(__dirname, "../alpha-5/extension/src");
const WEB_SRC = path.resolve(__dirname, "src");

// Marker string used to detect whether an importer lives inside the extension's src tree.
const EXT_MARKER = `${path.sep}alpha-5${path.sep}extension${path.sep}src${path.sep}`;

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // smoldot manages its own WASM/Worker loading — exclude from esbuild pre-bundling
    // so Vite doesn't choke on its subpath exports (./no-auto-bytecode, ./bytecode)
    exclude: ["smoldot"],
  },
  resolve: {
    /**
     * Force bare-module imports from extension source files to always resolve
     * from web/node_modules, not from the extension's own node_modules (which
     * isn't installed in CI/Cloudflare where only `cd web && npm install` runs).
     */
    // Note: do NOT dedupe @noble/hashes — ethers pins 1.3.2 while
    // @polkadot-api/substrate-bindings needs 2.x (imports "@noble/hashes/blake2.js"
    // which only exists in 2.x). Deduping forces everyone onto the hoisted 1.3.2
    // and breaks the bulletin-chain client build.
    dedupe: ["ethers", "react", "react-dom", "pine-rpc", "qrcode"],

    alias: [
      /**
       * wallet.ts (extension src, OUTSIDE web/) imports "@noble/hashes/argon2.js".
       * Resolved from its own location it can't see web/node_modules, and on CI the
       * extension's own node_modules isn't installed → "failed to resolve". We can't
       * dedupe the whole package (ethers→1.3.2 vs PAPI→2.x, see below), so pin just
       * this one subpath to web's installed 2.x file (which ships argon2.js).
       */
      { find: "@noble/hashes/argon2.js", replacement: path.resolve(__dirname, "node_modules/@noble/hashes/argon2.js") },

      /**
       * "@shared/..." — context-sensitive redirect:
       *
       *   importer inside  extension/src  →  extension/src/shared/…
       *   importer anywhere else          →  web/src/shared/…
       *
       * Using customResolver gives us access to `importer` at alias-resolution
       * time.  We delegate back to `this.resolve()` so Vite still handles file
       * extension probing (.ts / .tsx / .js / …) and all other built-in logic.
       */
      {
        find: /^@shared\/(.*)/,
        replacement: "$1",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async customResolver(this: any, source: string, importer: string | undefined, options: any) {
          const targetDir = importer?.includes(EXT_MARKER)
            ? path.join(EXT_SRC, "shared")
            : path.join(WEB_SRC, "shared");
          return this.resolve(path.join(targetDir, source), importer, { ...options, skipSelf: true });
        },
      },

      /** "@ext/…" always maps to the extension's src root */
      { find: "@ext", replacement: EXT_SRC },
    ],
  },
});
