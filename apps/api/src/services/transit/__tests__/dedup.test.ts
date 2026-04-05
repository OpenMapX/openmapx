import { describe, expect, it } from "vitest";
import {
  deduplicateStops,
  diceSimilarity,
  haversineMeters,
  isTripNumber,
  normalizeName,
  normalizeShortName,
  normalizeTimestamp,
} from "../dedup.js";
import type { TransitStop } from "../types.js";

// normalizeName

describe("normalizeName", () => {
  it("lowercases and strips common transit tokens", () => {
    expect(normalizeName("Berlin Hauptbahnhof")).toBe("berlin");
  });

  it("removes parenthesised suffixes", () => {
    expect(normalizeName("München Hbf (tief)")).toBe("münchen");
  });

  it("strips multiple noise words", () => {
    // "gare", "central", and "station" are all strip tokens
    expect(normalizeName("Gare Central Station")).toBe("");
    expect(normalizeName("Grand Central Station")).toBe("grand");
  });

  it("collapses whitespace", () => {
    expect(normalizeName("  Berlin  /  Hbf  ")).toBe("berlin");
  });

  it("returns empty string for pure noise input", () => {
    expect(normalizeName("Hbf Station")).toBe("");
  });
});

// diceSimilarity

describe("diceSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(diceSimilarity("berlin", "berlin")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(diceSimilarity("abc", "xyz")).toBe(0);
  });

  it("returns 0 for single-character strings that differ", () => {
    expect(diceSimilarity("a", "b")).toBe(0);
  });

  it("returns value between 0 and 1 for similar strings", () => {
    const sim = diceSimilarity("berlin", "berin");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("returns 1 for two identical empty strings", () => {
    expect(diceSimilarity("", "")).toBe(1);
  });

  it("returns 0 for one empty and one non-empty string", () => {
    expect(diceSimilarity("", "abc")).toBe(0);
  });
});

// haversineMeters

describe("haversineMeters", () => {
  it("returns 0 for same coordinates", () => {
    expect(haversineMeters(52.52, 13.405, 52.52, 13.405)).toBe(0);
  });

  it("returns roughly correct distance for known points", () => {
    // Berlin to Potsdam is ~27 km
    const dist = haversineMeters(52.52, 13.405, 52.3906, 13.0645);
    expect(dist).toBeGreaterThan(25_000);
    expect(dist).toBeLessThan(30_000);
  });

  it("returns short distance for nearby points", () => {
    // ~100m offset
    const dist = haversineMeters(52.52, 13.405, 52.5209, 13.405);
    expect(dist).toBeGreaterThan(50);
    expect(dist).toBeLessThan(200);
  });
});

// normalizeShortName

describe("normalizeShortName", () => {
  it("strips parenthetical suffixes at end", () => {
    expect(normalizeShortName("RB33 (Zug-Nr. 10323)")).toBe("RB33");
  });

  it("strips mode-word prefixes", () => {
    expect(normalizeShortName("Bus 73")).toBe("73");
    expect(normalizeShortName("Tram 12")).toBe("12");
    expect(normalizeShortName("Ferry F1")).toBe("F1");
  });

  it("preserves non-mode prefixes", () => {
    expect(normalizeShortName("RE4")).toBe("RE4");
  });

  it("handles whitespace", () => {
    expect(normalizeShortName("  Bus 99  ")).toBe("99");
  });
});

// normalizeTimestamp

describe("normalizeTimestamp", () => {
  it("normalises offset timestamps to UTC ISO", () => {
    const result = normalizeTimestamp("2024-03-10T13:38:00.000+01:00");
    expect(result).toBe("2024-03-10T12:38:00.000Z");
  });

  it("passes through already-UTC timestamps", () => {
    const result = normalizeTimestamp("2024-03-10T12:38:00.000Z");
    expect(result).toBe("2024-03-10T12:38:00.000Z");
  });

  it("returns original string for unparseable input", () => {
    expect(normalizeTimestamp("not-a-date")).toBe("not-a-date");
  });
});

// isTripNumber

describe("isTripNumber", () => {
  it("detects 5+ digit pure numbers as trip numbers", () => {
    expect(isTripNumber("26416")).toBe(true);
    expect(isTripNumber("30021")).toBe(true);
  });

  it("does not flag short numbers as trip numbers", () => {
    expect(isTripNumber("123")).toBe(false);
    expect(isTripNumber("1234")).toBe(false);
  });

  it("detects train-type prefix with 4+ digit number as trip number", () => {
    expect(isTripNumber("RB10325")).toBe(true);
    expect(isTripNumber("RE18935")).toBe(true);
    expect(isTripNumber("ICE1234")).toBe(true);
  });

  it("does not flag real line names as trip numbers", () => {
    expect(isTripNumber("RB33")).toBe(false);
    expect(isTripNumber("RE4")).toBe(false);
    expect(isTripNumber("IC2")).toBe(false);
    expect(isTripNumber("RE18")).toBe(false);
  });

  it("strips parenthetical suffixes before checking", () => {
    expect(isTripNumber("RB33 (Zug-Nr. 10323)")).toBe(false);
  });

  it("handles regular bus/tram line names", () => {
    expect(isTripNumber("M10")).toBe(false);
    expect(isTripNumber("U7")).toBe(false);
  });
});

