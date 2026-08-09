import type { PersonalTimelineDayV1 } from "@openmapx/core";
import {
  DawarichClient,
  DawarichClientError,
  type DawarichClientOptions,
  type DawarichTracksPage,
} from "./client.js";
import {
  type DecryptedTimelineConnection,
  TimelineConnectionError,
  type TimelineConnectionSnapshot,
  timelineConnectionService,
} from "./connection-service.js";
import type {
  DawarichSettings,
  DawarichTimelineDay,
  DawarichTimelineResponse,
  DawarichTrackFeatureCollection,
} from "./contracts.js";
import { computeDawarichDayRange } from "./day-range.js";
import { DAWARICH_LIMITS } from "./limits.js";
import { normalizeDawarichDay } from "./normalize.js";

type TimelineDayClient = Pick<DawarichClient, "getSettings" | "getTimeline" | "getTracksPage">;
type TimelineDayClientFactory = (options: DawarichClientOptions) => TimelineDayClient;

export interface TimelineDayConnectionService {
  decryptConnectionCredential(userId: string): Promise<DecryptedTimelineConnection>;
  updateReadMetadata(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    metadata: { timeZone: string; distanceUnit: string | null },
  ): Promise<TimelineConnectionSnapshot | null>;
  recordReadSuccess(userId: string, snapshot: TimelineConnectionSnapshot): Promise<void>;
  recordReadFailure(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    failureKind: "credential_invalid" | "transient",
  ): Promise<void>;
}

export interface TimelineDayServiceOptions {
  connectionService?: TimelineDayConnectionService;
  clientFactory?: TimelineDayClientFactory;
}

function mapRequiredError(error: unknown): TimelineConnectionError {
  if (error instanceof TimelineConnectionError) return error;
  if (!(error instanceof DawarichClientError)) {
    return new TimelineConnectionError("TIMELINE_UPSTREAM_UNAVAILABLE");
  }
  switch (error.kind) {
    case "unauthorized":
      return new TimelineConnectionError("TIMELINE_CREDENTIAL_INVALID");
    case "forbidden":
      return new TimelineConnectionError("TIMELINE_PLAN_RESTRICTED");
    case "unsupported":
      return new TimelineConnectionError("TIMELINE_INSTANCE_UNSUPPORTED");
    case "rate_limited":
      return new TimelineConnectionError("TIMELINE_RATE_LIMITED", error.retryAfterSeconds);
    case "unavailable":
      return new TimelineConnectionError("TIMELINE_UPSTREAM_UNAVAILABLE");
    case "invalid_response":
    case "page_limit":
      return new TimelineConnectionError("TIMELINE_RESPONSE_INVALID");
  }
}

async function throwRequiredError(
  connectionService: TimelineDayConnectionService,
  userId: string,
  snapshot: TimelineConnectionSnapshot,
  error: unknown,
): Promise<never> {
  const mapped = mapRequiredError(error);
  const failureKind =
    mapped.code === "TIMELINE_CREDENTIAL_INVALID"
      ? "credential_invalid"
      : mapped.code === "TIMELINE_UPSTREAM_UNAVAILABLE"
        ? "transient"
        : null;
  if (failureKind) await connectionService.recordReadFailure(userId, snapshot, failureKind);
  throw mapped;
}

function emptyDay(date: string, distanceUnit: string): DawarichTimelineDay {
  return {
    date,
    summary: {
      total_distance: 0,
      distance_unit: distanceUnit,
      places_visited: 0,
      time_moving_minutes: 0,
      time_stationary_minutes: 0,
    },
    bounds: null,
    entries: [],
  };
}

function selectDay(
  response: DawarichTimelineResponse,
  date: string,
  distanceUnit: string,
): DawarichTimelineDay {
  if (response.days.length === 0) return emptyDay(date, distanceUnit);
  const matches = response.days.filter((day) => day.date === date);
  if (matches.length !== 1 || response.days.length !== 1) {
    throw new TimelineConnectionError("TIMELINE_RESPONSE_INVALID");
  }
  return matches[0] as DawarichTimelineDay;
}

interface TracksResult {
  tracks: DawarichTrackFeatureCollection;
  unavailable: boolean;
  pageLimitReached: boolean;
}

function pageFeatures(page: DawarichTracksPage): DawarichTrackFeatureCollection["features"] {
  return page.data.features;
}

