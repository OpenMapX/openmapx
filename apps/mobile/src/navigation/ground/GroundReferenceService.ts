import {
  cumulativeDistances,
  eligibleLandmarkManeuvers,
  type GroundMobileSession,
  type LandmarkReference,
  landmarkManeuverAt,
  maneuverStartMeters,
  type Route,
  routeFingerprint,
  selectLandmark,
  signalAlongDistances,
  windowGeometry,
} from "@openmapx/core/navigation";
import {
  type ApiClient,
  fetchNavigationLandmarks,
  fetchRouteMatchWindow,
} from "@openmapx/core/navigation/api";
import { createNativeApiClient } from "../../api/nativeApiClient";

/**
 * The evidence for "At the second traffic light" and "At the Aral petrol
 * station" prompts, fetched by the native session for the route it follows.
 *
 * A page that already knows the signals and landmarks hands them over in the
 * start package; this covers a start without them and every native reroute,
 * whose new route has none. Like a reroute it runs outside the coordinator's
 * queue, and its answer re-enters bound to the session and route it was asked
 * for. It fetches the route's first match window (as the browser does first)
 * and the landmarks of the eligible manoeuvres inside it, in parallel.
 *
 * The requests go to the compiled API origin with `credentials: "omit"`: road
 * attributes need no identity.
 */

export type ReferenceFailureCode = "aborted" | "timeout" | "network" | "unsupported";

export type ReferenceOutcome =
  | {
      ok: true;
      requestId: string;
      sessionId: string;
      routeFingerprint: string;
      signalsAlong?: number[];
      signalSpans?: { from: number; to: number }[];
      landmarkReferences?: LandmarkReference[];
    }
  | { ok: false; requestId: string; sessionId: string; code: ReferenceFailureCode };

export interface ReferenceRequest {
  requestId: string;
  session: GroundMobileSession;
}

export interface ReferenceServiceDeps {
  apiOrigin: string;
  /** Injectable so tests drive the transport without a network. */
  client?: ApiClient;
}

const REFERENCE_MODES: ReadonlySet<string> = new Set(["driving", "motorcycle"]);
/** The browser's window bounds: below the gateway and Valhalla trace caps. */
const MAX_TRACE_POINTS = 4_500;
const MAX_TRACE_METERS = 100_000;
const MAX_LANDMARK_POINTS = 40;
/** The start package's bound; a longer list is left out rather than cut short. */
const MAX_SIGNALS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class GroundReferenceService {
  private readonly client: ApiClient;
  private readonly inFlight = new Set<AbortController>();

  constructor(deps: ReferenceServiceDeps) {
    // References are optional: a refused protocol leaves plain prompts, and the
    // reroute and refresh paths report the update.
    this.client = deps.client ?? createNativeApiClient(deps.apiOrigin);
  }

  abortAll(): void {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }

  async request({ requestId, session }: ReferenceRequest): Promise<ReferenceOutcome> {
    const base = { requestId, sessionId: session.sessionId };
    const { startPackage } = session.payload;
    if (!REFERENCE_MODES.has(startPackage.mode)) return { ...base, ok: false, code: "unsupported" };

    const route = startPackage.route as unknown as Route;
    const geometry = route.geometry;
    const cum = cumulativeDistances(geometry);
    const window = windowGeometry(geometry, 0, MAX_TRACE_POINTS, cum, MAX_TRACE_METERS);
    const maneuvers = eligibleLandmarkManeuvers(route)
      .filter((stepIndex) => maneuverStartMeters(route, stepIndex) <= window.endMeters)
      .slice(0, MAX_LANDMARK_POINTS)
      .flatMap((stepIndex) => {
        const maneuver = landmarkManeuverAt(route, stepIndex);
        return maneuver ? [maneuver] : [];
      });

    const controller = new AbortController();
    this.inFlight.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const options = { client: this.client, signal: controller.signal };
      const [match, landmarks] = await Promise.all([
        fetchRouteMatchWindow(window.trace, startPackage.mode, options),
        maneuvers.length > 0
          ? fetchNavigationLandmarks(
              maneuvers.map(({ point }) => ({ lat: point[1], lon: point[0] })),
              options,
            )
          : Promise.resolve([]),
      ]);
      if (controller.signal.aborted) {
        return { ...base, ok: false, code: timedOut ? "timeout" : "aborted" };
      }
      if (match.failed && landmarks === null) return { ...base, ok: false, code: "network" };

      const signalsAlong = match.failed
        ? null
        : signalAlongDistances(match.signals, geometry, cum, 0, window.trace.length - 1);
      const landmarkReferences = (landmarks ?? []).flatMap((result, i) => {
        const maneuver = maneuvers[i];
        if (!maneuver || result.unavailable) return [];
        const reference = selectLandmark(maneuver, result.candidates);
        return reference ? [reference] : [];
      });
      return {
        ...base,
        ok: true,
        routeFingerprint: routeFingerprint(geometry),
        ...(signalsAlong !== null &&
          signalsAlong.length <= MAX_SIGNALS && {
            signalsAlong,
            signalSpans: [{ from: 0, to: window.endMeters }],
          }),
        ...(landmarkReferences.length > 0 && { landmarkReferences }),
      };
    } catch {
      // The error is not inspected: a message can carry a URL with the
      // user's coordinates in its query.
      return { ...base, ok: false, code: controller.signal.aborted ? "aborted" : "network" };
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }
}
