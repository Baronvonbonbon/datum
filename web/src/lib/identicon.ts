// Deterministic SVG identicon for an EVM address.
//
// Produces a 5×5 symmetric pattern (Jdenticon-style) seeded from
// keccak256(addr) so every address has a stable visual identity even when
// no brand is registered. Pure function — no async, no DOM access.
//
// Output is a base64-encoded data URL string suitable for <img src=...>.

import { keccak256, toUtf8Bytes } from "ethers";

const SATURATION = 60;
const LIGHTNESS = 55;

export function identiconDataUrl(addr: string, size = 64): string {
  const a = (addr || "").toLowerCase();
  const seed = keccak256(toUtf8Bytes(a)).slice(2); // 64 hex chars

  // Hue from first byte; pixel pattern from rest.
  const hue = parseInt(seed.slice(0, 2), 16) * 360 / 256;
  const color = `hsl(${hue.toFixed(0)},${SATURATION}%,${LIGHTNESS}%)`;

  // 5×5 symmetric: left 3 columns drive right 2 via mirror, so we need
  // 15 bits of pattern. Pull from bytes 2..16 (one byte per cell, threshold
  // at the byte's high bit).
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i++) {
    const byte = parseInt(seed.slice(2 + i * 2, 4 + i * 2), 16);
    cells.push(byte > 127);
  }

  const cell = size / 5;
  const rects: string[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if (!cells[row * 3 + col]) continue;
      const x = col * cell;
      const y = row * cell;
      rects.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${color}"/>`);
      if (col < 2) {
        // mirror to the right (cols 3 + 4)
        const mx = (4 - col) * cell;
        rects.push(`<rect x="${mx.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${color}"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#111"/>${rects.join("")}</svg>`;
  // Use a UTF-8-safe encode that handles the SVG's non-ASCII fallback if any.
  const encoded = typeof btoa === "function" ? btoa(svg) : Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}
