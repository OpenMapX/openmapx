import type { IntegrationContext } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { Departure, TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../orchestrator.js";
import { createPlaceTransit } from "../place-transit.js";

function stop(id: string): TransitStop {
  const [provider] = id.split(":");
  return { id, provider, name: "Central", lat: 50.775, lng: 6.084, modes: ["rail"] };
}

function dep(
  tripId: string,
  line: string,
  headsign: string,
  time: string,
  extra: Partial<Departure> = {},
): Departure {
  return {
    tripId,
    route: { id: `${tripId.split(":")[0]}:${line}`, shortName: line, longName: "", mode: "rail" },
    headsign,
    scheduledAt: `2026-10-31T${time}Z`,
    ...extra,
  };
}

/** A board whose linked stops answer with the given departures, in stop order. */
async function board(byStop: Record<string, Departure[]>) {
  const ctx = {
    cache: {
      get: async () => null,
      set: async () => {},
      withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
    },
  } as unknown as IntegrationContext;
  const found: MobilityResult<TransitStop[]> = {
    data: Object.keys(byStop).map(stop),
    attributions: [],
    freshness: freshnessNow(),
  };
  const fetch = async (id: string): Promise<MobilityResult<Departure[]>> => ({
    data: byStop[id] ?? [],
    attributions: [],
    freshness: freshnessNow(),
  });
  const orchestrator = {
    searchByNameRaw: vi.fn(async () => found),
    getDepartures: fetch,
    getArrivals: fetch,
  } as unknown as TransitOrchestrator;
  const result = await createPlaceTransit(ctx, orchestrator).getMergedDepartures(
    50.775,
    6.084,
    "Central",
    60,
  );
  return result.data;
}

describe("merged place board", () => {
  it("keeps both directions of a line that leave within the same minutes", async () => {
    const rows = await board({
      "ms:central": [
        dep("ms:t1", "S1", "Köln Hbf", "10:00:00"),
        dep("ms:t2", "S1", "Aachen Hbf", "10:01:00"),
      ],
    });
    expect(rows.map((row) => row.headsign)).toEqual(["Köln Hbf", "Aachen Hbf"]);
  });

  it("keeps consecutive departures of a frequent line from one source apart", async () => {
    const rows = await board({
      "ms:central": [
        dep("ms:t1", "U6", "Klinikum", "10:00:00"),
        dep("ms:t2", "U6", "Klinikum", "10:02:00"),
        dep("ms:t3", "U6", "Klinikum", "10:04:00"),
      ],
    });
    expect(rows.map((row) => row.tripId)).toEqual(["ms:t1", "ms:t2", "ms:t3"]);
  });

  it("folds two sources' copies of one departure despite differently written headsigns", async () => {
    const rows = await board({
      "ms:central": [dep("ms:t1", "RE1", "Köln Hbf", "10:00:00")],
      "mo:central": [dep("mo:x1", "RE 1", "Köln Hauptbahnhof", "10:01:00", { platform: "4" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tripId: "ms:t1",
      tripIds: ["ms:t1", "mo:x1"],
      platform: "4",
      providers: ["ms", "mo"],
    });
  });

  it("pairs each source's copy of a frequent line with the closest departure", async () => {
    const rows = await board({
      "ms:central": [
        dep("ms:t1", "U6", "Klinikum", "10:00:00"),
        dep("ms:t2", "U6", "Klinikum", "10:02:00"),
      ],
      "mo:central": [
        dep("mo:x1", "U6", "Klinikum", "10:00:30"),
        dep("mo:x2", "U6", "Klinikum", "10:02:30"),
      ],
    });
    expect(rows.map((row) => row.tripIds)).toEqual([
      ["ms:t1", "mo:x1"],
      ["ms:t2", "mo:x2"],
    ]);
  });

  it("keeps different lines to the same destination apart across sources", async () => {
    const rows = await board({
      "ms:central": [dep("ms:t1", "S1", "Köln Hbf", "10:00:00", { platform: "2" })],
      "mo:central": [dep("mo:x1", "S2", "Köln Hbf", "10:00:00", { platform: "2" })],
    });
    expect(rows.map((row) => row.route.shortName)).toEqual(["S1", "S2"]);
  });

  it("folds a product-only line name into the numbered line with the same destination", async () => {
    const rows = await board({
      "ms:central": [dep("ms:t1", "ICE 123", "Berlin Hbf", "10:00:00", { platform: "7" })],
      "mo:central": [dep("mo:x1", "ICE", "Berlin Hbf", "10:00:00", { platform: "7" })],
    });
    expect(rows).toHaveLength(1);
  });

  it("folds one source's same trip seen at a station and its platform", async () => {
    const rows = await board({
      "ms:central": [dep("ms:t1", "RE1", "Köln Hbf", "10:00:00")],
      "ms:platform-4": [dep("ms:t1", "RE1", "Köln Hbf", "10:00:00", { platform: "4" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("4");
  });

  it("folds only exact repeats when a source gives no trip ids", async () => {
    const rows = await board({
      "tfl:central": [
        dep("", "Central", "Ealing", "10:00:00"),
        dep("", "Central", "Ealing", "10:03:00"),
      ],
      "tfl:platform": [dep("", "Central", "Ealing", "10:00:00")],
    });
    expect(rows.map((row) => row.scheduledAt)).toEqual([
      "2026-10-31T10:00:00Z",
      "2026-10-31T10:03:00Z",
    ]);
  });
});
