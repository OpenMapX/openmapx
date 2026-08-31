import { describe, expect, it } from "vitest";
import { aggregateCacheNamespaces, resolveCachePattern } from "./cache-namespaces";

describe("resolveCachePattern", () => {
  it.each([
    ["geocoding", "int:geocoding:*"],
    ["all", "int:all:*"],
    ["", "int::*"],
    ["int:geocoding:*", "int:geocoding:*"],
    ["cache:geocode*", "cache:geocode*"],
  ])("resolves %j to %j", (target, expected) => {
    expect(resolveCachePattern(target)).toBe(expected);
  });
});

describe("aggregateCacheNamespaces", () => {
  it("groups by the final key segment and sorts by count then name", () => {
    expect(
      aggregateCacheNamespaces([
        "int:transit:journeys:a",
        "int:geocoding:forward:a",
        "int:transit:journeys:b",
        "int:geocoding:reverse:a",
        "int:geocoding:forward:b",
        "standalone",
        "int::value",
      ]),
    ).toEqual([
      { namespace: "int:geocoding:forward", count: 2 },
      { namespace: "int:transit:journeys", count: 2 },
      { namespace: "int:", count: 1 },
      { namespace: "int:geocoding:reverse", count: 1 },
      { namespace: "standalone", count: 1 },
    ]);
  });

  it("returns an empty list for an empty key set", () => {
    expect(aggregateCacheNamespaces([])).toEqual([]);
  });
});
