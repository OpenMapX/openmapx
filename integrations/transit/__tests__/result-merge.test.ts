import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import { describe, expect, it, vi } from "vitest";
import { emptyResult, mergeAttributions, mergeFreshness } from "../result-merge.js";

function attribution(sourceId: string, name = sourceId): Attribution {
  return { sourceId, name };
}

function freshness(
  fetchedAt: string,
  options: Partial<Omit<Freshness, "fetchedAt">> = {},
): Freshness {
  return {
    fetchedAt,
    hasRealtimeData: false,
    isStale: false,
    ...options,
  };
}

describe("transit result merging", () => {
  it("builds an unattributed empty result with explicit realtime policy", () => {
    const before = Date.now();
    const result = emptyResult([], { hasRealtimeData: true });

    expect(result.data).toEqual([]);
    expect(result.attributions).toEqual([]);
    expect(result.freshness).toMatchObject({ hasRealtimeData: true, isStale: false });
    expect(Date.parse(result.freshness.fetchedAt)).toBeGreaterThanOrEqual(before);
  });

  it("deduplicates fallback attribution in first-seen order", () => {
    const first = attribution("first", "First");
    const duplicate = attribution("first", "Duplicate");
    const second = attribution("second", "Second");

    expect(mergeAttributions(undefined, [first], [duplicate, second])).toEqual([first, second]);
    expect(mergeAttributions(undefined)).toEqual([]);
  });

  it("delegates flattened attribution to the host index", () => {
    const ordered = [attribution("curated")];
    const dedupAndOrder = vi.fn(() => ordered);
    const input = [attribution("second"), attribution("first")];

    expect(mergeAttributions({ dedupAndOrder }, [input[0]], [input[1]])).toBe(ordered);
    expect(dedupAndOrder).toHaveBeenCalledWith(input);
  });

  it("uses the oldest timestamps and strongest realtime and stale signals", () => {
    const merged = mergeFreshness(
      freshness("2026-08-31T12:00:00.000Z", { dataAsOf: "2026-08-31T11:59:00.000Z" }),
      freshness("2026-08-31T11:00:00.000Z", {
        dataAsOf: "2026-08-31T10:59:00.000Z",
        hasRealtimeData: true,
      }),
      freshness("2026-08-31T11:30:00.000Z", { isStale: true }),
    );

    expect(merged).toEqual({
      fetchedAt: "2026-08-31T11:00:00.000Z",
      dataAsOf: "2026-08-31T10:59:00.000Z",
      hasRealtimeData: true,
      isStale: true,
    });
  });

  it("returns current static freshness for an empty merge", () => {
    const before = Date.now();
    const merged = mergeFreshness();

    expect(merged).toMatchObject({ hasRealtimeData: false, isStale: false });
    expect(Date.parse(merged.fetchedAt)).toBeGreaterThanOrEqual(before);
  });
});
