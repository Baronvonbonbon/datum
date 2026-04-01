import "./chromeMock";
import {
  getCategoryParent,
  buildCategoryHierarchy,
  CATEGORY_NAMES,
} from "@shared/types";

describe("getCategoryParent", () => {
  test("top-level categories (1-26) return 0", () => {
    for (let id = 1; id <= 26; id++) {
      expect(getCategoryParent(id)).toBe(0);
    }
  });

  test("subcategory 101 (Celebrities) → parent 1 (Arts & Entertainment)", () => {
    expect(getCategoryParent(101)).toBe(1);
  });

  test("subcategory 2604 (Polkadot & Parachains) → parent 26 (Crypto & Web3)", () => {
    expect(getCategoryParent(2604)).toBe(26);
  });

  test("subcategory 701 (Banking) → parent 7 (Finance)", () => {
    expect(getCategoryParent(701)).toBe(7);
  });

  test("subcategory 1001 (Health Conditions) → parent 10 (Health)", () => {
    expect(getCategoryParent(1001)).toBe(10);
  });

  test("out of range (>2700) returns 0", () => {
    expect(getCategoryParent(3000)).toBe(0);
  });

  test("0 returns 0", () => {
    expect(getCategoryParent(0)).toBe(0);
  });
});

describe("buildCategoryHierarchy", () => {
  test("returns 26 top-level groups", () => {
    const groups = buildCategoryHierarchy();
    expect(groups).toHaveLength(26);
  });

  test("each group has id, name, children", () => {
    const groups = buildCategoryHierarchy();
    for (const g of groups) {
      expect(g.id).toBeGreaterThanOrEqual(1);
      expect(g.id).toBeLessThanOrEqual(26);
      expect(typeof g.name).toBe("string");
      expect(Array.isArray(g.children)).toBe(true);
    }
  });

  test("Crypto & Web3 (26) has subcategories including Polkadot", () => {
    const groups = buildCategoryHierarchy();
    const crypto = groups.find((g) => g.id === 26)!;
    expect(crypto.name).toBe("Crypto & Web3");
    expect(crypto.children.length).toBeGreaterThanOrEqual(4);
    const polkadot = crypto.children.find((c) => c.id === 2604);
    expect(polkadot).toBeDefined();
    expect(polkadot!.name).toBe("Polkadot & Parachains");
  });

  test("no subcategory appears in multiple parents", () => {
    const groups = buildCategoryHierarchy();
    const allChildIds = groups.flatMap((g) => g.children.map((c) => c.id));
    const unique = new Set(allChildIds);
    expect(unique.size).toBe(allChildIds.length);
  });

  test("all CATEGORY_NAMES subcategories are accounted for", () => {
    const groups = buildCategoryHierarchy();
    const allChildIds = new Set(groups.flatMap((g) => g.children.map((c) => c.id)));
    const topLevelIds = new Set(groups.map((g) => g.id));

    for (const [idStr] of Object.entries(CATEGORY_NAMES)) {
      const id = Number(idStr);
      if (id === 0) continue; // Uncategorized
      if (id >= 1 && id <= 26) {
        expect(topLevelIds.has(id)).toBe(true);
      } else {
        expect(allChildIds.has(id)).toBe(true);
      }
    }
  });
});
