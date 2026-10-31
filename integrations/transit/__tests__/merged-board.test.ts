import type { IntegrationContext } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { Departure, TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../orchestrator.js";
import { createPlaceTransit } from "../place-transit.js";

function stop(id: string, name = "Central"): TransitStop {
  const [provider] = id.split(":");
  return { id, provider, name, lat: 50.775, lng: 6.084, modes: ["rail"] };
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

/**
 * A board whose linked stops answer with the given departures, in stop order.
 * Stops are named "Central" unless `names` says otherwise.
 */
async function board(
  byStop: Record<string, Departure[]>,
  names: Record<string, string> = {},
  placeName = "Central",
  openedFor?: string,
) {
  const ctx = {
    cache: {
      get: async () => null,
      set: async () => {},
      withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
    },
  } as unknown as IntegrationContext;
  const found: MobilityResult<TransitStop[]> = {
    data: Object.keys(byStop).map((id) => stop(id, names[id])),
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
    { lat: 50.775, lng: 6.084, name: placeName, stopName: openedFor },
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

describe("place stop linking", () => {
  it("keeps a stop abbreviating the station name when another source spells it out", async () => {
    const rows = await board(
      {
        "ms:hbf": [dep("ms:t1", "RE1", "Aachen Hbf", "10:00:00")],
        "mo:hbf": [dep("mo:x1", "S11", "Bergisch Gladbach", "10:05:00")],
        "mo:messe": [dep("mo:m1", "S6", "Essen Hbf", "10:07:00")],
      },
      { "ms:hbf": "Köln Hbf", "mo:hbf": "Köln Hauptbahnhof", "mo:messe": "Köln Messe" },
      "Köln Hauptbahnhof",
    );
    expect(rows.map((row) => row.stop?.id)).toEqual(["ms:hbf", "mo:hbf"]);
  });
});

describe("the stop a merged row leaves from", () => {
  it("names each row's stop without marking any when sources only spell the station differently", async () => {
    const rows = await board(
      {
        "ms:hbf": [dep("ms:t1", "RE1", "Aachen Hbf", "10:00:00")],
        "mo:hbf": [dep("mo:x1", "S11", "Bergisch Gladbach", "10:05:00")],
        "hm:hbf": [dep("hm:y1", "ICE 315", "Frankfurt(M) Flughafen", "10:10:00")],
      },
      { "ms:hbf": "Köln Hbf", "mo:hbf": "Köln Hauptbahnhof", "hm:hbf": "Hauptbahnhof, Köln" },
      "Köln Hauptbahnhof",
    );
    expect(rows.map((row) => row.stop)).toEqual([
      { id: "ms:hbf", name: "Köln Hbf" },
      { id: "mo:hbf", name: "Köln Hauptbahnhof" },
      { id: "hm:hbf", name: "Hauptbahnhof, Köln" },
    ]);
    expect(rows.some((row) => row.atOtherStop)).toBe(false);
  });

  it("treats a parenthesised qualifier as the same stop", async () => {
    const rows = await board(
      {
        "ms:hbf": [dep("ms:t1", "RE50", "Fulda", "10:00:00")],
        "mo:hbf": [dep("mo:x1", "S8", "Wiesbaden Hbf", "10:05:00")],
      },
      { "ms:hbf": "Frankfurt(Main)Hbf", "mo:hbf": "Frankfurt Hauptbahnhof" },
      "Frankfurt (Main) Hauptbahnhof",
    );
    expect(rows.some((row) => row.atOtherStop)).toBe(false);
  });

  it("marks rows leaving from a differently named stop of the place", async () => {
    const rows = await board(
      {
        "ms:hbf": [dep("ms:t1", "RE1", "Aachen Hbf", "10:00:00")],
        "ms:breslauer": [dep("ms:b1", "250", "Bergisch Gladbach", "10:02:00")],
      },
      { "ms:hbf": "Köln Hbf", "ms:breslauer": "Köln Breslauer Platz/Hbf" },
      "Köln Hauptbahnhof",
    );
    expect(rows.map((row) => [row.stop?.name, row.atOtherStop ?? false])).toEqual([
      ["Köln Hbf", false],
      ["Köln Breslauer Platz/Hbf", true],
    ]);
    expect(rows[1].fieldContributors?.stop).toBeDefined();
  });

  it("keeps a row at the main stop when another source lists it at a stop nearby", async () => {
    // A stop's board can include the whole station's departures (HAFAS related stations).
    const rows = await board(
      {
        "mo:hbf": [dep("mo:t1", "ICE 127", "Frankfurt(Main)Hbf", "10:00:00")],
        "oebb:breslauer": [
          dep("oebb:t1", "ICE 127", "Frankfurt(Main)Hbf", "10:00:00"),
          dep("oebb:b1", "250", "Bergisch Gladbach", "10:02:00"),
        ],
      },
      { "mo:hbf": "Köln Hbf", "oebb:breslauer": "Breslauer Platz/Hauptbahnhof, Köln" },
      "Köln Hbf",
    );
    expect(
      rows.map((row) => [row.route.shortName, row.stop?.name, row.atOtherStop ?? false]),
    ).toEqual([
      ["ICE 127", "Köln Hbf", false],
      ["250", "Breslauer Platz/Hauptbahnhof, Köln", true],
    ]);
  });

  it("uses the stop a source states for each departure over the stop it was asked about", async () => {
    const rows = await board(
      {
        "oebb:breslauer": [
          dep("oebb:t1", "ICE 127", "Frankfurt(Main)Hbf", "10:00:00", {
            stop: { id: "oebb:8000207", name: "Köln Hbf" },
          }),
        ],
        "db:hbf": [
          dep("db:b1", "250", "Bergisch Gladbach", "10:02:00", {
            stop: { id: "db:breslauer", name: "Köln Breslauer Platz/Hbf" },
          }),
        ],
      },
      { "oebb:breslauer": "Breslauer Platz/Hauptbahnhof, Köln", "db:hbf": "Köln Hbf" },
      "Köln Hbf",
    );
    expect(rows.map((row) => [row.stop?.id, row.atOtherStop ?? false])).toEqual([
      ["oebb:8000207", false],
      ["db:breslauer", true],
    ]);
  });

  it("treats the stop the place was opened for as main, naming the station instead", async () => {
    const rows = await board(
      {
        "ms:hbf": [dep("ms:t1", "RE1", "Aachen Hbf", "10:00:00")],
        "ms:breslauer": [dep("ms:b1", "250", "Bergisch Gladbach", "10:02:00")],
      },
      { "ms:hbf": "Köln Hbf", "ms:breslauer": "Köln Breslauer Platz/Hbf" },
      "Köln Hauptbahnhof",
      "Köln Breslauer Platz/Hbf",
    );
    expect(rows.map((row) => [row.stop?.name, row.atOtherStop ?? false])).toEqual([
      ["Köln Hbf", true],
      ["Köln Breslauer Platz/Hbf", false],
    ]);
  });

  it("takes the stop named most like the place as main when none is named exactly like it", async () => {
    const rows = await board(
      {
        "ms:bf": [dep("ms:t1", "RE1", "Aachen Hbf", "10:00:00")],
        "ms:bus": [dep("ms:u1", "150", "Chorweiler", "10:01:00")],
      },
      { "ms:bf": "Köln Messe/Deutz Bf", "ms:bus": "Köln Messe/Deutz Ottoplatz Bussteig" },
      "Köln Messe/Deutz",
    );
    expect(rows.map((row) => row.atOtherStop ?? false)).toEqual([false, true]);
  });
});
