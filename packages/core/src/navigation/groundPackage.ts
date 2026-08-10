import type { LngLat } from "../types/geometry";
import type { Route, TravelMode } from "../types/routing";
import { type GroundNavigationStartPackage, groundStartPackageSchema } from "./mobileProtocol";

/**
 * Everything the shell needs to guide a ground trip, and nothing else.
 *
 * The package crosses a trust boundary, so it is built by projecting named
 * fields rather than by handing over whatever the page happened to be holding.
 * A route object in the browser has been through a router client, a store, and
 * several components; anything incidental still attached to it — a query-cache
 * handle, an auth header, an incident resource — would ride along into a durable
 * native record if this spread the object instead of naming its parts.
 *
 * Bounds are checked here rather than at the far end. A package that is too
 * large to send is a local fact the page can explain, whereas the same rejection
 * arriving from the shell is an error the driver sees after tapping Start.
 */

export type GroundPackageError =
  | "invalid-package"
  | "no-destination"
  | "route-too-large"
  | "no-geometry";

export interface GroundNavigationSettings {
  voiceEnabled: boolean;
  keepScreenOn: boolean;
  voiceTiming: "early" | "normal" | "late";
}

export interface BuildGroundPackageInput {
  route: Route;
  /** The other routes offered, so a mid-trip switch needs no network. */
  alternatives?: readonly Route[];
  mode: TravelMode;
  destinationWaypoints: readonly LngLat[];
  routeProvider?: string;
  routeSelectionIntent: "automatic" | "userSelected";
  routeOptions?: Record<string, unknown>;
  /** Speed limits already resolved for this route, if any. */
  capturedLiveSpeedLimits?: readonly (number | null)[];
  locale: "en" | "de";
  units: "metric" | "imperial";
  settings: GroundNavigationSettings;
}

export type BuildGroundPackageResult =
  | { ok: true; startPackage: GroundNavigationStartPackage }
  | { ok: false; code: GroundPackageError };

/** The schema caps alternatives at eight; more is a page bug, not a rejection. */
const MAX_ALTERNATIVES = 8;

/**
 * How much route one message may carry.
 *
 * Well under the protocol's 8 MB envelope cap, because the route is only part of
 * the package and the failure this prevents is a driver tapping Start and being
 * told, seconds later, that the trip they planned cannot be sent.
 */
const MAX_ROUTE_POINTS = 60_000;
const MAX_ROUTE_STEPS = 4_000;

/**
 * Copies only the fields the shell's route schema names.
 *
 * `routeSchema` passes unknown keys through, which is right for forwards
 * compatibility with the router but wrong for a durable native record: a route
 * that has been through a query client and several components may still be
 * holding references nobody meant to persist.
 */
function projectRoute(route: Route): Record<string, unknown> {
  const source = route as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {
    distance: route.distance,
    duration: route.duration,
    geometry: route.geometry,
    steps: route.steps,
    mode: route.mode,
  };
  for (const key of ["legs", "segmentSpeedLimits", "summary"] as const) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  return projected;
}

/**
 * A structural identity for the route.
 *
 * Used to tell "the same route, one revision later" from "a different route" —
 * which is the difference between applying a progress delta and drawing a puck
 * on a line that is no longer there. Built over geometry and distance, both of
 * which change whenever the followed line does.
 */
export function groundRouteFingerprint(route: Route): string {
  const geometry = route.geometry ?? [];
  let hash = 0x811c9dc5 >>> 0;
  const mix = (value: number) => {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  mix(Math.round(route.distance ?? 0));
  mix(Math.round(route.duration ?? 0));
  for (const point of geometry) {
    // Rounded to about a centimetre: enough that a genuinely different line
    // differs, without making float noise look like a reroute.
    mix(Math.round((point?.[0] ?? 0) * 1e7));
    mix(Math.round((point?.[1] ?? 0) * 1e7));
  }
  return `rt-${hash.toString(36)}-${geometry.length}`;
}

/**
 * Builds the package, or explains why it cannot.
 *
 * Every failure is a named code rather than a thrown error: the caller has to
 * decide what to show the user, and "the route is too big for the bridge" and
 * "there is no destination" call for different words.
 */
export function buildGroundNavigationPackage(
  input: BuildGroundPackageInput,
): BuildGroundPackageResult {
  const geometry = input.route?.geometry ?? [];
  if (geometry.length < 2) return { ok: false, code: "no-geometry" };
  if (input.destinationWaypoints.length < 1) return { ok: false, code: "no-destination" };

  const alternatives = (input.alternatives ?? []).slice(0, MAX_ALTERNATIVES);
  const points = geometry.length + alternatives.reduce((sum, r) => sum + r.geometry.length, 0);
  const steps =
    (input.route.steps?.length ?? 0) + alternatives.reduce((sum, r) => sum + r.steps.length, 0);
  if (points > MAX_ROUTE_POINTS || steps > MAX_ROUTE_STEPS) {
    return { ok: false, code: "route-too-large" };
  }

  const candidate = {
    kind: "ground" as const,
    route: projectRoute(input.route),
    alternatives: alternatives.map(projectRoute) as unknown[],
    mode: input.mode,
    destinationWaypoints: input.destinationWaypoints as unknown[],
    ...(input.routeProvider ? { routeProvider: input.routeProvider } : {}),
    routeSelectionIntent: input.routeSelectionIntent,
    routeOptions: input.routeOptions ?? {},
    ...(input.capturedLiveSpeedLimits
      ? { capturedLiveSpeedLimits: [...input.capturedLiveSpeedLimits] }
      : {}),
    locale: input.locale,
    units: input.units,
    settings: input.settings,
  };

  const parsed = groundStartPackageSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "invalid-package" };
  return { ok: true, startPackage: parsed.data };
}
