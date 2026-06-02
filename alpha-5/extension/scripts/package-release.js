// package-release.js — bundle the production extension build (dist/) into a
// store-uploadable zip named after the manifest version. Run via
// `npm run build:release` (which builds dist/ first).
//
// The artifact lands in release/datum-extension-v<version>.zip and is what you
// upload to the Chrome Web Store / Edge Add-ons dashboard. Source maps are
// excluded (the production build emits none, but the filter is belt-and-braces).

const { execSync } = require("node:child_process");
const { readFileSync, mkdirSync, existsSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const manifestPath = resolve(root, "dist", "manifest.json");

if (!existsSync(manifestPath)) {
  console.error("[package-release] dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(manifestPath, "utf8"));
mkdirSync(resolve(root, "release"), { recursive: true });
const out = `release/datum-extension-v${version}.zip`;
const outAbs = resolve(root, out);
if (existsSync(outAbs)) rmSync(outAbs);

// Zip the CONTENTS of dist/ (so manifest.json sits at the archive root, as the
// stores require) — not the dist/ directory itself.
execSync(`cd "${resolve(root, "dist")}" && zip -qr "${outAbs}" . -x '*.map'`, {
  stdio: "inherit",
  shell: "/bin/bash",
});

console.log(`[package-release] packaged ${out} (manifest version ${version})`);
