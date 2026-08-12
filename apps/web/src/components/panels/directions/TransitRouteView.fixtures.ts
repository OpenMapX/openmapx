import type { TripItinerary } from "@openmapx/mobility-core/transit";

// Shared between TransitRouteView.test.tsx and TransitRouteView.timezone.test.tsx.
// Kept out of either .test.tsx file: importing a *.test.tsx file for its
// exports also re-executes that file's own vi.mock(...) calls and describe
// block in the importing file's module graph, silently overriding whichever
// mock (e.g. useDateTimeFormat) both files declare for the same path.
export const SAMPLE_TRANSIT_ITINERARY: TripItinerary = {
  duration: 164,
  startTime: "2026-04-21T22:08:16+02:00",
  endTime: "2026-04-21T22:11:00+02:00",
  transfers: 1,
  walkDistance: 250,
  co2Grams: 43.151,
  legs: [
    {
      mode: "rail",
      startTime: "2026-04-21T22:08:16+02:00",
      endTime: "2026-04-21T22:11:00+02:00",
      from: { name: "Nationaltheatret", lat: 59.915, lng: 10.728 },
      to: { name: "Oslo S", lat: 59.911, lng: 10.753 },
      route: { shortName: "R13", longName: "Drammen-Oslo S-Dal", color: "DF2027" },
      geometry: {
        type: "LineString",
        coordinates: [
          [10.728, 59.915],
          [10.753, 59.911],
        ],
      },
    },
  ],
};
