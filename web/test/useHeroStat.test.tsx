import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useHeroStat, type HeroStat } from "../src/hooks/useHeroStat";
import { __test as providerTest } from "../src/lib/provider";

beforeEach(() => {
  providerTest.reset();
});

function fireReady(head: number) {
  providerTest.setStatus({
    state: "ready",
    step: "connected",
    peers: 1,
    finalizedHead: head,
    indexedFromBlock: 0,
  });
}

describe("useHeroStat lifecycle", () => {
  it("renders initial loading state, then resolves the value", async () => {
    const stat: HeroStat = {
      label: "Active campaigns",
      value: async () => 42,
    };
    const { result } = renderHook(() => useHeroStat(stat));
    expect(result.current.loading).toBe(true);
    expect(result.current.formatted).toBe("—");

    act(() => fireReady(100));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.value).toBe(42);
    expect(result.current.formatted).toBe("42");
  });

  it("applies a custom formatter", async () => {
    const stat: HeroStat = {
      label: "Total revenue",
      value: async () => 12345,
      formatter: (v) => `$${v}`,
    };
    const { result } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.value).toBe(12345));
    expect(result.current.formatted).toBe("$12345");
  });

  it("resolves delta24h alongside value", async () => {
    const stat: HeroStat = {
      label: "Settlements",
      value: async () => 100,
      delta24h: async () => ({ value: 12, sign: "up" }),
    };
    const { result } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.delta).not.toBeNull());
    expect(result.current.delta).toEqual({ value: 12, sign: "up" });
  });

  it("resolves sparkline alongside value", async () => {
    const stat: HeroStat = {
      label: "Hourly volume",
      value: async () => 1,
      sparkline: async () => [1, 2, 3, 4],
    };
    const { result } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.sparkline).not.toBeNull());
    expect(result.current.sparkline).toEqual([1, 2, 3, 4]);
  });

  it("surfaces fetch errors via state.error", async () => {
    const stat: HeroStat = {
      label: "Broken",
      value: async () => {
        throw new Error("boom");
      },
    };
    const { result } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.formatted).toBe("—");
    expect(result.current.loading).toBe(false);
  });
});

describe("useHeroStat re-render policy", () => {
  it("skips re-render when value, delta, and sparkline are unchanged", async () => {
    const valueFn = vi.fn(async () => 100);
    const stat: HeroStat = {
      label: "Cached",
      value: valueFn,
    };
    const { result, rerender } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.value).toBe(100));
    const firstResult = result.current;

    // Re-tick with the same value — formatter result should be the
    // same object reference because state.setState was a no-op.
    act(() => fireReady(101));
    await waitFor(() => expect(valueFn).toHaveBeenCalledTimes(2));
    // identity preserved across the no-change tick
    rerender();
    expect(result.current).toBe(firstResult);
  });

  it("updates when the value actually changes", async () => {
    let n = 100;
    const stat: HeroStat = {
      label: "Climbing",
      value: async () => n,
    };
    const { result } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.value).toBe(100));

    n = 150;
    act(() => fireReady(101));
    await waitFor(() => expect(result.current.value).toBe(150));
  });

  it("considers the sparkline array element-wise for change detection", async () => {
    let arr = [1, 2, 3];
    const stat: HeroStat = {
      label: "Sparks",
      value: async () => 1,
      sparkline: async () => arr,
    };
    const { result, rerender } = renderHook(() => useHeroStat(stat));
    act(() => fireReady(100));
    await waitFor(() => expect(result.current.sparkline).toEqual([1, 2, 3]));
    const firstSpark = result.current.sparkline;

    // New reference, same values — should NOT re-render.
    arr = [1, 2, 3];
    act(() => fireReady(101));
    await new Promise((r) => setTimeout(r, 10));
    rerender();
    expect(result.current.sparkline).toBe(firstSpark);

    // Now actually change the values.
    arr = [1, 2, 4];
    act(() => fireReady(102));
    await waitFor(() => expect(result.current.sparkline).toEqual([1, 2, 4]));
  });
});
