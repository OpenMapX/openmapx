import { matchCountriesByPoint } from "../navigation/routeCountries";
import { matchSpeedLimitsByPoint } from "../navigation/speedLimits";
import { extractTrafficSignals } from "../navigation/trafficSignals";
import type { LngLat } from "../types/geometry";
import type { MatchResult, TravelMode } from "../types/routing";
import {
  type ApiRequestOptions,
  apiClient,
  isApiClientError,
  isApiRequestAbortedError,
} from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface RouteMatchWindow {
  /** Traffic-signal coordinates along the matched window. */
  signals: LngLat[];
  /**
   * Posted speed limit (km/h) per matched trace point, aligned 1:1 to the input
   * window's points. The caller offsets these into a route-geometry-indexed
   * array (the window is a slice of `route.geometry`).
   */
  speedLimitsByPoint: (number | null)[];
  /** ISO country code per matched trace point, aligned like `speedLimitsByPoint`. */
  countriesByPoint: (string | null)[];
}

const RETRY_DELAYS_MS = [1000, 3000] as const;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 30_000;

function retryDelay(error: unknown, backoff: number | undefined): number | undefined {
  if (backoff === undefined) return undefined;
  if (isApiClientError(error)) {
    if (![408, 429, 500, 502, 503, 504].includes(error.status)) return undefined;
    const delay = Math.max(backoff, (error.retryAfterSeconds ?? 0) * 1000);
    // Respect the server's minimum wait without holding a navigation window indefinitely.
    return delay <= MAX_RETRY_DELAY_MS ? delay : undefined;
  }
  if (isApiRequestAbortedError(error)) return error.code === "timeout" ? backoff : undefined;
  return error instanceof TypeError ? backoff : undefined;
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function matchWindow(
  trace: LngLat[],
  mode: TravelMode,
  signal?: AbortSignal,
): Promise<MatchResult> {
  const body = {
    trace: trace.map(([lng, lat]) => ({ lat, lng })),
    mode,
    // Valhalla only returns matched_points for map_snap. A successful
    // walk_or_snap edge walk omits them, losing both limits and countries.
    shapeMatch: "map_snap",
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await apiClient.post<MatchResult>(API_ENDPOINTS.routingMatch, body, {
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      const delay = retryDelay(error, RETRY_DELAYS_MS[attempt]);
      if (signal?.aborted || delay === undefined || !(await waitForRetry(delay, signal)))
        throw error;
    }
  }
}

/**
 * Map-match one route-geometry window and return both the traffic-signal
 * coordinates and the per-point speed limits along it, so navigation gets both
 * road attributes from a single request instead of polling. A failed lookup
 * (no map-matcher, network error, …) resolves to empty results — never throws,
 * matching {@link fetchTrafficSignals}. Temporary transport failures get at most
 * three attempts with backoff; valid responses with unknown attributes are not
 * retried. The optional signal cancels both requests and pending retries.
 */
export async function fetchRouteMatchWindow(
  trace: LngLat[],
  mode: TravelMode,
  options: Pick<ApiRequestOptions, "signal"> = {},
): Promise<RouteMatchWindow> {
  if (trace.length < 2) return { signals: [], speedLimitsByPoint: [], countriesByPoint: [] };
  try {
    const res = await matchWindow(trace, mode, options.signal);
    // The caller offsets speedLimitsByPoint into a route-geometry-indexed array
    // (window point j → geometry[start + j]), which is only correct when the
    // matcher returns exactly one point per input trace point, in order. If the
    // count differs (a matcher that interpolates or drops points), the alignment
    // is broken, so skip the limits for this window rather than mis-index them;
    // signals are independent (keyed by edge endShapeIndex) and stay valid.
    const aligned = (res.points?.length ?? 0) === trace.length;
    return {
      signals: extractTrafficSignals(res),
      speedLimitsByPoint: aligned ? matchSpeedLimitsByPoint(res) : [],
      countriesByPoint: aligned ? matchCountriesByPoint(res) : [],
    };
  } catch {
    return { signals: [], speedLimitsByPoint: [], countriesByPoint: [] };
  }
}
