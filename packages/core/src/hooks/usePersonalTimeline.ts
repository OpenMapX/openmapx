import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  connectTimeline,
  disconnectTimeline,
  getPersonalTimelineDay,
  getTimelineConnection,
  testTimelineConnection,
} from "../api/personalTimeline";
import type {
  ConnectPersonalTimelineRequest,
  PersonalTimelineDayV1,
  PersonalTimelineErrorCode,
  TimelineConnectionView,
} from "../types/personalTimeline";

export const PERSONAL_TIMELINE_QUERY_KEY = ["personalTimeline"] as const;

export type PersonalTimelineApiError = ApiError & {
  readonly code: PersonalTimelineErrorCode | null;
};

const connectionQueryKey = [...PERSONAL_TIMELINE_QUERY_KEY, "connection"] as const;

export function useTimelineConnection() {
  return useQuery<TimelineConnectionView, PersonalTimelineApiError>({
    queryKey: connectionQueryKey,
    queryFn: getTimelineConnection,
  });
}

export function useConnectTimeline() {
  const queryClient = useQueryClient();
  return useMutation<
    TimelineConnectionView,
    PersonalTimelineApiError,
    ConnectPersonalTimelineRequest
  >({
    mutationFn: connectTimeline,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PERSONAL_TIMELINE_QUERY_KEY }),
  });
}

export function useTestTimelineConnection() {
  const queryClient = useQueryClient();
  return useMutation<TimelineConnectionView, PersonalTimelineApiError, void>({
    mutationFn: testTimelineConnection,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PERSONAL_TIMELINE_QUERY_KEY }),
  });
}

export function useDisconnectTimeline() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, PersonalTimelineApiError, void>({
    mutationFn: disconnectTimeline,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: PERSONAL_TIMELINE_QUERY_KEY });
    },
  });
}

export function usePersonalTimelineDay(date: string, enabled: boolean) {
  return useQuery<PersonalTimelineDayV1, PersonalTimelineApiError>({
    queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "day", date] as const,
    queryFn: () => getPersonalTimelineDay(date),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: (failureCount, error) =>
      failureCount === 0 &&
      error instanceof ApiError &&
      error.status === 503 &&
      error.code === "TIMELINE_UPSTREAM_UNAVAILABLE",
  });
}
