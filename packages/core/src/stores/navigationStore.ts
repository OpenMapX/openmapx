import type { Route, TravelMode } from "@integrations/routing/types";
import { create } from "zustand";
import type { CameraMode, NavProgress, NavStatus } from "../navigation/types";
import type { LngLat } from "../types/geometry";

interface NavigationState {
  status: NavStatus;
  mode: TravelMode;
  route: Route | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  offRoute: boolean;
  cameraMode: CameraMode;
  currentSpeedLimit: number | null;
  voiceEnabled: boolean;
  keepScreenOn: boolean;

  startGroundNavigation: (route: Route, mode: TravelMode, waypoints: LngLat[]) => void;
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
  mode: "driving" as TravelMode,
  route: null,
  destinationWaypoints: [] as LngLat[],
  progress: null,
  offRoute: false,
  cameraMode: "follow" as CameraMode,
  currentSpeedLimit: null,
};

export const useNavigationStore = create<NavigationState>((set) => ({
  ...INITIAL,
  voiceEnabled: true,
  keepScreenOn: true,

  startGroundNavigation: (route, mode, waypoints) =>
    set({ ...INITIAL, status: "navigating", mode, route, destinationWaypoints: waypoints }),
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
