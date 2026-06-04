// Post-deploy address re-point: propagate alpha-5/deployed-addresses.json (the
// canonical file deploy.ts writes) to the web app's two address spots.
//
//   node scripts/repoint-addresses.mjs            (after a redeploy)
//
// Auto-handled elsewhere (no action needed):
//   - extension/deployed-addresses.json  <- written by deploy.ts (EXT_ADDR_FILE)
//   - relay + indexer                    <- read alpha-5/deployed-addresses.json
//                                           directly (DATUM_ADDRESSES default)
//
// This script touches only the web app:
//   - web/public/deployed-addresses.json <- runtime copy the demo fetches
//   - web/src/shared/networks.ts         <- build-time hardcoded address map
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALPHA5 = path.resolve(here, "..");
const SRC = path.join(ALPHA5, "deployed-addresses.json");
const WEB = path.resolve(ALPHA5, "..", "web");
const PUBLIC = path.join(WEB, "public", "deployed-addresses.json");
const NETWORKS = path.join(WEB, "src", "shared", "networks.ts");

// networks.ts key -> deployed-addresses.json key (where they differ)
const REMAP = { lifecycle: "campaignLifecycle", councilBlocklistCurator: "blocklistCurator" };

const dep = JSON.parse(fs.readFileSync(SRC, "utf8"));
const addr = (k) => dep[REMAP[k] || k];

// 1) runtime copy
fs.copyFileSync(SRC, PUBLIC);
console.log(`copied -> ${path.relative(path.resolve(ALPHA5, ".."), PUBLIC)}`);

// 2) build-time map in networks.ts (in-place per-line address swap; orphans left as-is)
let net = fs.readFileSync(NETWORKS, "utf8");
let updated = 0;
const skipped = [];
net = net.replace(/^(\s*)([A-Za-z][A-Za-z0-9]*)(:\s*)"0x[0-9a-fA-F]{40}"/gm, (m, indent, key, sep) => {
  const a = addr(key);
  if (!a) { skipped.push(key); return m; } // orphan / no deployed equivalent
  updated++;
  return `${indent}${key}${sep}"${a}"`;
});
fs.writeFileSync(NETWORKS, net);
console.log(`networks.ts: ${updated} addresses updated` + (skipped.length ? `, left unmatched: ${[...new Set(skipped)].join(", ")}` : ""));
console.log(`\nNext: rebuild web (npx vite build) + extension, restart relay/indexer.`);
