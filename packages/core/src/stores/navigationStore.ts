import type { Route, TravelMode } from "@integrations/routing/types";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { create } from "zustand";
import type { TransitProgress } from "../navigation/transitProgress";
import type { CameraMode, NavProgress, NavStatus } from "../navigation/types";
import type { LngLat } from "../types/geometry";

/**
 * Navigation runs in one of two parallel modes. `"ground"` is full
 * turn-by-turn driving/walking/cycling navigation (route + progress + reroute).
 * `"transit"` is a follow-along mode for a planned public-transit itinerary —
 * no rerouting; it just reports the current leg, next stop, and overall ETA.
 */
export type NavKind = "ground" | "transit";

interface NavigationState {
  status: NavStatus;
  kind: NavKind;
  mode: TravelMode;
  route: Route | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  offRoute: boolean;
  cameraMode: CameraMode;
  currentSpeedLimit: number | null;
  voiceEnabled: boolean;
  keepScreenOn: boolean;
  // Transit follow-along state (only populated when kind === "transit").
  itinerary: TripItinerary | null;
  transitProgress: TransitProgress | null;

  startGroundNavigation: (route: Route, mode: TravelMode, waypoints: LngLat[]) => void;
  startTransitNavigation: (itinerary: TripItinerary) => void;
  applyTransitProgress: (p: TransitProgress) => void;
  applyProgress: (progress: NavProgress) => void;
  setSpeedLimit: (v: number | null) => void;
  setOffRoute: (v: boolean) => void;
  beginReroute: () => void;
  applyReroute: (route: Route) => void;
  setCameraMode: (m: CameraMode) => void;
  toggleVoice: () => void;
  toggleKeepScreenOn: () => void;
  completeArrival: () => void;
  stopNavigation: () => void;
}

const INITIAL = {
  status: "idle" as NavStatus,
  kind: "ground" as NavKind,
  mode: "driving" as TravelMode,
  route: null,
  destinationWaypoints: [] as LngLat[],
  progress: null,
  offRoute: false,
  cameraMode: "follow" as CameraMode,
  currentSpeedLimit: null,
  itinerary: null as TripItinerary | null,
  transitProgress: null as TransitProgress | null,
};

export const useNavigationStore = create<NavigationState>((set) => ({
  ...INITIAL,
  voiceEnabled: true,
  keepScreenOn: true,

  startGroundNavigation: (route, mode, waypoints) =>
    set({
      ...INITIAL,
      status: "navigating",
      kind: "ground",
      mode,
      route,
      destinationWaypoints: waypoints,
    }),
  startTransitNavigation: (itinerary) =>
    set({
      ...INITIAL,
      status: "navigating",
      kind: "transit",
      itinerary,
      route: null,
      progress: null,
      transitProgress: null,
    }),
  applyTransitProgress: (transitProgress) => set({ transitProgress }),
  applyProgress: (progress) => set({ progress }),
  setSpeedLimit: (currentSpeedLimit) => set({ currentSpeedLimit }),
  setOffRoute: (offRoute) => set({ offRoute }),
  beginReroute: () => set({ status: "rerouting" }),
  applyReroute: (route) => set({ status: "navigating", route, offRoute: false }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  toggleVoice: () => set((s) => ({ voiceEnabled: !s.voiceEnabled })),
  toggleKeepScreenOn: () => set((s) => ({ keepScreenOn: !s.keepScreenOn })),
  completeArrival: () => set({ status: "arrived" }),
  stopNavigation: () => set({ ...INITIAL }),
}));
