import {
  bearingBetween,
  eligibleLandmarkManeuvers,
  fetchNavigationLandmarks,
  type LandmarkManeuver,
  type LandmarkReference,
  type NavigationLandmarkResult,
  type Route,
  selectLandmark,
  type TravelMode,
  useNavigationStore,
} from "@openmapx/core";
import { useEffect, useRef } from "react";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { OSM_ATTRIBUTION } from "@/lib/map";

const OSM_CREDIT = [OSM_ATTRIBUTION];
const NO_CREDIT: typeof OSM_CREDIT = [];
const LANDMARK_MODES: ReadonlySet<TravelMode> = new Set(["driving", "motorcycle"]);
const MAX_BATCH = 40;
/** Ask for the next batch once fewer than this many requested manoeuvres remain ahead. */
const LOOKAHEAD = 10;

interface Entry {
  stepIndex: number;
  status: "pending" | "sent" | "done";
}

interface LookupState {
  route: Route | null;
  entries: Entry[];
  abort: AbortController | null;
}

/**
 * Landmarks for voice prompts ("At the Aral petrol station, turn left"), looked
 * up per route in batches of eligible manoeuvres and selected on the client.
 * Driving and motorcycle only. A failed or unavailable answer means no
 * landmark for those manoeuvres; the prompt keeps its distance.
 */
export function useNavLandmarks(): void {
  const route = useNavigationStore((s) => s.route);
  const mode = useNavigationStore((s) => s.mode);
  const currentStepIndex = useNavigationStore((s) => s.progress?.currentStepIndex ?? 0);
  const online = useNavigationStore((s) => s.connectivity === "online");
  const credited = useNavigationStore(
    (s) =>
      s.landmarkReferences !== null &&
      s.landmarkReferences.route === s.route &&
      Object.keys(s.landmarkReferences.byStep).length > 0,
  );
  useMapAttributions("nav-landmark-references", credited ? OSM_CREDIT : NO_CREDIT);

  const state = useRef<LookupState>({ route: null, entries: [], abort: null });

  useEffect(() => {
    state.current.abort?.abort();
    const enabled = route !== null && LANDMARK_MODES.has(mode);
    state.current = {
      route: enabled ? route : null,
      entries: enabled
        ? eligibleLandmarkManeuvers(route).map((stepIndex) => ({ stepIndex, status: "pending" }))
        : [],
      abort: enabled ? new AbortController() : null,
    };
    // A new route asks for its first batch straight away, whatever the step.
    const nav = useNavigationStore.getState();
    if (nav.connectivity === "online") {
      requestBatch(state.current, nav.progress?.currentStepIndex ?? 0);
    }
  }, [route, mode]);

  // Progress and reconnection ask for the next batch; entries already sent are
  // skipped, so this never repeats the route effect's request.
  useEffect(() => {
    if (online) requestBatch(state.current, currentStepIndex);
  }, [currentStepIndex, online]);

  useEffect(() => () => state.current.abort?.abort(), []);
}

function requestBatch(lookup: LookupState, currentStepIndex: number): void {
  const { route, abort } = lookup;
  if (!route || !abort) return;
  const ahead = lookup.entries.filter((entry) => entry.stepIndex > currentStepIndex);
  if (!ahead.slice(0, LOOKAHEAD).some((entry) => entry.status === "pending")) return;
  const batch = ahead.filter((entry) => entry.status === "pending").slice(0, MAX_BATCH);
  const points = batch.flatMap((entry) => {
    const point = route.steps[entry.stepIndex]?.coordinates[0];
    return point ? [{ entry, lat: point[1], lon: point[0] }] : [];
  });
  for (const entry of batch) entry.status = "sent";
  if (points.length === 0) return;
  void fetchNavigationLandmarks(
    points.map(({ lat, lon }) => ({ lat, lon })),
    { signal: abort.signal },
  ).then((results) => {
    for (const { entry } of points) entry.status = "done";
    if (results)
      applyResults(
        route,
        points.map(({ entry }) => entry.stepIndex),
        results,
      );
  });
}

function applyResults(route: Route, stepIndices: number[], results: NavigationLandmarkResult[]) {
  const store = useNavigationStore.getState();
  // A reroute while the request was out: these manoeuvres belong to a route
  // that no longer exists.
  if (store.route !== route) return;
  const found: Record<number, LandmarkReference> = {};
  stepIndices.forEach((stepIndex, i) => {
    const result = results[i];
    const maneuver = maneuverAt(route, stepIndex);
    if (!result || result.unavailable || !maneuver) return;
    const reference = selectLandmark(maneuver, result.candidates);
    if (reference) found[stepIndex] = reference;
  });
  if (Object.keys(found).length === 0) return;
  const previous = store.landmarkReferences?.route === route ? store.landmarkReferences.byStep : {};
  store.setLandmarkReferences({ route, byStep: { ...previous, ...found } });
}

/** The manoeuvre's point and bearings, from the engine or the step geometry. */
function maneuverAt(route: Route, stepIndex: number): LandmarkManeuver | null {
  const step = route.steps[stepIndex];
  const point = step?.coordinates[0];
  const modifier = step?.maneuver?.modifier;
  if (!step || !point || !modifier) return null;
  const before = route.steps[stepIndex - 1]?.coordinates;
  const previousPoint = before && before.length >= 2 ? before.at(-2) : undefined;
  const nextPoint = step.coordinates[1];
  const bearingIn =
    step.bearingBefore ?? (previousPoint ? bearingBetween(previousPoint, point) : null);
  const bearingOut = step.bearingAfter ?? (nextPoint ? bearingBetween(point, nextPoint) : null);
  if (bearingIn === null || bearingOut === null) return null;
  return { stepIndex, point, bearingIn, bearingOut, modifier };
}
