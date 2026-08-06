import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { create } from "zustand";
import {
  createNavigationSessionSnapshot,
  type NavigationSessionSnapshot,
} from "../navigation/offlineSession";
import type { TransitProgress } from "../navigation/transitProgress";
import type { CameraMode, NavProgress, NavStatus } from "../navigation/types";
import { getStorage } from "../platform/storage";
import type { LngLat } from "../types/geometry";
import type { Route, TravelMode } from "../types/routing";

const VOICE_STORAGE_KEY = "openmapx:nav:voiceEnabled";
const KEEP_SCREEN_ON_STORAGE_KEY = "openmapx:nav:keepScreenOn";

/** Read a persisted boolean preference, falling back to `fallback` when unset. */
function readBoolPref(key: string, fallback: boolean): boolean {
  const value = getStorage().getString(key);
  if (value === null) return fallback;
  return value === "true";
}

/**
 * Navigation runs in one of two parallel modes. `"ground"` is full
 * turn-by-turn driving/walking/cycling navigation (route + progress + reroute).
 * `"transit"` is a follow-along mode for a planned public-transit itinerary —
 * no rerouting; it just reports the current leg, next stop, and overall ETA.
 */
export type NavKind = "ground" | "transit";

/** Whether the active ground route was chosen by the router or by the driver. */
export type RouteSelectionIntent = "automatic" | "userSelected";

/** Route constraints that must survive every mid-trip directions request. */
export interface NavigationRouteOptions {
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  avoidClosures: boolean;
}

/** Optional context captured when a ground navigation session starts. */
export interface NavigationStartOptions {
  routeIntent?: RouteSelectionIntent;
  routeOptions?: Partial<NavigationRouteOptions>;
}

const DEFAULT_ROUTE_OPTIONS: NavigationRouteOptions = {
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
  avoidClosures: false,
};

/**
 * Resolved MOTIS transit options captured when transit navigation starts, so an
 * on-trip replan reuses the user's original choices (preferred modes,
 * Deutschlandticket-filtered set, wheelchair, first/last-mile access) even after
 * the directions panel — and its store — has been reset (e.g. Escape, new
 * search). Mirrors the `opts` shape sent to MOTIS `/plan`.
 */
export interface TransitReplanOptions {
  modes?: string[];
  wheelchair?: boolean;
  wheelchairRequired?: boolean;
  maxTransfers?: number;
  transferBuffer?: "standard" | "relaxed" | "extra";
  requireBikeTransport?: boolean;
  bikeHillPreference?: "default" | "avoid" | "strongly-avoid";
  rentalFormFactors?: string[];
  preTransitModes?: string[];
  postTransitModes?: string[];
  directModes?: string[];
  deutschlandticketOnly?: boolean;
}

/**
 * A faster route found mid-trip and awaiting the driver's answer. Alternatives
 * come from the same re-plan so accepting can replace the stale origin plan.
 */
export interface FasterRouteProposal {
  route: Route;
  alternatives: Route[];
  savedSeconds: number;
  proposedAtMs: number;
}

export type NavigationConnectivity = "online" | "offline";
export type RerouteAvailability = "available" | "unavailable";

/**
 * The continuous state derived from one accepted navigation fix. These fields
 * describe a single instant, so they are published together — a subscriber must
 * never see the new progress next to the previous off-route or speed-limit
 * verdict.
 */
export interface GroundFixStoreUpdate {
  progress: NavProgress;
  weakGps: boolean;
  offRoute: boolean;
  currentSpeedLimit: number | null;
  /** Omit for a synthetic/coasted fix; `false` for a real fix that re-anchors. */
  coasting?: false;
}

