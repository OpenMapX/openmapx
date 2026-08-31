import {
  buildTransitNavigationPackage,
  type TransitMobileSession,
} from "@openmapx/core/navigation";
import {
  type ApiClient,
  type ApiRequestOptions,
  createApiClient,
  fetchTransitPlan,
  isApiRequestAbortedError,
} from "@openmapx/core/navigation/api";
import { fetchJourneyCaptures } from "./journeyCaptures";

/**
 * Finding a new way when the planned one stopped working.
 *
 * A replan is what happens after a missed connection or a cancellation: the
 * itinerary the rider is holding no longer gets them there, and refreshing its
 * times would only make a wrong plan look current.
 *
 * The captured trip stays active throughout. Until a complete, validated
 * replacement commits, the rider keeps whatever guidance they had — a stale plan
 * they can reason about beats no plan at all while standing on a platform.
 */

export const REPLAN_TIMEOUT_MS = 20_000;
/** Backoff after a failed replan, in order; the last repeats. */
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
export const MAX_CONSECUTIVE_FAILURES = RETRY_DELAYS_MS.length;

export type ReplanFailureCode = "timeout" | "aborted" | "network" | "no-result" | "invalid-result";

export type ReplanOutcome =
  | {
      ok: true;
      requestId: string;
      sessionId: string;
      generation: number;
      startPackage: unknown;
    }
  | {
      ok: false;
      requestId: string;
      sessionId: string;
      generation: number;
      code: ReplanFailureCode;
    };

export interface ReplanRequest {
  requestId: string;
  generation: number;
  session: TransitMobileSession;
  /** The raw accepted fix; the rider is where they are, not where the plan said. */
  origin: [number, number];
  nowMs: number;
}

export interface ReplanServiceDeps {
  apiOrigin: string;
  client?: ApiClient;
}

interface PlaceLike {
  lat?: number;
  lng?: number;
  name?: string;
}

interface LegLike {
  mode?: string;
  route?: unknown;
  tripId?: string;
  to?: PlaceLike;
}

/** Where the rider was actually going, taken from the last leg of the plan. */
export function replanDestination(session: TransitMobileSession): [number, number] | null {
  const legs = ((session.payload.startPackage.itinerary as { legs?: LegLike[] }).legs ??
    []) as LegLike[];
  const destination = legs[legs.length - 1]?.to;
  if (typeof destination?.lat !== "number" || typeof destination?.lng !== "number") return null;
  return [destination.lng, destination.lat];
}

/**
 * Rebuilds the plan request from what the rider originally chose.
 *
 * Every captured option travels: dropping the wheelchair requirement or the
 * transfer buffer would replan the trip as if the rider had asked for something
 * they did not.
 */
export function replanParams(request: ReplanRequest): Record<string, unknown> {
  const { session, origin, nowMs } = request;
  const destination = replanDestination(session);
  const captured = (session.payload.startPackage.replanOptions ?? {}) as Record<string, unknown>;

  // Spread first, so the three values this request owns cannot be overridden by
  // a captured option that happens to share their names.
  return {
    ...captured,
    origin,
    destination,
    // Now, not the time the trip was originally planned for: the rider is
    // standing on a platform having missed something.
    time: new Date(nowMs).toISOString(),
    lang: session.locale,
  };
}

export function journeysToCapture(itinerary: unknown): string[] {
  const legs = ((itinerary as { legs?: LegLike[] })?.legs ?? []) as LegLike[];
  const tripIds: string[] = [];
  for (const leg of legs) {
    if (leg.mode === "walking" || !leg.route || !leg.tripId) continue;
    if (!tripIds.includes(leg.tripId)) tripIds.push(leg.tripId);
  }
  return tripIds;
}

export class TransitReplanService {
  private readonly client: ApiClient;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(deps: ReplanServiceDeps) {
    this.client = deps.client ?? createApiClient({ baseUrl: deps.apiOrigin, credentials: "omit" });
  }

  abort(requestId: string): void {
    this.inFlight.get(requestId)?.abort();
    this.inFlight.delete(requestId);
  }

  abortAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  async request(request: ReplanRequest): Promise<ReplanOutcome> {
    const { requestId, generation, session } = request;
    const base = { requestId, generation, sessionId: session.sessionId };

    if (!replanDestination(session)) return { ...base, ok: false, code: "invalid-result" };

    const controller = new AbortController();
    this.inFlight.set(requestId, controller);
    const options: ApiRequestOptions = {
      signal: controller.signal,
      timeoutMs: REPLAN_TIMEOUT_MS,
    };

    try {
      const envelope = await fetchTransitPlan(replanParams(request) as never, this.client, options);
      const itinerary = (envelope as { data?: { itineraries?: unknown[] } })?.data
        ?.itineraries?.[0];
      if (!itinerary) return { ...base, ok: false, code: "no-result" };

      const journeys = await fetchJourneyCaptures(
        journeysToCapture(itinerary),
        this.client,
        options,
      );

      // Built through exactly the builder a first-time plan uses. A replacement
      // is a whole package or nothing: combining a new itinerary with old
      // captures would describe a journey that never existed.
      const built = buildTransitNavigationPackage({
        itinerary: itinerary as never,
        // The server's stop shape is asserted once here; the builder's own
        // schema is what actually validates the result.
        journeys: journeys as never,
        ...(session.payload.startPackage.replanOptions
          ? { replanOptions: session.payload.startPackage.replanOptions as Record<string, unknown> }
          : {}),
        locale: session.locale,
        units: session.units,
        settings: session.payload.startPackage.settings,
        capturedAtMs: request.nowMs,
      });
      if (!built.ok) return { ...base, ok: false, code: "invalid-result" };

      return { ...base, ok: true, startPackage: built.startPackage };
    } catch (error) {
      if (isApiRequestAbortedError(error)) {
        return { ...base, ok: false, code: error.code === "timeout" ? "timeout" : "aborted" };
      }
      // Not inspected further: an error message can carry a URL with the
      // rider's coordinates in its query.
      return { ...base, ok: false, code: "network" };
    } finally {
      this.inFlight.delete(requestId);
    }
  }
}

/** The delay before another attempt after a failed replan. */
export function replanRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index];
}
