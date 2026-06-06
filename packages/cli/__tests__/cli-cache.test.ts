import { describe, expect, it } from "vitest";
import { aggregateNamespaces, resolveCachePattern } from "../src/commands/cache";

describe("resolveCachePattern", () => {
  it("treats a bare word as an integration namespace", () => {
    expect(resolveCachePattern("geocoding")).toBe("int:geocoding:*");
    expect(resolveCachePattern("transit")).toBe("int:transit:*");
  });

  it("passes a glob through unchanged", () => {
    expect(resolveCachePattern("int:geocoding:*")).toBe("int:geocoding:*");
    expect(resolveCachePattern("cache:geocode*")).toBe("cache:geocode*");
  });
});

describe("aggregateNamespaces", () => {
  it("groups keys by their namespace (all but the last colon segment) and counts them", () => {
    const rows = aggregateNamespaces([
      "int:geocoding:cache:geocode:aaa",
      "int:geocoding:cache:geocode:bbb",
      "provider:health:dyn",
      "poi:live",
    ]);
    expect(rows).toEqual([
      { namespace: "int:geocoding:cache:geocode", count: 2 },
      { namespace: "poi", count: 1 },
      { namespace: "provider:health", count: 1 },
    ]);
  });

  it("returns an empty array for no keys", () => {
    expect(aggregateNamespaces([])).toEqual([]);
  });
});
