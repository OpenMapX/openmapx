import type { LngLat } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import { describe, expect, it } from "vitest";

import { splitNavRoute } from "./navRouteSplit";

const ROUTE: LngLat[] = [
  [6.95, 50.94],
  [6.96, 50.95],
  [6.97, 50.95],
];

const lengthKm = length(lineString(ROUTE), { units: "kilometers" });

describe("splitNavRoute", () => {
  it("returns only the remaining segment when no distance has been traveled", () => {
    const features = splitNavRoute(ROUTE, 0);
    expect(features.length).toBe(1);
    expect(features[0].properties).toEqual({ kind: "remaining" });
  });

  it("splits into traveled + remaining mid-route", () => {
    const features = splitNavRoute(ROUTE, (lengthKm / 2) * 1000);
    expect(features.map((f) => f.properties?.kind)).toEqual(["traveled", "remaining"]);
  });

  it("does not throw when alongMeters exceeds the geometry length (stale reroute progress)", () => {
    // After a reroute the new, shorter route is applied while `progress` still
    // holds the previous route's far-larger alongMeters for one render. The
    // clamp must keep the slice start within the line instead of throwing
    // "Start position is beyond line".
    expect(() => splitNavRoute(ROUTE, 9_000_000)).not.toThrow();
    const kinds = splitNavRoute(ROUTE, 9_000_000).map((f) => f.properties?.kind);
    expect(kinds).toContain("traveled");
  });

  it("is safe at exactly the geometry length", () => {
    expect(() => splitNavRoute(ROUTE, lengthKm * 1000)).not.toThrow();
  });

  it("returns nothing for a degenerate geometry", () => {
    expect(splitNavRoute([[0, 0]], 0)).toEqual([]);
  });
});