interface NavigationState {
  status: NavStatus;
  kind: NavKind;
  mode: TravelMode;
  route: Route | null;
  /** Active route plus its alternatives, so the user can switch mid-trip. */
  routes: Route[];
  /** Whether the active route is still the driver's explicit choice. */
  routeSelectionIntent: RouteSelectionIntent;
  /** Original route constraints reused by live reroutes and faster-route checks. */
  routeOptions: NavigationRouteOptions;
  /** Integration id of the routing provider that produced the active route, for map attribution. */
  routeProvider: string | null;
  activeRouteIndex: number;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  offRoute: boolean;
  /** True while GPS fixes are arriving too noisy to use (accuracy over the cap). */
  weakGps: boolean;
  /**
   * True while the shown position is being extrapolated along the route through
   * a GPS outage (tunnel, garage, urban canyon) rather than read from a fix.
   */
  coasting: boolean;
  /**
   * Monotonic counter bumped each time a reroute attempt fails, so the UI can
   * show a transient toast. A counter (rather than a boolean) lets repeated
   * failures re-trigger the toast.
   */
  rerouteFailedNonce: number;
  /** Pending faster-route offer, or null when there is nothing to answer. */
  fasterRoute: FasterRouteProposal | null;
  /** User declined faster-route suggestions for the remainder of this trip. */
  fasterRouteSuppressed: boolean;
  cameraMode: CameraMode;
  currentSpeedLimit: number | null;
  /**
   * Posted speed limit (km/h) per `route.geometry` index, accumulated up front
   * from the route's windowed map-match for engines that don't carry per-segment
   * limits on the route (Valhalla). Indexed by `progress.segmentIndex`; null
   * entries / null array mean unknown. Reset on every route change because the
   * indices belong to the old geometry.
   */
  liveSpeedLimits: (number | null)[] | null;
  voiceEnabled: boolean;
  keepScreenOn: boolean;
  // Transit follow-along state (only populated when kind === "transit").
  itinerary: TripItinerary | null;
  transitProgress: TransitProgress | null;
  /** Set when a missed connection is detected and an on-trip replan is wanted. */
  transitRerouteNeeded: boolean;
  /** User's resolved transit options, snapshotted for on-trip replans. */
  transitReplanOptions: TransitReplanOptions | null;
  /** Browser connectivity signal; route state is intentionally independent of it. */
  connectivity: NavigationConnectivity;
  /** True after an offline/error reroute until one succeeds or navigation ends. */
  rerouteUnavailable: boolean;
  /** True when live incidents/traffic/alerts are not known to be current. */
  liveDataUnavailable: boolean;
  /** Monotonic UI intent consumed by the web navigation engine for one retry. */
  rerouteRetryNonce: number;
  /** Start time for the bounded local route-session snapshot. */
  navigationStartedAtMs: number | null;

