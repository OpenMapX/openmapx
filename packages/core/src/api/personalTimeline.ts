import type z from "zod/v4";
import {
  personalTimelineDayV1Schema,
  personalTimelineDisconnectSchema,
  personalTimelineErrorCodeSchema,
  timelineConnectionViewSchema,
} from "../schemas/personalTimeline";
import type {
  ConnectPersonalTimelineRequest,
  PersonalTimelineDayV1,
  PersonalTimelineErrorCode,
  TimelineConnectionView,
} from "../types/personalTimeline";
import { apiClient, isApiClientError } from "./client";
import { API_ENDPOINTS } from "./endpoints";

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
  const code = personalTimelineErrorCodeSchema.safeParse((payload as { code?: unknown }).code);
  return code.success ? code.data : null;
}

async function timelineRequest<T>(
  request: () => Promise<unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const result = schema.safeParse(await request());
    if (!result.success) {
      throw new PersonalTimelineApiError(200, "TIMELINE_RESPONSE_INVALID", null);
    }
    return result.data;
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
  return timelineRequest(
    () => apiClient.get<unknown>(API_ENDPOINTS.timelineConnection),
    timelineConnectionViewSchema,
  );
}

export async function connectTimeline(
  request: ConnectPersonalTimelineRequest,
): Promise<TimelineConnectionView> {
  return timelineRequest(
    () => apiClient.put<unknown>(API_ENDPOINTS.timelineConnection, request),
    timelineConnectionViewSchema,
  );
}

export async function testTimelineConnection(): Promise<TimelineConnectionView> {
  return timelineRequest(
    () => apiClient.post<unknown>(API_ENDPOINTS.timelineConnectionTest, {}),
    timelineConnectionViewSchema,
  );
}

export async function disconnectTimeline(): Promise<{ ok: true }> {
  return timelineRequest(
    () => apiClient.delete<unknown>(API_ENDPOINTS.timelineConnection),
    personalTimelineDisconnectSchema,
  );
}

export async function getPersonalTimelineDay(date: string): Promise<PersonalTimelineDayV1> {
  return timelineRequest(
    () => apiClient.get<unknown>(`${API_ENDPOINTS.timelineDay}/${encodeURIComponent(date)}`),
    personalTimelineDayV1Schema,
  );
}
