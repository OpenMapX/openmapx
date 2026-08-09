import type {
  PersonalTimelineDayV1,
  PersonalTimelineJourneyV1,
  PersonalTimelineVisitV1,
} from "@openmapx/core";
import type { DawarichTimelineDay, DawarichTrackFeatureCollection } from "./contracts";

export interface NormalizeDawarichDayInput {
  day: DawarichTimelineDay;
  selectedDate: string;
  timeZone: string;
  distanceUnit: string;
  tracks?: DawarichTrackFeatureCollection;
  trackFetchFailed?: boolean;
  acceptedPartialTrackPageLimit?: boolean;
}

function toIsoString(value: string): string {
  return new Date(value).toISOString();
}

function normalizeVisit(
  visit: Extract<DawarichTimelineDay["entries"][number], { type: "visit" }>,
): PersonalTimelineVisitV1 {
  const location = visit.place ? { longitude: visit.place.lng, latitude: visit.place.lat } : null;
  return {
    type: "visit",
    id: String(visit.visit_id),
    name: visit.name,
    status: visit.status,
    startedAt: toIsoString(visit.started_at),
    endedAt: toIsoString(visit.ended_at),
    durationMinutes: visit.duration,
    ...(visit.point_count == null ? {} : { pointCount: visit.point_count }),
    ...(visit.place_id == null ? {} : { placeId: String(visit.place_id) }),
    tags: visit.tags.map((tag) => tag.name),
    location,
  };
}

function normalizeJourney(
  journey: Extract<DawarichTimelineDay["entries"][number], { type: "journey" }>,
): PersonalTimelineJourneyV1 {
  return {
    type: "journey",
    id: String(journey.track_id),
    startedAt: toIsoString(journey.started_at),
    endedAt: toIsoString(journey.ended_at),
    durationSeconds: journey.duration,
    distanceUnit: journey.distance_unit,
    dominantMode: journey.dominant_mode,
    ...(journey.distance == null ? {} : { distance: journey.distance }),
    ...(journey.avg_speed == null ? {} : { averageSpeed: journey.avg_speed }),
    ...(journey.speed_unit == null ? {} : { speedUnit: journey.speed_unit }),
    ...(journey.elevation_gain == null ? {} : { elevationGain: journey.elevation_gain }),
    ...(journey.elevation_loss == null ? {} : { elevationLoss: journey.elevation_loss }),
    ...(journey.continuation_of_date == null
      ? {}
      : { continuationOfDate: journey.continuation_of_date }),
    ...(journey.day_distance == null ? {} : { dayDistance: journey.day_distance }),
    ...(journey.day_duration == null ? {} : { dayDurationSeconds: journey.day_duration }),
  };
}

function emptyLineCollection(): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return { type: "FeatureCollection", features: [] };
}

function visitCollection(
  entries: Array<PersonalTimelineVisitV1 | PersonalTimelineJourneyV1>,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: entries.flatMap((entry) => {
      if (entry.type !== "visit" || !entry.location) return [];
      return [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [entry.location.longitude, entry.location.latitude],
          },
          properties: { id: entry.id },
        },
      ];
    }),
  };
}

export function normalizeDawarichDay(input: NormalizeDawarichDayInput): PersonalTimelineDayV1 {
  const entries = input.day.entries
    .map((entry) => (entry.type === "visit" ? normalizeVisit(entry) : normalizeJourney(entry)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const tracks = input.tracks
    ? {
        type: "FeatureCollection" as const,
        features: input.tracks.features.map((feature) => ({
          type: "Feature" as const,
          geometry: feature.geometry,
          properties: feature.properties,
        })),
      }
    : emptyLineCollection();
  const warnings: PersonalTimelineDayV1["warnings"] = [];
  if (input.trackFetchFailed) warnings.push("TRACK_GEOMETRY_UNAVAILABLE");
  if (input.acceptedPartialTrackPageLimit) warnings.push("PARTIAL_TRACK_PAGE_LIMIT");

  return {
    version: 1,
    date: input.selectedDate,
    timeZone: input.timeZone,
    distanceUnit: input.distanceUnit,
    summary: {
      totalDistance: input.day.summary.total_distance,
      placesVisited: input.day.summary.places_visited,
      movingMinutes: input.day.summary.time_moving_minutes,
      stationaryMinutes: input.day.summary.time_stationary_minutes,
    },
    bounds: input.day.bounds
      ? [
          input.day.bounds.sw_lng,
          input.day.bounds.sw_lat,
          input.day.bounds.ne_lng,
          input.day.bounds.ne_lat,
        ]
      : null,
    entries,
    map: { tracks, visits: visitCollection(entries) },
    capabilities: {
      trackGeometry: tracks.features.length > 0,
      elevation: entries.some(
        (entry) =>
          entry.type === "journey" &&
          (entry.elevationGain !== undefined || entry.elevationLoss !== undefined),
      ),
    },
    warnings,
  };
}