  startGroundNavigation: (
    route: Route,
    mode: TravelMode,
    waypoints: LngLat[],
    alternatives?: Route[],
    provider?: string,
    options?: NavigationStartOptions,
  ) => void;
  /** Switch the followed route to one of `routes` (an alternative shown on the map). */
  selectRoute: (index: number) => void;
  /**
   * Swap in a freshly-planned route that now routes through a newly-added stop,
   * persisting the new waypoint list so later reroutes keep the stop. Clears
   * stale progress like a reroute.
   */
  addStop: (route: Route, waypoints: LngLat[]) => void;
  startTransitNavigation: (itinerary: TripItinerary, replanOptions?: TransitReplanOptions) => void;
  applyTransitProgress: (p: TransitProgress) => void;
  setTransitRerouteNeeded: (v: boolean) => void;
  /** Swap in a freshly-planned itinerary (on-trip replan) and clear the flag. */
  replaceItinerary: (itinerary: TripItinerary) => void;
  /**
   * Update the itinerary in place with a live-refreshed copy (same leg
   * structure, updated realtime times/platforms/cancellations). Unlike
   * {@link replaceItinerary} it keeps the current transit progress, since the
   * geometry is unchanged — no need to blank the banner until the next fix.
   */
  updateItinerary: (itinerary: TripItinerary) => void;
  applyProgress: (progress: NavProgress) => void;
  /**
   * Publish everything one accepted ground fix produced in a single update. The
   * granular setters below remain for callers outside the per-fix hot path.
   */
  applyGroundFix: (update: GroundFixStoreUpdate) => void;
  setSpeedLimit: (v: number | null) => void;
  setLiveSpeedLimits: (v: (number | null)[] | null) => void;
  setOffRoute: (v: boolean) => void;
  setWeakGps: (v: boolean) => void;
  setCoasting: (v: boolean) => void;
  signalRerouteFailed: () => void;
  beginReroute: () => void;
  applyReroute: (route: Route, provider?: string, alternatives?: Route[]) => void;
  setConnectivity: (value: NavigationConnectivity) => void;
  setRerouteUnavailable: (value: boolean) => void;
  setLiveDataUnavailable: (value: boolean) => void;
  requestRerouteRetry: () => void;
  restoreGroundNavigation: (snapshot: NavigationSessionSnapshot) => void;
  proposeFasterRoute: (proposal: FasterRouteProposal) => void;
  /** Switch to the pending proposal and adopt its fresh alternatives. */
  acceptFasterRoute: (routeIntent?: RouteSelectionIntent) => void;
  dismissFasterRoute: () => void;
  /** Withdraw an offer for system reasons without suppressing future offers. */
  clearFasterRoute: () => void;
  setCameraMode: (m: CameraMode) => void;
  toggleVoice: () => void;
  toggleKeepScreenOn: () => void;
  completeArrival: () => void;
  stopNavigation: () => void;
  /**
   * Re-read the persisted voice / keep-screen-on preferences from storage. The
   * store is created at module-eval time, which can run before the platform
   * storage adapter is configured; calling this once on the client (after
   * configuration) applies the saved choices instead of the defaults.
   */
  hydrate: () => void;
}

/**
 * Fields derived from the OLD route that must never survive a route identity
 * change (route switch, added stop, reroute, or accepted faster route): they
 * are indexed into / measured against geometry that no longer exists, and
 * would mislead every consumer for one render until the next accepted fix
 * overwrites them. `currentSpeedLimit` belongs here alongside `progress` /
 * `offRoute` / `liveSpeedLimits` — it describes the OLD road, and leaving it
 * in place shows the previous route's regulatory badge against the new one.
 */
const ROUTE_IDENTITY_RESET = {
  progress: null as NavProgress | null,
  offRoute: false,
  liveSpeedLimits: null as (number | null)[] | null,
  currentSpeedLimit: null as number | null,
};

const INITIAL = {
  status: "idle" as NavStatus,
  kind: "ground" as NavKind,
  mode: "driving" as TravelMode,
  route: null as Route | null,
  routes: [] as Route[],
  routeSelectionIntent: "automatic" as RouteSelectionIntent,
  routeOptions: DEFAULT_ROUTE_OPTIONS,
  routeProvider: null as string | null,
  activeRouteIndex: 0,
  destinationWaypoints: [] as LngLat[],
  progress: null,
  offRoute: false,
  weakGps: false,
  coasting: false,
  rerouteFailedNonce: 0,
  fasterRoute: null as FasterRouteProposal | null,
  fasterRouteSuppressed: false,
  cameraMode: "follow" as CameraMode,
  currentSpeedLimit: null,
  liveSpeedLimits: null as (number | null)[] | null,
  itinerary: null as TripItinerary | null,
  transitProgress: null as TransitProgress | null,
  transitRerouteNeeded: false,
  transitReplanOptions: null as TransitReplanOptions | null,
  connectivity: "online" as NavigationConnectivity,
  rerouteUnavailable: false,
  liveDataUnavailable: false,
  rerouteRetryNonce: 0,
  navigationStartedAtMs: null as number | null,
};

