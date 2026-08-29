import type { TransitReachabilityCheckResult } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { applyExactTransitReachability } from "./useExploreReachResults";

const places = [
  { id: "a", coordinates: [13.4, 52.5] as const },
  { id: "b", coordinates: [13.5, 52.6] as const },
];

const result = (
  results: TransitReachabilityCheckResult["results"],
): TransitReachabilityCheckResult => ({
  queryTime: "2026-08-30T10:00:00.000Z",
  results,
});

describe("exact Explore transit mask", () => {
  it("applies a complete exact result, including a valid zero-result mask", () => {
    expect(
      applyExactTransitReachability(
        places,
        result([
          { id: "a", durationSeconds: 600, reachable: true },
          { id: "b", durationSeconds: null, reachable: false },
        ]),
      ),
    ).toEqual([places[0]]);
    expect(
      applyExactTransitReachability(
        places,
        result([
          { id: "a", durationSeconds: null, reachable: false },
          { id: "b", durationSeconds: null, reachable: false },
        ]),
      ),
    ).toEqual([]);
  });

  it("rejects missing, duplicate, and stale destination IDs", () => {
    expect(
      applyExactTransitReachability(
        places,
        result([{ id: "a", durationSeconds: 600, reachable: true }]),
      ),
    ).toBeNull();
    expect(
      applyExactTransitReachability(
        places,
        result([
          { id: "a", durationSeconds: 600, reachable: true },
          { id: "a", durationSeconds: 700, reachable: true },
        ]),
      ),
    ).toBeNull();
    expect(
      applyExactTransitReachability(
        places,
        result([
          { id: "a", durationSeconds: 600, reachable: true },
          { id: "old-b", durationSeconds: 700, reachable: true },
        ]),
      ),
    ).toBeNull();
  });
});
