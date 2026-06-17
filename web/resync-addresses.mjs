// Re-sync webapp address sources to a fresh alpha-core deploy.
// Patches src/shared/networks.ts (ALPHA_5_PASEO block + DEPLOY_VERSION) and
// merges into public/deployed-addresses.json. Idempotent. Run from web/:
//   node resync-addresses.mjs
import fs from "fs";
import path from "path";

const CORE = "../alpha-core/deployed-addresses.json";
const NETWORKS = "src/shared/networks.ts";
const PUBLIC = "public/deployed-addresses.json";
const NEW_VERSION = "2026-06-16T-keyrotation";

// networks.ts key -> deployed-addresses.json key (only where they differ)
const RENAME = { lifecycle: "campaignLifecycle", councilBlocklistCurator: "blocklistCurator" };

const core = JSON.parse(fs.readFileSync(CORE, "utf8"));
const jsonFor = (nkey) => core[RENAME[nkey] ?? nkey];

// ── patch networks.ts ────────────────────────────────────────────────────────
let src = fs.readFileSync(NETWORKS, "utf8");
const start = src.indexOf("const ALPHA_5_PASEO");
const end = src.indexOf("};", start) + 2;
let block = src.slice(start, end);

const changed = [], kept = [];
block = block.replace(/^(\s*)([A-Za-z0-9_]+):(\s*)"0x[0-9a-fA-F]{40}"/gm, (m, ind, key, sp) => {
  const v = jsonFor(key);
  if (!v) { kept.push(key); return m; }                 // not in core deploy (token plane / brand)
  changed.push(key);
  return `${ind}${key}:${sp}"${v}"`;
});
src = src.slice(0, start) + block + src.slice(end);
src = src.replace(/export const DEPLOY_VERSION = "[^"]*";/, `export const DEPLOY_VERSION = "${NEW_VERSION}";`);
fs.writeFileSync(NETWORKS, src);

// ── merge into public/deployed-addresses.json (keep extra keys) ──────────────
const pub = fs.existsSync(PUBLIC) ? JSON.parse(fs.readFileSync(PUBLIC, "utf8")) : {};
for (const [k, v] of Object.entries(core)) pub[k] = v;
fs.writeFileSync(PUBLIC, JSON.stringify(pub, null, 2) + "\n");

console.log(`DEPLOY_VERSION -> ${NEW_VERSION}`);
console.log(`networks.ts: ${changed.length} addresses updated`);
console.log(`networks.ts: ${kept.length} left at old values (not in core deploy): ${kept.join(", ")}`);
console.log(`public/deployed-addresses.json: merged ${Object.keys(core).length} core keys`);
