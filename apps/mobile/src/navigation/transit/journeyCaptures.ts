import {
  type ApiClient,
  type ApiRequestOptions,
  fetchVehicleJourney,
} from "@openmapx/core/navigation/api";

export const MAX_JOURNEY_CONCURRENCY = 4;

export type JourneyCaptures = Record<string, readonly unknown[] | undefined>;

export async function fetchJourneyCaptures(
  uniqueTripIds: readonly string[],
  client: ApiClient,
  options: ApiRequestOptions,
  concurrency = MAX_JOURNEY_CONCURRENCY,
): Promise<JourneyCaptures> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const captures: JourneyCaptures = {};
  for (let start = 0; start < uniqueTripIds.length; start += concurrency) {
    const batch = uniqueTripIds.slice(start, start + concurrency);
    const results = await Promise.all(
      batch.map(async (tripId) => {
        try {
          const envelope = await fetchVehicleJourney({ tripId }, client, options);
          const stops = (envelope as { data?: { stops?: unknown[] } })?.data?.stops;
          return [tripId, Array.isArray(stops) ? stops : undefined] as const;
        } catch {
          return [tripId, undefined] as const;
        }
      }),
    );
    for (const [tripId, stops] of results) captures[tripId] = stops;
  }
  return captures;
}
