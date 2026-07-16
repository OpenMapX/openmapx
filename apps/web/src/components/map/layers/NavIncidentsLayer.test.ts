import type { IncidentAlert } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildNavIncidentFeatureCollections,
  NAV_INCIDENT_LINE_LAYER_ID,
  NAV_INCIDENT_LINE_MIN_WIDTH,
  NAV_INCIDENT_MARKER_LAYER_ID,
  orderNavIncidentLayers,
} from "./NavIncidentsLayer";
import { NAV_ROUTE_REMAINING_LAYER_ID, NAV_ROUTE_REMAINING_WIDTH } from "./NavigationRouteLayer";

const lineIncident: IncidentAlert = {
  id: "closure-1",
  type: "traffic_incident",
  coord: [6.5, 51.3],
  alongMeters: 1000,
  eventType: "road_closure",
  severity: "critical",
  headline: "Closed",
  approach: { leadSec: 30, minM: 600, maxM: 2500 },
  geometry: {
    type: "LineString",
    coordinates: [
      [6.5, 51.3],
      [6.51, 51.31],
    ],
  },
};

describe("buildNavIncidentFeatureCollections", () => {
  it("keeps affected-road geometry and uses the overlay marker artwork", () => {
    const data = buildNavIncidentFeatureCollections([lineIncident]);
    expect(data.lines.features[0]?.geometry).toEqual(lineIncident.geometry);
    expect(data.markers.features[0]?.properties._icon).toBe("rc:road_closure:critical");
    expect(data.markers.features[0]?.properties._sev).toBe(4);
  });

  it("does not invent a line for a point-only report", () => {
    const data = buildNavIncidentFeatureCollections([
      {
        ...lineIncident,
        id: "hazard-1",
        eventType: "hazard",
        geometry: { type: "Point", coordinates: [6.5, 51.3] },
      },
    ]);
    expect(data.lines.features).toEqual([]);
    expect(data.markers.features.length).toBe(1);
  });
});

describe("orderNavIncidentLayers", () => {
  it("draws the incident shoulders wider than the blue route", () => {
    expect(NAV_INCIDENT_LINE_MIN_WIDTH > NAV_ROUTE_REMAINING_WIDTH).toBe(true);
  });

  it("puts the incident line below the blue route and its markers on top", () => {
    const moveLayer = vi.fn();
    const existing = new Set([
      NAV_INCIDENT_LINE_LAYER_ID,
      NAV_INCIDENT_MARKER_LAYER_ID,
      NAV_ROUTE_REMAINING_LAYER_ID,
    ]);
    orderNavIncidentLayers({
      getLayer: (id: string) => (existing.has(id) ? ({ id } as never) : undefined),
      moveLayer,
    });
    expect(moveLayer.mock.calls).toEqual([
      [NAV_INCIDENT_LINE_LAYER_ID, NAV_ROUTE_REMAINING_LAYER_ID],
      [NAV_INCIDENT_MARKER_LAYER_ID],
    ]);
  });
});
