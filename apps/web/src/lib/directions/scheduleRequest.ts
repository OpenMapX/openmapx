"use client";

import type { ScheduleDirectionsRequest, TravelMode, Waypoint } from "@openmapx/core";
import { toDateTimeLocalString } from "@/components/panels/directions/TimeModePicker";

export interface ScheduleRequestInput {
  waypoints: Waypoint[];
  mode: TravelMode;
  timeMode: "now" | "depart" | "arrive";
  tripTime: Date | null;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  avoidClosures: boolean;
  units: "metric" | "imperial";
  lang: string;
}

/**
 * The one place a scheduled request is assembled. Returns `null` when the trip
 * is incomplete or carries no constraints at all, in which case the caller keeps
 * using the plain `/directions` query and nothing about an ordinary trip changes.
 */
export function buildScheduleRequest(
  input: ScheduleRequestInput,
): ScheduleDirectionsRequest | null {
  const coords = input.waypoints.map((wp) => wp.coords);
  if (coords.length < 2 || coords.some((entry) => entry === null)) return null;
  if (input.waypoints.every((wp) => wp.schedule === undefined)) return null;

  const driving = input.mode === "driving";
  const wallClock =
    input.timeMode !== "now" && input.tripTime ? toDateTimeLocalString(input.tripTime) : undefined;

  return {
    waypoints: coords as [number, number][],
    schedules: input.waypoints.map((wp) => wp.schedule ?? null),
    mode: input.mode,
    ...(wallClock && input.timeMode === "depart" ? { departAt: wallClock } : {}),
    ...(wallClock && input.timeMode === "arrive" ? { arriveBy: wallClock } : {}),
    // Highways and tolls only apply to driving; the UI hides their toggles for
    // other modes, and `useDirections` already drops them the same way.
    avoidHighways: driving && input.avoidHighways,
    avoidTolls: driving && input.avoidTolls,
    avoidFerries: input.avoidFerries,
    avoidClosures: input.avoidClosures,
    units: input.units,
    lang: input.lang,
  };
}