// deduplicateStops

describe("deduplicateStops", () => {
  /** Priority resolver: lower number = higher priority. */
  const testPriority = (provider: string): number => {
    const priorities: Record<string, number> = {
      db: 1,
      vbb: 1,
      bvg: 1,
      "gtfs-de": 3,
      transitous: 10,
    };
    return priorities[provider] ?? 50;
  };

  function makeStop(
    overrides: Partial<TransitStop> & Pick<TransitStop, "id" | "name" | "provider">,
  ): TransitStop {
    return {
      lat: 52.52,
      lng: 13.405,
      modes: ["rail"],
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    expect(deduplicateStops([])).toEqual([]);
  });

  it("returns single stop unchanged", () => {
    const stop = makeStop({ id: "db:1", name: "Berlin Hbf", provider: "db" });
    expect(deduplicateStops([stop])).toEqual([stop]);
  });

  it("deduplicates nearby stops with similar names", () => {
    const stop1 = makeStop({
      id: "db:1",
      name: "Berlin Hauptbahnhof",
      provider: "db",
      lat: 52.525,
      lng: 13.369,
    });
    const stop2 = makeStop({
      id: "mo:2",
      name: "Berlin Hbf",
      provider: "transitous",
      lat: 52.5251,
      lng: 13.3691,
    });
    const result = deduplicateStops([stop1, stop2], testPriority);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("db");
  });

  it("keeps stops with different names even if nearby", () => {
    const stop1 = makeStop({
      id: "db:1",
      name: "Berlin Hbf",
      provider: "db",
      lat: 52.525,
      lng: 13.369,
    });
    const stop2 = makeStop({
      id: "db:2",
      name: "Friedrichstraße",
      provider: "db",
      lat: 52.5205,
      lng: 13.3867,
    });
    const result = deduplicateStops([stop1, stop2], testPriority);
    expect(result).toHaveLength(2);
  });

  it("keeps stops that are far apart even with similar names", () => {
    const stop1 = makeStop({
      id: "db:1",
      name: "Bahnhof",
      provider: "db",
      lat: 52.52,
      lng: 13.405,
    });
    const stop2 = makeStop({
      id: "db:2",
      name: "Bahnhof",
      provider: "db",
      lat: 48.14,
      lng: 11.56, // Munich — far away
    });
    const result = deduplicateStops([stop1, stop2], testPriority);
    expect(result).toHaveLength(2);
  });

  it("prefers higher-priority provider in cluster", () => {
    const stops: TransitStop[] = [
      makeStop({
        id: "mo:1",
        name: "Berlin Hbf",
        provider: "transitous",
        lat: 52.525,
        lng: 13.369,
      }),
      makeStop({
        id: "gtfs-de:1",
        name: "Berlin Hauptbahnhof",
        provider: "gtfs-de",
        lat: 52.5251,
        lng: 13.3691,
      }),
      makeStop({
        id: "db:1",
        name: "Berlin Hbf",
        provider: "db",
        lat: 52.5252,
        lng: 13.3692,
      }),
    ];
    const result = deduplicateStops(stops, testPriority);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("db");
  });

  it("handles multiple distinct clusters", () => {
    const stops: TransitStop[] = [
      // Cluster 1: Berlin Hbf area
      makeStop({
        id: "db:1",
        name: "Berlin Hbf",
        provider: "db",
        lat: 52.525,
        lng: 13.369,
      }),
      makeStop({
        id: "mo:1",
        name: "Berlin Hauptbahnhof",
        provider: "transitous",
        lat: 52.5251,
        lng: 13.3691,
      }),
      // Cluster 2: Friedrichstraße area
      makeStop({
        id: "db:2",
        name: "Berlin Friedrichstraße",
        provider: "db",
        lat: 52.5205,
        lng: 13.3867,
      }),
      makeStop({
        id: "mo:2",
        name: "Friedrichstraße",
        provider: "transitous",
        lat: 52.5206,
        lng: 13.3868,
      }),
    ];
    const result = deduplicateStops(stops, testPriority);
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.provider === "db")).toBe(true);
  });

  it("works without priority resolver (equal priority, first wins)", () => {
    const stop1 = makeStop({
      id: "a:1",
      name: "Berlin Hbf",
      provider: "provA",
      lat: 52.525,
      lng: 13.369,
    });
    const stop2 = makeStop({
      id: "b:1",
      name: "Berlin Hauptbahnhof",
      provider: "provB",
      lat: 52.5251,
      lng: 13.3691,
    });
    const result = deduplicateStops([stop1, stop2]);
    expect(result).toHaveLength(1);
  });
});
