// Sync committed consumer ABIs (web + extension) from the freshly-compiled
// Hardhat artifacts. Run after any contract change that alters an ABI.
//
//   npx hardhat compile && node scripts/sync-abis.mjs
//
// Only rewrites ABIs that changed (semantic compare), so the git diff shows
// exactly which contracts gained/changed functions or events. Reports any
// consumer ABI that has no matching artifact (renamed/removed contract).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALPHA5 = path.resolve(here, "..");
const ART = path.join(ALPHA5, "artifacts", "contracts");
const TARGETS = [
  path.resolve(ALPHA5, "..", "web", "src", "shared", "abis"),
  path.join(ALPHA5, "extension", "src", "shared", "abis"),
];

function collectArtifacts(dir, map = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectArtifacts(p, map);
    else if (e.name.endsWith(".json") && !e.name.endsWith(".dbg.json")) {
      const name = e.name.replace(/\.json$/, "");
      try { const a = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(a.abi)) map[name] = a.abi; } catch {}
    }
  }
  return map;
}

const artAbis = collectArtifacts(ART);
let updated = 0, unchanged = 0;
const missing = [];

for (const dir of TARGETS) {
  if (!fs.existsSync(dir)) { console.log(`(skip, not found) ${dir}`); continue; }
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const name = f.replace(/\.json$/, "");
    const fresh = artAbis[name];
    if (!fresh) { missing.push(path.join(path.basename(path.dirname(path.dirname(dir))), f)); continue; }
    const cur = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (JSON.stringify(cur) === JSON.stringify(fresh)) { unchanged++; continue; }
    fs.writeFileSync(path.join(dir, f), JSON.stringify(fresh, null, 2) + "\n");
    console.log(`  updated ${path.relative(path.resolve(ALPHA5, ".."), path.join(dir, f))}`);
    updated++;
  }
}

console.log(`\n${updated} ABIs updated, ${unchanged} unchanged.`);
if (missing.length) console.log(`No artifact for (renamed/removed?): ${[...new Set(missing)].join(", ")}`);
