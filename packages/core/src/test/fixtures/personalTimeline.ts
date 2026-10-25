import type { PersonalTimelineDayV1, TimelineConnectionView } from "../../types/personalTimeline";

// Synthetic application-wire fixtures; never use personal history here.
export const disconnected = {
  connected: false,
  connection: null,
  managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
} satisfies TimelineConnectionView;
export const connected = {
  connected: true,
  connection: {
    mode: "external",
    publicOrigin: "https://timeline.example.test",
    displayName: "Fixture timeline",
    upstreamEmail: "fixture@example.invalid",
    timeZone: "Etc/UTC",
    distanceUnit: null,
    status: "connected",
    validatedAt: "2026-01-02T00:00:00.000Z",
    lastReadAt: null,
  },
  managed: disconnected.managed,
} satisfies TimelineConnectionView;
export const day = {
  version: 1,
  date: "2026-01-02",
  timeZone: "Etc/UTC",
  distanceUnit: "km",
  summary: { totalDistance: 12, placesVisited: 1, movingMinutes: 10, stationaryMinutes: 20 },
  bounds: [12, 45, 13, 46],
  entries: [
    {
      type: "journey",
      id: "track-a",
      startedAt: "2026-01-02T08:00:00.000Z",
      endedAt: "2026-01-02T08:10:00.000Z",
      durationSeconds: 600,
      distanceUnit: "km",
      dominantMode: null,
    },
  ],
  map: {
    tracks: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "track-a" },
          geometry: {
            type: "LineString",
            coordinates: [
              [12, 45, -3],
              [13, 46, 7],
            ],
          },
        },
      ],
    },
    visits: { type: "FeatureCollection", features: [] },
  },
  capabilities: { trackGeometry: true, elevation: false },
  warnings: [],
} satisfies PersonalTimelineDayV1;
