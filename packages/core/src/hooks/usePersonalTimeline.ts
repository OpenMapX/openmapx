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
  const mutationKey = [...personalTimelineOwnerQueryKey(ownerId), "connect"] as const;
  const mutation = useMutation<
    TimelineConnectionView,
    PersonalTimelineApiError,
    ConnectPersonalTimelineRequest
  >({
    mutationKey,
    mutationFn: connectTimeline,
    networkMode: "always",
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: personalTimelineOwnerQueryKey(ownerId) }),
  });

  return {
    ...mutation,
    reset: () => {
      mutation.reset();
      const mutationCache = queryClient.getMutationCache();
      for (const cached of mutationCache.findAll({ mutationKey, exact: true })) {
        // A pending request cannot be cancelled by MutationCache removal. Its
        // owner-liveness is handled by the session guard; only settled entries
        // are eligible for synchronous credential eviction here.
        if (cached.state.status !== "pending") mutationCache.remove(cached);
      }
    },
  };
}

export function useTestTimelineConnection(ownerId: string) {
  const queryClient = useQueryClient();
  return useMutation<TimelineConnectionView, PersonalTimelineApiError, void>({
    mutationKey: [...personalTimelineOwnerQueryKey(ownerId), "test"],
    mutationFn: testTimelineConnection,
    networkMode: "always",
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: personalTimelineOwnerQueryKey(ownerId) }),
  });
}

export function useDisconnectTimeline(ownerId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, PersonalTimelineApiError, void>({
    mutationKey: [...personalTimelineOwnerQueryKey(ownerId), "disconnect"],
    mutationFn: disconnectTimeline,
    networkMode: "always",
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: personalTimelineOwnerQueryKey(ownerId) });
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
