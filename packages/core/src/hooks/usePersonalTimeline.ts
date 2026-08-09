import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  connectTimeline,
  disconnectTimeline,
  getPersonalTimelineDay,
  getTimelineConnection,
  testTimelineConnection,
} from "../api/personalTimeline";
import { usePersonalTimelineStore } from "../stores/personalTimelineStore";
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

export const personalTimelineOwnerQueryKey = (ownerId: string) =>
  [...PERSONAL_TIMELINE_QUERY_KEY, ownerId] as const;

export const personalTimelineConnectionQueryKey = (ownerId: string) =>
  [...personalTimelineOwnerQueryKey(ownerId), "connection"] as const;

export const personalTimelineDayQueryKey = (ownerId: string, date: string) =>
  [...personalTimelineOwnerQueryKey(ownerId), "day", date] as const;

export function useTimelineConnection(ownerId: string) {
  return useQuery<TimelineConnectionView, PersonalTimelineApiError>({
    queryKey: personalTimelineConnectionQueryKey(ownerId),
    queryFn: getTimelineConnection,
  });
}

export function useConnectTimeline(ownerId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    TimelineConnectionView,
    PersonalTimelineApiError,
    ConnectPersonalTimelineRequest
  >({
    mutationFn: connectTimeline,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: personalTimelineOwnerQueryKey(ownerId) }),
  });
}

export function useTestTimelineConnection(ownerId: string) {
  const queryClient = useQueryClient();
  return useMutation<TimelineConnectionView, PersonalTimelineApiError, void>({
    mutationFn: testTimelineConnection,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: personalTimelineOwnerQueryKey(ownerId) }),
  });
}

export function useDisconnectTimeline(ownerId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, PersonalTimelineApiError, void>({
    mutationFn: disconnectTimeline,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: personalTimelineOwnerQueryKey(ownerId) });
      usePersonalTimelineStore.getState().resetForSession();
    },
  });
}

export function usePersonalTimelineDay(ownerId: string, date: string, enabled: boolean) {
  return useQuery<PersonalTimelineDayV1, PersonalTimelineApiError>({
    queryKey: personalTimelineDayQueryKey(ownerId, date),
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
