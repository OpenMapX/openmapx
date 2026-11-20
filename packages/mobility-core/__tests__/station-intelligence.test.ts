import { describe, expect, it } from "vitest";
import { deriveStationIntelligence } from "../src/station-intelligence.js";
import type {
  TransitPlatformDetail,
  TransitStopAreaSummary,
  TransitStopParking,
  TransportMode,
} from "../src/types/transit.js";

const stop = (id: string, modes: TransportMode[] = ["bus"]) =>
  ({ id, name: id, modes }) as unknown as TransitStopAreaSummary;
const platforms = (count: number, modes: TransportMode[] = ["rail"]) =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    modes,
  })) as unknown as TransitPlatformDetail[];
const parking = (realtime: boolean) =>
  ({
    id: "car-park",
    hasRealtimeData: realtime,
    freeSpaces: realtime ? 12 : undefined,
  }) as unknown as TransitStopParking;

const base = { siblingStops: [], childStops: [], platforms: [], parking: [] };

describe("deriveStationIntelligence", () => {
  it("grades a lone single-mode stop as simple", () => {
    expect(deriveStationIntelligence({ ...base, requestedStop: stop("a") })).toEqual({
      complexity: "simple_stop",
      modeCount: 1,
      hasParking: false,
      hasRealtimeParking: false,
    });
  });

  it("counts every mode source once, including the requested and canonical stops", () => {
    const result = deriveStationIntelligence({
      ...base,
      requestedStop: stop("a", ["tram"]),
      canonicalStop: stop("b", ["bus"]),
      parentStop: stop("c", ["bus"]),
      platforms: platforms(1, ["rail"]),
    });
    expect(result.modeCount).toBe(3);
    expect(result.complexity).toBe("interchange");
  });

  it.each([
    ["two platforms", { platforms: platforms(2) }, "interchange"],
    ["parking alone", { parking: [parking(false)] }, "interchange"],
    ["four platforms", { platforms: platforms(4) }, "regional_hub"],
    ["three connected stop areas", { childStops: [stop("x"), stop("y")] }, "regional_hub"],
    ["eight platforms", { platforms: platforms(8) }, "major_interchange"],
    [
      "four connected stop areas",
      { siblingStops: [stop("x"), stop("y"), stop("z")] },
      "major_interchange",
    ],
    [
      "three modes with five platforms",
      {
        platforms: [...platforms(3, ["rail"]), ...platforms(1, ["tram"]), ...platforms(1, ["bus"])],
      },
      "major_interchange",
    ],
  ] as const)("grades %s", (_label, extra, complexity) => {
    expect(deriveStationIntelligence({ ...base, ...extra }).complexity).toBe(complexity);
  });

  it("reports realtime parking only when a car park publishes free spaces", () => {
    expect(deriveStationIntelligence({ ...base, parking: [parking(false)] })).toMatchObject({
      hasParking: true,
      hasRealtimeParking: false,
    });
    expect(
      deriveStationIntelligence({ ...base, parking: [parking(true)] }).hasRealtimeParking,
    ).toBe(true);
  });
});
