import type {
  ConnectPersonalTimelineRequest,
  PersonalTimelineDayV1,
  PersonalTimelineErrorCode,
  TimelineConnectionView,
} from "../types/personalTimeline";
import { apiClient, isApiClientError } from "./client";
import { API_ENDPOINTS } from "./endpoints";

const PERSONAL_TIMELINE_ERROR_CODES = new Set<PersonalTimelineErrorCode>([
  "TIMELINE_NOT_CONNECTED",
  "TIMELINE_MANAGED_DISABLED",
  "TIMELINE_CREDENTIAL_INVALID",
  "TIMELINE_INSTANCE_UNSUPPORTED",
  "TIMELINE_PLAN_RESTRICTED",
  "TIMELINE_RATE_LIMITED",
  "TIMELINE_UPSTREAM_UNAVAILABLE",
  "TIMELINE_RESPONSE_INVALID",
]);

/**
 * Payload-free failure exposed by the Personal Timeline API boundary.
 *
 * The shared transport deliberately keeps parsed response bodies on a
 * non-enumerable property. Timeline consumers need only a closed recovery code,
 * status and bounded retry delay, so nothing else crosses into UI/query state.
 */
export class PersonalTimelineApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: PersonalTimelineErrorCode | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Personal Timeline request failed with status ${status}`);
    this.name = "PersonalTimelineApiError";
  }
}

function timelineCode(payload: unknown): PersonalTimelineErrorCode | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" &&
    PERSONAL_TIMELINE_ERROR_CODES.has(code as PersonalTimelineErrorCode)
    ? (code as PersonalTimelineErrorCode)
    : null;
}

async function timelineRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof PersonalTimelineApiError) throw error;
    if (!isApiClientError(error)) throw new PersonalTimelineApiError(0, null, null);
    throw new PersonalTimelineApiError(
      error.status,
      timelineCode(error.payload),
      error.retryAfterSeconds,
    );
  }
}

export async function getTimelineConnection(): Promise<TimelineConnectionView> {
  return timelineRequest(() =>
    apiClient.get<TimelineConnectionView>(API_ENDPOINTS.timelineConnection),
  );
}

export async function connectTimeline(
  request: ConnectPersonalTimelineRequest,
): Promise<TimelineConnectionView> {
  return timelineRequest(() =>
    apiClient.put<TimelineConnectionView>(API_ENDPOINTS.timelineConnection, request),
  );
}

export async function testTimelineConnection(): Promise<TimelineConnectionView> {
  return timelineRequest(() =>
    apiClient.post<TimelineConnectionView>(API_ENDPOINTS.timelineConnectionTest, {}),
  );
}

export async function disconnectTimeline(): Promise<{ ok: true }> {
  return timelineRequest(() => apiClient.delete<{ ok: true }>(API_ENDPOINTS.timelineConnection));
}

export async function getPersonalTimelineDay(date: string): Promise<PersonalTimelineDayV1> {
  return timelineRequest(() =>
    apiClient.get<PersonalTimelineDayV1>(
      `${API_ENDPOINTS.timelineDay}/${encodeURIComponent(date)}`,
    ),
  );
}
