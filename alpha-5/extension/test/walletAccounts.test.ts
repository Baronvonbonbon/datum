import {
  type AccountMeta,
  defaultFirstAccount,
  nextHdIndex,
  appendHdAccount,
  appendImportedAccount,
  removeAccount,
  setLabel,
  findAccount,
  activeAccount,
  clampActiveIndex,
} from "../src/background/wallet/accounts";

function hd(index: number, addr: string, label = `Account ${index + 1}`): AccountMeta {
  return {
    source: "hd",
    address: addr.toLowerCase(),
    derivationIndex: index,
    label,
    createdAt: 1_000_000,
  };
}

function imported(addr: string, label = "Imported 1"): AccountMeta {
  return {
    source: "imported",
    address: addr.toLowerCase(),
    derivationIndex: null,
    label,
    createdAt: 1_000_000,
  };
}

describe("wallet/accounts", () => {
  describe("defaultFirstAccount", () => {
    it("creates an HD account at index 0", () => {
      const a = defaultFirstAccount("0xABCD");
      expect(a.source).toBe("hd");
      expect(a.address).toBe("0xabcd");
      expect(a.label).toBe("Account 1");
      if (a.source === "hd") expect(a.derivationIndex).toBe(0);
    });
  });

  describe("nextHdIndex", () => {
    it("returns 0 when no HD accounts present", () => {
      expect(nextHdIndex([])).toBe(0);
      expect(nextHdIndex([imported("0x1")])).toBe(0);
    });

    it("returns max-HD-index + 1", () => {
      const accounts = [hd(0, "0xa"), hd(1, "0xb"), imported("0xc")];
      expect(nextHdIndex(accounts)).toBe(2);
    });

    it("skips gaps — uses max, not length", () => {
      const accounts = [hd(0, "0xa"), hd(5, "0xb")];
      expect(nextHdIndex(accounts)).toBe(6);
    });
  });

  describe("appendHdAccount", () => {
    it("appends with monotonic indexing", () => {
      const a0 = defaultFirstAccount("0xa");
      const next = appendHdAccount([a0], "0xb", 1);
      expect(next).toHaveLength(2);
      expect(next[1].source).toBe("hd");
      expect(next[1].label).toBe("Account 2");
    });

    it("rejects duplicate addresses", () => {
      const a0 = defaultFirstAccount("0xa");
      expect(() => appendHdAccount([a0], "0xA", 1)).toThrow(/already in list/);
    });

    it("uses caller-supplied label when given", () => {
      const a0 = defaultFirstAccount("0xa");
      const next = appendHdAccount([a0], "0xb", 1, "Cold storage");
      expect(next[1].label).toBe("Cold storage");
    });
  });

  describe("appendImportedAccount", () => {
    it("appends with source=imported + derivationIndex=null", () => {
      const a0 = defaultFirstAccount("0xa");
      const next = appendImportedAccount([a0], "0xb");
      expect(next[1].source).toBe("imported");
      if (next[1].source === "imported") expect(next[1].derivationIndex).toBeNull();
    });

    it("default label numbers imported accounts independently", () => {
      const a0 = defaultFirstAccount("0xa");
      const a1 = appendImportedAccount([a0], "0xb");
      const a2 = appendImportedAccount(a1, "0xc");
      expect(a1[1].label).toBe("Imported 1");
      expect(a2[2].label).toBe("Imported 2");
    });

    it("rejects duplicate addresses", () => {
      const list = [defaultFirstAccount("0xa")];
      expect(() => appendImportedAccount(list, "0xA")).toThrow(/already in list/);
    });
  });

  describe("removeAccount", () => {
    it("removes by address (case-insensitive)", () => {
      const list = [hd(0, "0xa"), hd(1, "0xb")];
      const next = removeAccount(list, "0xA");
      expect(next).toHaveLength(1);
      expect(next[0].address).toBe("0xb");
    });

    it("refuses to remove the last account", () => {
      expect(() => removeAccount([hd(0, "0xa")], "0xa")).toThrow(/last account/);
    });

    it("errors when address not found", () => {
      expect(() => removeAccount([hd(0, "0xa"), hd(1, "0xb")], "0xZ")).toThrow(/not found/);
    });
  });

  describe("setLabel", () => {
    it("rewrites the label of a matching address", () => {
      const next = setLabel([hd(0, "0xa", "old"), hd(1, "0xb", "still old")], "0xa", "new");
      expect(next[0].label).toBe("new");
      expect(next[1].label).toBe("still old");
    });

    it("allows empty labels", () => {
      const next = setLabel([hd(0, "0xa", "x")], "0xa", "");
      expect(next[0].label).toBe("");
    });

    it("errors when address not found", () => {
      expect(() => setLabel([hd(0, "0xa")], "0xZ", "x")).toThrow(/not found/);
    });
  });

  describe("findAccount + activeAccount", () => {
    it("findAccount handles case-insensitive lookup", () => {
      const a = findAccount([hd(0, "0xABCD")], "0xabcd");
      expect(a?.address).toBe("0xabcd");
    });

    it("findAccount returns undefined for misses", () => {
      expect(findAccount([hd(0, "0xa")], "0xZ")).toBeUndefined();
    });

    it("activeAccount throws on out-of-range index", () => {
      expect(() => activeAccount([hd(0, "0xa")], 1)).toThrow(/out of range/);
      expect(() => activeAccount([hd(0, "0xa")], -1)).toThrow(/out of range/);
    });
  });

  describe("clampActiveIndex", () => {
    it("returns 0 on empty list", () => {
      expect(clampActiveIndex([], 5)).toBe(0);
    });
    it("clamps to upper bound when prev > new length", () => {
      expect(clampActiveIndex([hd(0, "0xa"), hd(1, "0xb")], 5)).toBe(1);
    });
    it("preserves prev when in range", () => {
      expect(clampActiveIndex([hd(0, "0xa"), hd(1, "0xb"), hd(2, "0xc")], 1)).toBe(1);
    });
    it("clamps negative to 0", () => {
      expect(clampActiveIndex([hd(0, "0xa")], -5)).toBe(0);
    });
  });
});
