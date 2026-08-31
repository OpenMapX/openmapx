import type { TransitMobileSession } from "@openmapx/core/navigation";
import {
  type ApiClient,
  type ApiRequestOptions,
  createApiClient,
  isApiRequestAbortedError,
  refreshTransitItinerary,
} from "@openmapx/core/navigation/api";
import { fetchJourneyCaptures } from "./journeyCaptures";
import type { RefreshFailure } from "./refreshState";
import { REQUEST_TIMEOUT_MS } from "./refreshState";

export { MAX_JOURNEY_CONCURRENCY } from "./journeyCaptures";

/**
 * Rotating the live-data token, from outside the coordinator's queue.
 *
 * Native is the only consumer of that token, and it is one-time: the server
 * returns a replacement and invalidates what was sent. Everything unusual about
 * this service follows from that.
 *
 * The failure classification is the part that matters most. A request that was
 * *rejected* tells us the token is gone. A request that *timed out* tells us
 * nothing — the server may have consumed it and the reply may have been lost —
 * and the only safe reading of "we do not know" is that it was spent. A request
 * that never reached the network at all is the one case where the same token can
 * safely be reused.
 */

export type RefreshOutcome =
  | {
      ok: true;
      requestId: string;
      sessionId: string;
      generation: number;
      itinerary: unknown;
      journeys: Record<string, readonly unknown[] | undefined>;
    }
  | {
      ok: false;
      requestId: string;
      sessionId: string;
      generation: number;
      failure: RefreshFailure | "unreachable";
    };

export interface RefreshRequest {
  requestId: string;
  generation: number;
  session: TransitMobileSession;
}

export interface RefreshServiceDeps {
  apiOrigin: string;
  client?: ApiClient;
  now: () => number;
}

interface LegLike {
  mode?: string;
  route?: unknown;
  tripId?: string;
}

/**
 * Which rides still matter.
 *
 * The current leg first, then the ones ahead. Refetching a ride already
 * completed spends a request on a stop list nobody will read again.
 */
export function journeysToRefetch(session: TransitMobileSession): string[] {
  const legs = ((session.payload.startPackage.itinerary as { legs?: LegLike[] }).legs ??
    []) as LegLike[];
  const from = session.payload.tickState.currentLegIndex;

  const tripIds: string[] = [];
  for (let index = from; index < legs.length; index += 1) {
    const leg = legs[index];
    if (leg.mode === "walking" || !leg.route || !leg.tripId) continue;
    if (!tripIds.includes(leg.tripId)) tripIds.push(leg.tripId);
  }
  return tripIds;
}

export class TransitRefreshService {
  private readonly client: ApiClient;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(deps: RefreshServiceDeps) {
    this.client =
      deps.client ??
      createApiClient({
        baseUrl: deps.apiOrigin,
        // The token in the body is the only credential this call carries. A
        // WebView cookie riding along would be an identity the rider never
        // agreed to attach to a timetable lookup.
        credentials: "omit",
      });
  }

  abort(requestId: string): void {
    this.inFlight.get(requestId)?.abort();
    this.inFlight.delete(requestId);
  }

  abortAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  async request(request: RefreshRequest): Promise<RefreshOutcome> {
    const { requestId, generation, session } = request;
    const base = { requestId, generation, sessionId: session.sessionId };

    const token = session.payload.refreshToken;
    if (!token) return { ...base, ok: false, failure: "rejected" };

    const controller = new AbortController();
    this.inFlight.set(requestId, controller);
    const options: ApiRequestOptions = {
      signal: controller.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    };

    try {
      const envelope = await refreshTransitItinerary(token, this.client, options);
      const itinerary = (envelope as { data?: { itinerary?: unknown } })?.data?.itinerary;
      if (!itinerary) {
        // The server answered and did not give us a replacement token. The old
        // one is spent either way.
        return { ...base, ok: false, failure: "rejected" };
      }

      const journeys = await fetchJourneyCaptures(journeysToRefetch(session), this.client, options);
      return { ...base, ok: true, itinerary, journeys };
    } catch (error) {
      if (isApiRequestAbortedError(error)) {
        // A timeout is genuinely ambiguous; a deliberate abort is not, because
        // this process is the one that cancelled it.
        return {
          ...base,
          ok: false,
          failure: error.code === "timeout" ? "ambiguous" : "unreachable",
        };
      }
      // Anything else reached the server or did not; without knowing which, the
      // token has to be treated as spent.
      return { ...base, ok: false, failure: "ambiguous" };
    } finally {
      this.inFlight.delete(requestId);
    }
  }
}
