import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const EXT_SRC = path.resolve(__dirname, "../alpha-3/extension/src");
const WEB_SRC = path.resolve(__dirname, "src");

// Marker string used to detect whether an importer lives inside the extension's src tree.
const EXT_MARKER = `${path.sep}alpha-3${path.sep}extension${path.sep}src${path.sep}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    /**
     * Force bare-module imports from extension source files to always resolve
     * from web/node_modules, not from the extension's own node_modules (which
     * isn't installed in CI/Cloudflare where only `cd web && npm install` runs).
     */
    dedupe: ["ethers", "react", "react-dom", "@noble/hashes", "pine-rpc"],

    alias: [
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
