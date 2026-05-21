// Smoke test — confirms Vitest + jsdom + setup.ts are wired
// correctly. Delete or expand once we have real tests.

import { describe, it, expect } from "vitest";

describe("vitest infra", () => {
  it("runs in a jsdom environment with window + localStorage", () => {
    expect(typeof window).toBe("object");
    expect(typeof localStorage).toBe("object");
  });

  it("setup wipes localStorage between tests", () => {
    expect(localStorage.length).toBe(0);
    localStorage.setItem("x", "1");
    expect(localStorage.length).toBe(1);
  });

  it("starts clean on the next test (proves the beforeEach hook)", () => {
    expect(localStorage.length).toBe(0);
  });
});