export const useNavigationStore = create<NavigationState>((set) => ({
  ...INITIAL,
  voiceEnabled: readBoolPref(VOICE_STORAGE_KEY, true),
  keepScreenOn: readBoolPref(KEEP_SCREEN_ON_STORAGE_KEY, true),

  startGroundNavigation: (route, mode, waypoints, alternatives = [], provider, options) =>
    set((current) => ({
      ...INITIAL,
      status: "navigating",
      kind: "ground",
      mode,
      route,
      routes: [route, ...alternatives],
      routeSelectionIntent: options?.routeIntent ?? "automatic",
      routeOptions: { ...DEFAULT_ROUTE_OPTIONS, ...options?.routeOptions },
      routeProvider: provider ?? null,
      activeRouteIndex: 0,
      destinationWaypoints: waypoints,
      navigationStartedAtMs: Date.now(),
      connectivity: current.connectivity,
      rerouteUnavailable: current.connectivity === "offline",
      liveDataUnavailable: current.connectivity === "offline",
    })),
  // Switch the followed route to a shown alternative. Clears progress (it belongs
  // to the old geometry) like a reroute; the engine/camera reset on route identity.
  selectRoute: (index) =>
    set((s) => {
      const next = s.routes[index];
      if (!next || index === s.activeRouteIndex) return {};
      return {
        route: next,
        activeRouteIndex: index,
        routeSelectionIntent: "userSelected",
        ...ROUTE_IDENTITY_RESET,
        fasterRoute: null,
        fasterRouteSuppressed: false,
      };
    }),
  addStop: (route, waypoints) =>
    set({
      status: "navigating",
      route,
      routes: [route],
      activeRouteIndex: 0,
      destinationWaypoints: waypoints,
      ...ROUTE_IDENTITY_RESET,
      routeSelectionIntent: "userSelected",
      fasterRouteSuppressed: false,
    }),
  startTransitNavigation: (itinerary, replanOptions) =>
    set({
      ...INITIAL,
      status: "navigating",
      kind: "transit",
      itinerary,
      route: null,
      progress: null,
      transitProgress: null,
      transitReplanOptions: replanOptions ?? null,
    }),
  applyTransitProgress: (transitProgress) => set({ transitProgress }),
  setTransitRerouteNeeded: (transitRerouteNeeded) => set({ transitRerouteNeeded }),
  replaceItinerary: (itinerary) =>
    set({ itinerary, transitProgress: null, transitRerouteNeeded: false }),
  updateItinerary: (itinerary) => set({ itinerary }),
  applyProgress: (progress) => set({ progress }),
  // One publication per accepted fix. A coasted fix omits `coasting` so the
  // ongoing coast survives; a real fix passes false to end it in the same update.
  applyGroundFix: (update) =>
    set((s) => ({
      progress: update.progress,
      weakGps: update.weakGps,
      offRoute: update.offRoute,
      currentSpeedLimit: update.currentSpeedLimit,
      coasting: update.coasting ?? s.coasting,
    })),
  setSpeedLimit: (currentSpeedLimit) => set({ currentSpeedLimit }),
  setLiveSpeedLimits: (liveSpeedLimits) => set({ liveSpeedLimits }),
  setOffRoute: (offRoute) => set({ offRoute }),
  setWeakGps: (weakGps) => set({ weakGps }),
  setCoasting: (coasting) => set({ coasting }),
  signalRerouteFailed: () => set((s) => ({ rerouteFailedNonce: s.rerouteFailedNonce + 1 })),
  beginReroute: () => set({ status: "rerouting" }),
  // Clear progress: it belongs to the OLD route. Leaving the previous route's
  // (larger) alongMeters in place would mislead every progress consumer for one
  // render against the new, often shorter, geometry until the next fix arrives.
  applyReroute: (route, provider, alternatives) =>
    set((s) => ({
      status: "navigating",
      route,
      ...ROUTE_IDENTITY_RESET,
      routeProvider: provider ?? s.routeProvider,
      routeSelectionIntent: "automatic",
      fasterRoute: null,
      fasterRouteSuppressed: false,
      rerouteUnavailable: false,
      ...(alternatives && { routes: [route, ...alternatives], activeRouteIndex: 0 }),
    })),
  setConnectivity: (connectivity) =>
    set({
      connectivity,
      ...(connectivity === "offline" && {
        rerouteUnavailable: true,
        liveDataUnavailable: true,
      }),
    }),
  setRerouteUnavailable: (rerouteUnavailable) => set({ rerouteUnavailable }),
  setLiveDataUnavailable: (liveDataUnavailable) => set({ liveDataUnavailable }),
  requestRerouteRetry: () => set((s) => ({ rerouteRetryNonce: s.rerouteRetryNonce + 1 })),
  restoreGroundNavigation: (snapshot) => {
    if (
      snapshot.kind !== "ground" ||
      !["driving", "walking", "cycling", "motorcycle"].includes(snapshot.mode)
    ) {
      throw new Error("only a ground navigation snapshot can be restored");
    }
    const restored = createNavigationSessionSnapshot({
      route: snapshot.route,
      routes: snapshot.routes,
      activeRouteIndex: snapshot.activeRouteIndex,
      routeSelectionIntent: snapshot.routeSelectionIntent,
      mode: snapshot.mode,
      routeOptions: snapshot.routeOptions,
      routeProvider: snapshot.routeProvider,
      destinationWaypoints: snapshot.destinationWaypoints,
      progress: snapshot.progress,
      packageIds: snapshot.packageIds,
      startedAtMs: snapshot.startedAtMs,
      updatedAtMs: snapshot.updatedAtMs,
      lastKnownPosition: snapshot.lastKnownPosition,
    });
    set((current) => ({
      ...INITIAL,
      status: "navigating",
      kind: "ground",
      mode: restored.mode,
      route: restored.route,
      routes: restored.routes,
      activeRouteIndex: restored.activeRouteIndex,
      routeSelectionIntent: restored.routeSelectionIntent,
      routeOptions: restored.routeOptions,
      routeProvider: restored.routeProvider,
      destinationWaypoints: restored.destinationWaypoints,
      progress: restored.progress,
      navigationStartedAtMs: restored.startedAtMs,
      connectivity: current.connectivity,
      rerouteUnavailable: current.connectivity === "offline",
      liveDataUnavailable: current.connectivity === "offline",
    }));
  },
  proposeFasterRoute: (fasterRoute) => set({ fasterRoute }),
  acceptFasterRoute: (routeIntent) =>
    set((s) => {
      const proposal = s.fasterRoute;
      if (!proposal) return {};
      return {
        status: "navigating" as const,
        route: proposal.route,
        routes: [proposal.route, ...proposal.alternatives],
        activeRouteIndex: 0,
        routeSelectionIntent: routeIntent ?? s.routeSelectionIntent,
        ...ROUTE_IDENTITY_RESET,
        fasterRoute: null,
        fasterRouteSuppressed: false,
      };
    }),
  dismissFasterRoute: () => set({ fasterRoute: null, fasterRouteSuppressed: true }),
  clearFasterRoute: () => set({ fasterRoute: null }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  toggleVoice: () =>
    set((s) => {
      const voiceEnabled = !s.voiceEnabled;
      getStorage().setString(VOICE_STORAGE_KEY, String(voiceEnabled));
      return { voiceEnabled };
    }),
  toggleKeepScreenOn: () =>
    set((s) => {
      const keepScreenOn = !s.keepScreenOn;
      getStorage().setString(KEEP_SCREEN_ON_STORAGE_KEY, String(keepScreenOn));
      return { keepScreenOn };
    }),
  completeArrival: () =>
    set({ status: "arrived", rerouteUnavailable: false, liveDataUnavailable: false }),
  stopNavigation: () => set((current) => ({ ...INITIAL, connectivity: current.connectivity })),
  hydrate: () =>
    set({
      voiceEnabled: readBoolPref(VOICE_STORAGE_KEY, true),
      keepScreenOn: readBoolPref(KEEP_SCREEN_ON_STORAGE_KEY, true),
    }),
}));
