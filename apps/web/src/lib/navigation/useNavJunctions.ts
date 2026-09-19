import {
  fetchJunctionLookups,
  findJunctionCandidates,
  findJunctionDecisionPoints,
  type GantryModel,
  type JunctionDecisionPoint,
  type JunctionLookupPoint,
  type JunctionLookupResult,
  junctionLookupPoints,
  mergeExitPanel,
  parseLaneTags,
  proxyImageUrl,
  type StreetLevelImage,
  sameJunction,
  searchStreetLevelImages,
  selectApproachWay,
  selectJunctionPhoto,
  selectRampWay,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { useStreetLevelProviders } from "@/integration-api/components/useStreetLevelProviders";
import {
  type CarriedJunctionState,
  type JunctionPhotoState,
  useNavJunctionStore,
} from "./junctionStore";

/**
 * Monotonic route generation; bumped on every route identity change so a
 * response that arrives after a reroute is recognised as stale and dropped.
 */
let routeGeneration = 0;

/** One junction (accepted or candidate) awaiting, riding, or done with its OSM lookup. */
interface LookupEntry {
  point: JunctionDecisionPoint;
  lookup: JunctionLookupPoint;
  /** Offered by the engine without motorway evidence; OSM decides. */
  candidate: boolean;
  status: "pending" | "sent" | "done";
  /** Settles when the batch carrying it lands. Photo selection waits for it. */
  settled: Promise<void>;
}

/** The current route's lookups, in route order. */
let lookupEntries: LookupEntry[] = [];

/** The pending retry of lookups a batch left unanswered, if one is scheduled. */
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive batches that came back with unanswered lookups; stretches the retry delay. */
let failedBatches = 0;

/** Gantry lookups cost one POST for up to 40 junctions. */
const MAX_GANTRY_POINTS = 40;
/** The next batch is sent once one of this many junctions ahead still waits for its lookup. */
const LOOKUP_LOOKAHEAD = 10;
/**
 * Delay before lookups a batch left unanswered are asked for again, doubling
 * per consecutive failure up to the cap. A motorway step can run for many
 * minutes, so waiting for the next step could reach the exit first; a
 * rate-limited OSM server needs the gap.
 */
const LOOKUP_RETRY_MS = 30_000;
const LOOKUP_RETRY_MAX_MS = 240_000;
/** Decision points ahead of the current step the photo window searches. */
const PHOTO_WINDOW_AHEAD = 4;
/** Decision points ahead whose photo bytes are held in memory. */
const PHOTO_BYTES_AHEAD = 2;
/** Search radius around the decision point, metres; the selector keeps 30–200 m. */
const PHOTO_SEARCH_RADIUS_M = 200;
const PHOTO_HEADING_TOLERANCE_DEG = 30;
/** Motorway coverage is often years old; the selector applies the 8-year cap itself. */
const PHOTO_CAPTURED_AFTER = "2018-01-01T00:00:00Z";
/** Search results per provider request. */
const PHOTO_SEARCH_LIMIT = 20;

/**
 * Route junction work: detect the decision points synchronously, look up the
 * per-lane gantry tags in batches of 40 as the drive reaches them, and run the
 * rolling photo window. A replacement route keeps what the previous one
 * already had for the junctions both share. Lookups and the photo window
 * advance with the step index, and resume as soon as the connection or the
 * view returns; lookups left unanswered are asked for again after a delay.
 * Nothing here runs per GPS fix.
 */
export function useNavJunctions(): void {
  const route = useNavigationStore((s) => s.route);
  const currentStepIndex = useNavigationStore((s) => s.progress?.currentStepIndex);
  const junctionPhotos = useSettingsStore((s) => s.junctionPhotos);
  // Subscribed, not read on demand: coming back online or switching the view
  // on mid-step must start the lookups at once. A motorway step can run tens
  // of kilometres and ends at the exit, so waiting for it to advance would
  // miss that exit entirely.
  const online = useNavigationStore((s) => s.connectivity === "online");
  const junctionView = useSettingsStore((s) => s.junctionView);
  // Candidates promoted after route start join the photo window when they land.
  const decisionPointCount = useNavJunctionStore((s) => s.decisionPoints.length);
  const { providers } = useStreetLevelProviders();
  const providerIds = useMemo(
    () =>
      providers.filter((provider) => provider.allowsNavigationUse).map((provider) => provider.id),
    [providers],
  );

  useEffect(() => {
    const store = useNavJunctionStore.getState();
    routeGeneration += 1;
    cancelLookupRetry();
    const previousEntries = lookupEntries;
    lookupEntries = [];
    if (!route) {
      revokePhotoUrls(store.photoByStep);
      store.reset();
      return;
    }
    const generation = routeGeneration;
    const decisionPoints = findJunctionDecisionPoints(route);
    const candidates = findJunctionCandidates(route);
    const lookups = junctionLookupPoints(route, [...decisionPoints, ...candidates]);
    const candidateSteps = new Set(candidates.map((candidate) => candidate.stepIndex));
    const points = [...decisionPoints, ...candidates];
    lookupEntries = lookups
      .map(({ stepIndex, lookup }, i) => ({
        point: points[i],
        lookup,
        candidate: candidateSteps.has(stepIndex),
        status: "pending" as LookupEntry["status"],
        settled: Promise.resolve(),
      }))
      .sort((a, b) => a.point.stepIndex - b.point.stepIndex);
    const { accepted, carried } = carryOver(store, previousEntries, lookupEntries, decisionPoints);
    store.setDecisionPoints(`route-${generation}`, accepted, carried);
  }, [route]);

  useEffect(() => {
    if (!route || !online || !junctionView) return;
    requestLookups(routeGeneration, currentStepIndex ?? 0);
  }, [route, currentStepIndex, online, junctionView]);

  useEffect(() => {
    if (!route || !online || !junctionView || !junctionPhotos) return;
    if (providerIds.length === 0 || decisionPointCount === 0) return;
    advancePhotoWindow(routeGeneration, currentStepIndex ?? 0, providerIds);
  }, [
    route,
    currentStepIndex,
    online,
    junctionView,
    junctionPhotos,
    providerIds,
    decisionPointCount,
  ]);

  useEffect(
    () => () => {
      // Anything still in flight belongs to a view that is gone; it must not
      // write into the cleared store (or leave an object URL there).
      routeGeneration += 1;
      cancelLookupRetry();
      const store = useNavJunctionStore.getState();
      revokePhotoUrls(store.photoByStep);
      store.reset();
      lookupEntries = [];
    },
    [],
  );
}

/**
 * Hand what the previous route knew about a junction to the same junction on
 * the new one — its lookup outcome, gantry, lane start and settled photo — so
 * accepting a faster route just before an exit does not blank the panel and
 * fetch it all again. Everything not carried is released.
 */
function carryOver(
  store: ReturnType<typeof useNavJunctionStore.getState>,
  previousEntries: LookupEntry[],
  entries: LookupEntry[],
  decisionPoints: JunctionDecisionPoint[],
): { accepted: JunctionDecisionPoint[]; carried: CarriedJunctionState } {
  const accepted = [...decisionPoints];
  const carried: CarriedJunctionState = {
    gantryByStep: new Map(),
    fullLanesByStep: new Map(),
    photoByStep: new Map(),
  };
  const keptUrls = new Set<string>();
  const previousDone = previousEntries.filter((entry) => entry.status === "done");
  for (const entry of entries) {
    const previous = previousDone.find((old) => sameJunction(old.point, entry.point));
    if (!previous) continue;
    const oldStep = previous.point.stepIndex;
    const newStep = entry.point.stepIndex;
    const wasAccepted = store.byStep.has(oldStep);
    // The previous route turned it down as a candidate, so no gantry was ever
    // built for it; this route accepts it outright and looks it up afresh.
    if (!entry.candidate && !wasAccepted) continue;
    entry.status = "done";
    if (entry.candidate) {
      // A candidate the previous lookup promoted is a junction on this route
      // too; one it turned down stays out, with nothing to carry.
      if (!wasAccepted) continue;
      accepted.push(entry.point);
    }
    const gantry = store.gantryByStep.get(oldStep);
    if (gantry) carried.gantryByStep.set(newStep, gantry);
    const fullLanes = store.fullLanesByStep.get(oldStep);
    if (fullLanes !== undefined) carried.fullLanesByStep.set(newStep, fullLanes);
    const photo = store.photoByStep.get(oldStep);
    // A search or byte fetch still in flight belongs to the old route and is
    // dropped on arrival, so only settled photos move over.
    if (photo?.status === "ready" || photo?.status === "none") {
      carried.photoByStep.set(newStep, {
        ...photo,
        bytesRequested: photo.objectUrl !== undefined,
      });
      if (photo.objectUrl) keptUrls.add(photo.objectUrl);
    }
  }
  for (const photo of store.photoByStep.values()) {
    if (photo.objectUrl && !keptUrls.has(photo.objectUrl)) URL.revokeObjectURL(photo.objectUrl);
  }
  accepted.sort((a, b) => a.stepIndex - b.stepIndex);
  return { accepted, carried };
}

/**
 * Send the next batch of up to 40 lookups, nearest first, once one of the next
 * ten junctions ahead still waits for its lookup — not yet sent, or sent and
 * left unanswered. Runs at route start, when the step advances, when the
 * connection or the view comes back, and on the retry after an unanswered
 * batch — never per fix.
 */
function requestLookups(generation: number, currentStepIndex: number): void {
  const ahead = lookupEntries.filter((entry) => entry.point.stepIndex > currentStepIndex);
  if (!ahead.slice(0, LOOKUP_LOOKAHEAD).some((entry) => entry.status === "pending")) return;
  const batch = ahead.filter((entry) => entry.status === "pending").slice(0, MAX_GANTRY_POINTS);
  if (batch.length === 0) return;
  for (const entry of batch) entry.status = "sent";
  const settled = fetchGantries(generation, batch);
  for (const entry of batch) entry.settled = settled;
}

/**
 * Ask again for what a batch left unanswered, after a delay that grows with
 * each consecutive failure. Only one retry is ever scheduled; it does nothing
 * for a superseded route, offline (the reconnect asks instead) or with the
 * view switched off.
 */
function scheduleLookupRetry(generation: number): void {
  failedBatches += 1;
  if (retryTimer !== null) return;
  const delay = Math.min(LOOKUP_RETRY_MS * 2 ** (failedBatches - 1), LOOKUP_RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (generation !== routeGeneration) return;
    const nav = useNavigationStore.getState();
    if (nav.connectivity !== "online" || !useSettingsStore.getState().junctionView) return;
    requestLookups(generation, nav.progress?.currentStepIndex ?? 0);
  }, delay);
}

function cancelLookupRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  failedBatches = 0;
}

/** Release every object URL the store still holds; the bytes are transient. */
function revokePhotoUrls(photoByStep: Map<number, JunctionPhotoState>): void {
  for (const photo of photoByStep.values()) {
    if (photo.objectUrl) URL.revokeObjectURL(photo.objectUrl);
  }
}

/** The decision points still ahead of the step being driven, nearest first. */
function pointsAhead(currentStepIndex: number, limit: number): JunctionDecisionPoint[] {
  return useNavJunctionStore
    .getState()
    .decisionPoints.filter((point) => point.stepIndex > currentStepIndex)
    .slice(0, limit);
}

/**
 * The rolling photo window: release the bytes of passed decision points,
 * search the next four ahead (once each), and hold bytes for the next two.
 */
function advancePhotoWindow(
  generation: number,
  currentStepIndex: number,
  providerIds: string[],
): void {
  const store = useNavJunctionStore.getState();
  for (const [stepIndex, photo] of store.photoByStep) {
    if (stepIndex <= currentStepIndex && photo.objectUrl) {
      URL.revokeObjectURL(photo.objectUrl);
      store.setPhoto(stepIndex, { ...photo, objectUrl: undefined });
    }
  }
  for (const point of pointsAhead(currentStepIndex, PHOTO_WINDOW_AHEAD)) {
    const existing = store.photoByStep.get(point.stepIndex);
    if (existing && existing.status !== "idle") continue;
    void searchPhoto(generation, point, providerIds);
  }
  prefetchWindowBytes(generation, currentStepIndex);
}

