import type { Route, TravelMode } from "@integrations/routing/types";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { create } from "zustand";
import type { TransitProgress } from "../navigation/transitProgress";
import type { CameraMode, NavProgress, NavStatus } from "../navigation/types";
import { getStorage } from "../platform/storage";
import type { LngLat } from "../types/geometry";

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
  preTransitModes?: string[];
  postTransitModes?: string[];
  directModes?: string[];
}

interface NavigationState {
  status: NavStatus;
  kind: NavKind;
  mode: TravelMode;
  route: Route | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  offRoute: boolean;
  /** True while GPS fixes are arriving too noisy to use (accuracy over the cap). */
  weakGps: boolean;
  /**
   * Monotonic counter bumped each time a reroute attempt fails, so the UI can
   * show a transient toast. A counter (rather than a boolean) lets repeated
   * failures re-trigger the toast.
   */
  rerouteFailedNonce: number;
  cameraMode: CameraMode;
  currentSpeedLimit: number | null;
  voiceEnabled: boolean;
  keepScreenOn: boolean;
  // Transit follow-along state (only populated when kind === "transit").
  itinerary: TripItinerary | null;
  transitProgress: TransitProgress | null;
  /** Set when a missed connection is detected and an on-trip replan is wanted. */
  transitRerouteNeeded: boolean;
  /** User's resolved transit options, snapshotted for on-trip replans. */
  transitReplanOptions: TransitReplanOptions | null;

  startGroundNavigation: (route: Route, mode: TravelMode, waypoints: LngLat[]) => void;
  startTransitNavigation: (itinerary: TripItinerary, replanOptions?: TransitReplanOptions) => void;
  applyTransitProgress: (p: TransitProgress) => void;
  setTransitRerouteNeeded: (v: boolean) => void;
  /** Swap in a freshly-planned itinerary (on-trip replan) and clear the flag. */
  replaceItinerary: (itinerary: TripItinerary) => void;
  applyProgress: (progress: NavProgress) => void;
  setSpeedLimit: (v: number | null) => void;
  setOffRoute: (v: boolean) => void;
  setWeakGps: (v: boolean) => void;
  signalRerouteFailed: () => void;
  beginReroute: () => void;
  applyReroute: (route: Route) => void;
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

const INITIAL = {
  status: "idle" as NavStatus,
  kind: "ground" as NavKind,
  mode: "driving" as TravelMode,
  route: null,
  destinationWaypoints: [] as LngLat[],
  progress: null,
  offRoute: false,
  weakGps: false,
  rerouteFailedNonce: 0,
  cameraMode: "follow" as CameraMode,
  currentSpeedLimit: null,
  itinerary: null as TripItinerary | null,
  transitProgress: null as TransitProgress | null,
  transitRerouteNeeded: false,
  transitReplanOptions: null as TransitReplanOptions | null,
};

export const useNavigationStore = create<NavigationState>((set) => ({
  ...INITIAL,
  voiceEnabled: readBoolPref(VOICE_STORAGE_KEY, true),
  keepScreenOn: readBoolPref(KEEP_SCREEN_ON_STORAGE_KEY, true),

  startGroundNavigation: (route, mode, waypoints) =>
    set({
      ...INITIAL,
      status: "navigating",
      kind: "ground",
      mode,
      route,
      destinationWaypoints: waypoints,
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
  applyProgress: (progress) => set({ progress }),
  setSpeedLimit: (currentSpeedLimit) => set({ currentSpeedLimit }),
  setOffRoute: (offRoute) => set({ offRoute }),
  setWeakGps: (weakGps) => set({ weakGps }),
  signalRerouteFailed: () => set((s) => ({ rerouteFailedNonce: s.rerouteFailedNonce + 1 })),
  beginReroute: () => set({ status: "rerouting" }),
  // Clear progress: it belongs to the OLD route. Leaving the previous route's
  // (larger) alongMeters in place would mislead every progress consumer for one
  // render against the new, often shorter, geometry until the next fix arrives.
  applyReroute: (route) => set({ status: "navigating", route, offRoute: false, progress: null }),
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
  completeArrival: () => set({ status: "arrived" }),
  stopNavigation: () => set({ ...INITIAL }),
  hydrate: () =>
    set({
      voiceEnabled: readBoolPref(VOICE_STORAGE_KEY, true),
      keepScreenOn: readBoolPref(KEEP_SCREEN_ON_STORAGE_KEY, true),
    }),
}));
