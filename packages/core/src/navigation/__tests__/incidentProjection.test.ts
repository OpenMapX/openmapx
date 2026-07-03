import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { RoadConditionEvent, RoadConditionSeverity } from "../../types/roadConditions";
import { projectEventsToRoute } from "../incidentProjection";

// A straight ~6.85 km west→east route at latitude 52.
const route: LngLat[] = [
  [13.0, 52.0],
  [13.1, 52.0],
];

function ev(
  id: string,
  severity: RoadConditionSeverity,
  geometry: RoadConditionEvent["geometry"],
  type: RoadConditionEvent["type"] = "accident",
): RoadConditionEvent {
  return { id, source: "s", provider: "p", type, severity, geometry, headline: `${type} ${id}` };
}

describe("projectEventsToRoute", () => {
  it("projects an on-corridor incident ahead with a severity-scaled approach window", () => {
    const out = projectEventsToRoute(
      [ev("a", "high", { type: "Point", coordinates: [13.05, 52.0003] })], // ~33 m off, mid-route
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("traffic_incident");
    expect(out[0]!.eventType).toBe("accident");
    expect(out[0]!.severity).toBe("high");
    expect(out[0]!.approach).toEqual({ leadSec: 20, minM: 400, maxM: 1500 });
    expect(out[0]!.alongMeters).toBeGreaterThan(3000);
    expect(out[0]!.alongMeters).toBeLessThan(3900);
  });

  it("drops incidents off the corridor", () => {
    const out = projectEventsToRoute(
      [ev("b", "high", { type: "Point", coordinates: [13.05, 52.02] })], // ~2.2 km off
      route,
      0,
    );
    expect(out).toEqual([]);
  });

  it("drops incidents behind the current position", () => {
    const out = projectEventsToRoute(
      [ev("c", "high", { type: "Point", coordinates: [13.02, 52.0] })], // ~1.4 km along
      route,
      5000,
    );
    expect(out).toEqual([]);
  });

  it("uses the nearest vertex (not the interpolated crossing) for a line geometry", () => {
    const out = projectEventsToRoute(
      [
        ev("d", "medium", {
          type: "LineString",
          coordinates: [
            [13.06, 51.995],
            [13.06, 52.005],
          ],
        }),
      ],
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.coord[1]).not.toBe(52.0);
    expect([51.995, 52.005]).toContain(out[0]!.coord[1]);
  });

  it("sorts by along-distance and scales the approach window by severity", () => {
    const out = projectEventsToRoute(
      [
        ev("far", "low", { type: "Point", coordinates: [13.08, 52.0] }),
        ev("near", "critical", { type: "Point", coordinates: [13.02, 52.0] }),
      ],
      route,
      0,
    );
    expect(out.map((a) => a.id)).toEqual(["near", "far"]);
    expect(out[0]!.approach).toEqual({ leadSec: 30, minM: 600, maxM: 2500 });
  });
});
