import { useQuery } from "@tanstack/react-query";
import { postScheduledDirections } from "../api/directions";
import type { ScheduleDirectionsRequest } from "../types/routing";

/**
 * Stable identity for a request object. Sorting the keys makes it independent
 * of the order a caller happens to build the object in, so the panel and the
 * map layer share one cache entry even when their builders differ.
 */
export function stableRequestKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableRequestKey).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableRequestKey(entryValue)}`)
    .join(",")}}`;
}

/**
 * The single source of truth for the scheduled-directions query key. Every
 * component that reads this cache MUST build its key with this.
 */
export function scheduledDirectionsQueryKey(request: ScheduleDirectionsRequest): string[] {
  return ["directions-schedule", stableRequestKey(request)];
}

/** Pass `null` to disable the query (no constraints, or an incomplete trip). */
export function useScheduledDirections(request: ScheduleDirectionsRequest | null) {
  return useQuery({
    queryKey: request ? scheduledDirectionsQueryKey(request) : ["directions-schedule", "disabled"],
    queryFn: () => postScheduledDirections(request as ScheduleDirectionsRequest),
    enabled: request !== null,
    staleTime: 120_000,
    gcTime: 600_000,
    retry: false,
  });
}