export class TimelineDayService {
  private readonly connectionService: TimelineDayConnectionService;
  private readonly clientFactory: TimelineDayClientFactory;

  constructor(options: TimelineDayServiceOptions = {}) {
    this.connectionService = options.connectionService ?? timelineConnectionService;
    this.clientFactory =
      options.clientFactory ?? ((clientOptions) => new DawarichClient(clientOptions));
  }

  async getPersonalTimelineDay(userId: string, date: string): Promise<PersonalTimelineDayV1> {
    const credential = await this.connectionService.decryptConnectionCredential(userId);
    let snapshot = credential.connectionSnapshot;
    const client = this.clientFactory({
      baseUrl: credential.upstreamBaseUrl,
      apiKey: credential.apiKey,
      allowPrivateHosts: credential.allowPrivateHosts,
    });

    let timeZone = credential.timeZone.trim();
    let distanceUnit = credential.distanceUnit?.trim() || "";
    if (!timeZone || !distanceUnit) {
      let settings: DawarichSettings;
      try {
        settings = await client.getSettings();
      } catch (error) {
        return throwRequiredError(this.connectionService, userId, snapshot, error);
      }
      timeZone = settings.settings.timezone.trim();
      distanceUnit = settings.settings.maps?.distance_unit.trim() || "km";
      if (!timeZone) throw new TimelineConnectionError("TIMELINE_RESPONSE_INVALID");
      const updatedSnapshot = await this.connectionService.updateReadMetadata(userId, snapshot, {
        timeZone,
        distanceUnit,
      });
      if (updatedSnapshot) snapshot = updatedSnapshot;
    }

    let range: { startAt: string; endAt: string };
    try {
      const computed = computeDawarichDayRange(date, timeZone);
      range = { startAt: computed.startAt, endAt: computed.endAt };
    } catch {
      throw new TimelineConnectionError("TIMELINE_RESPONSE_INVALID");
    }

    let timeline: DawarichTimelineResponse;
    try {
      timeline = await client.getTimeline(range, distanceUnit);
    } catch (error) {
      return throwRequiredError(this.connectionService, userId, snapshot, error);
    }

    const day = selectDay(timeline, date, distanceUnit);
    const trackResult = await this.fetchTracks(client, range);
    const normalized = normalizeDawarichDay({
      day,
      selectedDate: date,
      timeZone,
      distanceUnit,
      tracks: trackResult.tracks,
      trackFetchFailed: trackResult.unavailable,
      acceptedPartialTrackPageLimit: trackResult.pageLimitReached,
    });
    await this.connectionService.recordReadSuccess(userId, snapshot);
    return normalized;
  }

  private async fetchTracks(
    client: TimelineDayClient,
    range: { startAt: string; endAt: string },
  ): Promise<TracksResult> {
    const features: DawarichTrackFeatureCollection["features"] = [];
    let page = 1;
    while (page <= DAWARICH_LIMITS.maxTrackPages) {
      let result: DawarichTracksPage;
      try {
        result = await client.getTracksPage(range, page);
      } catch (error) {
        return {
          tracks: { type: "FeatureCollection", features },
          unavailable: !(error instanceof DawarichClientError && error.kind === "page_limit"),
          pageLimitReached: error instanceof DawarichClientError && error.kind === "page_limit",
        };
      }

      const remaining = DAWARICH_LIMITS.maxTrackFeaturesPerDay - features.length;
      const accepted = pageFeatures(result).slice(0, Math.max(0, remaining));
      features.push(...accepted);
      if (accepted.length < pageFeatures(result).length) {
        return {
          tracks: { type: "FeatureCollection", features },
          unavailable: false,
          pageLimitReached: true,
        };
      }
      if (
        result.pagination.totalPages === 0 ||
        result.pagination.currentPage >= result.pagination.totalPages
      ) {
        return {
          tracks: { type: "FeatureCollection", features },
          unavailable: false,
          pageLimitReached: false,
        };
      }
      page += 1;
    }
    return {
      tracks: { type: "FeatureCollection", features },
      unavailable: false,
      pageLimitReached: true,
    };
  }
}

export const timelineDayService = new TimelineDayService();

export function getPersonalTimelineDay(
  userId: string,
  date: string,
): Promise<PersonalTimelineDayV1> {
  return timelineDayService.getPersonalTimelineDay(userId, date);
}
