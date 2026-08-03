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
  extra: Partial<RoadConditionEvent> = {},
): RoadConditionEvent {
  return {
    id,
    source: "s",
    provider: "p",
    type,
    severity,
    geometry,
    headline: `${type} ${id}`,
    ...extra,
  };
}

const motorwayStep = {
  instruction: "Continue on A 57",
  distance: 6800,
  duration: 300,
  coordinates: route,
  roadNames: ["A 57/E 31"],
};

describe("projectEventsToRoute", () => {
  it("projects an on-corridor incident ahead with a severity-scaled approach window", () => {
    const out = projectEventsToRoute(
      [ev("a", "high", { type: "Point", coordinates: [13.05, 52.00008] })], // ~9 m off
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("traffic_incident");
    expect(out[0]?.eventType).toBe("accident");
    expect(out[0]?.severity).toBe("high");
    expect(out[0]?.approach).toEqual({ leadSec: 20, minM: 400, maxM: 1500 });
    expect(out[0]?.alongMeters).toBeGreaterThan(3000);
    expect(out[0]?.alongMeters).toBeLessThan(3900);
  });

  it("carries the event's delaySeconds onto the projected alert", () => {
    const out = projectEventsToRoute(
      [
        ev("d", "high", { type: "Point", coordinates: [13.05, 52.00008] }, "accident", {
          delaySeconds: 900,
        }),
      ],
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.delaySeconds).toBe(900);
  });

  it("carries the display group id without changing route projection", () => {
    const out = projectEventsToRoute(
      [
        ev("grouped", "high", { type: "Point", coordinates: [13.05, 52.00008] }, "roadworks", {
          groupId: "works-42",
        }),
      ],
      route,
      0,
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.groupId).toBe("works-42");
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

  it("uses the first sustained route-overlapping portion of a line geometry", () => {
    const out = projectEventsToRoute(
      [
        ev("d", "medium", {
          type: "LineString",
          coordinates: [
            [13.04, 52.00005],
            [13.06, 52.00005],
          ],
        }),
      ],
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.coord[0]).toBeGreaterThan(13.039);
    expect(out[0]?.coord[0]).toBeLessThan(13.061);
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
    expect(out[0]?.approach).toEqual({ leadSec: 30, minM: 600, maxM: 2500 });
  });

  it("drops an exit whose geometry only touches the route at the split", () => {
    const out = projectEventsToRoute(
      [
        ev(
          "exit",
          "critical",
          {
            type: "LineString",
            coordinates: [
              [13.05, 52.0],
              [13.0502, 52.0001],
              [13.052, 52.003],
              [13.055, 52.006],
            ],
          },
          "road_closure",
        ),
      ],
      route,
      0,
    );
    expect(out).toEqual([]);
  });

  it("drops a nearby parallel road when its road identity differs", () => {
    const out = projectEventsToRoute(
      [
        ev(
          "parallel",
          "high",
          {
            type: "LineString",
            coordinates: [
              [13.03, 52.00015],
              [13.07, 52.00015],
            ],
          },
          "congestion",
          { roads: [{ name: "L 9", direction: "east" }] },
        ),
      ],
      route,
      0,
      { corridorMeters: 50, routeSteps: [motorwayStep] },
    );
    expect(out).toEqual([]);
  });

  it("drops the opposite carriageway and keeps the route direction", () => {
    const westbound = ev(
      "westbound",
      "high",
      {
        type: "LineString",
        coordinates: [
          [13.07, 52.00005],
          [13.03, 52.00005],
        ],
      },
      "congestion",
      { roads: [{ name: "A57", direction: "west" }] },
    );
    const eastbound = ev(
      "eastbound",
      "high",
      {
        type: "LineString",
        coordinates: [
          [13.03, 52.00005],
          [13.07, 52.00005],
        ],
      },
      "congestion",
      { roads: [{ name: "A 57", direction: "east" }] },
    );
    const out = projectEventsToRoute([westbound, eastbound], route, 0, {
      routeSteps: [motorwayStep],
    });
    expect(out.map((incident) => incident.id)).toEqual(["eastbound"]);
  });

  it("uses supplied direction to reject a point on the opposite carriageway", () => {
    const out = projectEventsToRoute(
      [
        ev(
          "opposite-point",
          "medium",
          { type: "Point", coordinates: [13.05, 52.0] },
          "congestion",
          {
            roads: [{ name: "A 57", direction: "west" }],
          },
        ),
      ],
      route,
      0,
      { routeSteps: [motorwayStep] },
    );
    expect(out).toEqual([]);
  });
});