/** Search the providers in order for one qualifying image. */
async function searchPhoto(
  generation: number,
  point: JunctionDecisionPoint,
  providerIds: string[],
): Promise<void> {
  const store = useNavJunctionStore.getState();
  store.setPhoto(point.stepIndex, { status: "loading" });
  const query = {
    lngLat: point.point,
    radiusM: PHOTO_SEARCH_RADIUS_M,
    heading: point.approachBearing,
    headingToleranceDeg: PHOTO_HEADING_TOLERANCE_DEG,
    capturedAfter: PHOTO_CAPTURED_AFTER,
    lookingAt: point.point,
    limit: PHOTO_SEARCH_LIMIT,
  };
  const lookup =
    lookupEntries.find((entry) => entry.point.stepIndex === point.stepIndex)?.settled ??
    Promise.resolve();
  try {
    for (const providerId of providerIds) {
      const images = await searchStreetLevelImages(providerId, query);
      await lookup;
      if (generation !== routeGeneration) return;
      // Read after the generation check, so a superseded route can never be
      // the one a photo is judged against.
      const geometry = useNavigationStore.getState().route?.geometry;
      const fullLanesFromMeters = useNavJunctionStore
        .getState()
        .fullLanesByStep.get(point.stepIndex);
      const selected = selectJunctionPhoto(images, point, new Date(), {
        ...(geometry ? { geometry } : {}),
        ...(fullLanesFromMeters !== undefined ? { fullLanesFromMeters } : {}),
      });
      if (selected) {
        store.setPhoto(point.stepIndex, { status: "ready", image: selected });
        const currentStepIndex = useNavigationStore.getState().progress?.currentStepIndex ?? 0;
        prefetchWindowBytes(generation, currentStepIndex);
        return;
      }
    }
  } catch {
    // A photo is decoration: any failure below shows the schematic instead.
  }
  if (generation === routeGeneration) store.setPhoto(point.stepIndex, { status: "none" });
}

