import type { ServiceAlert, TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { collectActiveAlerts } from "./transitAlerts";

function alert(id: string, severity: ServiceAlert["severity"]): ServiceAlert {
  return {
    id,
    providers: [],
    severity,
    title: id,
    affectedRouteIds: [],
    affectedStopIds: [],
    activePeriods: [],
  };
}

function leg(alerts?: ServiceAlert[]): TripLeg {
  return {
    mode: "rail",
    startTime: "",
    endTime: "",
    from: { name: "A", lat: 0, lng: 0 },
    to: { name: "B", lat: 0, lng: 0 },
    geometry: { type: "LineString", coordinates: [] },
    alerts,
  };
}

describe("collectActiveAlerts", () => {
  it("gathers alerts from the current and upcoming legs, most severe first", () => {
    const legs = [
      leg([alert("past", "severe")]),
      leg([alert("info1", "info")]),
      leg([alert("severe1", "severe"), alert("warn1", "warning")]),
    ];
    const result = collectActiveAlerts(legs, 1).map((a) => a.id);
    expect(result).toEqual(["severe1", "warn1", "info1"]);
    // The passed leg's alert must not appear.
    expect(result).not.toContain("past");
  });

  it("dedupes an alert repeated across legs", () => {
    const shared = alert("dup", "warning");
    const legs = [leg([shared]), leg([shared])];
    expect(collectActiveAlerts(legs, 0)).toHaveLength(1);
  });

  it("returns an empty list when there are no alerts", () => {
    expect(collectActiveAlerts([leg(), leg()], 0)).toEqual([]);
  });
});
