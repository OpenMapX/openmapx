/**
 * Capturing a transit trip before it starts.
 *
 * A planned itinerary says which train, not which stops that train makes — and
 * counting stops is how a rider knows when to get off. Underground, that count
 * is the only thing they have. So before the session starts, while the
 * connection still works, each ridden leg's journey is fetched once and sliced
 * from boarding to alighting.
 *
 * A leg whose journey cannot be fetched becomes an explicit `missing` capture.
 * That is the whole point: the shell can then say "we do not know the
 * intermediate stops for this leg" and fall back to the schedule, rather than
 * invent stops that would put someone off a train in the wrong place.
 */

import {
  type ApiClient,
  type BuildTransitPackageResult,
  buildTransitNavigationPackage,
  fetchVehicleJourney,
  isApiRequestAbortedError,
  type JourneyStopLike,
} from "@openmapx/core/navigation/api";
import type { TripItinerary } from "@openmapx/mobility-core/transit";

/** How many journeys are fetched at once. */
export const CAPTURE_CONCURRENCY = 4;
/** One slow provider must not hold up the whole start. */
export const CAPTURE_TIMEOUT_MS = 8_000;

export interface CaptureOutcome {
  tripId: string;
  status: "captured" | "missing";
}

export interface PrepareTransitStartInput {
  itinerary: TripItinerary;
  client: ApiClient;
  locale: "en" | "de";
  units: "metric" | "imperial";
  settings: { voiceEnabled: boolean; keepScreenOn: boolean; alightAlertsEnabled: boolean };
  replanOptions?: Record<string, unknown>;
  capturedAtMs: number;
  signal?: AbortSignal;
}

export type PrepareTransitStartResult =
  | {
      ok: true;
      startPackage: Extract<BuildTransitPackageResult, { ok: true }>["startPackage"];
      outcomes: CaptureOutcome[];
    }
  | { ok: false; code: "aborted" | "no-destination" | "invalid-package" };

/** Legs the rider walks, cycles or drives; none has a stop list to count. */
const STREET_MODES = new Set(["walking", "cycling", "driving"]);

/**
 * The distinct trips actually ridden.
 *
 * Deduplicated because a trip can legitimately appear twice — a circular route
 * boarded and re-boarded, or a leg split across a stop — and fetching the same
 * journey twice buys nothing but latency at the worst moment.
 */
function riddenTripIds(itinerary: TripItinerary): string[] {
  const seen = new Set<string>();
  for (const leg of itinerary.legs ?? []) {
    const tripId = leg.tripId;
    // A street leg has no trip to capture; its geometry is already in the
    // itinerary, and it carries no stop list to count down.
    if (!tripId || STREET_MODES.has(leg.mode)) continue;
    seen.add(tripId);
  }
  return [...seen];
}

/** Runs `task` over `items`, at most `limit` at a time, preserving order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetches one journey, or reports that it could not be had.
 *
 * Never throws: a leg with no journey is a *result*, not an error, and the
 * caller's job is to represent that honestly rather than to abandon the trip.
 * An abort is the one exception the caller must distinguish, so it is returned
 * as a flag rather than swallowed.
 */
async function fetchJourneyStops(
  tripId: string,
  client: ApiClient,
  signal: AbortSignal | undefined,
): Promise<{ stops: readonly JourneyStopLike[] | undefined; aborted: boolean }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    const envelope = await fetchVehicleJourney({ tripId }, client, { signal: controller.signal });
    const stops = (envelope.data as { stops?: readonly JourneyStopLike[] } | undefined)?.stops;
    return { stops, aborted: false };
  } catch (error) {
    // The caller aborting is different from the fetch failing: one means the
    // user moved on, the other means this leg degrades to schedule times.
    return {
      stops: undefined,
      aborted: signal?.aborted === true || isApiRequestAbortedError(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Builds a startable transit package from a planned itinerary.
 *
 * The rotating refresh token stays where it already is — inside the itinerary
 * this package carries — and is never lifted out into a field of its own, so
 * there is exactly one place it can leak from and the snapshot stripping that
 * runs on every outbound projection already covers it.
 */
export async function prepareTransitStart(
  input: PrepareTransitStartInput,
): Promise<PrepareTransitStartResult> {
  const tripIds = riddenTripIds(input.itinerary);

  const fetched = await mapWithLimit(tripIds, CAPTURE_CONCURRENCY, (tripId) =>
    fetchJourneyStops(tripId, input.client, input.signal),
  );
  if (input.signal?.aborted || fetched.some((result) => result.aborted)) {
    return { ok: false, code: "aborted" };
  }

  const journeys: Record<string, readonly JourneyStopLike[] | undefined> = {};
  const outcomes: CaptureOutcome[] = [];
  for (const [index, tripId] of tripIds.entries()) {
    const stops = fetched[index].stops;
    journeys[tripId] = stops;
    outcomes.push({ tripId, status: stops && stops.length > 0 ? "captured" : "missing" });
  }

  const built = buildTransitNavigationPackage({
    itinerary: input.itinerary,
    journeys,
    replanOptions: input.replanOptions,
    locale: input.locale,
    units: input.units,
    settings: input.settings,
    capturedAtMs: input.capturedAtMs,
  });
  if (!built.ok) return { ok: false, code: built.code };
  return { ok: true, startPackage: built.startPackage, outcomes };
}

/**
 * Which legs the rider should be told are running on schedule data alone.
 *
 * Returned as leg indices rather than a boolean so the UI can mark the specific
 * leg, which is the difference between a useful warning and a vague one.
 */
export function degradedLegIndices(
  itinerary: TripItinerary,
  outcomes: readonly CaptureOutcome[],
): number[] {
  const missing = new Set(
    outcomes.filter((outcome) => outcome.status === "missing").map((outcome) => outcome.tripId),
  );
  const indices: number[] = [];
  for (const [index, leg] of (itinerary.legs ?? []).entries()) {
    if (leg.tripId && missing.has(leg.tripId)) indices.push(index);
  }
  return indices;
}
