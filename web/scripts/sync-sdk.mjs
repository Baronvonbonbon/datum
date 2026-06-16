#!/usr/bin/env node
// sync-sdk.mjs — propagate the canonical Publisher SDK to every place it is
// served from, so the four copies can never drift again.
//
// Canonical source:  sdk/datum-sdk.js   (the SDK's home + dev version)
// Targets:
//   - web/public/datum-sdk.js                                  (Cloudflare site + /demo)
//   - docs/datum-sdk.js                                        (GitHub Pages)
//   - wordpress-plugin/datum-publisher/assets/js/datum-sdk.js  (WP plugin)
//
// Root cause this addresses: there were four hand-maintained copies that drifted
// across versions (sdk/ v3.4, docs/+web v3.3, WP v3.2) — production lagged the
// source by a feature version. Run after editing the SDK:  node scripts/sync-sdk.mjs
// CI runs `--check` to fail the build on any drift.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const SOURCE = path.join(repoRoot, "sdk", "datum-sdk.js");
const TARGETS = [
  path.join(repoRoot, "web", "public", "datum-sdk.js"),
  path.join(repoRoot, "docs", "datum-sdk.js"),
  path.join(repoRoot, "wordpress-plugin", "datum-publisher", "assets", "js", "datum-sdk.js"),
];

const check = process.argv.includes("--check");
const rel = (p) => path.relative(repoRoot, p);

if (!fs.existsSync(SOURCE)) {
  console.error(`[sync-sdk] canonical source missing: ${rel(SOURCE)}`);
  process.exit(1);
}
const src = fs.readFileSync(SOURCE, "utf8");
const version = (src.match(/var VERSION = "([^"]+)"/) || [])[1] || "?";

let drift = 0;
let wrote = 0;
for (const target of TARGETS) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (current === src) continue;
  if (check) {
    console.error(`[sync-sdk] DRIFT: ${rel(target)} differs from ${rel(SOURCE)}`);
    drift++;
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, src);
    console.log(`[sync-sdk] wrote ${rel(target)}`);
    wrote++;
  }
}

if (check) {
  if (drift > 0) {
    console.error(`[sync-sdk] ${drift} copy(ies) out of sync. Run: node web/scripts/sync-sdk.mjs`);
    process.exit(1);
  }
  console.log(`[sync-sdk] OK — all ${TARGETS.length} copies match sdk/datum-sdk.js (v${version}).`);
} else {
  console.log(`[sync-sdk] done — synced ${wrote}/${TARGETS.length} target(s) to v${version}.`);
}
