import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  applyDeutschlandticketFilter,
  DEUTSCHLANDTICKET_MOTIS_MODES,
  preferredModesToMotis,
  rankItineraries,
} from "./transit";

function itin(partial: Partial<TripItinerary>): TripItinerary {
  return {
    duration: 1800,
    startTime: "2026-06-01T10:00:00Z",
    endTime: "2026-06-01T10:30:00Z",
    transfers: 0,
    walkDistance: 0,
    legs: [],
    ...partial,
  } as TripItinerary;
}

describe("preferredModesToMotis", () => {
  it("returns undefined when nothing is selected (falls back to TRANSIT)", () => {
    expect(preferredModesToMotis([])).toBeUndefined();
  });

  it("expands a single preference to its MOTIS modes", () => {
    expect(preferredModesToMotis(["subway"])).toEqual(["SUBWAY"]);
    expect(preferredModesToMotis(["bus"])).toEqual(["BUS", "COACH"]);
  });

  it("unions multiple preferences without duplicates", () => {
    const modes = preferredModesToMotis(["bus", "tram"]);
    expect(modes).toEqual(["BUS", "COACH", "TRAM"]);
  });

  it("keeps subway and train distinct (train excludes SUBWAY)", () => {
    expect(preferredModesToMotis(["train"])).not.toContain("SUBWAY");
    expect(preferredModesToMotis(["train"])).toContain("REGIONAL_RAIL");
  });
});

describe("applyDeutschlandticketFilter", () => {
  it("uses the full covered set when no preference is given", () => {
    expect(applyDeutschlandticketFilter(undefined)).toEqual([...DEUTSCHLANDTICKET_MOTIS_MODES]);
    expect(applyDeutschlandticketFilter([])).toEqual([...DEUTSCHLANDTICKET_MOTIS_MODES]);
  });

  it("excludes long-distance modes (ICE/IC/Nightjet/FlixBus/airplane)", () => {
    const covered = applyDeutschlandticketFilter(undefined);
    for (const excluded of ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "COACH", "AIRPLANE"]) {
      expect(covered).not.toContain(excluded);
    }
  });

  it("intersects an existing preference, dropping excluded modes", () => {
    // "Train" expands to ICE/IC/Nightjet long-distance + the regional modes; only
    // the regional rail modes (RE/RB + S-Bahn) are Deutschlandticket-covered, so
    // those survive the filter while the long-distance modes are dropped.
    const trainModes = preferredModesToMotis(["train"]);
    expect(applyDeutschlandticketFilter(trainModes)).toEqual([
      "REGIONAL_FAST_RAIL",
      "REGIONAL_RAIL",
      "SUBURBAN",
    ]);
  });

  it("drops COACH from a Bus preference but keeps BUS", () => {
    const busModes = preferredModesToMotis(["bus"]);
    expect(applyDeutschlandticketFilter(busModes)).toEqual(["BUS"]);
  });

  it("falls back to the full covered set when the intersection is empty", () => {
    expect(applyDeutschlandticketFilter(["HIGHSPEED_RAIL", "LONG_DISTANCE"])).toEqual([
      ...DEUTSCHLANDTICKET_MOTIS_MODES,
    ]);
  });
});

describe("rankItineraries", () => {
  const fastManyTransfers = itin({ duration: 1000, transfers: 3, walkDistance: 100 });
  const slowFewTransfers = itin({ duration: 2000, transfers: 0, walkDistance: 800 });
  const midLittleWalk = itin({ duration: 1500, transfers: 1, walkDistance: 50 });
  const list = [fastManyTransfers, slowFewTransfers, midLittleWalk];

  it("leaves order untouched for 'best'", () => {
    expect(rankItineraries(list, "best")).toBe(list);
  });

  it("'wheelchair' does not reorder (handled server-side)", () => {
    expect(rankItineraries(list, "wheelchair")).toBe(list);
  });

  it("'fewerTransfers' sorts by transfers then duration", () => {
    const ranked = rankItineraries(list, "fewerTransfers");
    expect(ranked.map((i) => i.transfers)).toEqual([0, 1, 3]);
    expect(ranked).not.toBe(list); // new array, input untouched
  });

  it("'lessWalking' sorts by walk distance then duration", () => {
    const ranked = rankItineraries(list, "lessWalking");
    expect(ranked.map((i) => i.walkDistance)).toEqual([50, 100, 800]);
  });
});
