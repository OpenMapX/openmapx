import { describe, expect, it } from "vitest";
import type { ScheduleDirectionsRequest } from "../../types/routing";
import { scheduledDirectionsQueryKey } from "../useScheduledDirections";

const request: ScheduleDirectionsRequest = {
  waypoints: [
    [0, 0],
    [1, 1],
  ],
  schedules: [null, { arriveBy: "2026-09-01T14:00" }],
  mode: "driving",
  units: "metric",
  lang: "en",
};

describe("scheduledDirectionsQueryKey", () => {
  it("is stable for the same request", () => {
    expect(scheduledDirectionsQueryKey(request)).toEqual(
      scheduledDirectionsQueryKey({ ...request }),
    );
  });

  it("changes when any schedule field changes", () => {
    expect(scheduledDirectionsQueryKey(request)).not.toEqual(
      scheduledDirectionsQueryKey({
        ...request,
        schedules: [null, { arriveBy: "2026-09-01T14:30" }],
      }),
    );
  });

  it("changes when the trip anchor changes", () => {
    expect(scheduledDirectionsQueryKey(request)).not.toEqual(
      scheduledDirectionsQueryKey({ ...request, departAt: "2026-09-01T09:00" }),
    );
  });

  it("is independent of key insertion order", () => {
    const reordered: ScheduleDirectionsRequest = {
      lang: "en",
      units: "metric",
      mode: "driving",
      schedules: [null, { arriveBy: "2026-09-01T14:00" }],
      waypoints: [
        [0, 0],
        [1, 1],
      ],
    };
    expect(scheduledDirectionsQueryKey(request)).toEqual(scheduledDirectionsQueryKey(reordered));
  });
});
