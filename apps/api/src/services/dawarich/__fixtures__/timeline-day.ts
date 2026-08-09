import type { DawarichTimelineDay } from "../contracts";

export const timelineDayFixture: DawarichTimelineDay = {
  date: "2026-01-02",
  summary: {
    total_distance: 12.5,
    distance_unit: "km",
    places_visited: 1,
    time_moving_minutes: 42,
    time_stationary_minutes: 25,
  },
  bounds: { sw_lng: 12.3, sw_lat: 45.6, ne_lng: 12.5, ne_lat: 45.8 },
  entries: [
    {
      type: "visit",
      visit_id: "visit-fixture-1",
      name: "Fixture Plaza",
      status: "confirmed",
      place_id: "place-fixture-1",
      point_count: 4,
      tags: [{ id: "tag-fixture-1", name: "fixture" }],
      started_at: "2026-01-02T08:00:00Z",
      ended_at: "2026-01-02T08:25:00Z",
      duration: 25,
      place: { lat: 45.7, lng: 12.4 },
    },
    {
      type: "journey",
      track_id: "track-fixture-1",
      started_at: "2026-01-02T08:25:00Z",
      ended_at: "2026-01-02T09:07:00Z",
      duration: 2520,
      distance: 12.5,
      distance_unit: "km",
      dominant_mode: "cycling",
      avg_speed: 18.2,
      speed_unit: "km/h",
      elevation_gain: 25,
      elevation_loss: 18,
    },
  ],
};

export const timelineResponseFixture = { days: [timelineDayFixture] };

export const settingsFixture = {
  settings: { timezone: "Etc/UTC", maps: { distance_unit: "km" } },
  status: "success",
};

export const currentUserFixture = {
  user: { email: "fixture@example.invalid", settings: { timezone: "Etc/UTC" } },
};
