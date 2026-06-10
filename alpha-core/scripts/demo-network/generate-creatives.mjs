// generate-creatives.mjs — write themed SVG ad creatives for every brand × IAB
// format defined in manifest.json. Output: creatives/<brandId>/<format>.svg, each
// sized to exact IAB pixels. Self-contained SVG (no external refs) so it pins to
// IPFS and renders anywhere. Re-run any time; it overwrites.
//
//   node generate-creatives.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf8"));
const SIZES = manifest.formatSizes;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Greedy word-wrap to a max chars-per-line, capped at maxLines (last line ellipsized).
function wrap(text, perLine, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > perLine) {
      if (cur) lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, "…");
  }
  return lines.slice(0, maxLines);
}

function tspans(lines, x, y, lh) {
  return lines.map((l, i) => `<tspan x="${x}" y="${y + i * lh}">${esc(l)}</tspan>`).join("");
}

// Monogram tile: rounded square with an accent gradient + the brand initial.
function tile(x, y, s, b, gid) {
  const r = Math.max(4, s * 0.18);
  return (
    `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="url(#${gid})"/>` +
    `<text x="${x + s / 2}" y="${y + s / 2}" font-size="${s * 0.6}" font-weight="800" ` +
    `fill="${b.bg}" text-anchor="middle" dominant-baseline="central" font-family="Inter,Arial,sans-serif">${esc(b.name[0])}</text>`
  );
}

function ctaPill(x, y, w, h, label, b) {
  const r = h / 2;
  const fs = Math.min(h * 0.5, 15);
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${b.accent}"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2}" font-size="${fs}" font-weight="700" fill="${b.bg}" ` +
    `text-anchor="middle" dominant-baseline="central" font-family="Inter,Arial,sans-serif">${esc(label)}</text>`
  );
}

// Build one creative for a brand at a given pixel size.
function creative(b, w, h) {
  const gid = `g_${b.id}`;
  const ratio = w / h;
  const layout = ratio > 3 ? "strip" : ratio < 0.7 ? "tower" : "box";
  const defs =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${b.accent}"/><stop offset="1" stop-color="${b.accent2}"/></linearGradient></defs>`;
  const bg = `<rect width="${w}" height="${h}" fill="${b.bg}"/>` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="${b.accent}" stroke-opacity="0.25"/>`;
  // tiny "Ad" marker, top-right
  const adMark = `<text x="${w - 5}" y="11" font-size="9" fill="${b.fg}" fill-opacity="0.45" text-anchor="end" font-family="Inter,Arial,sans-serif">Ad</text>`;
  let body = "";

  if (layout === "strip") {
    const ts = Math.min(h - 16, 64);
    const ty = (h - ts) / 2;
    const small = h < 70;
    const nameFs = small ? 15 : 22;
    const tagFs = small ? 0 : 13;
    const cw = small ? 78 : 120, ch = small ? 26 : 34;
    const cx = w - cw - 12, cy = (h - ch) / 2;
    const textX = 14 + ts + 14;
    body =
      tile(12, ty, ts, b, gid) +
      `<text x="${textX}" y="${small ? h / 2 : h * 0.42}" font-size="${nameFs}" font-weight="800" fill="${b.fg}" ` +
      `dominant-baseline="central" font-family="Inter,Arial,sans-serif">${esc(b.name)}</text>` +
      (tagFs
        ? `<text x="${textX}" y="${h * 0.72}" font-size="${tagFs}" fill="${b.fg}" fill-opacity="0.7" font-family="Inter,Arial,sans-serif">${esc(b.tagline)}</text>`
        : "") +
      ctaPill(cx, cy, cw, ch, b.cta, b);
  } else if (layout === "tower") {
    const ts = Math.min(w - 32, 96);
    const tx = (w - ts) / 2;
    body =
      tile(tx, 24, ts, b, gid) +
      `<text x="${w / 2}" y="${24 + ts + 30}" font-size="20" font-weight="800" fill="${b.fg}" text-anchor="middle" font-family="Inter,Arial,sans-serif">${esc(b.name)}</text>` +
      `<text font-size="14" fill="${b.fg}" fill-opacity="0.82" text-anchor="middle" font-family="Inter,Arial,sans-serif">${tspans(wrap(b.tagline, Math.floor(w / 8), 3), w / 2, 24 + ts + 58, 19)}</text>` +
      `<text font-size="12" fill="${b.fg}" fill-opacity="0.6" text-anchor="middle" font-family="Inter,Arial,sans-serif">${tspans(wrap(b.text, Math.floor(w / 7), h > 400 ? 5 : 2), w / 2, h - 110, 17)}</text>` +
      ctaPill((w - Math.min(w - 32, 180)) / 2, h - 56, Math.min(w - 32, 180), 38, b.cta, b);
  } else {
    // Box formats (medium-rectangle / large-rectangle / square) are short — tile
    // + name + tagline + CTA only. Body copy is omitted here (it overlaps the CTA
    // at 250–280px tall); it lives on the taller tower formats instead.
    const ts = Math.min(w, h) * 0.3;
    body =
      tile(16, 16, ts, b, gid) +
      `<text x="16" y="${16 + ts + 32}" font-size="22" font-weight="800" fill="${b.fg}" font-family="Inter,Arial,sans-serif">${esc(b.name)}</text>` +
      `<text font-size="14" fill="${b.fg}" fill-opacity="0.82" font-family="Inter,Arial,sans-serif">${tspans(wrap(b.tagline, Math.floor(w / 8), 2), 16, 16 + ts + 56, 19)}</text>` +
      ctaPill(16, h - 50, Math.min(w - 32, 150), 36, b.cta, b);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(b.name)} — ${esc(b.tagline)}">` +
    defs + bg + body + adMark + `</svg>`
  );
}

let n = 0;
for (const b of manifest.brands) {
  const outDir = resolve(DIR, "creatives", b.id);
  mkdirSync(outDir, { recursive: true });
  for (const fmt of manifest.formats) {
    const { w, h } = SIZES[fmt];
    writeFileSync(resolve(outDir, `${fmt}.svg`), creative(b, w, h));
    n++;
  }
  console.log(`  ${b.id}: ${manifest.formats.length} formats`);
}
console.log(`\n✓ Generated ${n} SVG creatives across ${manifest.brands.length} brands → creatives/`);
