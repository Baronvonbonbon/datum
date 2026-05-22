// Blockie — deterministic 8×8 pixel identicon derived from an
// Ethereum address. No external dependency; the algorithm is a
// lightweight PRNG seeded from the address bytes.
//
// Output is a CSS-only grid of coloured squares — no canvas, no
// SVG library, ~1 KB of code. Render at any size via the `size`
// prop; pixel grid stays 8×8 to keep the visual stable across
// scales.
//
// Inspired by Ethereum Blockies but reduced (8×8 instead of
// 8×16-mirrored) and ported to React.

const GRID = 8;

type Rgb = { r: number; g: number; b: number };

export function Blockie({
  address,
  size = 24,
  rounded = true,
}: {
  address: string;
  size?: number;
  rounded?: boolean;
}) {
  const cells = pixelGrid(address);
  const colour = derivedColour(address);
  const bg = mixToward(colour, { r: 240, g: 240, b: 240 }, 0.85);
  const fg = rgbStr(colour);
  const bgStr = rgbStr(bg);
  const cellSize = size / GRID;

  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "grid",
        gridTemplateColumns: `repeat(${GRID}, 1fr)`,
        gridTemplateRows: `repeat(${GRID}, 1fr)`,
        borderRadius: rounded ? Math.round(size * 0.15) : 0,
        overflow: "hidden",
        flexShrink: 0,
        background: bgStr,
      }}
    >
      {cells.map((on, i) => (
        <div
          key={i}
          style={{
            width: cellSize,
            height: cellSize,
            background: on ? fg : "transparent",
          }}
        />
      ))}
    </div>
  );
}

function pixelGrid(address: string): boolean[] {
  // Seed a small PRNG from the address bytes; emit a left-side
  // 4×8 pattern and mirror to the right so the identicon has the
  // characteristic blockies symmetry.
  const rng = seedFromAddress(address);
  const cells = new Array<boolean>(GRID * GRID).fill(false);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID / 2; x++) {
      const on = rng() < 0.5;
      cells[y * GRID + x] = on;
      cells[y * GRID + (GRID - 1 - x)] = on;
    }
  }
  return cells;
}

function derivedColour(address: string): Rgb {
  // Pull three bytes deep in the hash so the colour is roughly
  // decorrelated from the pattern bits up top.
  const hex = (address || "").toLowerCase().replace(/^0x/, "");
  if (hex.length < 12) return { r: 80, g: 120, b: 200 };
  const r = parseInt(hex.slice(20, 22), 16);
  const g = parseInt(hex.slice(22, 24), 16);
  const b = parseInt(hex.slice(24, 26), 16);
  // Boost saturation a little so muted addresses still show colour.
  return saturate({ r, g, b }, 0.15);
}

function saturate(c: Rgb, amount: number): Rgb {
  const avg = (c.r + c.g + c.b) / 3;
  const push = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n + (n - avg) * amount)));
  return { r: push(c.r), g: push(c.g), b: push(c.b) };
}

function mixToward(c: Rgb, target: Rgb, t: number): Rgb {
  return {
    r: Math.round(c.r * (1 - t) + target.r * t),
    g: Math.round(c.g * (1 - t) + target.g * t),
    b: Math.round(c.b * (1 - t) + target.b * t),
  };
}

function rgbStr(c: Rgb): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function seedFromAddress(address: string): () => number {
  // xorshift32 seeded from a sliding xor of the address bytes.
  const hex = (address || "").toLowerCase().replace(/^0x/, "");
  let seed = 0x6a09e667;
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) continue;
    seed = (seed ^ (byte << ((i % 4) * 8))) >>> 0;
    seed = (Math.imul(seed, 0x85ebca6b) + 0x9e3779b1) >>> 0;
  }
  let state = seed || 0xdeadbeef;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}
