import type { Waypoint } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { buildScheduleRequest } from "./scheduleRequest";

function waypoint(
  id: string,
  coords: [number, number] | null,
  schedule?: Waypoint["schedule"],
): Waypoint {
  return { id, coords, label: id, type: "waypoint", ...(schedule ? { schedule } : {}) };
}

const BASE = {
  mode: "driving" as const,
  timeMode: "now" as const,
  tripTime: null,
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
  avoidClosures: false,
  units: "metric" as const,
  lang: "en",
};

describe("buildScheduleRequest", () => {
  it("returns null when a waypoint has no coordinate", () => {
    expect(
      buildScheduleRequest({
        ...BASE,
        waypoints: [waypoint("a", [0, 0]), waypoint("b", null)],
      }),
    ).toBeNull();
  });

  it("returns null when no waypoint carries a constraint", () => {
    expect(
      buildScheduleRequest({
        ...BASE,
        waypoints: [waypoint("a", [0, 0]), waypoint("b", [1, 1])],
      }),
    ).toBeNull();
  });

  it("builds a request once any schedule is set, aligned to the waypoints", () => {
    const request = buildScheduleRequest({
      ...BASE,
      waypoints: [
        waypoint("a", [0, 0]),
        waypoint("b", [1, 1], { dwellSeconds: 600 }),
        waypoint("c", [2, 2]),
      ],
    });
    expect(request).toEqual({
      waypoints: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      schedules: [null, { dwellSeconds: 600 }, null],
      mode: "driving",
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
      units: "metric",
      lang: "en",
    });
  });

  it("maps the trip time mode onto departAt or arriveBy in local wall clock", () => {
    const at = new Date(2026, 8, 1, 9, 30);
    const departing = buildScheduleRequest({
      ...BASE,
      timeMode: "depart",
      tripTime: at,
      waypoints: [waypoint("a", [0, 0], { dwellSeconds: 0 }), waypoint("b", [1, 1])],
    });
    expect(departing).toMatchObject({ departAt: "2026-09-01T09:30" });
    expect(departing).not.toHaveProperty("arriveBy");

    const arriving = buildScheduleRequest({
      ...BASE,
      timeMode: "arrive",
      tripTime: at,
      waypoints: [waypoint("a", [0, 0], { dwellSeconds: 0 }), waypoint("b", [1, 1])],
    });
    expect(arriving).toMatchObject({ arriveBy: "2026-09-01T09:30" });
  });

  it("drops highway and toll avoidance outside driving, matching useDirections", () => {
    const request = buildScheduleRequest({
      ...BASE,
      mode: "cycling",
      avoidHighways: true,
      avoidTolls: true,
      avoidFerries: true,
      waypoints: [waypoint("a", [0, 0], { dwellSeconds: 60 }), waypoint("b", [1, 1])],
    });
    expect(request).toMatchObject({
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: true,
    });
  });
});
