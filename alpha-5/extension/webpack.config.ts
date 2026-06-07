/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin");
const WebExtensionPlugin = require("webpack-target-webextension");

const config = (
  _env: Record<string, string>,
  argv: { mode: string }
): object => {
  const isDev = argv.mode === "development";

  return {
    entry: {
      background: "./src/background/index.ts",
      content: "./src/content/index.ts",
      // Stage 2b: new wallet content scripts. walletInjector runs in
      // MAIN world (declared in manifest.json) and exposes window.datum;
      // walletBridge runs in ISOLATED world and relays to background.
      // The legacy `provider` entry is left in for now — it backs the
      // old window.datum binding used by the App.legacy popup and is
      // removed alongside the legacy popup migration.
      provider: "./src/content/provider.ts",
      walletInjector: "./src/content/walletInjector.ts",
      walletBridge: "./src/content/walletBridge.ts",
      popup: "./src/popup/index.tsx",
      offscreen: "./src/offscreen/offscreen.ts",
      history: "./src/history/index.tsx",
    },

    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },

    target: "web",

    resolve: {
      extensions: [".ts", ".tsx", ".js", ".json"],
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
      },
      // ethers v6 uses package.json "exports" — "browser" condition gets tree-shaken build
      conditionNames: ["browser", "module", "import", "default"],
    },

    // No eval; MV3 CSP blocks it.
    devtool: isDev ? "source-map" : false,

    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: [
            {
              loader: "ts-loader",
              options: {
                // transpileOnly for speed; type-check separately with tsc --noEmit
                transpileOnly: true,
              },
            },
          ],
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader"],
        },
      ],
    },

    plugins: [
      // Polyfill Node.js builtins needed by @polkadot/util-crypto and ethers crypto path
      new NodePolyfillPlugin({
        excludeAliases: ["console"],
      }),

      // MV3-aware plugin: handles service worker chunk loading correctly
      new WebExtensionPlugin({
        background: {
          serviceWorkerEntry: "background",
        },
      }),

      new HtmlWebpackPlugin({
        template: "./src/popup/index.html",
        filename: "popup.html",
        chunks: ["popup"],
      }),

      new HtmlWebpackPlugin({
        template: "./src/offscreen/offscreen.html",
        filename: "offscreen.html",
        chunks: ["offscreen"],
        inject: false,  // offscreen.html has its own <script src="offscreen.js">
      }),

      new HtmlWebpackPlugin({
        template: "./src/history/index.html",
        filename: "history.html",
        chunks: ["history"],
      }),

      new CopyWebpackPlugin({
        patterns: [
          { from: "manifest.json", to: "manifest.json" },
          { from: "icons", to: "icons", noErrorOnMissing: true },
          { from: "deployed-addresses.json", to: "deployed-addresses.json", noErrorOnMissing: true },
          // Circuit files for real Groth16 proof generation (impression.circom).
          // They live in alpha-5/circuits (one level up from this extension dir).
          { from: "../circuits/impression_js/impression.wasm", to: "circuits/impression.wasm" },
          { from: "../circuits/impression.zkey", to: "circuits/impression.zkey" },
        ],
      }),

      new webpack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify(
          isDev ? "development" : "production"
        ),
      }),
    ],

    // No splitChunks: content scripts must be self-contained single files.
    // Background chunk loading is handled by webpack-target-webextension.
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
    },

    performance: {
      hints: isDev ? false : "warning",
      maxEntrypointSize: 3_000_000,
      // The Groth16 proving key (circuits/impression.zkey, ~3.2 MiB) is a
      // bundled static asset, not JS — keep the headroom above it so the
      // warning stays meaningful for actual code bloat.
      maxAssetSize: 4_000_000,
    },
  };
};

module.exports = config;
