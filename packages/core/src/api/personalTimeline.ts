import type {
  ConnectPersonalTimelineRequest,
  PersonalTimelineDayV1,
  TimelineConnectionView,
} from "../types/personalTimeline";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export function getTimelineConnection(): Promise<TimelineConnectionView> {
  return apiClient.get<TimelineConnectionView>(API_ENDPOINTS.timelineConnection);
}

export function connectTimeline(
  request: ConnectPersonalTimelineRequest,
): Promise<TimelineConnectionView> {
  return apiClient.put<TimelineConnectionView>(API_ENDPOINTS.timelineConnection, request);
}

export function testTimelineConnection(): Promise<TimelineConnectionView> {
  return apiClient.post<TimelineConnectionView>(API_ENDPOINTS.timelineConnectionTest, {});
}

export function disconnectTimeline(): Promise<{ ok: true }> {
  return apiClient.delete<{ ok: true }>(API_ENDPOINTS.timelineConnection);
}

export function getPersonalTimelineDay(date: string): Promise<PersonalTimelineDayV1> {
  return apiClient.get<PersonalTimelineDayV1>(
    `${API_ENDPOINTS.timelineDay}/${encodeURIComponent(date)}`,
  );
}
