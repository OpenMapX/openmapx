export type PersonalTimelineWarning = "TRACK_GEOMETRY_UNAVAILABLE" | "PARTIAL_TRACK_PAGE_LIMIT";

export type PersonalTimelineErrorCode =
  | "TIMELINE_NOT_CONNECTED"
  | "TIMELINE_MANAGED_DISABLED"
  | "TIMELINE_CREDENTIAL_INVALID"
  | "TIMELINE_INSTANCE_UNSUPPORTED"
  | "TIMELINE_PLAN_RESTRICTED"
  | "TIMELINE_RATE_LIMITED"
  | "TIMELINE_UPSTREAM_UNAVAILABLE"
  | "TIMELINE_RESPONSE_INVALID";

export type TimelineConnectionMode = "external" | "managed";
export type TimelineConnectionStatus = "connected" | "degraded" | "invalid";

export type ConnectPersonalTimelineRequest =
  | { mode: "external"; instanceUrl: string; apiKey: string; displayName?: string }
  | { mode: "managed"; apiKey: string };

export interface TimelineConnectionView {
  connected: boolean;
  connection: null | {
    mode: TimelineConnectionMode;
    publicOrigin: string;
    displayName: string;
    upstreamEmail: string | null;
    timeZone: string;
    distanceUnit: string | null;
    status: TimelineConnectionStatus;
    validatedAt: string;
    lastReadAt: string | null;
  };
  managed: {
    available: boolean;
    healthy: boolean;
    publicOrigin: string | null;
    reason: "disabled" | "unhealthy" | "unprovisioned" | null;
  };
}

export interface PersonalTimelineSummaryV1 {
  totalDistance: number;
  placesVisited: number;
  movingMinutes: number;
  stationaryMinutes: number;
}

export interface PersonalTimelineVisitV1 {
  type: "visit";
  id: string;
  name: string | null;
  status: string | null;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  pointCount?: number;
  placeId?: string;
  tags: string[];
  location: { longitude: number; latitude: number } | null;
}

export interface PersonalTimelineJourneyV1 {
  type: "journey";
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distance?: number;
  distanceUnit: string;
  dominantMode: string | null;
  averageSpeed?: number;
  speedUnit?: string;
  elevationGain?: number;
  elevationLoss?: number;
  continuationOfDate?: string;
  dayDistance?: number;
  dayDurationSeconds?: number;
}

export interface PersonalTimelineDayV1 {
  version: 1;
  date: string;
  timeZone: string;
  distanceUnit: string;
  summary: PersonalTimelineSummaryV1;
  bounds: [west: number, south: number, east: number, north: number] | null;
  entries: Array<PersonalTimelineVisitV1 | PersonalTimelineJourneyV1>;
  map: {
    tracks: GeoJSON.FeatureCollection<GeoJSON.LineString>;
    visits: GeoJSON.FeatureCollection<GeoJSON.Point>;
  };
  capabilities: { trackGeometry: boolean; elevation: boolean };
  warnings: PersonalTimelineWarning[];
}
