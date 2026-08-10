import { type GroundMobileSession, remainingWaypoints } from "@openmapx/core/navigation";
import {
  type ApiClient,
  type ApiRequestOptions,
  createApiClient,
  fetchDirections,
  isApiRequestAbortedError,
} from "@openmapx/core/navigation/api";
import { validateGroundStartPackage } from "./groundSession";
import { REQUEST_TIMEOUT_MS } from "./rerouteState";

/**
 * Asking the server for a new route, from outside the coordinator's queue.
 *
 * A reroute is the only navigation operation that waits on a socket. Running it
 * inside the serialised queue would stall every location fix behind a request
 * that might take fifteen seconds, so it happens here and its *result* re-enters
 * as an ordinary command bound to the session and revision it was computed from.
 * A result for a session that has since stopped, or a route that has since been
 * replaced, is discarded rather than applied.
 *
 * The request itself is deliberately unauthenticated: it goes to the compiled
 * API origin with `credentials: "omit"`, so no WebView cookie, token or session
 * travels with it. Rerouting needs a road network, not an identity.
 */

export type RerouteFailureCode =
  | "timeout"
  | "aborted"
  | "network"
  | "invalid-response"
  | "no-route";

export type RerouteOutcome =
  | { ok: true; requestId: string; sessionId: string; baseRevision: number; route: unknown }
  | {
      ok: false;
      requestId: string;
      sessionId: string;
      baseRevision: number;
      code: RerouteFailureCode;
    };

export interface RerouteRequest {
  requestId: string;
  session: GroundMobileSession;
  /** The raw accepted fix — never the position snapped to the obsolete route. */
  origin: [number, number];
}

export interface RerouteServiceDeps {
  apiOrigin: string;
  /** Injectable so tests drive the transport without a network. */
  client?: ApiClient;
  now: () => number;
}

/**
 * Builds the waypoint list for a reroute.
 *
 * The origin is the raw fix. Snapping it to the route being abandoned would ask
 * the server to route from a road the user has left — which is exactly how a
 * reroute sends someone back to the turn they just missed. The snapped progress
 * is used only to decide which intermediate stops are already behind them; the
 * destination is always kept.
 */
export function rerouteWaypoints(request: RerouteRequest): Array<[number, number]> {
  const { session, origin } = request;
  const waypoints = session.payload.startPackage.destinationWaypoints as Array<[number, number]>;
  const progress = session.payload.progress as { alongMeters?: number } | null;

  // `remainingWaypoints` re-anchors the list at `origin` itself, so the raw fix
  // becomes the start and only genuinely-passed intermediate stops are pruned.
  return remainingWaypoints(
    session.payload.startPackage.route.geometry as Array<[number, number]>,
    waypoints,
    origin,
    progress?.alongMeters ?? 0,
  ) as Array<[number, number]>;
}

export class GroundRerouteService {
  private readonly client: ApiClient;
  /** One controller per in-flight request, so a stop can abort it immediately. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(deps: RerouteServiceDeps) {
    this.client =
      deps.client ??
      createApiClient({
        baseUrl: deps.apiOrigin,
        // No cookie, no bearer token, no WebView session. A road network does
        // not need to know who is asking.
        credentials: "omit",
      });
  }

  /** Aborts a request whose session has ended or been replaced. */
  abort(requestId: string): void {
    this.inFlight.get(requestId)?.abort();
    this.inFlight.delete(requestId);
  }

  abortAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  async request(request: RerouteRequest): Promise<RerouteOutcome> {
    const { requestId, session } = request;
    const base = {
      requestId,
      sessionId: session.sessionId,
      baseRevision: session.revision,
    };

    const controller = new AbortController();
    this.inFlight.set(requestId, controller);
    const options: ApiRequestOptions = {
      signal: controller.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    };

    try {
      const { startPackage } = session.payload;
      const routeOptions = startPackage.routeOptions as Record<string, unknown>;
      const result = await fetchDirections(
        {
          waypoints: rerouteWaypoints(request),
          mode: startPackage.mode,
          units: startPackage.units,
          lang: startPackage.locale,
          // Every avoid flag the user captured is carried forward; dropping one
          // would silently route them onto a toll road they excluded.
          avoidHighways: routeOptions.avoidHighways === true,
          avoidTolls: routeOptions.avoidTolls === true,
          avoidFerries: routeOptions.avoidFerries === true,
          avoidClosures: routeOptions.avoidClosures === true,
        },
        this.client,
        options,
      );

      const candidate = (result as { routes?: unknown[] })?.routes?.[0];
      if (!candidate) return { ...base, ok: false, code: "no-route" };

      // Validated through exactly the schema a captured package uses. A server
      // response is not more trustworthy than the page, and a malformed route
      // must leave the old one in place rather than half-replace it.
      const replacement = { ...startPackage, route: candidate, alternatives: [] };
      const validated = validateGroundStartPackage(replacement);
      if (!validated.ok) return { ...base, ok: false, code: "invalid-response" };

      return { ...base, ok: true, route: validated.startPackage };
    } catch (error) {
      if (isApiRequestAbortedError(error)) {
        return { ...base, ok: false, code: error.code === "timeout" ? "timeout" : "aborted" };
      }
      // The error is deliberately not inspected further: a message can contain
      // a URL with the user's coordinates in its query.
      return { ...base, ok: false, code: "network" };
    } finally {
      this.inFlight.delete(requestId);
    }
  }
}
