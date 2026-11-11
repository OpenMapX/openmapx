import type { TransitMobileSession } from "@openmapx/core/navigation";
import {
  type ApiClient,
  type ApiRequestOptions,
  createApiClient,
  isApiClientError,
  refreshTransitItinerary,
} from "@openmapx/core/navigation/api";
import { fetchJourneyCaptures } from "./journeyCaptures";
import type { RefreshFailure } from "./refreshState";
import { REQUEST_TIMEOUT_MS } from "./refreshState";

export { MAX_JOURNEY_CONCURRENCY } from "./journeyCaptures";

/** Native owns the rotating handle and classifies failures for bounded replay. */

export type RefreshOutcome =
  | {
      ok: true;
      requestId: string;
      sessionId: string;
      generation: number;
      itinerary: unknown;
      journeys: Record<string, readonly unknown[] | undefined>;
      capturesOnly?: boolean;
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

  async request(request: RefreshRequest): Promise<RefreshOutcome> {
    const { requestId, generation, session } = request;
    const base = { requestId, generation, sessionId: session.sessionId };

    const token = session.payload.refreshToken;

    // Never abandoned: the server may spend the one-time token on receipt,
    // and only the answer carries its replacement. The timeout bounds it.
    const options: ApiRequestOptions = { timeoutMs: REQUEST_TIMEOUT_MS };

    try {
      const [envelope, journeys] = await Promise.all([
        token ? refreshTransitItinerary(token, this.client, options) : Promise.resolve(null),
        fetchJourneyCaptures(journeysToRefetch(session).slice(0, 4), this.client, options),
      ]);
      if (!token) {
        if (!Object.values(journeys).some((stops) => stops?.length))
          return { ...base, ok: false, failure: "retryable" };
        return {
          ...base,
          ok: true,
          itinerary: session.payload.startPackage.itinerary,
          journeys,
          capturesOnly: true,
        };
      }
      const itinerary = (envelope as { data?: { itinerary?: unknown } })?.data?.itinerary;
      if (!itinerary || envelope?.data?.fallbackOccurred) {
        // The server answered and did not give us a replacement token. The old
        // one is spent either way.
        return { ...base, ok: false, failure: "rejected" };
      }

      return { ...base, ok: true, itinerary, journeys };
    } catch (error) {
      if (isApiClientError(error)) {
        if (error.status === 400 || error.status === 409)
          return { ...base, ok: false, failure: "rejected" };
        if (error.status === 503) return { ...base, ok: false, failure: "retryable" };
      }
      // A lost response is ambiguous; the server replay window bounds retries.
      return { ...base, ok: false, failure: "ambiguous" };
    }
  }
}
