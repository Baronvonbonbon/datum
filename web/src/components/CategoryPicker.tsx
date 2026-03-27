import { CATEGORY_NAMES } from "@shared/types";

interface Props {
  value: Set<number>;
  onChange: (categories: Set<number>) => void;
  maxCategories?: number; // optional limit (default: unlimited)
}

const TOP_LEVEL = Array.from({ length: 26 }, (_, i) => i + 1);

export function CategoryPicker({ value, onChange, maxCategories }: Props) {
  function toggle(id: number) {
    const next = new Set(value);
    if (next.has(id)) {
      next.delete(id);
    } else {
      if (maxCategories && next.size >= maxCategories) return;
      next.add(id);
    }
    onChange(next);
  }

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
      gap: 4,
    }}>
      {TOP_LEVEL.map((id) => {
        const selected = value.has(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className={selected ? "nano-btn nano-btn-accent" : "nano-btn"}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            <span style={{ marginRight: 4, fontSize: 10, color: "var(--text-muted)" }}>{id}</span>
            {CATEGORY_NAMES[id]}
          </button>
        );
      })}
    </div>
  );
}

/** Convert a Set of category IDs to an on-chain bitmask (bigint) */
export function categoriesToBitmask(categories: Set<number>): bigint {
  let mask = 0n;
  for (const id of categories) {
    if (id >= 1 && id <= 26) mask |= 1n << BigInt(id);
  }
  return mask;
}

/** Convert an on-chain bitmask to a Set of category IDs */
export function bitmaskToCategories(mask: bigint): Set<number> {
  const result = new Set<number>();
  for (let i = 1; i <= 26; i++) {
    if ((mask >> BigInt(i)) & 1n) result.add(i);
  }
  return result;
}