/** Start fetching bytes for the ready photos of the next decision points. */
function prefetchWindowBytes(generation: number, currentStepIndex: number): void {
  const store = useNavJunctionStore.getState();
  for (const point of pointsAhead(currentStepIndex, PHOTO_BYTES_AHEAD)) {
    const photo = store.photoByStep.get(point.stepIndex);
    if (photo?.status !== "ready" || !photo.image || photo.bytesRequested) continue;
    store.setPhoto(point.stepIndex, { ...photo, bytesRequested: true });
    void fetchPhotoBytes(generation, point.stepIndex, photo.image);
  }
}

/**
 * Fetch the photo's bytes through the image proxy into an object URL: the
 * thumbnail for a flat frame, the `sd` asset for a panorama.
 */
async function fetchPhotoBytes(
  generation: number,
  stepIndex: number,
  image: StreetLevelImage,
): Promise<void> {
  // The panel shows the scene, not legible sign text (the gantry strip above
  // draws that), so a flat frame's thumbnail is enough: Panoramax's 500 px
  // frame is ~30 KB against ~500 KB for its 2048 px one, on mobile data, per
  // junction. A panorama's thumbnail is only a crop from its middle, while the
  // panel lays out the full 360°, so a panorama needs the whole frame.
  const source = image.isPano ? image.assets.sd : (image.assets.thumb ?? image.assets.sd);
  if (!source) return;
  try {
    const res = await fetch(proxyImageUrl(source));
    if (!res.ok) return;
    const blob = await res.blob();
    if (generation !== routeGeneration) return;
    // Bytes landing after the junction was passed would never be released:
    // the window already revoked that step and does not look back.
    const currentStepIndex = useNavigationStore.getState().progress?.currentStepIndex ?? 0;
    if (stepIndex <= currentStepIndex) return;
    const store = useNavJunctionStore.getState();
    const photo = store.photoByStep.get(stepIndex);
    if (photo?.image?.id !== image.id) return;
    store.setPhoto(stepIndex, { ...photo, objectUrl: URL.createObjectURL(blob) });
  } catch {
    // No bytes: the panel falls back to the schematic.
  }
}

/**
 * Fetch and map the gantry ways for one batch of junctions; a response from a
 * superseded route is discarded. A junction the server could not answer for —
 * the request failed, or OSM was unreachable — goes back to pending and rides
 * the next batch or the retry, so one dropped request does not cost it for
 * the whole drive.
 */
async function fetchGantries(generation: number, batch: LookupEntry[]): Promise<void> {
  const results = await fetchJunctionLookups(batch.map((entry) => entry.lookup));
  if (generation !== routeGeneration) return;
  const answered = batch.flatMap((entry, i) => {
    const result = results?.[i];
    if (!result || result.unavailable) {
      entry.status = "pending";
      return [];
    }
    entry.status = "done";
    return [{ entry, result }];
  });
  if (answered.length < batch.length) scheduleLookupRetry(generation);
  else failedBatches = 0;
  // A candidate becomes a junction only where OSM puts the route on a motorway
  // or trunk carriageway at the split; an on-ramp's town street never is.
  const confirmed = answered.flatMap(({ entry, result }) =>
    entry.candidate && result.onMotorway ? [entry.point] : [],
  );
  if (confirmed.length > 0) useNavJunctionStore.getState().addDecisionPoints(confirmed);
  for (const { entry, result } of answered) {
    const store = useNavJunctionStore.getState();
    const point = store.byStep.get(entry.point.stepIndex);
    if (!point) continue;
    if (result.fullLanesFromMeters !== undefined) {
      store.setFullLanesFrom(point.stepIndex, result.fullLanesFromMeters);
    }
    const model = buildGantry(result, point);
    if (model) store.setGantry(point.stepIndex, model);
  }
}

/** Approach way → parsed lane tags → exit panel from the ramp or the engine sign. */
function buildGantry(
  result: JunctionLookupResult,
  point: JunctionDecisionPoint,
): GantryModel | null {
  const approach = selectApproachWay(result.approach, point);
  if (!approach) return null;
  const model = parseLaneTags(approach.tags, point.laneCount);
  if (!model) return null;
  const rampWay = selectRampWay(result.ramps, point)[0];
  return mergeExitPanel(model, point, rampWay?.tags);
}
